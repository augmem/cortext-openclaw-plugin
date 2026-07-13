export type MemoryScope = "agent" | "session" | "global";

/** How Cortext compacts the model-visible window (`ownsCompaction`):
 *  - "hybrid": keep system prompt + recalled long-term memory + a verbatim
 *    tail of recent messages (exchange-aligned). Safe default.
 *  - "full": keep system prompt + Cortext memory only (long-term recall plus
 *    the live working-memory snapshot); the verbatim window shrinks to the
 *    current exchange. Maximum token savings — memory IS the context. */
export type CompactionMode = "hybrid" | "full";

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
  /** Compaction window mode (see CompactionMode). */
  compactionMode: CompactionMode;
  /** Hybrid mode: number of trailing messages kept verbatim (the cut is walked
   *  back to a user-message boundary so the tail is a self-contained exchange). */
  protectTail: number;
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
  compactionMode: "hybrid",
  protectTail: 6,
};

const SCOPES: MemoryScope[] = ["agent", "session", "global"];
const COMPACTION_MODES: CompactionMode[] = ["hybrid", "full"];

export function resolveConfig(raw: Record<string, unknown> | undefined): CortextPluginConfig {
  const cfg: CortextPluginConfig = { ...DEFAULTS };
  if (!raw) return cfg;
  for (const key of Object.keys(DEFAULTS) as (keyof CortextPluginConfig)[]) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    (cfg as unknown as Record<string, unknown>)[key] = value;
  }
  if (!SCOPES.includes(cfg.memoryScope)) cfg.memoryScope = "session";
  if (!COMPACTION_MODES.includes(cfg.compactionMode)) cfg.compactionMode = "hybrid";
  if (!Number.isFinite(cfg.protectTail) || cfg.protectTail < 0) cfg.protectTail = 6;
  return cfg;
}
