import { register } from "../config/registry";

export const cfgMem0ApiUrl = register({
	id: "mem0.apiUrl",
	env: "MEM0_API_URL",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mem0",
		label: "Mem0 API URL",
		description: "Self-hosted Mem0 OSS REST server URL (not the Mem0 Platform API)",
		condition: "mem0Active",
	},
});

export const cfgMem0ApiKey = register({
	id: "mem0.apiKey",
	env: "MEM0_API_KEY",
	type: "string",
	credential: true,
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mem0",
		label: "Mem0 API Key",
		description: "X-API-Key credential for the self-hosted server",
		condition: "mem0Active",
	},
});

export const cfgMem0UserId = register({
	id: "mem0.userId",
	env: "MEM0_USER_ID",
	type: "string",
	default: "omp",
	ui: {
		tab: "memory",
		group: "Mem0",
		label: "Mem0 User Namespace",
		description: "Namespace prefixed to the canonical project path hash; use a unique value on shared servers",
		condition: "mem0Active",
	},
});

export const cfgMem0AutoRecall = register({
	id: "mem0.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mem0",
		label: "Mem0 Auto Recall",
		description: "Search project memories before each user prompt",
		condition: "mem0Active",
	},
});

export const cfgMem0AutoRetain = register({
	id: "mem0.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mem0",
		label: "Mem0 Auto Retain",
		description:
			"Send new user/assistant text to Mem0 after each completed turn; never backfill existing transcripts",
		condition: "mem0Active",
	},
});

export const cfgMem0RecallLimit = register({ id: "mem0.recallLimit", type: "number", default: 10 });
export const cfgMem0RecallMaxChars = register({ id: "mem0.recallMaxChars", type: "number", default: 6000 });
export const cfgMem0RecallTimeoutMs = register({ id: "mem0.recallTimeoutMs", type: "number", default: 5000 });
export const cfgMem0RetainTimeoutMs = register({ id: "mem0.retainTimeoutMs", type: "number", default: 60000 });
