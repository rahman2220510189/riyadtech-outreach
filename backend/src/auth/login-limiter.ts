/**
 * Per-account lockout, on top of the per-IP rate limit.
 * The IP limit can be dodged by an attacker who spoofs X-Forwarded-For when calling
 * the backend directly; this one counts failed passwords per e-mail no matter the IP.
 * In memory: one process, one admin. Resets when the service restarts.
 */
export interface LoginLimiterOptions {
  maxFailures: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}

interface Entry {
  failures: number;
  firstAt: number;
}

export class LoginLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly opts: LoginLimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  /** Milliseconds until the key may try again, or 0 if allowed now. */
  retryAfterMs(key: string): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    const age = this.now() - e.firstAt;
    if (age >= this.opts.windowMs) {
      this.entries.delete(key);
      return 0;
    }
    return e.failures >= this.opts.maxFailures ? this.opts.windowMs - age : 0;
  }

  recordFailure(key: string): void {
    this.prune();
    const e = this.entries.get(key);
    if (!e || this.now() - e.firstAt >= this.opts.windowMs) {
      this.entries.set(key, { failures: 1, firstAt: this.now() });
    } else {
      e.failures++;
    }
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private prune(): void {
    if (this.entries.size < this.maxKeys) return;
    const t = this.now();
    for (const [k, e] of this.entries) if (t - e.firstAt >= this.opts.windowMs) this.entries.delete(k);
    // Still full (flood of distinct e-mails): drop the oldest entries.
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
