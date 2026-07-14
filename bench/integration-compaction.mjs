// LIVE compaction integration test — proves Cortext-owned compaction end to
// end against a real `openclaw gateway run` daemon:
//   1. seed a session with a needle fact the model is told NOT to repeat
//   2. restart the gateway with a tight token budget -> the host's budget
//      pressure forces engine compaction (no summarizer LLM call)
//   3. assert the compaction fired and the anchor sidecar was written
//   4. HONESTY CHECK: parse the transcript and assert the needle does NOT
//      appear at/after the anchor — i.e. it survives ONLY in Cortext memory
//   5. restart with a normal budget and assert the model answers the needle
//      from memory injection alone
//
// Requires OPENAI_API_KEY. Slow. Run explicitly: node bench/integration-compaction.mjs
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const BENCH = dirname(fileURLToPath(import.meta.url));
const PLUGIN = dirname(BENCH);
const OC = join(BENCH, "node_modules", ".bin", "openclaw");
const PROFILE = "cortext-compacttest";
const HOME = join(homedir(), `.openclaw-${PROFILE}`);
const LOG = join(BENCH, ".compact-itest.log");
const NEEDLE = "quill-7284";
// Budget math (verified against openclaw 2026.6.11): the prompt must fit
// contextTokens minus a fixed 16384-token reserve, and OpenClaw's own system
// prompt is ~13k tokens. 28000 -> pressure (compaction fires, turn may
// overflow); 40000 -> fits comfortably.
const TIGHT = "28000";
const ROOMY = "40000";
if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }

const oc = (args, opts = {}) => execFileSync(OC, ["--profile", PROFILE, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: opts.t ?? 200000, env: process.env });
const fails = [];
const check = (name, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails.push(name); };

let gw = null;
async function startGateway() {
  const out = openSync(LOG, "a");
  gw = spawn(OC, ["--profile", PROFILE, "--log-level", "debug", "gateway", "run", "--allow-unconfigured"], { stdio: ["ignore", out, out], env: process.env });
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const log = existsSync(LOG) ? readFileSync(LOG, "utf-8") : "";
    if (/http server listening|\bready\b/.test(log)) return true;
    if (/Gateway start blocked|fatal/i.test(log)) return false;
  }
  return false;
}
async function stopGateway() {
  if (!gw) return;
  gw.kill("SIGTERM");
  await sleep(1500);
  try { gw.kill("SIGKILL"); } catch { /* already dead */ }
  gw = null;
}
function turn(msg) {
  try { return oc(["agent", "--session-id", "K1", "-m", msg]).trim().split("\n").pop() ?? ""; }
  catch (e) { return String(e.stdout || "").trim().split("\n").pop() ?? ""; }
}
function transcriptMessages() {
  const file = join(HOME, "agents", "main", "sessions", "K1.jsonl");
  const out = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== "message") continue;
      const text = (e.message.content ?? []).map((p) => (p && typeof p === "object" && typeof p.text === "string" ? p.text : "")).join(" ");
      out.push({ role: e.message.role, text });
    } catch { /* skip */ }
  }
  return out;
}

// --- setup ---
rmSync(HOME, { recursive: true, force: true });
rmSync(LOG, { force: true });
console.log("installing plugin + configuring gateway…");
oc(["plugins", "install", PLUGIN], { t: 200000 });
oc(["config", "set", "plugins.slots.contextEngine", "cortext"]);
oc(["config", "set", "plugins.slots.memory", "none"]);
oc(["config", "set", "gateway.mode", "local"]);
oc(["config", "set", "gateway.auth.mode", "token"]);
oc(["config", "set", "gateway.auth.token", "compacttest-token"]);
oc(["config", "set", "plugins.entries.cortext.config.protectTail", "2"]);
oc(["config", "set", "agents.defaults.contextTokens", ROOMY]);

try {
  // --- 1. seed: needle first, then filler so the tail cannot contain it ---
  console.log("seeding session (needle + OK-only filler)…");
  check("gateway starts (seed phase)", await startGateway());
  turn(`Remember this: the shipment crate label is ${NEEDLE}. Acknowledge with only the word OK — do not repeat the label.`);
  turn("Reply with only the word OK.");
  turn("Reply with only the word OK.");
  await stopGateway();

  // --- 2. tight budget -> budget pressure forces engine compaction ---
  console.log("restarting with a tight budget to force compaction…");
  oc(["config", "set", "agents.defaults.contextTokens", TIGHT]);
  rmSync(LOG, { force: true });
  check("gateway starts (pressure phase)", await startGateway());
  turn("Reply with only OK."); // the turn itself may overflow — compaction still fires
  await sleep(1000);
  const log = readFileSync(LOG, "utf-8");
  check("compaction fires under budget pressure (no summarizer LLM call)", /cortext compaction: Archived \d+ message/.test(log));
  await stopGateway();

  // --- 3. anchor sidecar written ---
  const sidecarPath = join(HOME, "agents", "main", "agent", "cortext", "compaction.json");
  const sidecar = existsSync(sidecarPath) ? JSON.parse(readFileSync(sidecarPath, "utf-8")) : {};
  const anchor = Object.values(sidecar)[0];
  check("anchor sidecar persisted", Boolean(anchor?.textPrefix), anchor && `anchor="${anchor.textPrefix.slice(0, 40)}" dropped=${anchor.dropped}`);

  // --- 4. honesty check: the needle exists ONLY behind the window ---
  const msgs = transcriptMessages();
  const anchorIdx = anchor ? msgs.findIndex((m) => m.role === anchor.role && m.text.startsWith(anchor.textPrefix)) : -1;
  const tail = anchorIdx >= 0 ? msgs.slice(anchorIdx) : [];
  const needleInTail = tail.some((m) => m.text.toLowerCase().includes(NEEDLE));
  const needleBeforeAnchor = anchorIdx > 0 && msgs.slice(0, anchorIdx).some((m) => m.text.toLowerCase().includes(NEEDLE));
  check("needle is in the ARCHIVED prefix, not the kept tail", anchorIdx >= 0 && needleBeforeAnchor && !needleInTail, `anchorIdx=${anchorIdx} tailMsgs=${tail.length}`);

  // --- 5. roomy budget: post-compaction turn works, needle recalled from memory ---
  console.log("restarting with a roomy budget for the recall probe…");
  oc(["config", "set", "agents.defaults.contextTokens", ROOMY]);
  rmSync(LOG, { force: true });
  check("gateway starts (probe phase)", await startGateway());
  const ok = turn("Reply with only the word OK.");
  check("post-compaction turn succeeds with the windowed context", /\bok\b/i.test(ok), JSON.stringify(ok.slice(0, 40)));
  const probe = turn("What is the shipment crate label? Answer with just the label.");
  check("archived-only fact recalled from Cortext memory injection", probe.toLowerCase().includes(NEEDLE), JSON.stringify(probe.slice(0, 40)));
} finally {
  await stopGateway();
  rmSync(HOME, { recursive: true, force: true });
  rmSync(LOG, { force: true });
}

console.log(`\n${fails.length ? "FAILED: " + fails.join("; ") : "ALL COMPACTION INTEGRATION CHECKS PASSED"}`);
process.exit(fails.length ? 1 : 0);
