import { test } from "node:test";
import assert from "node:assert/strict";
import { InterruptBus } from "../dist/store.js";

test("stage accumulates and take drains", () => {
  const bus = new InterruptBus();
  bus.stage("s", "- a");
  bus.stage("s", "- b");
  assert.equal(bus.take("s"), "- a\n- b");
  assert.equal(bus.take("s"), "", "take clears the staged block");
});

test("stage ignores blank blocks", () => {
  const bus = new InterruptBus();
  bus.stage("s", "   ");
  assert.equal(bus.take("s"), "");
});

test("staging is isolated per session", () => {
  const bus = new InterruptBus();
  bus.stage("a", "- x");
  assert.equal(bus.take("b"), "");
  assert.equal(bus.take("a"), "- x");
});
