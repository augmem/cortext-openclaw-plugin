# membench — cheaper LongMemEval subset for OpenClaw memory

`membench.mjs` is the recommended default harness: it keeps LongMemEval's real,
non-saturating difficulty but is **cheaper to run** than `longmemeval.mjs`, with
noise controls (majority-vote judging, cross-rep variance, a no-memory control).
Built by fanning the pieces out to subagents (curation, vote-judge, cost model),
integrated here.

## Cheaper

- **Curated cheap-but-hard subset** (`data/curated-subset.json`, built by
  `curate.mjs`): the lowest-token instances in each ability category — ~2.1×
  fewer tokens per instance than the full LongMemEval oracle set (mean ~3.1k vs
  ~6.6k), covering all six categories plus abstention. 54 instances by default.
- **Cheap ingest model**: history sessions are ingested on `openai/gpt-5.4-nano`
  (the cheapest catalog model, input 0.2 vs mini's 0.75). The ingest reply is
  discarded, so it doesn't need a smart model; only the **probe** uses the main
  model (`openai/gpt-5.4-mini`).
- **Preflight cost report** (`cost.mjs`): every run prints turn/call counts
  split by model before executing; `--dry-run` prints it and stops.

## Noise controls

- **Majority-vote judging** (`judge-vote.mjs`): each answer is graded by N
  independent judges (default 3) with decorrelated temperature and two grader
  phrasings; the majority wins. Cuts single-judge flip noise.
- **Variance across repeats**: `--reps N` runs the whole subset N times (each a
  fresh cold-start) and reports **mean [min-max]** per arm, exposing the
  memory/judge nondeterminism a single run hides.
- **No-memory control** bounds the "base model already knew it" confound;
  **abstention** is scored as its own bucket (a system that fabricates on
  unanswerable questions is penalized).
- **Both OpenClaw slots pinned** per arm (`contextEngine` + `memory`), so recall
  is attributable to one system.

## Run it

```bash
cd bench
npm install openclaw@latest @augmem/cortext@latest
node fetch-longmemeval.mjs oracle      # dataset
node curate.mjs --per 8 --abs 6        # (re)build the curated subset
export OPENAI_API_KEY=sk-...
export MEM0_API_KEY=m0-...              # only for the mem0 arm

node membench.mjs --dry-run                              # see cost first
node membench.mjs --arms cortext,control,memory-core,mem0 --reps 3 --votes 3
node membench.mjs --arms cortext,control --limit 8       # quick check
```

Flags: `--arms <csv>`, `--reps <N>` (variance), `--votes <N>` (judge votes),
`--limit <N>` (cap instances, spread across categories; omit for the full
subset), `--dry-run`. Env: `BENCH_MODEL` (probe model), `BENCH_JUDGE_MODEL`.

Output: per-arm, per-category accuracy (mean [min-max] over reps) +
`membench-results.json` with every judged answer and the cost record.

## Same faithfulness caveat as the other harnesses

OpenClaw's CLI only accepts user messages, so each haystack session is replayed
as one transcript message the memory ingests (both roles preserved), identically
across arms. Cross-arm results are apples-to-apples; **absolute scores are not
comparable to the public LongMemEval leaderboard** (which injects the raw
transcript into the context window). Faithful injection needs OpenClaw's embedded
API — future work.
