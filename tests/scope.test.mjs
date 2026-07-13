import { test } from "node:test";
import assert from "node:assert/strict";
import { CortextStore } from "../dist/cortext.js";
import { resolveConfig } from "../dist/config.js";

const store = (scope) => new CortextStore(resolveConfig({ memoryScope: scope }), "/tmp/x");

test("session scope: distinct session keys give distinct stores (no collapse)", () => {
  const s = store("session");
  const keys = ["agent:main:A", "agent:main:B", "telegram:alice", "telegram:bob", "alice-session"].map((sk) =>
    s.scopeKey({ sessionKey: sk }),
  );
  assert.equal(new Set(keys).size, keys.length, "every distinct session key maps to a distinct scope");
});

test("agent scope: canonical agent id separates agents", () => {
  const s = store("agent");
  assert.notEqual(s.scopeKey({ sessionKey: "agent:alice:A" }), s.scopeKey({ sessionKey: "agent:bob:Z" }));
});

test("agent scope: absent/non-canonical agent normalizes to main (like OpenClaw)", () => {
  const s = store("agent");
  const main = s.scopeKey({ sessionKey: "agent:main:A" });
  assert.equal(s.scopeKey({ sessionKey: "telegram:alice" }), main, "non-canonical key has no agent -> main");
  assert.equal(s.scopeKey({ sessionId: "loose" }), main);
});

test("scope key folds in the session key, not just sessionId", () => {
  // Two different agents sharing a sessionId must NOT collide under agent scope.
  const s = store("agent");
  const a = s.scopeKey({ sessionKey: "agent:alice:X", sessionId: "X" });
  const b = s.scopeKey({ sessionKey: "agent:bob:X", sessionId: "X" });
  assert.notEqual(a, b, "same sessionId, different agent -> different scope");
});
