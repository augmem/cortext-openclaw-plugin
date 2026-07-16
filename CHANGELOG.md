# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-07-16

### Changed

- **Consolidation is compact-time only again** — reverts 0.2.2's
  ingest-time consolidation on the engine's `consolidation_state: "required"`
  hint. Rationale: measured retrieval is identical with and without
  hint-driven consolidation (same needle hits and ranks across
  no-consolidation, required-only, and recommended+required policy stores),
  so ingest-time consolidation bought no recall — and the throughput envelope
  behind the hint is being reworked upstream (it catches rate excursions but
  adapts around slow drift). Compact-time `autoConsolidate` is the safe,
  sufficient cadence until the engine signal settles.

## [0.2.2] - 2026-07-16

### Added

- **Honor the engine's throughput-derived consolidation hint.**
  `@augmem/cortext` 1.2.2 replaced the time/count consolidation flags with
  `consolidation_state: "none" | "recommended" | "required"`, computed from
  each store's write-rate envelope (rate degraded toward the observed floor →
  escalate; a consolidation acknowledges and re-arms). On `"required"` the
  plugin now consolidates immediately after that ingest (gated by
  `autoConsolidate`, measured 0.1–1.0s per pass); `"recommended"` is left to
  the existing compact-time consolidation. Keeps per-write cost on the flat
  part of the curve in long-lived sessions that never hit compaction.

## [0.2.1] - 2026-07-16

### Changed

- **`@augmem/cortext` 1.2.2.** Brings the engine's durable-ingestion scaling fix
  (flat per-write cost — verified independently: 900 real messages in flat
  ~3–8s/100 batches vs a 4.9s→85s runaway on 1.2.0) and reworked long-term
  retrieval ranking (verified on an identical 1,915-memory store built from a
  real ~345k-token agent transcript: needle-recall probes went 1/7 → 3/7 on the
  engine swap alone).
- **Working memory now rides along in `hybrid` mode after compaction** (it
  always did in `full` mode). The 1.2.2 ranking scales retrieval top-k down on
  small stores, so a fact archived moments ago could fall outside
  query-relevant recall right after an early-session compaction; the live
  working-memory snapshot (returned by the same recall call, no extra query)
  still spans it. Injected items already carried verbatim by the kept tail are
  deduplicated out (`dedupeAgainstWindow`), so long sessions don't pay for
  duplicates. Caught by the existing archived-fact-recall unit test.

### Fixed

- Compaction unit-test fixture padded every message with the same repeated
  sentence, making all embeddings near-identical — a degenerate corpus, not a
  realistic one. Each message now carries distinct realistic padding; the
  recall assertion is unchanged.

## [0.2.0] - 2026-07-13

### Added

- **Cortext owns compaction — no summarizer LLM call.** `ownsCompaction: true`:
  on `compact` the engine picks an exchange-aligned cut in the transcript view
  and anchors it; every `assemble` drops the archived prefix from the model
  context and bridges it with recalled memory. The on-disk transcript is never
  mutated; archived content remains recallable per turn. Two modes
  (`compactionMode`): `hybrid` (default — system prompt + long-term recall + a
  verbatim `protectTail` tail walked back to a user-message boundary) and
  `full` (system prompt + long-term recall + the live working-memory snapshot;
  verbatim window shrinks to the current exchange).
- Cold-start support: preflight compaction on a fresh gateway process (before
  any assemble) reads the transcript file directly to pick its cut.
- The cut anchor is content-based and persisted (`compaction.json` sidecar):
  it survives gateway restarts, and self-heals by clearing if the host rotates
  or rewrites the transcript — the window never over-drops.

### Verified

- Live gateway with budget pressure: compaction archived 16 messages with no
  LLM call (~453 → ~107 estimated tokens), the following turn succeeded with
  the windowed context, and a fact present *only* behind the window (never
  restated in the kept tail) was answered correctly from memory injection.

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
