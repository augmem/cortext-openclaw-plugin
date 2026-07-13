export type MemoryScope = "agent" | "session" | "global";

export interface CortextPluginConfig {
  dbPath: string;
  /** Isolation boundary for memory. "session" (default): one store per session
   *  — safe when an agent serves multiple users, since it never shares memory
   *  across conversations. "agent": one store per agent identity — persists
   *  across that agent's sessions; use only for single-user agents. "global":
   *  one shared store. */
  memoryScope: MemoryScope;
  focus: number;
  sensitivity: number;
  stability: number;
  recallLimit: number;
  interruptGate: boolean;
  ingestReasoning: boolean;
  /** When the gate fires should_interrupt mid-generation, request a revise via
   *  before_agent_finalize so the model reconsiders THIS answer with the recalled
   *  memory (costs one extra pass per trigger). */
  forceRepass: boolean;
  autoConsolidate: boolean;
}

// focus/stability defaults mirror the tuning carried over from the Hermes
// provider bench (F=.45 S=.50 T=.50). See cortext-hermes-plugin/bench/README.md.
export const DEFAULTS: CortextPluginConfig = {
  dbPath: "cortext",
  memoryScope: "session",
  focus: 0.45,
  sensitivity: 0.5,
  stability: 0.5,
  recallLimit: 12,
  interruptGate: true,
  ingestReasoning: true,
  forceRepass: true,
  autoConsolidate: true,
};

const SCOPES: MemoryScope[] = ["agent", "session", "global"];

export function resolveConfig(raw: Record<string, unknown> | undefined): CortextPluginConfig {
  const cfg: CortextPluginConfig = { ...DEFAULTS };
  if (!raw) return cfg;
  for (const key of Object.keys(DEFAULTS) as (keyof CortextPluginConfig)[]) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    (cfg as unknown as Record<string, unknown>)[key] = value;
  }
  if (!SCOPES.includes(cfg.memoryScope)) cfg.memoryScope = "session";
  return cfg;
}
