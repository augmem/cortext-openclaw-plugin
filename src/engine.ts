import type {
  AssembleParams,
  AssembleResult,
  CompactParams,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestParams,
  IngestResult,
  Logger,
} from "./openclaw.js";
import { CortextStore, formatMemories, memoryBlock, safe } from "./cortext.js";
import type { InterruptBus } from "./store.js";

// Bound serialized tool-call arguments so a huge payload (a file write, a long
// patch) doesn't dominate the store; the result text is ingested separately.
const TOOL_ARGS_MAX_CHARS = 2000;

/** Render a transcript content part as text. Tool calls (OpenClaw stores them
 *  as `{type:"toolCall", name, arguments}` content parts with no `text` field)
 *  are rendered as "[tool call] name {args}" so the durable record keeps WHAT
 *  the agent did, not just what came back. Parts with no textual form (images,
 *  binary payloads) yield "". */
function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const p = part as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
  if (typeof p.text === "string") return p.text;
  if (p.type === "toolCall" && typeof p.name === "string") {
    let args = "";
    try { args = p.arguments === undefined ? "" : JSON.stringify(p.arguments); } catch { /* unserializable */ }
    if (args.length > TOOL_ARGS_MAX_CHARS) args = args.slice(0, TOOL_ARGS_MAX_CHARS) + "…";
    return `[tool call] ${p.name}${args ? " " + args : ""}`;
  }
  return "";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      const text = partText(part);
      if (text) parts.push(text);
    }
    return parts.join(" ");
  }
  return "";
}

function estimateTokens(messages: { content: unknown }[]): number {
  let chars = 0;
  for (const m of messages) chars += messageText(m.content).length;
  return Math.ceil(chars / 4);
}

function latestUserText(messages: { role: string; content: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messageText(messages[i].content);
  }
  return messageText(messages[messages.length - 1]?.content);
}

/**
 * Piece 1: Cortext owns the OpenClaw context-engine slot.
 *
 * Every operation resolves the CortextStore to the isolation scope of the
 * current agent/session (see CortextStore), so memory never crosses the
 * configured boundary. Recall is not cached across turns — a stale read after a
 * fresh ingest was a bug; each assemble queries Cortext live.
 */
export class CortextContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "cortext",
    name: "Cortext Memory",
    version: "0.1.2",
    ownsCompaction: false,
  };

  constructor(
    private readonly store: CortextStore,
    private readonly bus: InterruptBus,
    private readonly logger: Logger,
    private readonly autoConsolidate: boolean,
    private readonly recallLimit: number,
  ) {}

  async ingest(params: IngestParams): Promise<IngestResult> {
    const role = String(params.message?.role ?? "user");
    const text = messageText(params.message?.content);
    if (!text.trim()) return { ingested: false };
    const engine = this.store.for({ sessionKey: params.sessionKey, sessionId: params.sessionId });
    const ctx = engine.ingest(text, this.source(params.sessionId, role, "ingest"));
    return { ingested: ctx !== null };
  }

  async assemble(params: AssembleParams): Promise<AssembleResult> {
    const estimatedTokens = estimateTokens(params.messages);
    const query = (params.prompt ?? latestUserText(params.messages)).trim();
    if (!query) return { messages: params.messages, estimatedTokens };

    const scopeKey = this.store.scopeKey({ sessionKey: params.sessionKey, sessionId: params.sessionId });
    const engine = this.store.forScope(scopeKey);
    const ctx = engine.recall(query, this.source(params.sessionId, "agent", "assemble"));
    const recalled = ctx ? formatMemories(ctx.retrieved_memory, this.recallLimit) : "";
    // Drain what the gate staged mid-generation, keyed by the SAME scope key —
    // so a different scope's assemble can never pick it up.
    const staged = this.bus.take(scopeKey);
    const body = [staged, recalled].filter(Boolean).join("\n");
    if (!body) return { messages: params.messages, estimatedTokens };

    return {
      messages: params.messages,
      estimatedTokens,
      systemPromptAddition: memoryBlock(body),
    };
  }

  async compact(params: CompactParams): Promise<CompactResult> {
    // Cortext memory persists out-of-band; consolidate its graph, delegate
    // transcript compaction to the host. (Compact params carry no agentId in
    // the real openclaw types; agent scope derives from the sessionKey.)
    const engine = this.store.for({ sessionKey: params.sessionKey, sessionId: params.sessionId });
    if (this.autoConsolidate) engine.consolidate();
    engine.flush();
    return { ok: true, compacted: false, reason: "cortext retains memory out-of-band; transcript compaction delegated to host" };
  }

  async dispose(): Promise<void> {
    this.store.disposeAll();
  }

  private source(sessionId: string, role: string, stage: string): string {
    return ["openclaw", role, safe(sessionId), stage].join("/");
  }
}
