// OFFLINE compaction stress test on a REAL conversation — no model calls.
//
// Replays a Claude Code transcript (~/.claude/projects/**/<session>.jsonl)
// through the Cortext context engine: converts Claude-format entries to
// OpenClaw AgentMessages (text, toolCall, toolResult), ingests everything
// durably, then runs compaction and asserts the mechanical invariants on a
// genuinely tool-heavy conversation:
//   - every message role ingests (user / assistant / toolCall / toolResult)
//   - hybrid + full windows: system survives, bridge present, tail starts on
//     a user message (never an orphaned tool result), tokens shrink
//   - recall probes: archived user asks and tool outputs come back from the
//     durable store after they leave the verbatim window
//
// Usage: node bench/replay-transcript.mjs <transcript.jsonl> [--limit N]
// The transcript stays local — nothing is copied or committed.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../dist/register.js";

// --- convert Claude Code transcript entries -> OpenClaw AgentMessages ------
export function convert(file) {
  const messages = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "user" && e.type !== "assistant") continue;
    const content = e.message?.content;
    if (typeof content === "string") {
      if (content.trim()) messages.push({ role: e.type, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts = [];         // text/toolCall parts for this message
    const toolResults = [];   // emitted as separate toolResult messages
    for (const p of content) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) parts.push({ type: "text", text: p.text });
      else if (p.type === "tool_use") parts.push({ type: "toolCall", id: String(p.id ?? ""), name: String(p.name ?? "tool"), arguments: p.input });
      else if (p.type === "tool_result") {
        const inner = p.content;
        const text = typeof inner === "string" ? inner
          : Array.isArray(inner) ? inner.map((q) => (q && typeof q === "object" && typeof q.text === "string" ? q.text : "")).join(" ") : "";
        if (text.trim()) toolResults.push({ role: "toolResult", content: [{ type: "text", text }] });
      }
      // thinking parts are skipped — reasoning is ephemeral by design
    }
    if (parts.length) messages.push({ role: e.type, content: parts });
    messages.push(...toolResults);
  }
  return messages;
}

// --- minimal real-surface api double (mirrors tests/helpers.mjs) -----------
export function buildEngine(dir, config) {
  const captured = {};
  register({
    id: "cortext", config: {}, pluginConfig: config,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    resolvePath: (p) => join(dir, p),
    agent: { events: { registerAgentEventSubscription: () => {} } },
    on: () => {},
    registerContextEngine: (_id, factory) => { captured.engine = factory({ agentDir: dir }); },
    registerService: () => { throw new Error("unexpected registerService"); },
  });
  return captured.engine;
}

// --- main (only when executed directly) -------------------------------------
const isMain = import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (!isMain) {
  // imported as a library (replay-judged.mjs) — skip the CLI run
} else {
  await main();
}
async function main() {
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const limit = Number(args[args.indexOf("--limit") + 1] || 400);
if (!file) { console.error("usage: node bench/replay-transcript.mjs <claude-transcript.jsonl> [--limit N]"); process.exit(1); }

const all = convert(file);
const roleCounts = all.reduce((acc, m) => ((acc[m.role] = (acc[m.role] ?? 0) + 1), acc), {});
const toolCalls = all.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "toolCall")).length;
console.log(`converted ${all.length} messages (${JSON.stringify(roleCounts)}, ${toolCalls} with tool calls)`);
const msgs = all.slice(0, limit);
console.log(`replaying first ${msgs.length} (--limit ${limit})`);

const fails = [];
const check = (name, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails.push(name); };
const sk = "agent:main:replay";
const text = (m) => Array.isArray(m.content) ? m.content.map((p) => p.text ?? "").join(" ") : String(m.content ?? "");

for (const mode of ["hybrid", "full"]) {
  const dir = mkdtempSync(join(tmpdir(), `cortext-replay-${mode}-`));
  try {
    console.log(`\n=== mode: ${mode} ===`);
    const eng = buildEngine(dir, { compactionMode: mode, protectTail: 6 });

    // 1. ingest everything, as OpenClaw would per turn
    let ingested = 0; const t0 = Date.now();
    for (const m of msgs) {
      const r = await eng.ingest({ sessionId: "R", sessionKey: sk, message: m });
      if (r.ingested) ingested++;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    check("ingests a real tool-heavy conversation", ingested > msgs.length * 0.9, `${ingested}/${msgs.length} in ${secs}s`);

    // 2. compact on the full view
    const view = [{ role: "system", content: "system prompt placeholder" }, ...msgs];
    await eng.assemble({ sessionId: "R", sessionKey: sk, messages: view, prompt: "status" });
    const res = await eng.compact({ sessionId: "R", sessionKey: sk });
    check("compaction archives the prefix", res.ok && res.compacted, res.reason);
    check("tokens shrink", (res.result?.tokensAfter ?? 1) < (res.result?.tokensBefore ?? 0),
      `~${res.result?.tokensBefore} -> ~${res.result?.tokensAfter}`);

    // 3. window invariants on the tool-heavy transcript
    const out = await eng.assemble({ sessionId: "R", sessionKey: sk, messages: view, prompt: "status" });
    const w = out.messages;
    check("system prompt survives", w[0]?.role === "system");
    check("bridge message present", /archived to Cortext/i.test(text(w[1] ?? {})));
    check("tail starts on a user message (no orphaned tool result)", w[2]?.role === "user", `tail[0]=${w[2]?.role}`);
    const orphan = w.findIndex((m, i) => i >= 2 && m.role === "toolResult" &&
      !w.slice(2, i).some((c) => Array.isArray(c.content) && c.content.some((p) => p.type === "toolCall")));
    check("no tool result precedes its call in the window", orphan === -1, orphan >= 0 ? `orphan at ${orphan}` : "");

    // 4. recall probes: archived user asks + archived tool output
    const archivedUsers = msgs.slice(0, Math.floor(msgs.length / 2)).filter((m) => m.role === "user" && text(m).length > 40);
    let hits = 0; const probes = archivedUsers.filter((_, i) => i % Math.ceil(archivedUsers.length / 5) === 0).slice(0, 5);
    for (const p of probes) {
      const q = text(p).slice(0, 120);
      const r = await eng.assemble({ sessionId: "R", sessionKey: sk, messages: view, prompt: q });
      if (r.systemPromptAddition) hits++;
    }
    check("archived content recalled for related queries", hits >= Math.ceil(probes.length / 2), `${hits}/${probes.length} probes returned memory`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${fails.length ? "FAILED: " + fails.join("; ") : "ALL REPLAY CHECKS PASSED"}`);
process.exit(fails.length ? 1 : 0);
}
