/**
 * Concurrency primitives for the parallel runner (no dependencies).
 *
 *   Semaphore  — counting semaphore whose limit can change at runtime
 *                (the adaptive controller raises/lowers it; lowering never
 *                interrupts holders, it only delays new acquisitions).
 *   mapLimit   — run an async mapper over items with bounded concurrency.
 *   backoffMs  — bounded exponential backoff with jitter.
 */

class Semaphore {
  constructor(limit, { name = 'semaphore', min = 1, max = Infinity } = {}) {
    this.name = name;
    this.min = min;
    this.max = max;
    this._limit = Math.max(min, Math.min(max, limit));
    this.active = 0;
    this.waiters = [];
  }

  get limit() {
    return this._limit;
  }

  get waiting() {
    return this.waiters.length;
  }

  setLimit(n) {
    this._limit = Math.max(this.min, Math.min(this.max, Math.round(n)));
    this._drain();
    return this._limit;
  }

  /** Resolves with a one-shot release function once a slot is free. */
  acquire() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this._drain();
    });
  }

  /** Reject everyone still waiting (used on shutdown). */
  rejectWaiters(err) {
    const w = this.waiters.splice(0);
    for (const { reject } of w) reject(err);
  }

  _drain() {
    while (this.active < this._limit && this.waiters.length) {
      const { resolve } = this.waiters.shift();
      this.active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this._drain();
      });
    }
  }

  async run(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Ordered results; each item gets its own promise so callers can consume as they resolve. */
function mapLimitLazy(items, limit, mapper) {
  const sem = new Semaphore(limit, { name: 'mapLimit' });
  return items.map((item, i) => sem.run(() => mapper(item, i)));
}

async function mapLimit(items, limit, mapper) {
  return Promise.all(mapLimitLazy(items, limit, mapper));
}

/** attempt 1 → base, 2 → 2×base … capped, ±20% jitter. */
function backoffMs(attempt, { baseMs = 30_000, maxMs = 240_000, jitter = 0.2, random = Math.random } = {}) {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const j = raw * jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(raw + j));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { Semaphore, mapLimit, mapLimitLazy, backoffMs, sleep };
