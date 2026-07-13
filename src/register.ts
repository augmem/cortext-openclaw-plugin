import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "./openclaw.js";
import { resolveConfig } from "./config.js";
import { CortextStore } from "./cortext.js";
import { CortextContextEngine } from "./engine.js";
import { InterruptGate } from "./stream.js";
import { InterruptBus } from "./store.js";

/**
 * Wire the plugin into the injected OpenClaw `api`, using only the real,
 * installed api surface (verified against openclaw's dist types):
 *   - api.registerContextEngine(id, factory)
 *   - api.agent.events.registerAgentEventSubscription(sub)   — streaming gate
 *   - api.on("before_agent_finalize", handler)               — re-pass on interrupt
 */
export function register(api: OpenClawPluginApi): void {
  const cfg = resolveConfig(api.pluginConfig);
  const bus = new InterruptBus();
  const store = new CortextStore(cfg, join(homedir(), ".openclaw", "cortext"));

  api.registerContextEngine("cortext", (ctx) => {
    store.setBaseDir(ctx?.agentDir);
    return new CortextContextEngine(store, bus, api.logger, cfg.autoConsolidate, cfg.recallLimit);
  });

  if (cfg.interruptGate) {
    const gate = new InterruptGate(store, bus, api.logger, cfg.ingestReasoning, cfg.recallLimit);
    api.agent.events.registerAgentEventSubscription(gate.subscription());

    // When the gate flagged an interrupt for this run, veto the finished answer
    // and ask the harness to revise it — the re-pass's assemble drains the
    // memory the gate staged (under the same scope key), so the model corrects
    // the CURRENT answer, not just a later turn.
    if (cfg.forceRepass) {
      api.on("before_agent_finalize", (event) => {
        api.logger.debug?.(`cortext: before_agent_finalize (run ${event.runId})`);
        if (!gate.takeRevise(event.runId)) return;
        api.logger.info(`cortext: revising answer on interrupt (run ${event.runId})`);
        return {
          action: "revise",
          reason: "Cortext recalled memory relevant to this answer; reconsider it with that memory in context.",
          retry: { instruction: "Recalled memory has been added to context. Reconcile your answer with it.", maxAttempts: 1 },
        };
      });
    }
  }

  api.logger.info(`cortext plugin: context engine active (scope=${cfg.memoryScope}, gate=${cfg.interruptGate}, repass=${cfg.forceRepass})`);
}
