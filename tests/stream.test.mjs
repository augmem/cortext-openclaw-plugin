import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../dist/register.js";
import { fakeApi, tempDir } from "./helpers.mjs";

function ev(stream, sessionId, data) {
  return { runId: "r", seq: 0, ts: 0, stream, sessionId, sessionKey: `agent:main:${sessionId}`, data };
}

test("gate registers via api.agent.events.registerAgentEventSubscription", () => {
  const { dir, cleanup } = tempDir();
  try {
    const { subscription } = build(dir);
    assert.ok(subscription, "a subscription was registered");
    assert.equal(subscription.id, "cortext-interrupt-gate");
    assert.deepEqual(subscription.streams, ["thinking", "assistant", "lifecycle"]);
    assert.equal(typeof subscription.handle, "function");
  } finally { cleanup(); }
});

test("interruptGate=false registers no subscription", () => {
  const { dir, cleanup } = tempDir();
  try {
    const { subscription } = build(dir, { interruptGate: false });
    assert.equal(subscription, null);
  } finally { cleanup(); }
});

test("forceRepass registers a before_agent_finalize hook via api.on", () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.equal(typeof build(dir).finalizeHandler, "function", "hook registered by default");
    assert.equal(build(dir, { forceRepass: false }).finalizeHandler, null, "not registered when disabled");
  } finally { cleanup(); }
});

test("finalize handler returns nothing when the run did not interrupt", () => {
  const { dir, cleanup } = tempDir();
  try {
    const h = build(dir).finalizeHandler;
    assert.equal(h({ runId: "unseen", sessionId: "s" }), undefined, "no revise without a flagged interrupt");
  } finally { cleanup(); }
});

test("thinking deltas process without throwing", () => {
  const { dir, cleanup } = tempDir();
  try {
    const { subscription } = build(dir);
    assert.doesNotThrow(() => {
      for (const d of ["Let me reconsider the ", "deployment rollback ", "procedure.\n"]) {
        subscription.handle(ev("thinking", "s1", { delta: d }), noCtx);
      }
    });
  } finally { cleanup(); }
});

test("snapshot-only text is diffed, not double-counted", () => {
  const { dir, cleanup } = tempDir();
  try {
    const { subscription } = build(dir);
    assert.doesNotThrow(() => {
      subscription.handle(ev("assistant", "s1", { text: "The answer is " }), noCtx);
      subscription.handle(ev("assistant", "s1", { text: "The answer is 42.\n" }), noCtx);
    });
  } finally { cleanup(); }
});

test("ingestReasoning=false ignores thinking; lifecycle end is safe", () => {
  const { dir, cleanup } = tempDir();
  try {
    const { subscription } = build(dir, { ingestReasoning: false });
    assert.doesNotThrow(() => {
      subscription.handle(ev("thinking", "s1", { delta: "ignored reasoning.\n" }), noCtx);
      subscription.handle(ev("assistant", "s1", { delta: "visible answer.\n" }), noCtx);
      subscription.handle(ev("lifecycle", "s1", { phase: "end" }), noCtx);
      subscription.handle(ev("tool", "s1", { name: "x" }), noCtx);
    });
  } finally { cleanup(); }
});

const noCtx = { getRunContext: () => undefined, setRunContext: () => {}, clearRunContext: () => {} };

function build(dir, config = {}) {
  const { api, captured } = fakeApi(dir, config);
  register(api);
  return captured;
}
