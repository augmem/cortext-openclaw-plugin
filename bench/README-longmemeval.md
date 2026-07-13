# LongMemEval on OpenClaw memory systems

This is the **reputable** benchmark harness: it runs the standard
[LongMemEval](https://github.com/xiaowu0162/LongMemEval) benchmark (Wu et al.) —
the long-term chat-memory benchmark that memory vendors (mem0, Zep, Letta)
report on — against OpenClaw memory systems, judged by an LLM.

The smaller `run-compare.mjs` (see [README.md](README.md)) is a hand-authored
needle-in-a-haystack recall check; **this** harness is the one to trust for
capability claims.

## What it measures

LongMemEval has 500 multi-session instances across five abilities —
**information extraction, multi-session reasoning, temporal reasoning,
knowledge updates, and abstention** — the axes where memory systems actually
diverge (a simple recall test saturates them all). Each instance is a set of
dated conversation sessions (`haystack_sessions`) plus a `question` and gold
`answer`; answers are graded by an LLM judge (as in the official autoeval).

Arms are the same isolated OpenClaw configurations as `run-compare.mjs`, each
pinning **both** exclusive slots so recall is attributable to one system:

| Arm | contextEngine | memory | Locality |
| --- | --- | --- | --- |
| cortext | cortext | none | local |
| control | legacy | none | — |
| memory-core | legacy | memory-core | local |
| mem0 | legacy | openclaw-mem0 | cloud |

## Reputability: what's faithful, what's approximate

- **Real benchmark data** (`xiaowu0162/longmemeval-cleaned`), unmodified.
- **LLM judge** following the LongMemEval autoeval approach, including the
  abstention rule (correct = the model declines on unanswerable questions).
- **Stratified, seeded sampling** — reproducible subsets across all categories.
- **Isolated arms** — both slots pinned; a no-memory `control` bounds the "the
  base model already knew it" confound.
- **Approximation — read before quoting.** OpenClaw's CLI accepts only user
  messages, so each haystack session is replayed as one dated transcript message
  the memory system ingests (both roles preserved in the text). This is applied
  **identically to every arm**, so cross-arm comparisons are apples-to-apples,
  but it differs from the official protocol (raw transcript in the context
  window). **Absolute scores here are NOT directly comparable to the published
  LongMemEval leaderboard.** Faithful transcript injection needs OpenClaw's
  embedded API and is future work.

## Run it

```bash
cd bench
npm install openclaw@latest @augmem/cortext@latest
node fetch-longmemeval.mjs oracle          # or `s` for the full-haystack variant
export OPENAI_API_KEY=sk-...
export MEM0_API_KEY=m0-...                  # only for the mem0 arm

# stratified subset (default 3 instances/category = 18 total):
node longmemeval.mjs --n 3 --arms cortext,control,memory-core,mem0 --seed 42

# the full benchmark (expensive — 500 instances x arms, hours):
node longmemeval.mjs --n 999 --arms cortext,control,memory-core,mem0
```

Flags: `--n <perCategory>`, `--arms <csv>`, `--seed <n>`, `--data <path>`.
Cost per instance ≈ (num sessions) ingest turns + 1 probe turn + 1 judge call,
per arm. The `oracle` variant (evidence sessions only) is cheapest; `s` is the
realistic ~115k-token haystack.

Environment: `BENCH_MODEL` (agent model, default `openai/gpt-5.4-mini`),
`BENCH_JUDGE_MODEL` (judge, default `gpt-5.4-mini`).

Output: per-arm, per-category accuracy table + `bench/longmemeval-results.json`
with every judged answer.

## Caveats

- Subsets are directional; report the `--n` and `--seed` with any number, and
  run multiple seeds for variance. Only the full 500 is a headline figure.
- Scores are not comparable to the public leaderboard (see the approximation
  note above) — they compare arms **against each other** under identical
  treatment.
- Single agent model per run; the judge is itself an LLM and adds noise —
  spot-check `longmemeval-results.json`.
