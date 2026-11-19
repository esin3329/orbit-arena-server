/**
 * 토큰 버킷 레이트 리미터.
 * capacity 만큼 버스트를 허용하고 초당 refillPerSec 만큼 회복한다.
 */
export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSec: number;
  private tokens: number;
  private last: number;

  constructor(capacity: number, refillPerSec: number, now = performance.now()) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.last = now;
  }

  take(cost = 1, now = performance.now()): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  get lastUsed(): number {
    return this.last;
  }
}

/** 키(IP 등)별 토큰 버킷. 오래 안 쓰인 버킷은 sweep()으로 정리해 메모리 누수를 막는다. */
export class KeyedRateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private capacity: number;
  private refillPerSec: number;

  constructor(capacity: number, refillPerSec: number) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
  }

  take(key: string, cost = 1, now = performance.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(this.capacity, this.refillPerSec, now);
      this.buckets.set(key, b);
    }
    return b.take(cost, now);
  }

  sweep(idleMs = 60_000, now = performance.now()) {
    for (const [k, b] of this.buckets) if (now - b.lastUsed > idleMs) this.buckets.delete(k);
  }

  get size() {
    return this.buckets.size;
  }
}
