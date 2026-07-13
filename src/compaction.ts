import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "./openclaw.js";

/**
 * Compaction as a window over the transcript, not transcript surgery.
 *
 * When the host asks the engine to compact (ownsCompaction: true), we pick an
 * exchange-aligned cut point in the last assembled view and remember the first
 * KEPT message as an anchor. Every subsequent assemble() drops the prefix
 * before the anchor and bridges it with Cortext memory — the on-disk transcript
 * is never mutated, so nothing is destroyed and anything dropped remains
 * recallable from the durable store.
 *
 * The anchor is content-based (role + text prefix), not positional: if the
 * host rotates or rewrites the transcript and the anchor vanishes, the window
 * self-heals by clearing (worst case the context regrows until the next
 * compaction — never over-drops).
 */

export interface CompactionAnchor {
  role: string;
  /** First KEEP_PREFIX_CHARS of the anchor message's extracted text. */
  textPrefix: string;
  /** Messages dropped when the anchor was set (telemetry only). */
  dropped: number;
  ts: number;
}

const KEEP_PREFIX_CHARS = 200;
const STATE_FILE = "compaction.json";

export class CompactionState {
  private anchors = new Map<string, CompactionAnchor>();
  private loadedFrom: string | null = null;

  /** Load persisted anchors from the store dir (idempotent per dir). */
  load(dir: string): void {
    if (this.loadedFrom === dir) return;
    this.loadedFrom = dir;
    try {
      const raw = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf-8")) as Record<string, CompactionAnchor>;
      this.anchors = new Map(Object.entries(raw));
    } catch { /* first run or unreadable — start empty */ }
  }

  get(scopeKey: string): CompactionAnchor | undefined {
    return this.anchors.get(scopeKey);
  }

  set(scopeKey: string, anchor: CompactionAnchor, dir: string): void {
    this.anchors.set(scopeKey, anchor);
    this.persist(dir);
  }

  clear(scopeKey: string, dir: string): void {
    if (this.anchors.delete(scopeKey)) this.persist(dir);
  }

  private persist(dir: string): void {
    try {
      writeFileSync(join(dir, STATE_FILE), JSON.stringify(Object.fromEntries(this.anchors)), "utf-8");
    } catch { /* best-effort — state also lives in memory */ }
  }
}

export function anchorFor(message: AgentMessage, extract: (content: unknown) => string, dropped: number): CompactionAnchor {
  return {
    role: String(message.role ?? ""),
    textPrefix: extract(message.content).slice(0, KEEP_PREFIX_CHARS),
    dropped,
    ts: Date.now(),
  };
}

export function matchesAnchor(message: AgentMessage, anchor: CompactionAnchor, extract: (content: unknown) => string): boolean {
  return String(message.role ?? "") === anchor.role &&
    extract(message.content).slice(0, KEEP_PREFIX_CHARS) === anchor.textPrefix;
}

/**
 * Choose the index of the first message to KEEP.
 *
 * - "full": keep from the last user message onward (the current exchange).
 * - "hybrid": keep the last `protectTail` messages, then walk the cut back to
 *   a user message so the tail starts on a self-contained exchange (never on a
 *   tool result or mid tool-exchange).
 *
 * System-role messages are ignored here — the caller always keeps them.
 * Returns 0 when there is nothing worth cutting.
 */
export function chooseCut(messages: AgentMessage[], mode: "hybrid" | "full", protectTail: number): number {
  const lastUser = (from: number): number => {
    for (let i = from; i >= 0; i--) {
      if (messages[i]?.role === "user") return i;
    }
    return 0;
  };
  if (mode === "full") return lastUser(messages.length - 1);
  let cut = Math.max(0, messages.length - Math.max(1, protectTail));
  cut = lastUser(cut);
  return cut;
}

/**
 * Cold-start fallback: when compact() runs before any assemble in this process
 * (the host's preflight compaction on a fresh gateway), read the message
 * entries straight from the transcript jsonl. Linear read of `type:"message"`
 * entries — good enough to pick a cut; if a branched/rotated DAG makes the
 * anchor stale, assemble's anchor-miss self-heal clears it rather than
 * over-dropping.
 */
export function readTranscriptMessages(sessionFile: string | undefined): AgentMessage[] {
  if (!sessionFile) return [];
  let raw: string;
  try { raw = readFileSync(sessionFile, "utf-8"); } catch { return []; }
  const messages: AgentMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; content?: unknown } };
      if (entry.type === "message" && entry.message && typeof entry.message.role === "string") {
        messages.push(entry.message as AgentMessage);
      }
    } catch { /* skip malformed line */ }
  }
  return messages;
}

/** The bridge message inserted where the archived prefix used to be. */
export function bridgeMessage(mode: "hybrid" | "full"): AgentMessage {
  const wm = mode === "full" ? " and its working-memory snapshot" : "";
  return {
    role: "user",
    content:
      `[Earlier conversation was archived to Cortext durable memory. ` +
      `Relevant context is recalled into the system prompt each turn${wm}. ` +
      `Continue the conversation naturally.]`,
  };
}
