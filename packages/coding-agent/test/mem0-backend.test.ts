import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { mkdirSync, symlinkSync } from "node:fs";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mem0Backend } from "@oh-my-pi/pi-coding-agent/mem0/backend";
import { formatMem0Memories, loadMem0Config, Mem0Client } from "@oh-my-pi/pi-coding-agent/mem0/client";
import {
	bindMem0SessionState,
	getMem0SessionState,
	Mem0SessionState,
	releaseMem0Session,
} from "@oh-my-pi/pi-coding-agent/mem0/state";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("Mem0 OSS backend", () => {
	let server: Server<undefined>;
	let temp: TempDir;
	let settings: Settings;
	let respond: (request: Request) => Response | Promise<Response>;
	let requests: Array<{ method: string; path: string; body: Record<string, unknown>; key: string | null }>;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		temp = TempDir.createSync("@mem0-backend-");
		requests = [];
		respond = () => Response.json({ results: [] });
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests.push({
					method: request.method,
					path: new URL(request.url).pathname,
					body: request.body ? ((await request.clone().json()) as Record<string, unknown>) : {},
					key: request.headers.get("X-API-Key"),
				});
				return respond(request);
			},
		});
		settings = Settings.isolated({
			"memory.backend": "mem0",
			"mem0.apiUrl": server.url.href,
			"mem0.apiKey": "test-credential",
		});
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await releaseMem0Session(session);
		server.stop(true);
		temp.removeSync();
	});

	function createState(existingText?: string) {
		const manager = SessionManager.inMemory(temp.path());
		if (existingText) manager.appendMessage({ role: "user", content: existingText, timestamp: 1 });
		const listeners = new Set<AgentSessionEventListener>();
		const session = {
			settings,
			sessionManager: manager,
			sessionId: manager.getSessionId(),
			emitNotice() {},
			async refreshBaseSystemPrompt() {},
			subscribe(listener: AgentSessionEventListener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		} as unknown as AgentSession;
		const state = new Mem0SessionState(session, loadMem0Config(settings, temp.path()));
		bindMem0SessionState(session, state);
		sessions.push(session);
		const tools = { settings, getMem0SessionState: () => getMem0SessionState(session) } as ToolSession;
		return { state, session, manager, listeners, tools };
	}

	it("accepts a retain call immediately after SDK startup without an initialization race", async () => {
		const auth = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		respond = () => Response.json({ results: [{ id: "startup-fact", event: "ADD" }] });
		try {
			const created = await createAgentSession({
				cwd: temp.path(),
				agentDir: temp.path(),
				authStorage: auth,
				modelRegistry: new ModelRegistry(auth, temp.join("models.yml"), { settings }),
				model: getBundledModel("openai", "gpt-4o-mini"),
				sessionManager: SessionManager.inMemory(temp.path()),
				settings,
				toolNames: ["retain", "recall"],
				disableExtensionDiscovery: true,
				contextFiles: [],
				skills: [],
				promptTemplates: [],
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				bindProcessState: false,
				skipPythonPreflight: true,
			});
			session = created.session;
			const result = await session.getToolByName("retain")!.execute("startup", {
				items: [{ content: "Use Bun for this project." }],
			});
			expect(result.details).toEqual({ count: 1 });
		} finally {
			await session?.dispose();
			auth.close();
		}
	});

	it("separates same-named projects and canonicalizes symlinks", () => {
		const left = temp.join("left/project");
		const right = temp.join("right/project");
		mkdirSync(left, { recursive: true });
		mkdirSync(right, { recursive: true });
		symlinkSync(left, temp.join("alias"));
		expect(loadMem0Config(settings, left).userId).not.toBe(loadMem0Config(settings, right).userId);
		expect(loadMem0Config(settings, left).userId).toBe(loadMem0Config(settings, temp.join("alias")).userId);
	});

	it("redacts secrets and reports extracted writes rather than input item count", async () => {
		const { state, tools } = createState();
		respond = () =>
			Response.json({
				results: [{ id: "fact-1", event: "ADD" }, { id: "fact-2", event: "UPDATE" }, { event: "NONE" }],
			});
		const token = "ghp_123456789012345678901234567890";
		const result = await new MemoryRetainTool(tools).execute("retain", {
			items: [{ content: `Use Bun. Credential ${token}`, context: token }],
		});
		expect(result.details?.count).toBe(2);
		expect(requests[0]!.body.user_id).toBe(state.config.userId);
		expect(JSON.stringify(requests[0]!.body)).not.toContain(token);
		expect(JSON.stringify(requests[0]!.body)).toContain("[REDACTED]");
		expect(requests[0]!.key).toBe("test-credential");
		respond = () => Response.json({ results: [] });
		const duplicate = await state.save({ content: "Use Bun." });
		expect(duplicate.stored).toBe(0);
	});

	it("rejects a global batch before any partial project write", async () => {
		const { tools } = createState();
		await expect(
			new MemoryRetainTool(tools).execute("retain", {
				items: [{ content: "project fact" }, { content: "global fact", scope: "global" }],
			}),
		).rejects.toThrow("project-scoped");
		expect(requests).toEqual([]);
	});

	it("searches across sessions but never across project scopes", async () => {
		const { state, tools } = createState();
		respond = () =>
			Response.json({ results: [{ id: "prior", memory: "Use Bun", user_id: state.config.userId, score: 0.8 }] });
		const result = await new MemoryRecallTool(tools).execute("recall", { query: "runtime?" });
		expect(result.content).toEqual([{ type: "text", text: '{"id":"prior","memory":"Use Bun"}' }]);
		expect(requests[0]!.body.filters).toEqual({ user_id: state.config.userId });
		expect(requests[0]!.body).not.toHaveProperty("run_id");
		respond = () =>
			Response.json({ results: [{ id: "other", memory: "Private fact", user_id: "different-project" }] });
		await expect(state.client.search("runtime?")).rejects.toThrow("outside the requested project scope");
	});

	it("does not turn authentication or malformed responses into empty recall", async () => {
		const { state } = createState();
		respond = () => new Response("private transcript and secret", { status: 401 });
		await expect(state.client.search("runtime?")).rejects.toThrow("HTTP 401");
		respond = () => Response.json({ unrelated: [] });
		await expect(state.client.search("runtime?")).rejects.toThrow("expected a results array");
	});

	it("propagates cancellation and enforces the recall deadline", async () => {
		const { state } = createState();
		const gate = Promise.withResolvers<Response>();
		respond = () => gate.promise;
		try {
			// Native fetch observes AbortSignal.timeout, not Bun fake timers; exercise its real deadline.
			const client = new Mem0Client({ ...state.config, recallTimeoutMs: 10 });
			await expect(client.search("runtime?")).rejects.toMatchObject({ name: "TimeoutError" });
			const abort = new AbortController();
			const pending = state.client.search("runtime?", 10, abort.signal);
			abort.abort(new Error("cancelled by caller"));
			await expect(pending).rejects.toThrow("cancelled by caller");
		} finally {
			gate.resolve(Response.json({ results: [] }));
		}
	});

	it("retains only new conversation text and serializes overlapping turn captures", async () => {
		const { state, manager } = createState("Historical content must not be uploaded");
		manager.appendCustomEntry("injected", { content: "Untrusted recalled memory" });
		manager.appendMessage({ role: "user", content: "Use PostgreSQL for this project.", timestamp: 2 });
		respond = () => Response.json({ results: [{ id: "db", event: "ADD" }] });
		await Promise.all([state.retain(), state.retain()]);
		expect(requests).toHaveLength(1);
		expect(requests[0]!.body.messages).toEqual([{ role: "user", content: "Use PostgreSQL for this project." }]);
		manager.appendMessage({ role: "user", content: "Use Redis for caching.", timestamp: 3 });
		await state.retain();
		expect(requests[1]!.body.messages).toEqual([{ role: "user", content: "Use Redis for caching." }]);
	});

	it("invalidates staged recall after reset and after a scoped clear", async () => {
		const { state, manager } = createState();
		respond = request =>
			request.method === "DELETE"
				? Response.json({ message: "Memory deleted successfully" })
				: Response.json({ results: [{ id: "old", memory: "Use SQLite" }] });
		const stale = await state.prepareRecall("database?");
		state.resetConversationTracking();
		expect(stale?.commit()).toBe(false);
		const fresh = await state.prepareRecall("database?");
		manager.appendMessage({ role: "user", content: "An obsolete transcript fact", timestamp: 1 });
		let clearedScope: string | null = null;
		respond = request => {
			clearedScope = new URL(request.url).searchParams.get("user_id");
			return Response.json({ message: "Memory deleted successfully" });
		};
		await state.clear();
		expect<string | null>(clearedScope).toBe(state.config.userId);
		expect(fresh?.commit()).toBe(false);
		await state.retain();
		expect(requests.filter(request => request.method === "POST" && request.path === "/memories")).toEqual([]);
	});

	it("flushes queued writes on release without closing the parent when an alias exits", async () => {
		const { state, session, listeners } = createState();
		state.attach();
		const child = { sessionId: "child" } as AgentSession;
		bindMem0SessionState(child, state);
		await releaseMem0Session(child);
		expect(state.closed).toBe(false);
		expect(listeners.size).toBe(1);
		respond = () => Response.json({ results: [{ id: "saved", event: "ADD" }] });
		const pending = state.save({ content: "Use Bun" });
		await releaseMem0Session(session);
		expect((await pending).ids).toEqual(["saved"]);
		expect(listeners.size).toBe(0);
		await expect(state.save({ content: "Too late" })).rejects.toThrow("closed");
	});

	it("rejects a prepared context after its backend owner is replaced", async () => {
		const { session } = createState();
		respond = () => Response.json({ results: [{ id: "old", memory: "Use SQLite" }] });
		const preparation = await mem0Backend.beforeAgentStartPrompt!(session, "database?");
		await releaseMem0Session(session);
		expect(preparation?.commit()).toBe(false);
	});

	it("bounds oversized recalled content without silently dropping the best hit", () => {
		const rendered = formatMem0Memories([{ id: "long", content: "Use Bun. ".repeat(1000) }], 256);
		expect(rendered.length).toBe(256);
		expect(rendered).toContain("Use Bun.");
		expect(rendered.endsWith("[truncated]")).toBe(true);
	});
});
