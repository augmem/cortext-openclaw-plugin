# Cortext for OpenClaw

Durable local memory for [OpenClaw](https://openclaw.ai), built on the native
[`@augmem/cortext`](https://github.com/augmem/cortext) engine. It plugs into two
OpenClaw surfaces (verified against the installed `openclaw` package's types, not
docs):

1. **Context engine** (`api.registerContextEngine`) — Cortext owns the exclusive
   `plugins.slots.contextEngine` slot. It writes each message to memory on
   `ingest`, and prepends recalled long-term memory to the system prompt on
   `assemble`. Memory is **isolated per conversation** by default (see
   [Isolation](#isolation)).
2. **Streaming gate** (`api.agent.events.registerAgentEventSubscription`) —
   subscribes to the agent event stream and feeds `thinking` (reasoning) and
   `assistant` deltas through Cortext's interrupt gate as they stream. When
   Cortext reports `should_interrupt` / `at_boundary`, the recalled memory is
   staged (keyed by the session's scope) for the next assembly, and — via
   `api.on("before_agent_finalize")` — a **revise of the current answer** is
   requested (see the limits note below).

## Isolation

Cortext keeps one SQLite store **per isolation scope** — source ids are metadata
within a store, so distinct scopes are distinct databases (staged gate memory is
keyed by the same scope, so it can't cross the boundary either). `memoryScope`:

- **`session`** (default) — one store per conversation. Safe when an agent serves
  multiple people (a shared channel bot): memory never crosses conversations.
  Verified live: a fresh session cannot recall a prior session's fact.
- **`agent`** — one store per agent identity; memory persists across that agent's
  sessions. Use only for **single-user** agents — it shares memory across every
  conversation the agent handles. Verified live: agent `bob` cannot see agent
  `main`'s memory (isolation is across agents, not sessions).
- **`global`** — a single shared store.

Session keys always fold into the scope key (sessionId alone is not unique across
agents), and an absent/non-canonical agent normalizes to `main` like OpenClaw.

## Requirements

- Node.js ≥ 18.
- `@augmem/cortext` with a native prebuild for your platform — installed as a
  dependency. **On first use Cortext downloads its local model assets once**
  (one network fetch); after that, memory runs fully offline with no per-turn
  network and no LLM calls.
- OpenClaw with the context-engine slot (`plugins.slots.contextEngine`).

## Install

```bash
openclaw plugins install @augmem/cortext-openclaw-plugin
```

```jsonc
// openclaw.json
{
  "plugins": {
    "slots": { "contextEngine": "cortext" },
    "entries": {
      "cortext": {
        "config": { "memoryScope": "session", "focus": 0.45 },
        // Only needed for the interrupt re-pass (forceRepass). OpenClaw blocks
        // the before_agent_finalize hook for non-bundled plugins without it.
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

If no engine is selected, OpenClaw runs its built-in `legacy` engine and this
plugin is not used.

## Configuration

Under `plugins.entries.cortext.config`:

| Key | Default | Meaning |
|-----|---------|---------|
| `dbPath` | `cortext` | Directory (under the agent dir) for Cortext stores |
| `memoryScope` | `session` | Isolation boundary: `session` / `agent` / `global` |
| `focus` | `0.45` | F knob: retrieval breadth vs precision |
| `sensitivity` | `0.5` | S knob: affective relaxation of the gate |
| `stability` | `0.5` | T knob: gate refractory + boundary pacing |
| `recallLimit` | `12` | max memories injected per assembly |
| `interruptGate` | `true` | run the streaming gate |
| `ingestReasoning` | `true` | feed `thinking` deltas, not just answer text |
| `forceRepass` | `true` | request a revise on interrupt (see limits — may be a no-op) |
| `autoConsolidate` | `true` | consolidate on compaction |
| `compactionMode` | `hybrid` | `hybrid`: system + recall + verbatim tail; `full`: system + recall + working memory only |
| `protectTail` | `6` | hybrid: trailing messages kept verbatim (exchange-aligned) |

## Design and limits

- **Recalled memory is untrusted input.** A prior turn could have ingested a
  prompt-injection payload. Before injection, recalled text is stripped of
  data-fence breakouts and fake system markers, and wrapped in a block that
  explicitly labels it as reference data, not instructions. This is a mitigation,
  not a guarantee.
- **No cross-turn recall cache.** Recall queries Cortext live every assembly, so
  a correction ingested this turn is reflected immediately (an earlier caching
  bug returned stale facts).
- **Compaction is a window, not surgery.** Cortext owns compaction
  (`ownsCompaction: true`) and never calls a summarizer LLM: every message is
  already in the durable store, so `compact` picks an exchange-aligned cut,
  and each `assemble` drops the archived prefix from the model context and
  bridges it with recalled memory. The on-disk transcript is never mutated —
  nothing is destroyed, and archived content comes back through query-relevant
  recall each turn (fresher than a frozen summary). The cut anchor is
  content-based and self-healing: if the host rotates the transcript, the
  window clears rather than over-dropping. Two modes (`compactionMode`):
  - **`hybrid`** (default): keep system prompt + long-term recall + a verbatim
    tail of the last `protectTail` messages, walked back to a user-message
    boundary so the tail is a self-contained exchange.
  - **`full`**: keep system prompt + Cortext memory only; the verbatim window
    shrinks to the current exchange. Maximum savings — memory IS the context.

  After compaction, both modes also inject the live working-memory snapshot
  (it arrives with the same recall call — no extra query), deduplicated
  against anything the kept tail already carries verbatim. This covers the
  early-session gap where a just-archived fact is not yet surfaced by
  query-relevant recall.

  Verified live (gateway + budget-pressure compaction): 16 messages archived
  with no LLM call, and a fact that existed *only* behind the window was
  answered correctly from memory injection on the next turn. Reproduce with
  `npm run test:integration:compaction` — the script seeds a needle the model
  never repeats, forces budget compaction, asserts from the transcript that
  the needle is only in the archived prefix, then probes recall.

  Measured against the alternative (offline replay of a real ~345k-token,
  ~1,900-message Claude Code transcript; LLM-judged QA on archived-only
  content; see `bench/replay-judged.mjs`): a real summarizer running
  OpenClaw's own structured-summary compaction contract compressed 345k
  tokens into a ~910-token summary at 14 LLM calls per compaction and scored
  **0/30** on archived-detail questions. Cortext compaction used **0** LLM
  calls, and every archived-detail point scored in any arm came from Cortext
  memory injection. Recall of fine-grained archived detail is a work in
  progress (needle-probe hit rate on that transcript: 3/7 on
  `@augmem/cortext` 1.2.2, up from 1/7 on 1.2.1) — but the alternative is a
  summary that retains none of it.
- **The gate cannot splice into a live decode**, but it requests a re-pass.
  The agent event stream is one-way (observe only). On `should_interrupt` the
  plugin (a) stages the recalled memory for the next assembly and (b) via
  `api.on("before_agent_finalize")` returns `{ action: "revise" }` so the harness
  reconsiders the *current* answer. Requires
  `plugins.entries.cortext.hooks.allowConversationAccess: true` (OpenClaw blocks
  the hook otherwise). **Verified against a running gateway** (`openclaw gateway
  run` + a routed turn, `bench/integration-gateway.mjs`): the automated test
  asserts the hook fires; a returned `revise` triggering a second model pass was
  additionally verified in a live manual gateway session (the interrupt that
  requests a revise is not deterministic per turn). It does **not** fire in the
  `openclaw agent --local` embedded runner — only the full gateway path. It is a
  no-op when it doesn't apply; disable with `forceRepass: false`.

## Validated live

Run in a real OpenClaw gateway (`openclaw agent --local`, `gpt-5.4-mini`) — see
[`bench/integration.mjs`](bench/integration.mjs), a scripted integration test
against the actual `openclaw` binary:

- The plugin loads and the gate registers with **no error** (an earlier build
  called a non-existent `api.runtime.events.onAgentEvent` and crashed).
- **Default session scope isolates conversations**: a fresh session answers "I
  don't know" for a fact stored in another session; the same session recalls it.
- **Cross-agent isolation**: agent `bob` cannot see agent `main`'s memory, while
  `main` itself still recalls the fact (positive control in the same run; the
  needle is a nonsense token the model cannot guess from priors).
- **No stale recall** — after correcting a fact, a fresh query returns the new
  value.

```bash
cd bench && OPENAI_API_KEY=sk-... node integration.mjs   # real gateway, ~6 turns
```

See [bench/](bench/) for cold-start recall and LongMemEval comparison harnesses.

## Develop

```bash
npm install
npm run build       # tsc → dist/
npm run typecheck
npm test            # build + unit tests (native engine; fast, offline)
```

`npm test` uses a test double that mirrors the **real** injected api surface, so
an unsupported call fails tests. For end-to-end coverage against the actual
gateway (the thing a double can't prove), run `bench/integration.mjs`.
`src/openclaw.d.ts` is transcribed from the **installed** `openclaw` package's
types.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
