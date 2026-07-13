import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway temp dir for Cortext SQLite stores, cleaned up by the caller. */
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "cortext-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * A fake OpenClaw `api` that mirrors the REAL installed surface:
 *   api.agent.events.registerAgentEventSubscription(sub)
 *   api.registerContextEngine(id, factory)
 *   api.on("before_agent_finalize", handler)
 *   api.resolvePath(p)
 * It deliberately provides NOTHING else (no api.runtime, no registerHook), so a
 * call to an unsupported method throws in tests (the bug the old stub hid).
 *
 * `agentDir` is passed to the context-engine factory (Cortext writes its stores
 * there), giving each test an isolated on-disk location.
 */
export function fakeApi(dir, pluginConfig = {}) {
  const captured = { contextEngine: null, subscription: null, finalizeHandler: null };
  const api = {
    id: "cortext",
    config: {},
    pluginConfig,
    logger: silentLogger,
    resolvePath: (p) => join(dir, p),
    agent: {
      events: {
        registerAgentEventSubscription: (sub) => { captured.subscription = sub; },
      },
    },
    registerContextEngine: (_id, factory) => {
      captured.contextEngine = factory({ agentDir: dir });
    },
    on: (event, handler) => {
      if (event === "before_agent_finalize") captured.finalizeHandler = handler;
    },
    registerService: () => { throw new Error("registerService should not be used"); },
  };
  return { api, captured };
}
