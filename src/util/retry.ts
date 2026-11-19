export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  onRetry?: (err: unknown, attempt: number) => void;
}

/** 지수 백오프 재시도 (100ms → 200ms → 400ms …). 마지막 시도의 에러를 그대로 던진다. */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 100;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts) break;
      opts.onRetry?.(err, i);
      await new Promise((r) => setTimeout(r, base * 2 ** (i - 1)));
    }
  }
  throw lastErr;
}
