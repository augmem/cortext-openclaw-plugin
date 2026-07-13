// Head-to-head OpenClaw memory comparison, mirroring the Hermes bench method:
// each arm runs in its OWN isolated profile (separate ~/.openclaw-<profile>),
// facts are stored in one session, and every probe runs in a FRESH session so
// recall must come from durable memory.
//
// OpenClaw exposes TWO independent exclusive slots that both affect recall:
//   - contextEngine: assembles/injects context (default "legacy"; cortext here)
//   - memory:        auto-recall/capture memory plugin (default "memory-core")
// To attribute recall to ONE system, every arm pins BOTH slots explicitly. The
// `control` arm pins both to the built-in no-memory baseline, so a correct probe
// in any other arm is attributable to that arm's named memory system.
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { FACTS, PROBES } from "./scenario.mjs";

const BENCH = dirname(fileURLToPath(import.meta.url));
const PLUGIN = dirname(BENCH);
const OC = join(BENCH, "node_modules", ".bin", "openclaw");
const MODEL = process.env.BENCH_MODEL || "openai/gpt-5.4-mini";
const RUN_ID = String(Date.now());
const ONLY = process.argv.slice(2);

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY not set");
  process.exit(1);
}

function oc(profile, args, opts = {}) {
  return execFileSync(OC, ["--profile", profile, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", opts.showErr ? "inherit" : "ignore"],
    timeout: opts.timeout ?? 240000,
    env: process.env,
  });
}

function turn(profile, sessionId, message) {
  const out = oc(profile, ["agent", "--local", "--json", "--session-id", sessionId, "-m", message, "--model", MODEL]);
  try {
    const j = JSON.parse(out);
    const payloads = j.reply?.payloads || j.payloads || [];
    return payloads.map((p) => p.text).join(" ").trim();
  } catch {
    return "";
  }
}

// Each arm pins contextEngine + memory explicitly. `install` adds a plugin;
// `config` sets plugin-entry keys; `settleMs` waits for async cloud extraction.
const ARMS = [
  { name: "cortext", profile: "bench-cx", context: "cortext", memory: "none", install: PLUGIN, note: "this plugin (context engine), local" },
  { name: "control", profile: "bench-ctl", context: "legacy", memory: "none", note: "built-in engine, no memory plugin" },
  { name: "memory-core", profile: "bench-mc", context: "legacy", memory: "memory-core", note: "OpenClaw built-in memory plugin, local" },
  {
    name: "mem0",
    profile: "bench-mem0",
    context: "legacy",
    memory: "openclaw-mem0",
    install: "clawhub:@mem0/openclaw-mem0",
    entryId: "openclaw-mem0",
    config: [["mode", "platform"], ["apiKey", "${MEM0_API_KEY}"], ["userId", `bench-${RUN_ID}`], ["autoRecall", "true"], ["autoCapture", "true"]],
    settleMs: 15000,
    requiresEnv: "MEM0_API_KEY",
    note: "mem0 cloud memory plugin (data leaves machine)",
  },
].filter((a) => ONLY.length === 0 || ONLY.includes(a.name));

async function setupArm(arm) {
  const stateDir = join(homedir(), `.openclaw-${arm.profile}`);
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  if (arm.install) oc(arm.profile, ["plugins", "install", arm.install], { timeout: 200000 });
  // Pin BOTH slots explicitly (after install, so our values win).
  oc(arm.profile, ["config", "set", "plugins.slots.contextEngine", arm.context]);
  oc(arm.profile, ["config", "set", "plugins.slots.memory", arm.memory]);
  for (const [k, v] of arm.config ?? []) {
    oc(arm.profile, ["config", "set", `plugins.entries.${arm.entryId}.config.${k}`, v]);
  }
}

async function runArm(arm) {
  console.log(`\n=== arm: ${arm.name}  (ctxEngine=${arm.context}, memory=${arm.memory}) — ${arm.note} ===`);
  if (arm.requiresEnv && !process.env[arm.requiresEnv]) {
    console.log(`  SKIPPED: ${arm.requiresEnv} not set`);
    return { arm: arm.name, skipped: true };
  }
  await setupArm(arm);

  const storeSession = `${arm.name}-store`;
  for (const fact of FACTS) turn(arm.profile, storeSession, `Please remember this: ${fact}`);
  console.log(`  stored ${FACTS.length} facts`);

  if (arm.settleMs) {
    console.log(`  settling ${arm.settleMs}ms for async extraction…`);
    await sleep(arm.settleMs);
  }

  const results = [];
  for (const probe of PROBES) {
    const answer = turn(arm.profile, `${arm.name}-probe-${probe.id}`, probe.q);
    const recalled = probe.want.every((re) => re.test(answer));
    const stale = probe.stale.some((re) => re.test(answer));
    results.push({ id: probe.id, recalled, stale, answer });
    console.log(`  [${recalled ? "✓" : "✗"}${stale ? " STALE" : ""}] ${probe.id}: ${answer.slice(0, 84).replace(/\n/g, " ")}`);
  }
  const recall = results.filter((r) => r.recalled).length;
  const leaks = results.filter((r) => r.stale).length;
  return { arm: arm.name, context: arm.context, memory: arm.memory, note: arm.note, recall, total: PROBES.length, leaks, results };
}

const report = [];
for (const arm of ARMS) report.push(await runArm(arm));

console.log("\n\n===== SUMMARY =====");
console.log("arm          ctxEngine  memory        recall   stale");
for (const r of report) {
  if (r.skipped) { console.log(`${r.arm.padEnd(12)} (skipped)`); continue; }
  console.log(`${r.arm.padEnd(12)} ${r.context.padEnd(10)} ${r.memory.padEnd(13)} ${String(r.recall + "/" + r.total).padEnd(8)} ${r.leaks}`);
}
writeFileSync(join(BENCH, "compare-results.json"), JSON.stringify({ runId: RUN_ID, model: MODEL, report }, null, 2));
console.log("\nwrote bench/compare-results.json");
