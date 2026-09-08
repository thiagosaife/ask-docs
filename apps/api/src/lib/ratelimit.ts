/**
 * Token-bucket rate limiter. In-memory for a single instance; the interface is what a Redis-backed
 * implementation would satisfy.
 */
export interface RateLimiter {
  /** Returns true and consumes a token when allowed. */
  take(key: string, now?: number): { ok: boolean; retryAfterMs: number };
}

export interface BucketOptions {
  capacity: number; // burst size
  refillPerMs: number; // tokens added per millisecond
}

export class MemoryTokenBucket implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private lastSweep = 0;

  constructor(private readonly opts: BucketOptions) {}

  take(key: string, now = Date.now()): { ok: boolean; retryAfterMs: number } {
    this.sweep(now);
    const b = this.buckets.get(key) ?? { tokens: this.opts.capacity, updated: now };
    const elapsed = Math.max(0, now - b.updated);
    b.tokens = Math.min(this.opts.capacity, b.tokens + elapsed * this.opts.refillPerMs);
    b.updated = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return { ok: true, retryAfterMs: 0 };
    }
    this.buckets.set(key, b);
    return { ok: false, retryAfterMs: Math.ceil((1 - b.tokens) / this.opts.refillPerMs) };
  }

  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const fullAfter = this.opts.capacity / this.opts.refillPerMs;
    for (const [k, b] of this.buckets) if (now - b.updated > fullAfter) this.buckets.delete(k);
  }
}

/** Per-site daily answer budget; resets at UTC midnight. */
export class DailyBudget {
  private readonly counts = new Map<string, { day: string; n: number }>();

  take(key: string, limit: number, now = new Date()): { ok: boolean; used: number } {
    const day = now.toISOString().slice(0, 10);
    const c = this.counts.get(key);
    const cur = c && c.day === day ? c : { day, n: 0 };
    if (cur.n >= limit) return { ok: false, used: cur.n };
    cur.n += 1;
    this.counts.set(key, cur);
    return { ok: true, used: cur.n };
  }
}
