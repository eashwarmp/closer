// The buyer's side of the conversation: utterances arrive at any time (typed, simulated, or
// transcribed speech) and queue here until the agent reads them.

type Listener = (text: string | null) => void;

export class BuyerChannel {
  private queue: string[] = [];
  private listeners = new Set<Listener>();
  private closed = false;

  push(text: string): void {
    if (this.closed || !text.trim()) return;
    this.queue.push(text.trim());
    for (const l of [...this.listeners]) l(text.trim());
  }

  get pending(): number {
    return this.queue.length;
  }

  drain(): string[] {
    return this.queue.splice(0);
  }

  /** Subscribe to new utterances. Returns an unsubscribe function. */
  onPush(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Next utterance, or null if the channel closes or the timeout passes first. */
  next(timeoutMs = Infinity): Promise<string | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (v: string | null) => {
        clearTimeout(timer);
        off();
        resolve(v);
      };
      const off = this.onPush(() => done(this.queue.length ? this.queue.shift()! : null));
      if (Number.isFinite(timeoutMs)) timer = setTimeout(() => done(null), timeoutMs);
    });
  }

  close(): void {
    this.closed = true;
    for (const l of [...this.listeners]) l(null);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
