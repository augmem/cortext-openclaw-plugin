import type { AgentEventPayload, AgentEventSubscription, Logger } from "./openclaw.js";
import { CortextStore, formatMemories, safe } from "./cortext.js";
import type { InterruptBus } from "./store.js";

const SEGMENT_MIN_CHARS = 120;
const BREAK = /[.!?\n]/;

type GatedStream = "thinking" | "assistant";

interface StreamBuf {
  buffer: string;
  lastLen: number;
}
function emptyBuf(): StreamBuf {
  return { buffer: "", lastLen: 0 };
}

/**
 * Piece 2: interrupt gate over streaming reasoning.
 *
 * Registered via `api.agent.events.registerAgentEventSubscription`. Buffers are
 * keyed by runId (unique per generation, always present) — NOT sessionId, which
 * is not unique across agents. When Cortext reports should_interrupt /
 * at_boundary, the recalled memory is staged on the bus under the SESSION'S
 * SCOPE KEY (the same key the context engine uses), so a different scope's
 * assemble can never drain it. On should_interrupt the run is flagged so the
 * before_agent_finalize hook can request a revise of the current answer.
 */
export class InterruptGate {
  private runs = new Map<string, { thinking: StreamBuf; assistant: StreamBuf }>();
  // runIds that fired should_interrupt. Bounded: when before_agent_finalize
  // never fires to consume an entry (--local runner, or the hook blocked
  // without allowConversationAccess), stale ids must not accumulate forever.
  private reviseRuns = new Set<string>();
  private static readonly MAX_REVISE_RUNS = 256;

  constructor(
    private readonly store: CortextStore,
    private readonly bus: InterruptBus,
    private readonly logger: Logger,
    private readonly ingestReasoning: boolean,
    private readonly recallLimit: number,
  ) {}

  subscription(): AgentEventSubscription {
    return {
      id: "cortext-interrupt-gate",
      description: "Cortext interrupt gate over streaming reasoning",
      streams: ["thinking", "assistant", "lifecycle"],
      handle: (event) => {
        try {
          this.handle(event);
        } catch (err) {
          // Distinct prefix: must never match the "cortext interrupt gate:" fire
          // logs, or a crashing handler looks like a working gate in the logs.
          this.logger.debug?.(`cortext gate error: ${String(err)}`);
        }
      },
    };
  }

  /** Consumed by the before_agent_finalize hook: did this run fire an interrupt? */
  takeRevise(runId: string | undefined): boolean {
    if (!runId || !this.reviseRuns.has(runId)) return false;
    this.reviseRuns.delete(runId);
    return true;
  }

  private handle(event: AgentEventPayload): void {
    const runId = event.runId || "run";

    if (event.stream === "lifecycle") {
      const phase = String(event.data?.phase ?? "");
      if (phase === "end" || phase === "error") this.runs.delete(runId);
      return;
    }

    let stream: GatedStream;
    if (event.stream === "thinking") {
      if (!this.ingestReasoning) return;
      stream = "thinking";
    } else if (event.stream === "assistant") {
      stream = "assistant";
    } else {
      return;
    }

    let run = this.runs.get(runId);
    if (!run) {
      run = { thinking: emptyBuf(), assistant: emptyBuf() };
      this.runs.set(runId, run);
      // One unambiguous per-run signal that the subscription is receiving events
      // (the integration test asserts on it; the fire logs are not guaranteed).
      this.logger.debug?.(`cortext gate: observing run ${runId}`);
    }
    const buf = run[stream];

    const increment = extractIncrement(event.data, buf);
    if (!increment) return;
    buf.buffer += increment;
    if (buf.buffer.length < SEGMENT_MIN_CHARS && !BREAK.test(increment)) return;

    const segment = buf.buffer.trim();
    buf.buffer = "";
    this.gate(event, runId, stream, segment);
  }

  private gate(event: AgentEventPayload, runId: string, stream: GatedStream, segment: string): void {
    if (!segment) return;
    const ids = { agentId: event.agentId, sessionKey: event.sessionKey, sessionId: event.sessionId };
    const scopeKey = this.store.scopeKey(ids);
    const engine = this.store.forScope(scopeKey);
    const ctx = engine.recall(segment, `openclaw/agent/${safe(scopeKey)}/stream/${stream}`);
    if (!ctx) return;

    if (ctx.should_interrupt || ctx.at_boundary) {
      const block = formatMemories(ctx.retrieved_memory, this.recallLimit);
      if (block) this.bus.stage(scopeKey, block); // keyed by SCOPE, not sessionId
      if (ctx.should_interrupt) {
        this.reviseRuns.add(runId);
        while (this.reviseRuns.size > InterruptGate.MAX_REVISE_RUNS) {
          const oldest = this.reviseRuns.values().next().value as string;
          this.reviseRuns.delete(oldest);
        }
      }
      const kind = ctx.should_interrupt ? "interrupt" : "boundary";
      this.logger.info(
        `cortext interrupt gate: ${kind} on ${stream} (scope ${scopeKey}) — staged ${ctx.retrieved_memory?.length ?? 0} memories`,
      );
    }
  }
}

function extractIncrement(data: Record<string, unknown> | undefined, buf: StreamBuf): string {
  if (!data) return "";
  const delta = data.delta;
  const text = data.text;
  if (typeof delta === "string") {
    buf.lastLen = typeof text === "string" ? text.length : buf.lastLen + delta.length;
    return delta;
  }
  if (typeof text === "string") {
    const inc = text.length > buf.lastLen ? text.slice(buf.lastLen) : "";
    buf.lastLen = text.length;
    return inc;
  }
  return "";
}
