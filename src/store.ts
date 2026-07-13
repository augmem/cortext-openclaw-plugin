/**
 * Hand-off from the interrupt-gate subscription (piece 2) to the context engine
 * (piece 1). When the gate fires mid-generation it stages the recalled memory
 * here, keyed by session; the next assemble() for that session drains and
 * injects it. The staged text was recalled from the session's scoped Cortext
 * store, so draining it introduces no cross-scope leak.
 */
// A staged block whose scope never assembles again (session ended mid-run)
// would otherwise sit forever; keep the bus bounded, dropping the oldest.
const MAX_PENDING = 128;

export class InterruptBus {
  private pending = new Map<string, string>();

  stage(sessionId: string, block: string): void {
    if (!block.trim()) return;
    const prev = this.pending.get(sessionId);
    this.pending.delete(sessionId); // re-insert as most recent
    this.pending.set(sessionId, prev ? `${prev}\n${block}` : block);
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value as string;
      this.pending.delete(oldest);
    }
  }

  take(sessionId: string): string {
    const block = this.pending.get(sessionId) ?? "";
    this.pending.delete(sessionId);
    return block;
  }
}
