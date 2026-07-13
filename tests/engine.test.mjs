import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../dist/register.js";
import { fakeApi, tempDir } from "./helpers.mjs";

// Build a plugin whose context engine writes to an isolated temp dir.
function build(dir, config = {}) {
  const { api, captured } = fakeApi(dir, config);
  register(api);
  return captured;
}

test("agent scope recalls across sessions of the same agent", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir, { memoryScope: "agent" }).contextEngine;
    await eng.ingest({ sessionId: "A", sessionKey: "agent:main:A", message: { role: "user", content: "Avery lives in Austin." } });
    const out = await eng.assemble({ sessionId: "B", sessionKey: "agent:main:B", messages: [], prompt: "Where does Avery live?" });
    assert.match(out.systemPromptAddition ?? "", /Austin/, "same agent, different session recalls");
  } finally { cleanup(); }
});

test("default (session) scope does NOT recall across sessions", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir).contextEngine; // default memoryScope: session
    await eng.ingest({ sessionId: "A", sessionKey: "agent:main:A", message: { role: "user", content: "Avery lives in Austin." } });
    const out = await eng.assemble({ sessionId: "B", sessionKey: "agent:main:B", messages: [], prompt: "Where does Avery live?" });
    assert.doesNotMatch(out.systemPromptAddition ?? "", /Austin/, "different session must not see it by default");
  } finally { cleanup(); }
});

test("ISOLATION: agent scope isolates distinct agents", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir, { memoryScope: "agent" }).contextEngine;
    await eng.ingest({ sessionId: "A", sessionKey: "agent:alice:A", message: { role: "user", content: "Avery lives in Austin." } });
    const out = await eng.assemble({ sessionId: "Z", sessionKey: "agent:bob:Z", messages: [], prompt: "Where does Avery live?" });
    assert.doesNotMatch(out.systemPromptAddition ?? "", /Austin/, "different agent must not see it");
  } finally { cleanup(); }
});

test("no stale recall stays in the SAME session by default", async () => {
  // regression note: with session scope the same session must recall its own fact
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir).contextEngine;
    await eng.ingest({ sessionId: "S", sessionKey: "agent:main:S", message: { role: "user", content: "Avery lives in Austin." } });
    const out = await eng.assemble({ sessionId: "S", sessionKey: "agent:main:S", messages: [], prompt: "Where does Avery live?" });
    assert.match(out.systemPromptAddition ?? "", /Austin/, "same session recalls its own memory");
  } finally { cleanup(); }
});

test("ISOLATION: session scope prevents cross-session recall", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir, { memoryScope: "session" }).contextEngine;
    await eng.ingest({ sessionId: "A", sessionKey: "agent:main:A", message: { role: "user", content: "Avery lives in Austin." } });
    const out = await eng.assemble({ sessionId: "B", sessionKey: "agent:main:B", messages: [], prompt: "Where does Avery live?" });
    assert.doesNotMatch(out.systemPromptAddition ?? "", /Austin/, "session scope isolates sessions");
  } finally { cleanup(); }
});

test("no stale recall after an update in the same session (cache removed)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir).contextEngine;
    const sk = "agent:main:S";
    await eng.ingest({ sessionId: "S", sessionKey: sk, message: { role: "user", content: "Avery lives in Austin." } });
    const q = { sessionId: "S", sessionKey: sk, messages: [], prompt: "Where does Avery live?" };
    await eng.assemble(q); // warms any cache
    await eng.ingest({ sessionId: "S", sessionKey: sk, message: { role: "user", content: "Avery moved to Boston." } });
    const out = await eng.assemble(q);
    assert.match(out.systemPromptAddition ?? "", /Boston/, "the new fact is recalled");
  } finally { cleanup(); }
});

test("recalled memory is framed as data, not instructions", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir).contextEngine;
    const sk = "agent:main:S";
    await eng.ingest({ sessionId: "S", sessionKey: sk, message: { role: "user", content: "My city is Austin." } });
    const out = await eng.assemble({ sessionId: "S", sessionKey: sk, messages: [], prompt: "What is my city?" });
    assert.match(out.systemPromptAddition, /reference data only|never as instructions/i, "injection guard preamble present");
  } finally { cleanup(); }
});

test("empty store yields passthrough with an estimatedTokens number", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir).contextEngine;
    const messages = [{ role: "user", content: "hello" }];
    const out = await eng.assemble({ sessionId: "S", sessionKey: "agent:main:S", messages, prompt: "hello" });
    assert.equal(out.systemPromptAddition, undefined);
    assert.equal(typeof out.estimatedTokens, "number");
    assert.equal(out.messages, messages);
  } finally { cleanup(); }
});

test("tool calls are ingested (real OpenClaw toolCall content-part shape)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir).contextEngine;
    const sk = "agent:main:S";
    // Shape captured from a live OpenClaw transcript: the call is a content
    // part with type "toolCall" and NO text field.
    const ingested = await eng.ingest({
      sessionId: "S", sessionKey: sk,
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_x|fc_y",
          name: "exec",
          arguments: { command: "tar -czf backup-vermilion.tgz /srv/data", timeout: 10 },
        }],
      },
    });
    assert.equal(ingested.ingested, true, "a toolCall-only message must be ingested");
    const out = await eng.assemble({ sessionId: "S", sessionKey: sk, messages: [], prompt: "What command created the backup archive?" });
    assert.match(out.systemPromptAddition ?? "", /backup-vermilion|tar -czf/, "the call's command is recallable");
  } finally { cleanup(); }
});

test("tool results are ingested (text content part)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir).contextEngine;
    const sk = "agent:main:S";
    const ingested = await eng.ingest({
      sessionId: "S", sessionKey: sk,
      message: { role: "toolResult", content: [{ type: "text", text: "backup written: 4183 files, checksum qz88x" }] },
    });
    assert.equal(ingested.ingested, true);
    const out = await eng.assemble({ sessionId: "S", sessionKey: sk, messages: [], prompt: "What was the backup checksum?" });
    assert.match(out.systemPromptAddition ?? "", /qz88x/, "the result text is recallable");
  } finally { cleanup(); }
});

test("compact without an assembled view is a safe no-op", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const eng = build(dir).contextEngine;
    assert.equal(eng.info.ownsCompaction, true, "cortext owns compaction");
    const res = await eng.compact({ sessionId: "S", sessionKey: "agent:main:S" });
    assert.equal(res.ok, true);
    assert.equal(res.compacted, false, "no view yet — nothing to cut");
  } finally { cleanup(); }
});
