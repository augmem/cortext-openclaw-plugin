# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-07-13

### Added

- **Tool calls are now ingested.** OpenClaw stores a tool call as a
  `{type: "toolCall", name, arguments}` content part with no `text` field, so
  it previously extracted to empty and was skipped — the durable record kept
  what a tool *returned* but not what the agent *did*. Calls are now rendered
  as `[tool call] <name> <args>` (arguments bounded at 2k chars) and stored
  durably alongside their results. Verified live: the call text appears in the
  session store after a real `exec` turn.

## [0.1.1] - 2026-07-13

### Changed

- Removed the per-message `flush()` after durable ingest. Durable `processText`
  commits on its own — the write is immediately visible to recall, even from a
  fresh handle on the same database (verified empirically against
  `@augmem/cortext` 1.2.0; the earlier "flush required for recall visibility"
  note was wrong). `flush()` remains at deliberate checkpoints: `compact()`,
  LRU eviction, and `dispose()`.

## [0.1.0] - 2026-07-13

Initial release. Cortext memory for OpenClaw.

### Added

- **Context engine** for the `plugins.slots.contextEngine` slot: durable write on
  `ingest`, recalled-memory injection on `assemble`, and graph consolidation on
  `compact`. Built on the native `@augmem/cortext` engine (local SQLite).
- **Per-scope isolation** (`memoryScope`, default `session`): one SQLite store per
  isolation scope, enforced by separate databases. `session` is safe when an
  agent serves multiple users; `agent` and `global` are opt-in. Scope keys fold
  in the full session key and normalize an absent agent to `main` like OpenClaw.
- **Streaming interrupt gate** (`api.agent.events.registerAgentEventSubscription`):
  feeds `thinking` and `assistant` deltas through Cortext's gate; on
  `should_interrupt`/`at_boundary` stages recalled memory (keyed by scope) for the
  next assembly.
- **Interrupt re-pass** via `api.on("before_agent_finalize")` returning
  `{ action: "revise" }` — reconsiders the current answer when the gate
  interrupts. Requires `hooks.allowConversationAccess: true`; fires only in the
  full gateway path, not `--local`. Gated by `forceRepass`.
- **Prompt-injection mitigation**: recalled text is stripped of data-fence
  breakouts and framed as reference data, not instructions.
- **Benchmarks** (`bench/`): a needle-in-a-haystack recall comparison against
  OpenClaw's built-in memory and mem0, a LongMemEval harness, and a cheaper
  curated LongMemEval subset (`membench.mjs`) with majority-vote judging.

### Verified

- **Unit tests** (36) run against a test double that mirrors the real injected
  api surface, so an unsupported call fails tests.
- **Real gateway integration** (`bench/integration.mjs`, `integration-gateway.mjs`)
  drives the actual `openclaw` binary: the plugin loads without crashing, session
  scope isolates conversations (separate stores), a different agent cannot see
  another's memory, the streaming gate receives events without erroring, and the
  before_agent_finalize hook fires through a live `openclaw gateway run` daemon.
  (A returned `revise` triggering a second model pass was verified in a live
  manual gateway session; the automated test asserts the hook fires — the
  interrupt that requests a revise is not deterministic per turn.)

### Notes

- Cortext downloads its local model assets once on first use; after that, memory
  runs offline with no per-turn network and no LLM calls.
- Requires `openclaw.extensions` in `package.json` for `openclaw plugins install`
  to recognize the entry.
