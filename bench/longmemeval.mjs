// LongMemEval harness for OpenClaw memory systems.
//
// LongMemEval (Wu et al.) is the standard long-term chat-memory benchmark: 500
// multi-session instances across information-extraction, multi-session
// reasoning, temporal reasoning, knowledge-update, and abstention abilities,
// scored by an LLM judge. Vendors (mem0, Zep) report on it. This harness runs a
// stratified sample through the SAME isolated OpenClaw arms as run-compare.mjs
// (both slots pinned) and judges answers with judge.mjs.
//
// Ingestion note (read before quoting): OpenClaw's CLI accepts only user
// messages, so each haystack session is replayed as one dated transcript
// message that the memory system ingests (both roles preserved in content).
// This is applied identically to every arm — so cross-arm results are
// apples-to-apples — but it differs from the official protocol (which places
// the raw transcript in the context window), so absolute scores are NOT
// directly comparable to the published LongMemEval leaderboard. Faithful
// transcript injection needs OpenClaw's embedded API (future work).
//
// Usage:
//   node longmemeval.mjs [--n <perCategory>] [--arms a,b] [--seed <n>] [--data <path>]
//   OPENAI_API_KEY required; MEM0_API_KEY required only for the mem0 arm.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { buildArms, setupArm, turn, MODEL } from "./arms.mjs";
import { judge, JUDGE_MODEL } from "./judge.mjs";

const BENCH = dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PER_CAT = parseInt(arg("n", "3"), 10); // instances per category
const SEED = parseInt(arg("seed", "42"), 10);
const DATA = arg("data", join(BENCH, "data", "longmemeval_oracle.json"));
const ARM_FILTER = arg("arms", "").split(",").filter(Boolean);
const RUN_ID = String(SEED); // deterministic; keeps mem0 userId stable per seed

if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY not set"); process.exit(1); }

// Deterministic PRNG (mulberry32) for reproducible sampling.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function stratifiedSample(data, perCat, seed) {
  const rnd = rng(seed);
  const byCat = {};
  for (const x of data) (byCat[x.question_type] ||= []).push(x);
  const out = [];
  for (const cat of Object.keys(byCat).sort()) out.push(...shuffle(byCat[cat], rnd).slice(0, perCat));
  return out;
}

const isAbstention = (inst) => inst.question_id.endsWith("_abs");

// One haystack session -> one dated transcript message for the memory to ingest.
function sessionMessage(session, date) {
  const lines = session.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n");
  return `Here is a past conversation from ${date} for you to remember:\n\n${lines}`;
}

async function runArmInstance(arm, inst, idx) {
  const base = `${arm.name}-${idx}`;
  // Ingest each haystack session as its own session (mirrors multi-session).
  inst.haystack_sessions.forEach((session, si) => {
    const date = inst.haystack_dates?.[si] || inst.question_date || "an earlier date";
    turn(arm.profile, `${base}-s${si}`, sessionMessage(session, date));
  });
  if (arm.settleMs) await sleep(arm.settleMs);
  // Probe the question in a FRESH session.
  const answer = turn(arm.profile, `${base}-probe`, inst.question);
  const qtype = isAbstention(inst) ? "abstention" : inst.question_type;
  const correct = await judge(qtype, inst.question, inst.answer, answer);
  return { qid: inst.question_id, type: inst.question_type, abstention: isAbstention(inst), correct, answer };
}

async function runArm(arm, sample) {
  console.log(`\n=== arm: ${arm.name} (ctxEngine=${arm.context}, memory=${arm.memory}, ${arm.locality}) ===`);
  if (arm.requiresEnv && !process.env[arm.requiresEnv]) { console.log(`  SKIPPED: ${arm.requiresEnv} not set`); return { arm: arm.name, skipped: true }; }
  setupArm(arm);
  const results = [];
  for (let i = 0; i < sample.length; i++) {
    const r = await runArmInstance(arm, sample[i], i);
    results.push(r);
    process.stdout.write(`  [${r.correct ? "✓" : "✗"}] ${r.type}${r.abstention ? "/abs" : ""}\n`);
  }
  return { arm: arm.name, locality: arm.locality, context: arm.context, memory: arm.memory, results };
}

function tally(results) {
  const byCat = {};
  let ok = 0;
  for (const r of results) {
    const cat = r.abstention ? "abstention" : r.type;
    (byCat[cat] ||= { ok: 0, n: 0 });
    byCat[cat].n++; if (r.correct) { byCat[cat].ok++; ok++; }
  }
  return { overall: { ok, n: results.length }, byCat };
}

const data = JSON.parse(readFileSync(DATA, "utf8"));
const sample = stratifiedSample(data, PER_CAT, SEED);
const arms = buildArms(RUN_ID).filter((a) => ARM_FILTER.length === 0 || ARM_FILTER.includes(a.name));

console.log(`LongMemEval subset: ${sample.length} instances (${PER_CAT}/category, seed ${SEED})`);
console.log(`agent model=${MODEL}  judge model=${JUDGE_MODEL}  arms=${arms.map((a) => a.name).join(",")}`);

const report = [];
for (const arm of arms) report.push(await runArm(arm, sample));

const cats = [...new Set(sample.map((x) => (isAbstention(x) ? "abstention" : x.question_type)))].sort();
console.log("\n\n===== LongMemEval subset accuracy (judge-scored) =====");
console.log(["arm".padEnd(12), "overall".padEnd(9), ...cats.map((c) => c.slice(0, 10).padEnd(11))].join(" "));
const summary = [];
for (const r of report) {
  if (r.skipped) { console.log(`${r.arm.padEnd(12)} (skipped)`); continue; }
  const t = tally(r.results);
  const row = [r.arm.padEnd(12), `${t.overall.ok}/${t.overall.n}`.padEnd(9)];
  for (const c of cats) { const b = t.byCat[c]; row.push((b ? `${b.ok}/${b.n}` : "-").padEnd(11)); }
  console.log(row.join(" "));
  summary.push({ arm: r.arm, locality: r.locality, ...t });
}

writeFileSync(join(BENCH, "longmemeval-results.json"), JSON.stringify({ seed: SEED, perCat: PER_CAT, model: MODEL, judge: JUDGE_MODEL, data: DATA, report, summary }, null, 2));
console.log("\nwrote bench/longmemeval-results.json");
