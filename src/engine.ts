import type {
  AgentMessage,
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
import type { CortextPluginConfig } from "./config.js";
import { CortextStore, dedupeAgainstWindow, formatMemories, memoryBlock, safe } from "./cortext.js";
import { CompactionState, anchorFor, bridgeMessage, chooseCut, matchesAnchor, readTranscriptMessages } from "./compaction.js";
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
    version: "0.2.3",
    ownsCompaction: true,
  };

  /** Last full (pre-window) assembled view per scope — compact() picks its cut
   *  from this, since CompactParams carry no messages. */
  private lastView = new Map<string, AgentMessage[]>();
  private compaction = new CompactionState();

  constructor(
    private readonly store: CortextStore,
    private readonly bus: InterruptBus,
    private readonly logger: Logger,
    private readonly cfg: CortextPluginConfig,
  ) {}

  async ingest(params: IngestParams): Promise<IngestResult> {
    const role = String(params.message?.role ?? "user");
    const text = messageText(params.message?.content);
    if (!text.trim()) return { ingested: false };
    const engine = this.store.for({ sessionKey: params.sessionKey, sessionId: params.sessionId });
    const ctx = engine.ingest(text, this.source(params.sessionId, role, "ingest"));
    // Consolidation happens at compaction only (autoConsolidate). The engine's
    // throughput hint (consolidation_state, ≥1.2.2) is deliberately NOT acted
    // on at ingest: measured retrieval is identical with or without it, and
    // the envelope behind the hint is being reworked upstream — compact-time
    // consolidation is the safe cadence until it settles.
    return { ingested: ctx !== null };
  }

  async assemble(params: AssembleParams): Promise<AssembleResult> {
    const scopeKey = this.store.scopeKey({ sessionKey: params.sessionKey, sessionId: params.sessionId });
    // Remember the full pre-window view: compact() picks its cut from it.
    this.lastView.set(scopeKey, params.messages);

    const { messages, windowed } = this.applyWindow(scopeKey, params.messages);
    const estimatedTokens = estimateTokens(messages);
    const query = (params.prompt ?? latestUserText(params.messages)).trim();

    const engine = this.store.forScope(scopeKey);
    const ctx = query ? engine.recall(query, this.source(params.sessionId, "agent", "assemble")) : null;
    const recalled = ctx ? formatMemories(ctx.retrieved_memory, this.cfg.recallLimit) : "";
    // Any mode with an active window: recently-archived facts may still be
    // outside query-relevant recall (small stores return a small top-k), but
    // the live working-memory snapshot — which rides along with the same
    // recall call at no extra cost — still spans them. Inject it, minus
    // items already covered verbatim by the kept tail.
    const working = windowed && ctx
      ? formatMemories(
          dedupeAgainstWindow(ctx.working_memory, messages.map((m) => messageText(m.content))),
          this.cfg.recallLimit,
        )
      : "";
    // Drain what the gate staged mid-generation, keyed by the SAME scope key —
    // so a different scope's assemble can never pick it up.
    const staged = this.bus.take(scopeKey);
    const body = [staged, recalled, working].filter(Boolean).join("\n");

    return {
      messages,
      estimatedTokens,
      ...(windowed ? { promptAuthority: "assembled" as const } : {}),
      ...(body ? { systemPromptAddition: memoryBlock(body) } : {}),
    };
  }

  /** Drop the archived prefix (everything before the anchor), keeping system
   *  messages and bridging with a note. Self-heals if the anchor is gone. */
  private applyWindow(scopeKey: string, messages: AgentMessage[]): { messages: AgentMessage[]; windowed: boolean } {
    const dir = this.store.storeDir();
    this.compaction.load(dir);
    const anchor = this.compaction.get(scopeKey);
    if (!anchor) return { messages, windowed: false };

    // The anchor text can occur more than once (repeated short user messages,
    // self-quoting transcripts): an early duplicate would silently keep the
    // whole conversation; a late one would over-drop. Disambiguate with the
    // anchor's recorded position — `dropped` counts the non-system messages
    // before the true cut, and the prefix is immutable while windowed, so the
    // right occurrence is the one at that exact position (fall back to the
    // first match at or past it if the host inserted messages).
    let idx = -1;
    let fallbackIdx = -1;
    let nonSystem = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "system") continue;
      if (matchesAnchor(messages[i], anchor, messageText)) {
        if (nonSystem === anchor.dropped) { idx = i; break; }
        if (nonSystem > anchor.dropped && fallbackIdx < 0) fallbackIdx = i;
      }
      nonSystem++;
    }
    if (idx < 0) idx = fallbackIdx;
    if (idx < 0) {
      // Transcript rotated/rewritten under us — never over-drop; regrow instead.
      this.compaction.clear(scopeKey, dir);
      return { messages, windowed: false };
    }
    if (idx === 0) return { messages, windowed: false };

    const head = messages.slice(0, idx).filter((m) => m.role === "system");
    return { messages: [...head, bridgeMessage(this.cfg.compactionMode), ...messages.slice(idx)], windowed: true };
  }

  async compact(params: CompactParams): Promise<CompactResult> {
    // Compaction = moving the window, not destroying the transcript. Every
    // message is already in the durable store (ingest), so we pick an
    // exchange-aligned cut in the last assembled view, anchor it, and let
    // assemble() drop the archived prefix from the model context. The on-disk
    // transcript is untouched; dropped content stays recallable. No LLM call.
    // (Compact params carry no agentId in the real openclaw types; agent scope
    // derives from the sessionKey.)
    const scopeKey = this.store.scopeKey({ sessionKey: params.sessionKey, sessionId: params.sessionId });
    const engine = this.store.forScope(scopeKey);
    if (this.cfg.autoConsolidate) engine.consolidate();
    engine.flush();

    // Preflight compaction on a fresh gateway process runs before any
    // assemble — fall back to reading the transcript file so a cold-start
    // compact still works (returning compacted:false here fails the turn).
    const view = this.lastView.get(scopeKey) ?? readTranscriptMessages(params.sessionFile);
    if (!view.length) {
      return { ok: true, compacted: false, reason: "no assembled view or readable transcript for this scope" };
    }
    const cut = chooseCut(view, this.cfg.compactionMode, this.cfg.protectTail);
    const dropped = view.slice(0, cut).filter((m) => m.role !== "system").length;
    if (cut <= 0 || dropped === 0) {
      return { ok: true, compacted: false, reason: "nothing before the protected window to archive" };
    }

    const dir = this.store.storeDir();
    this.compaction.load(dir);
    this.compaction.set(scopeKey, anchorFor(view[cut], messageText, dropped), dir);

    const tokensBefore = estimateTokens(view);
    const kept = this.applyWindow(scopeKey, view).messages;
    const tokensAfter = estimateTokens(kept);
    const summary =
      `Archived ${dropped} message(s) to Cortext durable memory ` +
      `(${this.cfg.compactionMode} mode; recalled per turn, no summarizer LLM call).`;
    this.logger.info(
      `cortext compaction: ${summary} ~${tokensBefore} -> ~${tokensAfter} tokens (scope ${scopeKey})`,
    );
    return { ok: true, compacted: true, reason: summary, result: { summary, tokensBefore, tokensAfter } };
  }

  async dispose(): Promise<void> {
    this.store.disposeAll();
  }

  private source(sessionId: string, role: string, stage: string): string {
    return ["openclaw", role, safe(sessionId), stage].join("/");
  }
}
