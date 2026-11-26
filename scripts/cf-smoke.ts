/**
 * Cloudflare Workers 배포본 스모크 테스트 — `wrangler dev`(로컬 workerd) 또는 실제 배포 URL 에 대고 돈다.
 *
 *   node scripts/cf-smoke.ts http://127.0.0.1:8787
 *
 * Node 서버용 테스트는 cloudflare/worker.ts 를 실행하지 않으므로, 라이브 데모가 실제로 타는 경로
 * (정적 에셋 → REST → Durable Object → WebSocket 업그레이드 → 매치 시작 → 바이너리 스냅샷)를 여기서 끝까지 확인한다.
 * 실제 배포 URL 에 돌리면 게스트 계정이 하나 생기므로, CI 에서는 로컬 wrangler dev 에만 쓴다.
 *
 * 주의: wrangler dev 는 프로젝트의 .env 를 바인딩으로 읽는다. 로컬 .env 에 DB_DRIVER=supabase 가 있으면
 * 로컬 실행이라도 실제 Supabase 에 게스트가 기록되므로, 로컬에서 돌릴 때는 .env 를 비우거나 --env-file 로 분리한다.
 */
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '../shared/sim.js';

const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const TIMEOUT_MS = 20_000;

function step(name: string) {
  console.log(`✔ ${name}`);
}

async function get(path: string) {
  const res = await fetch(base + path);
  assert.equal(res.status, 200, `${path} → ${res.status}`);
  return res;
}

// ── 정적 에셋 (Workers Assets) ──
assert.match(await (await get('/')).text(), /Orbit Arena/);
assert.match((await get('/shared/codec.js')).headers.get('content-type') ?? '', /javascript/);
step('정적 에셋: index.html, /shared/codec.js');

// ── REST → Durable Object ──
const health = (await (await get('/health')).json()) as { status: string; db: string; dbOk: boolean; protocolVersion: number };
assert.equal(health.status, 'ok');
assert.equal(health.dbOk, true);
assert.equal(health.protocolVersion, PROTOCOL_VERSION, '클라이언트와 서버 프로토콜 버전 일치');
step(`/health: db=${health.db}, protocol v${health.protocolVersion}`);

const guestRes = await fetch(base + '/api/auth/guest', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ nickname: 'CfSmoke' }),
});
assert.equal(guestRes.status, 201);
const { token } = (await guestRes.json()) as { token: string };
step('게스트 생성');

const board = (await (await get('/api/leaderboard')).json()) as { players: unknown[] };
assert.ok(Array.isArray(board.players));
step('리더보드 조회');

// ── WebSocket: 구버전 프로토콜 거부 ──
await new Promise<void>((resolve, reject) => {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?v=${PROTOCOL_VERSION - 1}&token=${token}`);
  ws.onopen = () => reject(new Error('구버전 프로토콜 접속이 허용됨'));
  ws.onerror = () => resolve();
  ws.onclose = () => resolve();
});
step('구버전 프로토콜 WebSocket 거부');

// ── WebSocket: 접속 → 대기열 → 봇 채움 매치 시작 → 바이너리 스냅샷 ──
await new Promise<void>((resolve, reject) => {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?v=${PROTOCOL_VERSION}&token=${token}`);
  ws.binaryType = 'arraybuffer';
  const timer = setTimeout(() => {
    ws.close();
    reject(new Error(`${TIMEOUT_MS}ms 안에 매치 스냅샷을 받지 못함`));
  }, TIMEOUT_MS);
  let started = false;
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const msg = JSON.parse(ev.data) as { t: string };
      if (msg.t === 'welcome') {
        step('WebSocket welcome');
        ws.send(JSON.stringify({ t: 'queue' }));
      } else if (msg.t === 'match_start') {
        started = true;
        step('매치 시작 (봇 채움)');
      }
      return;
    }
    if (!started) return;
    const bytes = new Uint8Array(ev.data as ArrayBuffer);
    assert.ok(bytes.byteLength > 0);
    step(`바이너리 스냅샷 수신 (${bytes.byteLength}B)`);
    clearTimeout(timer);
    ws.close();
    resolve();
  };
  ws.onerror = () => {
    clearTimeout(timer);
    reject(new Error('WebSocket 오류'));
  };
});

console.log(`\nCloudflare 스모크 테스트 통과: ${base}`);
