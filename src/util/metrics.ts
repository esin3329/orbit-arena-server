/**
 * 경량 메트릭 레지스트리. /metrics 에서 Prometheus 텍스트 포맷으로 노출한다.
 * 틱 처리 시간은 링버퍼에 최근 N개를 보관해 p50/p99 를 계산한다.
 */
export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, () => number>();
  private ticks = new Float64Array(4096);
  private tickIdx = 0;
  private tickFilled = 0;
  private tickTotal = 0;

  inc(name: string, by = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  counter(name: string) {
    return this.counters.get(name) ?? 0;
  }

  /** 누적된 카운터 증분을 꺼내고 초기화한다 (워커 → 게이트웨이 집계용) */
  drainCounters(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counters) {
      if (v !== 0) out[k] = v;
    }
    this.counters.clear();
    return out;
  }

  gauge(name: string, fn: () => number) {
    this.gauges.set(name, fn);
  }

  observeTick(ms: number) {
    this.ticks[this.tickIdx] = ms;
    this.tickIdx = (this.tickIdx + 1) % this.ticks.length;
    this.tickFilled = Math.min(this.tickFilled + 1, this.ticks.length);
    this.tickTotal++;
  }

  tickStats() {
    const n = this.tickFilled;
    if (n === 0) return { samples: 0, total: this.tickTotal, avgMs: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 };
    const arr = Array.from(this.ticks.subarray(0, n)).sort((a, b) => a - b);
    const sum = arr.reduce((a, b) => a + b, 0);
    const pct = (p: number) => arr[Math.min(n - 1, Math.floor(p * n))];
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return { samples: n, total: this.tickTotal, avgMs: r(sum / n), p50Ms: r(pct(0.5)), p99Ms: r(pct(0.99)), maxMs: r(arr[n - 1]) };
  }

  toPrometheus(): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`# TYPE ${k} counter`, `${k} ${v}`);
    for (const [k, fn] of this.gauges) lines.push(`# TYPE ${k} gauge`, `${k} ${fn()}`);
    const t = this.tickStats();
    lines.push(
      '# TYPE game_tick_duration_ms summary',
      `game_tick_duration_ms{quantile="0.5"} ${t.p50Ms}`,
      `game_tick_duration_ms{quantile="0.99"} ${t.p99Ms}`,
      `game_tick_duration_ms_count ${t.total}`,
    );
    const mem = process.memoryUsage();
    lines.push('# TYPE process_heap_used_bytes gauge', `process_heap_used_bytes ${mem.heapUsed}`);
    return lines.join('\n') + '\n';
  }
}

export const metrics = new Metrics();
