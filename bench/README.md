# Cortext-for-OpenClaw live benchmark

> This is the quick needle-in-a-haystack recall check. For a real,
> non-saturating capability benchmark, use
> **[membench](README-membench.md)** (recommended: cheap curated subset,
> cheap-model ingestion, majority-vote judging, cross-rep variance) or the
> straight **[LongMemEval harness](README-longmemeval.md)**.


Head-to-head cold-start recall comparison, run **live inside a real OpenClaw
gateway** (`openclaw agent --local`, embedded runner, OpenAI `gpt-5.4-mini`),
mirroring the Cortext-for-Hermes method: each arm runs in its **own isolated
profile** (`~/.openclaw-<profile>`, wiped before the run), facts are stored in
one session, and every probe runs in a **fresh session** so recall must come
from durable memory — never chat history.

## Isolating the two memory slots

OpenClaw exposes **two independent exclusive slots** that both affect recall:

- `contextEngine` — assembles and injects context (default `legacy`; **cortext**
  installs here).
- `memory` — an auto-recall/capture memory plugin (default `memory-core`;
  **mem0** installs here).

The default `memory-core` plugin is active unless disabled, so an early run that
only set `contextEngine` credited recall to the wrong system (the built-in
`memory-core` was silently recalling in every arm). **Every arm below pins BOTH
slots explicitly**, and the `control` arm pins both to the no-memory baseline —
so a correct probe in any other arm is attributable to that arm's named system.

## Result (2026-07-12, OpenClaw 2026.6.11, gpt-5.4-mini)

Scenario: 7 stored facts (one supersession pair), 6 cold-start probes.

| Arm | contextEngine | memory | Cold-start recall | Stale leaks | Locality |
| --- | --- | --- | ---: | ---: | --- |
| **cortext** (this plugin) | cortext | none | **6/6** | **0** | **local** |
| mem0 | legacy | openclaw-mem0 | 6/6 | 0 | **cloud** |
| memory-core (OpenClaw built-in) | legacy | memory-core | 5/6 | 0 | local |
| control | legacy | none | 0/6 | 0 | — |

**The `control` at 0/6 validates the method**: the base engine with no memory
plugin recalls nothing across sessions ("I can't see that from here"). So the
recall in every other arm is real, attributable memory.

**Cortext ties the cloud leader while staying fully local.** It matches mem0's
6/6 (including the supersession probe — the moved appointment returned the new
day with no stale leak) with **zero network, no API key, and no LLM calls for
memory**, and it edges OpenClaw's own built-in `memory-core` (5/6; memory-core
missed the superseded appointment entirely).

Per-probe transcripts are in [compare-results.json](compare-results.json).

## Dimensions beyond recall

Recall alone hides the real trade-off. On this scenario cortext and mem0 tie on
recall, but they are not equivalent:

| | cortext | mem0 | memory-core |
| --- | --- | --- | --- |
| Runs | in-process, local SQLite | mem0 cloud (`api.mem0.ai`) | in-process, local |
| Requires | nothing | `MEM0_API_KEY`, network | nothing |
| Data leaves machine | no | **yes** (conversation → cloud) | no |
| Works offline | yes | no | yes |
| Recall latency | local read | network round-trip + async settle | local read |
| Memory extraction | none (engine is online) | server-side LLM per exchange | local |

mem0 needed a 15 s settle delay before probes because extraction is asynchronous
server-side; cortext and memory-core are synchronous local reads.

## Method

- **Isolation.** Each arm gets a dedicated `--profile`, its state dir wiped
  before the run, and **both** slots pinned (`plugins.slots.contextEngine` and
  `plugins.slots.memory`).
- **Cold start.** All facts stored in one session; each probe asked in a
  brand-new session id, so a correct answer can only come from durable memory.
- **Unique cloud identity.** The mem0 arm uses a per-run `userId` so a prior
  run's cloud memories can't leak in.
- **Neutral facts.** No secrets (passwords/keys) that trip model-safety refusals.
- **Recall / stale.** A probe is recalled when the reply matches every expected
  pattern; a stale leak is a superseded fact resurfacing.

## Reproduce

```bash
cd bench
npm install openclaw@latest @augmem/cortext@latest
export OPENAI_API_KEY=sk-...
export MEM0_API_KEY=m0-...        # only needed for the mem0 arm
node run-compare.mjs             # all arms; ~10 min
node run-compare.mjs cortext control   # subset by arm name
```

Outputs land in `bench/compare-results.json`.

## Caveats — read before quoting

- **One scenario, one run, small N**, single model (`gpt-5.4-mini`), frozen in
  `scenario.mjs` before the run. This measures the automatic memory path under
  identical isolated treatment; it is not a claim about every workload.
- **A 7-fact clean scenario is near the recall ceiling** — cortext and mem0 both
  hit 6/6. Differentiating the *top* systems from each other needs a harder
  scenario (more facts, distractor chatter, buried facts), as the Hermes bench
  used. The clear separations here are memory-vs-none (control 0/6) and the
  supersession probe.
- **Only local built-in + mem0 are compared.** Other ClawHub memory plugins
  (LanceDB, TencentDB, memory-graph, …) are additional arms not yet run.
- **This bench exercises the context-engine/memory recall path, not cortext's
  streaming interrupt gate or re-pass** — validating those live needs a separate
  `onAgentEvent` harness.
