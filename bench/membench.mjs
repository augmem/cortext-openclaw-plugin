// membench — a cheaper OpenClaw memory benchmark over a curated LongMemEval subset.
//
// Cheaper than longmemeval.mjs:
//   - runs a CURATED cheap-but-hard subset (bench/data/curated-subset.json,
//     ~2x fewer tokens/instance than the full set) covering every ability;
//   - ingests history on a CHEAP model (INGEST_MODEL) since the ingest reply is
//     discarded, reserving the main model for probes only.
// Noise controls:
//   - each answer is graded by a MAJORITY VOTE of independent judges (voteJudge)
//     instead of a single noisy judge;
//   - the whole subset is repeated over `--reps` runs and we report mean±range,
//     capturing memory/judge nondeterminism;
//   - a no-memory `control` arm bounds the "the base model already knew it"
//     confound; abstention is scored as its own bucket (hallucination penalty).
//
// Ingestion faithfulness is the same documented approximation as longmemeval.mjs
// (transcript-as-message, identical across arms → cross-arm fair, not
// leaderboard-comparable).
//
// Usage:
//   node membench.mjs [--arms a,b] [--reps N] [--votes N] [--limit N] [--dry-run]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { buildArms, setupArm, turn } from "./arms.mjs";
import { INGEST_MODEL, PROBE_MODEL, estimateCost, formatCostReport } from "./cost.mjs";
import { voteJudge, DEFAULT_VOTES } from "./judge-vote.mjs";

const BENCH = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(`--${n}`);

const REPS = parseInt(arg("reps", "1"), 10);
const VOTES = parseInt(arg("votes", String(DEFAULT_VOTES)), 10);
const LIMIT = parseInt(arg("limit", "0"), 10);
const ARM_FILTER = arg("arms", "").split(",").filter(Boolean);

if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY not set"); process.exit(1); }

const oracle = JSON.parse(readFileSync(join(BENCH, "data", "longmemeval_oracle.json"), "utf8"));
const byId = Object.fromEntries(oracle.map((x) => [x.question_id, x]));
let subset = JSON.parse(readFileSync(join(BENCH, "data", "curated-subset.json"), "utf8"));
if (LIMIT > 0) subset = stratifiedLimit(subset, LIMIT);

// Take up to `limit` items spread ACROSS categories (round-robin) so a small
// --limit smoke stays representative instead of collapsing to one category.
function stratifiedLimit(items, limit) {
  const byCat = {};
  for (const it of items) (byCat[it.question_type] ||= []).push(it);
  const cats = Object.keys(byCat).sort();
  const out = [];
  let added = true;
  while (out.length < limit && added) {
    added = false;
    for (const c of cats) { if (byCat[c].length && out.length < limit) { out.push(byCat[c].shift()); added = true; } }
  }
  return out;
}
const instances = subset.map((s) => ({ ...byId[s.question_id], _meta: s })).filter((x) => x.question_id);

const isAbstention = (inst) => inst.question_id.endsWith("_abs");
const catOf = (inst) => (isAbstention(inst) ? "abstention" : inst.question_type);

function sessionMessage(session, date) {
  const lines = session.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n");
  return `Here is a past conversation from ${date} for you to remember:\n\n${lines}`;
}

const arms = buildArms("membench").filter((a) => ARM_FILTER.length === 0 || ARM_FILTER.includes(a.name));

// Preflight cost.
const est = estimateCost(subset, arms, { votes: VOTES, seeds: REPS });
console.log(`membench: ${instances.length} curated instances x ${arms.length} arms x ${REPS} rep(s), ${VOTES}-judge vote`);
console.log(`ingest model=${INGEST_MODEL}  probe model=${PROBE_MODEL}`);
console.log(formatCostReport(est));
if (has("dry-run")) { console.log("\n--dry-run: not executing."); process.exit(0); }

async function runInstance(arm, inst, tag) {
  inst.haystack_sessions.forEach((session, si) => {
    const date = inst.haystack_dates?.[si] || inst.question_date || "an earlier date";
    turn(arm.profile, `${tag}-s${si}`, sessionMessage(session, date), INGEST_MODEL); // cheap ingest
  });
  if (arm.settleMs) return sleep(arm.settleMs).then(() => probe(arm, inst, tag));
  return probe(arm, inst, tag);
}
async function probe(arm, inst, tag) {
  const answer = turn(arm.profile, `${tag}-probe`, inst.question, PROBE_MODEL);
  const v = await voteJudge(catOf(inst), inst.question, inst.answer, answer, { votes: VOTES });
  return { qid: inst.question_id, cat: catOf(inst), correct: v.correct, confidence: v.confidence };
}

// arm -> rep -> results
const report = [];
for (const arm of arms) {
  if (arm.requiresEnv && !process.env[arm.requiresEnv]) { console.log(`\n=== ${arm.name}: SKIPPED (${arm.requiresEnv} unset) ===`); report.push({ arm: arm.name, skipped: true }); continue; }
  console.log(`\n=== arm: ${arm.name} (ctxEngine=${arm.context}, memory=${arm.memory}, ${arm.locality}) ===`);
  const reps = [];
  for (let r = 0; r < REPS; r++) {
    setupArm(arm); // wipe + reconfigure each rep for a true cold start
    const results = [];
    for (let i = 0; i < instances.length; i++) {
      results.push(await runInstance(arm, instances[i], `${arm.name}-r${r}-${i}`));
      process.stdout.write(results[results.length - 1].correct ? "✓" : "·");
    }
    process.stdout.write(`  rep${r + 1}: ${results.filter((x) => x.correct).length}/${results.length}\n`);
    reps.push(results);
  }
  report.push({ arm: arm.name, locality: arm.locality, context: arm.context, memory: arm.memory, reps });
}

// Aggregate: per arm, overall + per-category, mean across reps with range.
const cats = [...new Set(instances.map(catOf))].sort();
function agg(reps) {
  const perRepOverall = reps.map((rs) => rs.filter((x) => x.correct).length / rs.length);
  const catAcc = {};
  for (const c of cats) {
    const vals = reps.map((rs) => { const s = rs.filter((x) => x.cat === c); return s.length ? s.filter((x) => x.correct).length / s.length : null; }).filter((v) => v !== null);
    if (vals.length) catAcc[c] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  const mean = perRepOverall.reduce((a, b) => a + b, 0) / perRepOverall.length;
  return { mean, min: Math.min(...perRepOverall), max: Math.max(...perRepOverall), catAcc, n: reps[0].length };
}

console.log("\n\n===== Robust bench (mean accuracy across reps, judge-voted) =====");
const pct = (x) => (x == null ? "  -  " : (x * 100).toFixed(0).padStart(3) + "%");
console.log(["arm".padEnd(12), "overall".padEnd(12), ...cats.map((c) => c.slice(0, 9).padEnd(10))].join(" "));
const summary = [];
for (const r of report) {
  if (r.skipped) { console.log(`${r.arm.padEnd(12)} (skipped)`); continue; }
  const a = agg(r.reps);
  const overall = REPS > 1 ? `${pct(a.mean)} [${pct(a.min)}-${pct(a.max)}]` : pct(a.mean);
  console.log([r.arm.padEnd(12), overall.padEnd(12), ...cats.map((c) => pct(a.catAcc[c]).padEnd(10))].join(" "));
  summary.push({ arm: r.arm, locality: r.locality, n: a.n, reps: REPS, overallMean: a.mean, overallMin: a.min, overallMax: a.max, byCategory: a.catAcc });
}

writeFileSync(join(BENCH, "membench-results.json"), JSON.stringify({ instances: instances.length, reps: REPS, votes: VOTES, ingestModel: INGEST_MODEL, probeModel: PROBE_MODEL, cost: est, report, summary }, null, 2));
console.log("\nwrote bench/membench-results.json");
