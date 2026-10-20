import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { type } from "@oh-my-pi/omptype";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { Settings } from "../config/settings";
import { redactMemorySecrets, redactMemoryTextFields } from "../memory-backend/redact";
import type { MemoryBackendSaveResult, MemoryBackendSearchItem } from "../memory-backend/types";
import {
	cfgMem0ApiKey,
	cfgMem0ApiUrl,
	cfgMem0AutoRecall,
	cfgMem0AutoRetain,
	cfgMem0RecallLimit,
	cfgMem0RecallMaxChars,
	cfgMem0RecallTimeoutMs,
	cfgMem0RetainTimeoutMs,
	cfgMem0UserId,
} from "./settings";

const mem0ResultSchema = type({
	"id?": "string",
	"memory?": "string",
	"user_id?": "string",
	"event?": "string",
	"score?": "number | null",
	"updated_at?": "string | null",
});
const mem0ResponseSchema = type({ results: mem0ResultSchema.array() });
type Mem0Result = typeof mem0ResultSchema.infer;

export interface Mem0Message {
	role: "user" | "assistant";
	content: string;
}

export interface Mem0Config {
	apiUrl: string;
	apiKey?: string;
	userId: string;
	autoRecall: boolean;
	autoRetain: boolean;
	recallLimit: number;
	recallMaxChars: number;
	recallTimeoutMs: number;
	retainTimeoutMs: number;
}

export function loadMem0Config(settings: Settings, cwd: string): Mem0Config {
	const rawUrl = cfgMem0ApiUrl.get(settings)?.trim();
	if (!rawUrl) throw new Error("Set mem0.apiUrl or MEM0_API_URL to a self-hosted Mem0 OSS server.");
	const url = new URL(rawUrl);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("mem0.apiUrl must be an HTTP(S) URL without credentials, query, or fragment.");
	}
	const namespace = cfgMem0UserId.get(settings).trim();
	if (!namespace) throw new Error("mem0.userId must not be empty.");
	const project = realpathSync(vcs.repo(cwd)?.primaryRoot() ?? cwd);
	return {
		apiUrl: url.href.replace(/\/+$/, ""),
		apiKey: cfgMem0ApiKey.get(settings),
		userId: `${namespace}:${createHash("sha256").update(project).digest("hex")}`,
		autoRecall: cfgMem0AutoRecall.get(settings),
		autoRetain: cfgMem0AutoRetain.get(settings),
		recallLimit: Math.max(1, Math.min(100, Math.floor(cfgMem0RecallLimit.get(settings)))),
		recallMaxChars: Math.max(256, Math.floor(cfgMem0RecallMaxChars.get(settings))),
		recallTimeoutMs: Math.max(1, Math.floor(cfgMem0RecallTimeoutMs.get(settings))),
		retainTimeoutMs: Math.max(1, Math.floor(cfgMem0RetainTimeoutMs.get(settings))),
	};
}

/** Mem0 OSS v2.2 REST contract. Scope cannot be overridden by tool input. */

export class Mem0Client {
	constructor(readonly config: Mem0Config) {}

	async #request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
		const timeout = AbortSignal.timeout(
			method === "GET" || path === "/search" ? this.config.recallTimeoutMs : this.config.retainTimeoutMs,
		);
		const response = await fetch(`${this.config.apiUrl}${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				...(this.config.apiKey ? { "X-API-Key": this.config.apiKey } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			redirect: "error",
		});
		if (!response.ok) {
			// Server errors may echo transcript text or credentials; never expose the body.
			await response.body?.cancel();
			throw new Error(`Mem0 ${method} ${path.split("?")[0]} failed (HTTP ${response.status}).`);
		}
		return response.json();
	}

	#results(response: unknown): Mem0Result[] {
		let rows: Mem0Result[];
		try {
			rows = mem0ResponseSchema.assert(response).results;
		} catch {
			// Schema errors can include the rejected memory text; expose only the contract.
			throw new Error("Invalid Mem0 OSS response: expected a results array.");
		}
		for (const row of rows) {
			if (row.user_id !== undefined && row.user_id !== this.config.userId) {
				throw new Error("Mem0 returned a memory outside the requested project scope.");
			}
		}
		return rows;
	}

	async search(
		query: string,
		limit = this.config.recallLimit,
		signal?: AbortSignal,
	): Promise<MemoryBackendSearchItem[]> {
		if (!query.trim()) throw new Error("Mem0 search query must not be empty.");
		const response = await this.#request(
			"POST",
			"/search",
			{
				query: redactMemorySecrets(query),
				filters: { user_id: this.config.userId },
				top_k: Math.max(1, Math.min(100, Math.floor(limit))),
			},
			signal,
		);
		return this.#results(response).map(row => {
			if (typeof row.id !== "string" || !row.id || typeof row.memory !== "string") {
				throw new Error("Invalid Mem0 search result: expected id and memory strings.");
			}
			return {
				id: row.id,
				content: row.memory,
				timestamp: typeof row.updated_at === "string" ? row.updated_at : undefined,
				score: typeof row.score === "number" && Number.isFinite(row.score) ? row.score : undefined,
			};
		});
	}

	async add(
		messages: Mem0Message[],
		metadata: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<MemoryBackendSaveResult> {
		const response = await this.#request(
			"POST",
			"/memories",
			{
				messages: messages.map(message => ({ ...message, content: redactMemorySecrets(message.content) })),
				user_id: this.config.userId,
				...redactMemoryTextFields({ metadata }),
				infer: true,
			},
			signal,
		);
		const ids: string[] = [];
		let deleted = 0;
		for (const row of this.#results(response)) {
			if (row.event === "NONE") continue;
			if (!["ADD", "UPDATE", "DELETE"].includes(String(row.event)) || typeof row.id !== "string" || !row.id) {
				throw new Error("Invalid Mem0 write result: expected an id and ADD, UPDATE, DELETE, or NONE event.");
			}
			if (row.event === "DELETE") deleted++;
			else ids.push(row.id);
		}
		return {
			backend: "mem0",
			stored: ids.length,
			ids,
			message: `Mem0 added or updated ${ids.length} memories and deleted ${deleted}.`,
		};
	}

	async probe(signal?: AbortSignal): Promise<void> {
		this.#results(
			await this.#request(
				"GET",
				`/memories?user_id=${encodeURIComponent(this.config.userId)}&top_k=1`,
				undefined,
				signal,
			),
		);
	}

	async clear(): Promise<void> {
		// The OSS server requires an admin API key for this project-scoped deletion.
		await this.#request("DELETE", `/memories?user_id=${encodeURIComponent(this.config.userId)}`);
	}
}

/** Character-bounded, quoted data, never instructions or an addressable memory:// resource. */
export function formatMem0Memories(items: MemoryBackendSearchItem[], maxChars: number): string {
	let result = "";
	for (const item of items) {
		const line = `${JSON.stringify({ id: item.id, memory: item.content, updated_at: item.timestamp })}\n`;
		if (result.length + line.length > maxChars) {
			const suffix = "\n[truncated]";
			return (result + line).slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
		}
		result += line;
	}
	return result.trimEnd();
}
