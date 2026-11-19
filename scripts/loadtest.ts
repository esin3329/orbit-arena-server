/**
 * 부하 테스트: N개의 가상 클라이언트가 게스트 로그인 → 매칭 → 30Hz 입력 전송.
 * 클라이언트 측 RTT / 스냅샷 간격과 서버의 틱 처리 시간(/api/stats)을 리포트한다.
 *
 *   node scripts/loadtest.ts [clients=64] [seconds=20] [url=http://localhost:3000]
 */
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../shared/sim.js';

const N = Number(process.argv[2] ?? 64);
const SECONDS = Number(process.argv[3] ?? 20);
const BASE = process.argv[4] ?? 'http://localhost:3000';
const WS_BASE = BASE.replace(/^http/, 'ws');

const rtts: number[] = [];
const gaps: number[] = [];
let snaps = 0;
let bytes = 0;
let started = 0;

const pct = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

async function bot(i: number) {
  const res = await fetch(`${BASE}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: `load${i}` }) });
  if (!res.ok) throw new Error(`guest failed: ${res.status} ${await res.text()}`);
  const { token } = (await res.json()) as { token: string };
  const ws = new WebSocket(`${WS_BASE}/ws?v=${PROTOCOL_VERSION}&token=${token}`);
  let seq = 0;
  let lastSnap = 0;
  let angle = Math.random() * Math.PI * 2;
  const timers: NodeJS.Timeout[] = [];

  ws.on('open', () => ws.send(JSON.stringify({ t: 'queue' })));
  ws.on('message', (raw) => {
    const data = raw.toString();
    bytes += data.length;
    const m = JSON.parse(data);
    if (m.t === 'match_start') {
      started++;
      const t0 = performance.now();
      let sent = 0;
      timers.push(
        setInterval(() => {
          const due = Math.floor((performance.now() - t0) / (1000 / 30));
          while (sent < due) {
            sent++;
            if (Math.random() < 0.05) angle += (Math.random() - 0.5) * 2;
            ws.send(JSON.stringify({ t: 'input', seq: ++seq, dx: Math.cos(angle), dy: Math.sin(angle), aim: angle, fire: Math.random() < 0.3, dash: Math.random() < 0.01 }));
          }
        }, 10),
        setInterval(() => ws.send(JSON.stringify({ t: 'ping', ts: performance.now() })), 1000),
      );
    } else if (m.t === 'snap') {
      snaps++;
      const now = performance.now();
      if (lastSnap) gaps.push(now - lastSnap);
      lastSnap = now;
    } else if (m.t === 'pong') {
      rtts.push(performance.now() - m.ts);
    } else if (m.t === 'match_end') {
      ws.send(JSON.stringify({ t: 'queue' }));
      lastSnap = 0;
    }
  });
  return () => {
    timers.forEach(clearInterval);
    ws.close();
  };
}

console.log(`부하 테스트: 클라이언트 ${N}명, ${SECONDS}초, ${BASE}`);
const stops = await Promise.all(Array.from({ length: N }, (_, i) => bot(i)));
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const stats = (await (await fetch(`${BASE}/api/stats`)).json()) as any;
stops.forEach((s) => s());

console.log(
  JSON.stringify(
    {
      clients: N,
      matchedClients: started,
      rooms: stats.rooms,
      snapshotsReceived: snaps,
      downstreamKBps: Math.round(bytes / 1024 / SECONDS),
      rttMs: { p50: +pct(rtts, 0.5).toFixed(2), p99: +pct(rtts, 0.99).toFixed(2) },
      snapshotGapMs: { p50: +pct(gaps, 0.5).toFixed(1), p99: +pct(gaps, 0.99).toFixed(1) },
      serverTickMs: stats.tick,
    },
    null,
    2,
  ),
);
process.exit(0);
