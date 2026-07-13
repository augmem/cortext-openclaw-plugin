// FULL gateway integration test — spins up the real `openclaw gateway run`
// daemon and routes a token-authed turn through it, then asserts that BOTH
// plugin surfaces fire in the full harness path (which the `--local` embedded
// runner does not exercise):
//   - the streaming gate subscription receives events (P0-1 in gateway mode)
//   - the before_agent_finalize hook fires (the re-pass wiring)
//
// Requires OPENAI_API_KEY. Slow. Run explicitly: node bench/integration-gateway.mjs
import { execFileSync, spawn } from "node:child_process";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const BENCH = dirname(fileURLToPath(import.meta.url));
const PLUGIN = dirname(BENCH);
const OC = join(BENCH, "node_modules", ".bin", "openclaw");
const PROFILE = "cortext-gwtest";
const MODEL = process.env.BENCH_MODEL || "openai/gpt-5.4-mini";
const TOKEN = "cortext-gwtest-token";
const LOG = join(BENCH, ".gw-itest.log");
if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }

const oc = (args, opts = {}) => execFileSync(OC, ["--profile", PROFILE, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: opts.t ?? 120000, env: process.env });
const fails = [];
const check = (name, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails.push(name); };

// --- setup ---
rmSync(join(homedir(), `.openclaw-${PROFILE}`), { recursive: true, force: true });
rmSync(LOG, { force: true });
console.log("installing plugin + configuring gateway…");
oc(["plugins", "install", PLUGIN], { t: 200000 });
oc(["config", "set", "plugins.slots.contextEngine", "cortext"]);
oc(["config", "set", "plugins.slots.memory", "none"]);
oc(["config", "set", "gateway.mode", "local"]);
oc(["config", "set", "gateway.auth.mode", "token"]);
oc(["config", "set", "gateway.auth.token", TOKEN]);
// The before_agent_finalize hook is blocked for non-bundled plugins unless this
// is set — required for the re-pass.
oc(["config", "set", "plugins.entries.cortext.hooks.allowConversationAccess", "true"]);

// --- start the real gateway daemon ---
console.log("starting gateway daemon…");
const out = (await import("node:fs")).openSync(LOG, "a");
const gw = spawn(OC, ["--profile", PROFILE, "--log-level", "debug", "gateway", "run", "--allow-unconfigured"], { stdio: ["ignore", out, out], env: process.env });
try {
  // wait for ready
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const log = existsSync(LOG) ? readFileSync(LOG, "utf-8") : "";
    if (/http server listening|\bready\b/.test(log)) { ready = true; break; }
    if (/Gateway start blocked|fatal/i.test(log)) break;
  }
  check("gateway starts and loads the plugin", ready && /context engine active/.test(readFileSync(LOG, "utf-8")));

  // route a turn THROUGH the gateway (no --local)
  console.log("routing a turn through the gateway…");
  try { oc(["agent", "--session-id", "GW1", "-m", "Name one planet."], { t: 150000 }); } catch { /* reply not needed */ }
  await sleep(1500);

  const log = readFileSync(LOG, "utf-8");
  // "observing run" is logged once per run on the first event the subscription
  // receives — unlike the interrupt/boundary fire logs it is deterministic, and
  // unlike the old check it cannot be satisfied by the gate's own error log.
  check("P0-1: streaming gate subscription receives events in the gateway", /cortext gate: observing run /.test(log));
  check("P0-1: gate handler does not error", !/cortext gate error:/.test(log));
  check("re-pass: before_agent_finalize hook fires in the gateway", /before_agent_finalize \(run /.test(log));
} finally {
  gw.kill("SIGTERM");
  await sleep(500);
  try { gw.kill("SIGKILL"); } catch { /* already dead */ }
  rmSync(join(homedir(), `.openclaw-${PROFILE}`), { recursive: true, force: true });
  rmSync(LOG, { force: true });
}

console.log(`\n${fails.length ? "FAILED: " + fails.join("; ") : "ALL GATEWAY INTEGRATION CHECKS PASSED"}`);
process.exit(fails.length ? 1 : 0);
