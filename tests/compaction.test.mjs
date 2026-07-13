import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../dist/register.js";
import { fakeApi, tempDir } from "./helpers.mjs";

function build(dir, config = {}) {
  const { api, captured } = fakeApi(dir, config);
  register(api);
  return captured;
}

const sk = "agent:main:S";
const u = (text) => ({ role: "user", content: text });
const a = (text) => ({ role: "assistant", content: text });
const sys = (text) => ({ role: "system", content: text });

/** A ten-message conversation with a distinctive early fact. The middle is
 *  padded to realistic length so the archived prefix outweighs the bridge. */
const PAD = " Detailed discussion followed covering rollout sequencing, canary analysis, dashboards, alert thresholds, and rollback drills.".repeat(4);
function transcript() {
  return [
    sys("You are a helpful assistant."),
    u("Please remember: the deploy freeze ends on the 14th." + PAD),
    a("Noted — the deploy freeze ends on the 14th." + PAD),
    u("Also the staging environment refreshes weekly." + PAD),
    a("Understood." + PAD),
    u("What did we decide about retries?"),
    a("Three retries with exponential backoff."),
    u("Draft the rollout plan."),
    a("Here is the rollout plan draft: ship canary first."),
    u("Looks good. What is next?"),
  ];
}

async function warmIngest(eng, msgs) {
  for (const m of msgs) {
    if (m.role === "system") continue;
    await eng.ingest({ sessionId: "S", sessionKey: sk, message: m });
  }
}

test("hybrid compaction: system + bridge + exchange-aligned tail; prefix dropped", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir, { compactionMode: "hybrid", protectTail: 4 }).contextEngine;
    const msgs = transcript();
    await warmIngest(eng, msgs);
    await eng.assemble({ sessionId: "S", sessionKey: sk, messages: msgs, prompt: "What is next?" });

    const res = await eng.compact({ sessionId: "S", sessionKey: sk });
    assert.equal(res.ok, true);
    assert.equal(res.compacted, true);
    assert.ok(res.result.tokensAfter < res.result.tokensBefore, "window must shrink");

    const out = await eng.assemble({ sessionId: "S", sessionKey: sk, messages: msgs, prompt: "What is next?" });
    assert.equal(out.promptAuthority, "assembled");
    assert.equal(out.messages[0].role, "system", "system prompt survives");
    assert.match(String(out.messages[1].content), /archived to Cortext/i, "bridge message present");
    assert.equal(out.messages[2].role, "user", "tail starts on a user message (exchange-aligned)");
    assert.ok(out.messages.length < msgs.length, "prefix was dropped");
    const flat = out.messages.map((m) => String(m.content)).join(" ");
    assert.doesNotMatch(flat, /deploy freeze/, "archived prefix is out of the verbatim window");
  } finally { cleanup(); }
});

test("hybrid compaction: archived fact remains recallable via memory injection", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir, { compactionMode: "hybrid", protectTail: 4 }).contextEngine;
    const msgs = transcript();
    await warmIngest(eng, msgs);
    await eng.assemble({ sessionId: "S", sessionKey: sk, messages: msgs, prompt: "next" });
    await eng.compact({ sessionId: "S", sessionKey: sk });

    const out = await eng.assemble({
      sessionId: "S", sessionKey: sk, messages: msgs,
      prompt: "When does the deploy freeze end?",
    });
    assert.match(out.systemPromptAddition ?? "", /14th|deploy freeze/i, "dropped fact comes back through recall");
  } finally { cleanup(); }
});

test("full compaction: window shrinks to the current exchange, working memory rides along", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir, { compactionMode: "full" }).contextEngine;
    const msgs = transcript();
    await warmIngest(eng, msgs);
    await eng.assemble({ sessionId: "S", sessionKey: sk, messages: msgs, prompt: "What is next?" });

    const res = await eng.compact({ sessionId: "S", sessionKey: sk });
    assert.equal(res.compacted, true);

    const out = await eng.assemble({ sessionId: "S", sessionKey: sk, messages: msgs, prompt: "What is next?" });
    // system + bridge + last user message only
    assert.equal(out.messages.length, 3, `full mode keeps system+bridge+current exchange (got ${out.messages.length})`);
    assert.equal(out.messages[2].role, "user");
    assert.match(String(out.messages[2].content), /What is next/, "current prompt survives verbatim");
    assert.ok(out.systemPromptAddition, "memory block present in full mode");
  } finally { cleanup(); }
});

test("anchor persists across engine instances (gateway restart)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const msgs = transcript();
    const first = build(dir, { compactionMode: "hybrid", protectTail: 4 }).contextEngine;
    await warmIngest(first, msgs);
    await first.assemble({ sessionId: "S", sessionKey: sk, messages: msgs, prompt: "next" });
    await first.compact({ sessionId: "S", sessionKey: sk });

    const second = build(dir, { compactionMode: "hybrid", protectTail: 4 }).contextEngine;
    const out = await second.assemble({ sessionId: "S", sessionKey: sk, messages: msgs, prompt: "next" });
    assert.equal(out.promptAuthority, "assembled", "window survives a restart via the sidecar");
    assert.ok(out.messages.length < msgs.length);
  } finally { cleanup(); }
});

test("missing anchor self-heals: never over-drops after a transcript rewrite", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir, { compactionMode: "hybrid", protectTail: 4 }).contextEngine;
    const msgs = transcript();
    await warmIngest(eng, msgs);
    await eng.assemble({ sessionId: "S", sessionKey: sk, messages: msgs, prompt: "next" });
    await eng.compact({ sessionId: "S", sessionKey: sk });

    // Simulate the host rotating the transcript: the anchor message is gone.
    const rotated = [sys("You are a helpful assistant."), u("Fresh start."), a("Hi."), u("Continue.")];
    const out = await eng.assemble({ sessionId: "S", sessionKey: sk, messages: rotated, prompt: "Continue." });
    assert.equal(out.promptAuthority, undefined, "no windowing without the anchor");
    assert.equal(out.messages.length, rotated.length, "nothing dropped");

    // And the cleared state stays cleared on the next assemble too.
    const again = await eng.assemble({ sessionId: "S", sessionKey: sk, messages: rotated, prompt: "Continue." });
    assert.equal(again.messages.length, rotated.length);
  } finally { cleanup(); }
});

test("cold-start compact falls back to the transcript file (preflight before any assemble)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sessionFile = join(dir, "S.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "S" }),
      ...transcript().filter((m) => m.role !== "system").map((m) =>
        JSON.stringify({ type: "message", message: m })),
    ];
    writeFileSync(sessionFile, lines.join("\n") + "\n");

    // Fresh engine, NO assemble first — exactly the preflight path.
    const eng = build(dir, { compactionMode: "hybrid", protectTail: 4 }).contextEngine;
    const res = await eng.compact({ sessionId: "S", sessionKey: sk, sessionFile });
    assert.equal(res.ok, true);
    assert.equal(res.compacted, true, "cold-start compact must work from the transcript file");

    const out = await eng.assemble({ sessionId: "S", sessionKey: sk, messages: transcript(), prompt: "next" });
    assert.equal(out.promptAuthority, "assembled", "anchor from the file-based cut applies");
  } finally { cleanup(); }
});

test("compaction state is per scope: another session keeps its full window", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir, { compactionMode: "hybrid", protectTail: 4 }).contextEngine;
    const msgs = transcript();
    await eng.assemble({ sessionId: "A", sessionKey: "agent:main:A", messages: msgs, prompt: "next" });
    await eng.compact({ sessionId: "A", sessionKey: "agent:main:A" });

    const other = await eng.assemble({ sessionId: "B", sessionKey: "agent:main:B", messages: msgs, prompt: "next" });
    assert.equal(other.messages.length, msgs.length, "scope B is not windowed by scope A's compaction");
  } finally { cleanup(); }
});

test("repeat compaction is a no-op when only the protected tail remains", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir, { compactionMode: "hybrid", protectTail: 8 }).contextEngine;
    const short = [sys("s"), u("hello"), a("hi"), u("ok")];
    await eng.assemble({ sessionId: "S", sessionKey: sk, messages: short, prompt: "ok" });
    const res = await eng.compact({ sessionId: "S", sessionKey: sk });
    assert.equal(res.compacted, false, "nothing before the protected window");
  } finally { cleanup(); }
});
