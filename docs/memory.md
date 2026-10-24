# Autonomous Memory

omp supports six memory modes. Memory is disabled by default; select one backend via `/settings` or `config.yml`:

| `memory.backend` | Storage and behavior                                                   | Guide                                                   |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `off`            | No memory backend                                                      | —                                                       |
| `local`          | Project-scoped summaries and lessons generated from persisted sessions | This page                                               |
| `hindsight`      | Remote, bank-scoped Hindsight memory                                   | [Hindsight](#hindsight-remote-backend)                  |
| `mem0`           | Self-hosted Mem0 OSS REST memory with project-scoped recall and retention | [Mem0](#mem0-oss-remote-backend) |
| `mnemopi`        | Local Mnemopi SQLite memory                                            | [Mnemopi memory backend](./mnemosyne-memory-backend.md) |
| `sharpshooter`   | Friction-gated project decision files (architecture/product/style), consolidated in the background | [Sharpshooter](#sharpshooter-backend) |

Enable the local summary pipeline:

```yaml
memory:
  backend: local
```

## Usage

### What gets injected

At session start, if a consolidated summary or manually captured lesson exists for the current project, it is injected into the system prompt as a **Memory Guidance** block. The summary and lessons share `memories.summaryInjectionTokenLimit`.

If startup consolidation finishes after the first prompt build, the active session's summary snapshot is refreshed. Captured lessons remain pinned to the initial snapshot, so a concurrent `learn` call still affects only later sessions.

- Treat memory as heuristic context — useful for process and prior decisions, not authoritative on current repo state.
- Cite the memory artifact path when memory changes the plan, and pair it with current-repo evidence before acting.
- Prefer repo state and user instruction when they conflict with memory; treat conflicting memory as stale.

### Reading memory artifacts

The agent can read memory files directly using `memory://` URLs with the `read` tool:

| URL                                    | Content                              |
| -------------------------------------- | ------------------------------------ |
| `memory://root`                        | Compact summary injected at startup  |
| `memory://root/MEMORY.md`              | Full long-term memory document       |
| `memory://root/learned.md`             | Lessons captured by the `learn` tool |
| `memory://root/skills/<name>/SKILL.md` | A generated skill playbook           |
| `memory://<memory-id>`                 | Full Mnemopi memory row (working or episodic) with a YAML frontmatter metadata header; only available when `memory.backend` is `mnemopi` |

The `memory://<memory-id>` form returns the full stored row rather than the clipped recall preview (recall content that exceeds the preview cap ends with a trailing `…`); agents are instructed to read it before any `memory_edit update`.

The `memory://root[/…]` rows are file-backed and only exist with `memory.backend: local`, which populates the on-disk memory root via the consolidation pipeline. Other backends do not resolve these URLs. Use their memory tools instead; `memory://<memory-id>` is available only with `mnemopi`.

### `/memory` slash command

| Subcommand            | Effect                                                    |
| --------------------- | --------------------------------------------------------- |
| `view`                | Show the current backend injection payload                |
| `stats`               | Show backend-specific memory statistics, when supported   |
| `diagnose`            | Show backend-specific diagnostics, when supported         |
| `queue`               | Show pending memory deltas awaiting consolidation         |
| `sync`                | Run memory consolidation now                              |
| `clear` / `reset`     | Delete active backend memory data/artifacts               |
| `enqueue` / `rebuild` | Force consolidation/retention work for the active backend |
| `mm …`                | Hindsight mental-model maintenance (`list`/`show`/`refresh`/`history`/`seed`/`delete`/`reload`); unsupported in ACP mode |

### Capturing lessons

Enable `autolearn.enabled` to make the `learn` tool available:

```yaml
autolearn:
  enabled: true
```

With the local backend active, `learn` saves explicit durable lessons to the project's `learned.md`. Lessons are newest-first, deduplicated, secret-redacted, capped at 100 entries, and injected starting with the next session; a `learn` call does not mutate the active session's prompt-cache prefix. Each lesson's content is capped at 2,000 characters and optional context at 400 characters. Structured memory search, `recall`, `retain`, `reflect`, and `memory_edit` are not available for the local backend.

## How it works

Local summary memories are built by a background pipeline that runs at startup; `/memory enqueue` marks consolidation work that the next startup picks up. The pipeline is skipped for subagents and for sessions that are not persisted to a session file.

**Phase 1 — per-session extraction:** For each past session that has changed since it was last processed, a model reads the session history and extracts durable signal: technical decisions, constraints, resolved failures, recurring workflows. Sessions that are too recent, too old, currently active, or beyond the configured scan/age limits are skipped. Each extraction produces a raw memory block and a short synopsis for that session.

**Phase 2 — consolidation:** After extraction, a second model pass reads all per-session extractions and produces three generated outputs written to disk:

- `MEMORY.md` — a curated long-term memory document
- `memory_summary.md` — the compact text injected at session start
- `skills/` — reusable procedural playbooks, each in its own subdirectory

The separately maintained `learned.md` is not overwritten by consolidation.

Phase 2 uses a lease and heartbeat to prevent double-running when multiple processes start simultaneously. Stale skill directories from prior runs are pruned automatically.

Consolidated output is redacted for common secret/token patterns before `MEMORY.md`, `memory_summary.md`, or generated skills are written to disk.

### Extraction behavior

Memory extraction and consolidation behavior is driven by static prompt files in `packages/coding-agent/src/prompts/memories/`.

| File                      | Purpose                                          | Variables                                   |
| ------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `stage_one_system.md`     | System prompt for per-session extraction         | —                                           |
| `stage_one_input.md`      | User-turn template wrapping session content      | `{{thread_id}}`, `{{response_items_json}}`  |
| `consolidation_system.md` | System prompt for cross-session consolidation    | —                                           |
| `consolidation.md`        | User-turn prompt for cross-session consolidation | `{{raw_memories}}`, `{{rollout_summaries}}` |
| `read-path.md`            | Memory guidance injected into live sessions      | `{{memory_summary}}`, `{{learned}}`         |

### Model selection

Memory piggybacks on the model role system.

| Phase                   | Role                                                                | Purpose                          |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Phase 1 (extraction)    | `default`                                                           | Per-session knowledge extraction |
| Phase 2 (consolidation) | `smol` (falls back to `default`, then current/first registry model) | Cross-session synthesis          |

If the requested memory role is not configured, memory model resolution falls back to the `default` role, then the active session model, then the first model in the registry.

## Configuration

| Setting                               | Default | Description                                                                                                                              |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                      | `off`   | Select `local` for this pipeline; legacy `memories.enabled: true` is migrated to `memory.backend: local` when no explicit backend is set |
| `memories.maxRolloutAgeDays`          | `30`    | Sessions older than this are not processed                                                                                               |
| `memories.minRolloutIdleHours`        | `12`    | Sessions active more recently than this are skipped                                                                                      |
| `memories.maxRolloutsPerStartup`      | `64`    | Cap on sessions processed in a single startup                                                                                            |
| `memories.threadScanLimit`            | `300`   | Maximum recent session records scanned at startup                                                                                        |
| `memories.maxRawMemoriesForGlobal`    | `200`   | Maximum per-session extractions supplied to global consolidation                                                                         |
| `memories.stage1Concurrency`          | `8`     | Concurrent per-session extraction jobs                                                                                                   |
| `memories.stage1LeaseSeconds`         | `120`   | Extraction job lease duration                                                                                                            |
| `memories.stage1RetryDelaySeconds`    | `120`   | Delay before a failed extraction becomes claimable again                                                                                 |
| `memories.phase2LeaseSeconds`         | `180`   | Consolidation lease duration                                                                                                             |
| `memories.phase2RetryDelaySeconds`    | `180`   | Delay before failed consolidation is retried                                                                                             |
| `memories.phase2HeartbeatSeconds`     | `30`    | Consolidation lease heartbeat interval                                                                                                   |
| `memories.rolloutPayloadPercent`      | `0.7`   | Fraction of the selected model's context budget available to rollout payloads                                                            |
| `memories.phase1InputTokenLimit`      | `4000`  | Per-session extraction input cap                                                                                                         |
| `memories.fallbackTokenLimit`         | `16000` | Model token budget used when the model has no finite declared context window                                                             |
| `memories.summaryInjectionTokenLimit` | `5000`  | Shared approximate token cap for the summary and captured lessons injected into the system prompt                                        |

## Hindsight remote backend

Hindsight requires a reachable [Hindsight](https://hindsight.vectorize.io/) server. The default endpoint is `http://localhost:8888`; set a token when the server requires authentication:

```yaml
memory:
  backend: hindsight
hindsight:
  apiUrl: http://localhost:8888
  apiToken: ${HINDSIGHT_API_TOKEN}
```

`HINDSIGHT_*` environment variables override `hindsight.*` settings, which override built-in defaults. See the [complete Hindsight environment-variable table](./environment-variables.md#hindsight-memory-backend) for all 18 supported overrides, accepted values, parsing rules, precedence, and defaults.

By default, Hindsight uses `per-project-tagged` scoping: writes go to a shared bank with a project tag, while recall includes project-tagged and untagged global memories. `per-project` isolates each working-directory project in its own bank; `global` uses one shared bank. An explicit `hindsight.bankId` selects the bank base. Changes to the bank ID, prefix, or scoping rebuild the primary session state so later operations use the new scope.

Both project-scoped modes name the project the same way: take the repository's primary checkout root (so every linked worktree of one repository resolves to the same directory), then lowercase its basename. A checkout at `~/code/General` therefore tags `project:general`. Tags are matched literally, so this fold is what keeps one repository in one memory scope no matter how the path is capitalised.

The primary session recalls on its first model turn (`hindsight.autoRecall: true`) and automatically retains completed conversation turns every three user turns by default. `/memory enqueue` flushes queued tool retains and forces retention of the current session. At agent end, the primary state schedules cadence-based retention and flushes the retain queue; session disposal drains that queue before releasing the state. Request failures and configured timeouts are logged and leave the coding session usable. Subagents alias the parent's client, bank, and scope for explicit `recall`, `retain`, and `reflect` calls, but do not run their own automatic recall or retention.

Recall is injected as background context, not instructions, and recalled memory is also available as extra context during compaction. The first-turn recall is stored in the session file, so resuming, switching to, or forking the session sends it unchanged instead of recalling again; a context reset, a different bank or tag filter, or a branch that edits the first prompt recalls afresh. Hindsight memories cannot be looked up by id, so changes to them since the recall are not reported. Mental models are still reloaded when a new process starts. Selecting Hindsight exposes `recall`, `retain`, and `reflect`; `memory_edit` is not available because upstream Hindsight memories are not edited through this backend.

`/memory view`, `/memory stats`, `/memory diagnose`, and `/memory enqueue` operate through the active Hindsight state. `/memory clear` first drains pending retains, then clears only the local session state and recall cache. It **does not delete the server-side bank**; delete that bank with the Hindsight UI or API.

## Mem0 OSS remote backend

This native backend connects directly to the [self-hosted Mem0 OSS REST server](https://github.com/mem0ai/mem0/tree/v2.2.1/server), tested against `mem0ai==2.2.1`. It does not use MCP, embed the Python engine, or support the separate Mem0 Platform API. Configure extraction, embeddings, and storage on the server; omp's model roles do not configure the Mem0 server.

Mem0 uses the same native settings registry and persistent `config.yml` as Hindsight. A separate Mem0 configuration file is not required.

After configuring the server, add the following blocks to `~/.omp/agent/config.yml` (or the active profile's configuration file), or configure them through `/settings` → Memory:

```yaml
memory:
  backend: mem0
mem0:
  apiUrl: http://127.0.0.1:8889
  userId: my-omp
  autoRecall: true
  autoRetain: true
```

The URL must match your actual server. The upstream Compose default is port `8888`, which also defaults to Hindsight's port; use a different published port if running both. Store the server credential in `mem0.apiKey` through the settings panel, or set `MEM0_API_KEY` to override the file value; requests use `X-API-Key`. Use HTTPS when connecting beyond loopback. Selecting Mem0 does not migrate or delete another backend's memories.

A Mem0-capable build also supports `omp config get` and `omp config set` for all `mem0.*` settings. These use the normal configuration file; `hindsight` and `mem0` sections can coexist, while `memory.backend` selects the active backend. The settings panel and `omp config list` mask API keys; an explicit `omp config get mem0.apiKey` reveals the value, so do not paste its output into logs or chat.

To run a source checkout without replacing your installed `omp`, follow the repository's build prerequisites, run `bun install --frozen-lockfile` and `bun run build:native`, then launch `bun packages/coding-agent/src/cli.ts`. It reads the normal configuration. Avoid `bun run setup` if you do not want its global-link step.

For an isolated trial, append `--config /path/to/mem0.yml`. This is a generic, process-local configuration overlay, not a Mem0-specific loader. If the installed `omp` does not support Mem0, keep the trial in an overlay rather than selecting Mem0 in its shared global configuration. Once using a Mem0-capable build for normal work, merge the tested values into the normal configuration, preserving the existing `autoRecall`, `autoRetain`, and `userId` values. Remove `--config` from the launch command afterward: overlay values take precedence over the main file and would otherwise override later settings-panel or CLI edits.

### Scope and lifecycle

- The Mem0 `user_id` is `<mem0.userId>:<SHA-256 of canonical project path>`. The primary repository root is used when available; linked worktrees share it. Outside a repository, the canonical cwd is used. Same-named projects at different paths remain separate. Moving a checkout to a new path changes its scope.
- A namespace and canonical path identify the same memory across sessions and omp profiles. Set a unique `mem0.userId` on a shared server. Scope filters are not server-side tenant authorization; protect access to the server and its credentials.
- Automatic recall searches before each user prompt. Context is character-bounded and treated as untrusted background data. An empty or failed search removes the previous turn's recalled context; cancellation or an owner change prevents a staged result from being committed.
- Automatic retention sends new user/assistant text after each completed primary turn with `infer: true`. Existing transcript entries are the starting cursor, not a backfill source. Tool results, thinking, and injected custom messages are excluded. Common credential-shaped tokens are redacted, but this is not a guarantee that arbitrary confidential text is safe to upload; disable `mem0.autoRetain` where appropriate.
- Writes are serialized and in-memory. Disposal drains already queued writes; network requests have configured deadlines. Failures are surfaced without stopping the main agent. This is not a durable delivery queue: unacknowledged writes are not replayed after restart. `/memory sync` retries outstanding transcript content in the current live state; use explicit `retain` to recover older unsaved facts.
- Subagents share the parent's scope for explicit tools, without automatic recall or transcript retention. Closing an alias does not close the parent. Restricted sessions keep the existing SDK policy that disables memory initialization.

### Tools and maintenance

`retain` waits for Mem0 and reports the server's actual ADD/UPDATE count, including zero when extraction deduplicates everything; DELETE events are reported separately. `recall` performs scoped semantic search. The extension memory runtime also exposes `save`, `search`, and `status`.

`/memory stats` and `/memory diagnose` probe authenticated connectivity and report scope, pending writes, and the last write error. They do not claim a total memory count from a limited listing. `/memory queue` shows pending write count; `/memory sync` and `/memory enqueue` retain new transcript content.

**`/memory clear` deletes all remote memories in the current project scope**, after pending writes finish. The OSS server requires an admin API key for this operation. It never calls `/reset` or an unscoped delete, and a failure is reported rather than displayed as successful clearing. The current transcript is not automatically re-uploaded after a successful clear.

There is no native `reflect`, `memory_edit`, `learn`, `memory://` lookup, or global-scope write in this backend. Use the Mem0 server UI/API for individual edits or deletion. No local or cloud fallback runs when the configured service is unavailable.

### Manual verification

Use an isolated test project and disable `mem0.autoRecall` and `mem0.autoRetain` before testing explicit tools:

1. Run `/memory diagnose` and check the backend, connectivity, and project scope.
2. Use `retain` to store a fresh synthetic marker and confirm an actual server-side addition or update.
3. Restart with `--no-session` in the same project directory, then use `recall` to ask for the marker without including its value in the query.
4. Inspect the tool result, not just the assistant's final answer. A nonempty result includes a count header and quoted memory records; the tool card reports `N found`, and expanding it reveals the records.
5. Clear only the isolated test scope with `/memory clear`, then confirm that another explicit recall returns no matches.

A correct assistant answer alone does not prove successful recall. Restart source-launched sessions after updating the checkout so new tool calls use the updated implementation.

### Settings

| Setting | Default | Behavior |
| --- | --- | --- |
| `mem0.apiUrl` | unset | OSS server base URL; required to initialize |
| `mem0.apiKey` | unset | Credential sent as `X-API-Key` |
| `mem0.userId` | `omp` | Non-empty namespace, combined with the project path hash |
| `mem0.autoRecall` | `true` | Recall before each primary user prompt |
| `mem0.autoRetain` | `true` | Retain new primary conversation text at completed turns |
| `mem0.recallLimit` | `10` | Requested `top_k`, clamped to 1–100 |
| `mem0.recallMaxChars` | `6000` | Maximum rendered recall characters, minimum 256 |
| `mem0.recallTimeoutMs` | `5000` | Search and connectivity deadline, minimum 1 ms |
| `mem0.retainTimeoutMs` | `60000` | Write and clear deadline, minimum 1 ms |

`MEM0_API_URL`, `MEM0_API_KEY`, and `MEM0_USER_ID` override their corresponding settings. Live `mem0.*` changes rebind the active backend and drain outgoing queued writes without backfilling the transcript into the new scope.

## Sharpshooter backend

Sharpshooter keeps three short project decision files — `architecture.md`, `product.md`, and `style.md` — and injects them into the system prompt. It needs no server; files live under `<agentDir>/memories/sharpshooter/<bank>/`, where the bank is derived from the working directory, so each project has its own decisions.

```yaml
memory:
  backend: sharpshooter
sharpshooter:
  minPromptLength: 4
  intervalMinutes: 5
```

**Extraction:** each user prompt in the main session (subagents are skipped) goes to the extraction model, which records durable decisions the user made — architecture, product, and style decisions, constraints, rejected approaches, and corrections — as deltas in a per-session queue. Slash commands and prompts shorter than `sharpshooter.minPromptLength` characters are not sent; a session runs one extraction at a time, and a prompt that arrives while one is running is not extracted. Short replies such as "opt 2" are resolved against the preceding assistant message, but at the default of 16 characters they are too short to be sent — lower `sharpshooter.minPromptLength` to capture them.

**Consolidation:** a scheduler checks every minute and, once `sharpshooter.intervalMinutes` have passed since the last run, applies the queued deltas to the three files in one model pass and removes them from the queue. `/memory enqueue` consolidates immediately; `/memory queue` lists pending deltas and `/memory clear` deletes the project's files and queue.

| Setting                            | Default    | Description                                                                                                                                                                                                                 |
| ---------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                   | `off`      | Set to `sharpshooter` to enable this backend                                                                                                                                                                                |
| `sharpshooter.model`               | unset      | Model selector for extraction and consolidation; unset uses the `smol` role                                                                                                                                                 |
| `sharpshooter.minPromptLength`     | `16`       | Prompts shorter than this many characters are not sent for extraction; values below `2` act as `2`. Characters are counted as displayed (one CJK character or emoji is one), the same in every language, so Chinese users may lower it to capture short replies such as "用方案二" |
| `sharpshooter.intervalMinutes`     | `5`        | Minimum minutes between consolidation runs                                                                                                                                                                                  |
| `sharpshooter.injectionTokenLimit` | `15000`    | Approximate token cap for the decision files injected into the system prompt                                                                                                                                                |

## Key files

- `packages/coding-agent/src/memories/index.ts` — pipeline orchestration, injection, clear/enqueue entry points (the `/memory` command routes here via `packages/coding-agent/src/memory-backend/local-backend.ts`)
- `packages/coding-agent/src/memories/storage.ts` — SQLite-backed job queue and thread registry
- `packages/coding-agent/src/prompts/memories/` — memory prompt templates
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL handler
