// REAL gateway integration test — drives the installed `openclaw` binary
// (not a stub, not the fakeApi double) through `openclaw agent --local` and
// asserts the memory behaviors the unit tests can only approximate:
//   - default (session) scope isolates conversations (P1-1)
//   - cross-agent isolation (P0-2)
//   - the plugin loads and the streaming gate registers without crashing (P0-1)
//
// Requires OPENAI_API_KEY. Slow (several live model turns) — run explicitly, not
// as part of `npm test`:  node bench/integration.mjs
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH = dirname(fileURLToPath(import.meta.url));
const PLUGIN = dirname(BENCH);
const OC = join(BENCH, "node_modules", ".bin", "openclaw");
const PROFILE = "cortext-itest";
const MODEL = process.env.BENCH_MODEL || "openai/gpt-5.4-mini";
if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }

const oc = (args, opts = {}) =>
  execFileSync(OC, ["--profile", PROFILE, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: opts.t ?? 200000, env: process.env });

function turn(args) {
  let out;
  try { out = oc(["agent", "--local", "--json", "--model", MODEL, ...args]); }
  catch (e) { out = e.stdout || ""; }
  try { return (JSON.parse(out).payloads || []).map((p) => p.text).join(" ").trim(); }
  catch { return "(no-reply)"; }
}

const fails = [];
const check = (name, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails.push(name); };

// --- setup: fresh profile, install plugin, cortext as the only memory ---
rmSync(join(homedir(), `.openclaw-${PROFILE}`), { recursive: true, force: true });
console.log("installing plugin into a fresh profile…");
const install = oc(["plugins", "install", PLUGIN]);
check("plugin installs without error", /Installed plugin: cortext/.test(install));
oc(["config", "set", "plugins.slots.contextEngine", "cortext"]);
oc(["config", "set", "plugins.slots.memory", "none"]);

// --- P0-1: loads + gate registers without crashing ---
// The plugin's "context engine active" log and any crash go to stderr, so run
// the boot turn with stderr merged and assert no TypeError + a real reply.
let boot = "";
try { boot = execFileSync(OC, ["--profile", PROFILE, "agent", "--local", "--json", "--session-id", "boot", "-m", "Say hi.", "--model", MODEL], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 200000, env: process.env }); } catch (e) { boot = (e.stdout || "") + (e.stderr || ""); }
let bootErr = "";
try { bootErr = execFileSync("sh", ["-c", `"${OC}" --profile ${PROFILE} agent --local --session-id boot2 -m "Say hi." --model ${MODEL} 2>&1`], { encoding: "utf-8", timeout: 200000, env: process.env }); } catch (e) { bootErr = e.stdout || ""; }
check("P0-1: gate registers, no crash on load", /context engine active/.test(bootErr) && !/TypeError|reading 'onAgentEvent'|is not a function/.test(bootErr));

// --- P1-1: default session scope. NOTE: in `--local`, OpenClaw itself carries
// facts across sessions of one agent regardless of the memory plugin (the
// built-in legacy engine leaks the same fact), so we do NOT assert the model's
// answer here — that would test OpenClaw, not cortext. Instead we assert the
// STRUCTURAL guarantee: session scope writes a SEPARATE store per session.
turn(["--session-id", "S1", "-m", "Please remember: Marisol's favorite color is teal."]);
const sameSession = turn(["--session-id", "S1", "-m", "Remind me, Marisol's favorite color?"]);
check("same session recalls its own memory", /teal/i.test(sameSession), sameSession.slice(0, 60));
turn(["--session-id", "S2", "-m", "Please remember: the sky is green."]);
const stores = execFileSync("sh", ["-c", `find "${join(homedir(), '.openclaw-' + PROFILE, 'agents')}" -path '*cortext*' -name 's-*.sqlite' 2>/dev/null | wc -l`], { encoding: "utf-8" }).trim();
check("P1-1: session scope writes a separate store per session", Number(stores) >= 2, `${stores} per-session stores`);

// --- P0-2: cross-agent isolation ---
const ws = join(homedir(), `.openclaw-${PROFILE}`, "ws-bob");
mkdirSync(ws, { recursive: true });
try { oc(["agents", "add", "bob", "--agent-dir", join(homedir(), `.openclaw-${PROFILE}`, "agents", "bob"), "--workspace", ws], { t: 90000 }); } catch { /* may already exist */ }
oc(["config", "set", "plugins.entries.cortext.config.memoryScope", "agent"]); // agent scope so the boundary under test is the agent, not the session
// The needle must be unguessable from priors (an earlier needle, "the mascot is
// a lobster", collided with OpenClaw's real lobster mascot — the model said
// "lobster" from its own knowledge and the check flagged a leak that wasn't).
turn(["--session-id", "AL1", "-m", "Please remember: the vault passphrase label is zephyr-9931."]);
const bob = turn(["--agent", "bob", "--session-id", "BO1", "-m", "What is the vault passphrase label? Say you don't know if unsure."]);
check(
  "P0-2: a different agent cannot see the first agent's memory",
  bob !== "(no-reply)" && !/zephyr[\s-]?9931/i.test(bob), // a failed turn must not pass vacuously
  bob.slice(0, 60),
);
const main = turn(["--session-id", "AL2", "-m", "What is the vault passphrase label?"]);
check("P0-2 control: the first agent itself recalls the fact (agent scope)", /zephyr[\s-]?9931/i.test(main), main.slice(0, 60));

console.log(`\n${fails.length ? "FAILED: " + fails.join("; ") : "ALL INTEGRATION CHECKS PASSED"}`);
process.exit(fails.length ? 1 : 0);
