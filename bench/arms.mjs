// Shared OpenClaw arm setup used by both benchmarks (run-compare.mjs and
// longmemeval.mjs). Each arm pins BOTH exclusive slots (contextEngine + memory)
// so recall is attributable to exactly one memory system.
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH = dirname(fileURLToPath(import.meta.url));
export const PLUGIN = dirname(BENCH);
export const OC = join(BENCH, "node_modules", ".bin", "openclaw");
export const MODEL = process.env.BENCH_MODEL || "openai/gpt-5.4-mini";

export function oc(profile, args, opts = {}) {
  return execFileSync(OC, ["--profile", profile, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", opts.showErr ? "inherit" : "ignore"],
    timeout: opts.timeout ?? 240000,
    env: process.env,
  });
}

/** Run one agent turn; return the assistant reply text (empty on parse failure).
 *  `model` overrides the agent model (e.g. a cheap model for ingestion). */
export function turn(profile, sessionId, message, model = MODEL) {
  const out = oc(profile, ["agent", "--local", "--json", "--session-id", sessionId, "-m", message, "--model", model]);
  try {
    const j = JSON.parse(out);
    const payloads = j.reply?.payloads || j.payloads || [];
    return payloads.map((p) => p.text).join(" ").trim();
  } catch {
    return "";
  }
}

/** The four isolated arms. runId gives mem0 a unique per-run cloud identity. */
export function buildArms(runId) {
  return [
    { name: "cortext", profile: "lme-cx", context: "cortext", memory: "none", install: PLUGIN, locality: "local", note: "this plugin (context engine)" },
    { name: "control", profile: "lme-ctl", context: "legacy", memory: "none", locality: "-", note: "built-in engine, no memory plugin" },
    { name: "memory-core", profile: "lme-mc", context: "legacy", memory: "memory-core", locality: "local", note: "OpenClaw built-in memory plugin" },
    {
      name: "mem0",
      profile: "lme-mem0",
      context: "legacy",
      memory: "openclaw-mem0",
      install: "clawhub:@mem0/openclaw-mem0",
      entryId: "openclaw-mem0",
      config: [["mode", "platform"], ["apiKey", "${MEM0_API_KEY}"], ["userId", `lme-${runId}`], ["autoRecall", "true"], ["autoCapture", "true"]],
      settleMs: 8000,
      requiresEnv: "MEM0_API_KEY",
      locality: "cloud",
      note: "mem0 cloud memory plugin",
    },
  ];
}

export function setupArm(arm) {
  const stateDir = join(homedir(), `.openclaw-${arm.profile}`);
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  if (arm.install) oc(arm.profile, ["plugins", "install", arm.install], { timeout: 200000 });
  oc(arm.profile, ["config", "set", "plugins.slots.contextEngine", arm.context]);
  oc(arm.profile, ["config", "set", "plugins.slots.memory", arm.memory]);
  for (const [k, v] of arm.config ?? []) {
    oc(arm.profile, ["config", "set", `plugins.entries.${arm.entryId}.config.${k}`, v]);
  }
}
