import { prompt } from "@oh-my-pi/pi-utils";
import { memoryToolRefs } from "../memory-backend/tool-names";
import type { MemoryBackend, MemoryBackendStatus } from "../memory-backend/types";
import type { AgentSession } from "../session/agent-session";
import mem0Instructions from "../prompts/system/mem0-instructions.md" with { type: "text" };
import { loadMem0Config } from "./client";
import { cfgMem0ApiUrl } from "./settings";
import { bindMem0SessionState, getMem0SessionState, Mem0SessionState, releaseMem0Session } from "./state";

function requireState(session: AgentSession | undefined): Mem0SessionState {
	const state = getMem0SessionState(session);
	if (!state)
		throw new Error("Mem0 backend is not initialised for this session. Check mem0.apiUrl and /memory diagnose.");
	return state;
}

async function status(session: AgentSession | undefined): Promise<MemoryBackendStatus> {
	const state = getMem0SessionState(session);
	if (!state)
		return {
			backend: "mem0",
			active: false,
			writable: false,
			searchable: false,
			error: "Mem0 is not initialised. Set mem0.apiUrl to a self-hosted Mem0 OSS REST server.",
		};
	try {
		await state.client.probe();
		return {
			backend: "mem0",
			active: true,
			writable: true,
			searchable: true,
			scope: state.config.userId,
			message: `Mem0 OSS connected; ${state.pendingWrites} pending writes. Project-scoped clear requires an admin API key.`,
			error: state.lastError,
		};
	} catch (error) {
		return {
			backend: "mem0",
			active: true,
			writable: false,
			searchable: false,
			scope: state.config.userId,
			error: error instanceof Error ? error.message : "Mem0 connectivity check failed.",
		};
	}
}

export const mem0Backend: MemoryBackend = {
	id: "mem0",
	async start({ session, settings, taskDepth, parentMem0SessionState }) {
		try {
			await releaseMem0Session(session);
			if (session.isDisposed) return;
			if (taskDepth > 0) {
				if (parentMem0SessionState) bindMem0SessionState(session, parentMem0SessionState);
				return;
			}
			const state = new Mem0SessionState(session, loadMem0Config(settings, session.sessionManager.getCwd()));
			bindMem0SessionState(session, state);
			state.attach();
		} catch (error) {
			session.emitNotice("warning", error instanceof Error ? error.message : "Mem0 initialisation failed.", "Mem0");
		}
	},
	async buildDeveloperInstructions(_agentDir, _cwd, settings, session) {
		if (!cfgMem0ApiUrl.get(settings)?.trim()) return undefined;
		return prompt.render(mem0Instructions, { toolRefs: memoryToolRefs(session?.getXdevToolEntries()) });
	},
	async beforeAgentStartPrompt(session, promptText, signal) {
		const state = getMem0SessionState(session);
		if (!state || state.session !== session) return undefined;
		try {
			// An empty or failed search must not reuse the previous turn's promoted memories.
			await session.refreshBaseSystemPrompt();
			const preparation = await state.prepareRecall(promptText, signal);
			if (!preparation) return undefined;
			return {
				context: preparation.context,
				commit: () => getMem0SessionState(session) === state && preparation.commit(),
			};
		} catch (error) {
			if (!signal?.aborted) state.reportFailure("Automatic recall", error);
			return undefined;
		}
	},
	async clear(_agentDir, _cwd, session) {
		await requireState(session).clear();
	},
	async enqueue(_agentDir, _cwd, session) {
		await requireState(session).retain();
	},
	async status({ session }) {
		return status(session);
	},
	async search({ session }, query, options) {
		const items = await requireState(session).client.search(query, options?.limit, options?.signal);
		return { backend: "mem0", query, count: items.length, items };
	},
	async save({ session }, input) {
		return requireState(session).save(input);
	},
	async stats(_agentDir, _cwd, session) {
		return JSON.stringify(await status(session), null, 2);
	},
	async diagnose(_agentDir, _cwd, session) {
		return JSON.stringify(await status(session), null, 2);
	},
	async queuePreview({ session }) {
		return `Mem0 pending writes: ${requireState(session).pendingWrites}. Writes are in-memory and best-effort, not a durable queue.`;
	},
};
