import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../shared/sim.js';
import { createSnapshotDecoder } from '../shared/codec.js';
import { createApp, type App } from '../src/app.ts';

process.env.LOG_LEVEL ??= 'silent';

let app: App;
let base: string;
let wsBase: string;

before(async () => {
  app = await createApp({
    sqlitePath: ':memory:',
    roomWorkers: 0,
    tokenSecret: 'test-secret',
    match: { botFillAfterMs: 200, durationSec: 2, botFillTo: 3 },
  });
  const port = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
});

async function guest(nickname: string) {
  const res = await fetch(`${base}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname }) });
  assert.equal(res.status, 201);
  return (await res.json()) as { token: string; player: { id: string } };
}

const messageStreams = new WeakMap<WebSocket, EventEmitter>();

/** 특정 타입 메시지가 올 때까지 대기 */
function waitFor(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  let stream = messageStreams.get(ws);
  if (!stream) {
    const messages = new EventEmitter();
    const decodeSnapshot = createSnapshotDecoder();
    ws.on('message', (data, isBinary) => {
      const msg = isBinary ? decodeSnapshot(data as Buffer) : JSON.parse(data.toString());
      messages.emit('message', msg);
    });
    messageStreams.set(ws, messages);
    stream = messages;
  }
  const messages = stream;
  return new Promise((resolve, reject) => {
    const onMsg = (msg: { t: string }) => {
      if (msg.t !== type) return;
      clearTimeout(timer);
      messages.off('message', onMsg);
      resolve(msg);
    };
    const timer = setTimeout(() => {
      messages.off('message', onMsg);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    messages.on('message', onMsg);
  });
}

test('REST: 닉네임 검증, 인증 필요한 엔드포인트, 헬스체크', async () => {
  const bad = await fetch(`${base}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: '<script>' }) });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/api/me`)).status, 401);

  const { token } = await guest('Rest');
  const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal((await fetch(`${base}/../../package.json`)).status, 404);
});

test('WS: 토큰 없으면 핸드셰이크 단계에서 401 거부', async () => {
  const ws = new WebSocket(`${wsBase}/ws?v=${PROTOCOL_VERSION}&token=invalid`);
  const status = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode!)));
  assert.equal(status, 401);
});

test('E2E: 접속 → 매칭(봇 채움) → 스냅샷 수신 → 매치 종료 → 리더보드 반영', async () => {
  const { token, player } = await guest('E2E');
  const ws = new WebSocket(`${wsBase}/ws?v=${PROTOCOL_VERSION}&token=${token}`);
  const welcome = await waitFor(ws, 'welcome');
  assert.equal(welcome.playerId, player.id);

  ws.send(JSON.stringify({ t: 'queue' }));
  const start = await waitFor(ws, 'match_start');
  assert.equal(start.roster.length, 3, '사람 1 + 봇 2');

  // 오른쪽으로 이동 입력을 보내고 스냅샷 ack 가 따라오는지 확인
  let seq = 0;
  const iv = setInterval(() => ws.send(JSON.stringify({ t: 'input', seq: ++seq, dx: 1, dy: 0, aim: 0, fire: true, dash: false })), 33);
  const snap = await waitFor(ws, 'snap');
  assert.ok(Array.isArray(snap.d.p) && snap.d.p.length === 3);
  await new Promise((r) => setTimeout(r, 300));
  const snap2 = await waitFor(ws, 'snap');
  assert.ok(snap2.ack > 0, '서버가 입력을 처리하고 ack 를 돌려줌');

  const end = await waitFor(ws, 'match_end', 5000);
  clearInterval(iv);
  assert.equal(end.reason, 'time');
  assert.equal(end.results.length, 3);

  const lb = await (await fetch(`${base}/api/leaderboard`)).json();
  assert.ok(lb.players.some((p: any) => p.id === player.id && p.games === 1));
  ws.close();
});

test('WS: 같은 계정으로 재접속하면 이전 연결은 4001 로 종료', async () => {
  const { token } = await guest('Dup');
  const ws1 = new WebSocket(`${wsBase}/ws?v=${PROTOCOL_VERSION}&token=${token}`);
  await waitFor(ws1, 'welcome');
  const closed = new Promise<number>((r) => ws1.on('close', (code) => r(code)));
  const ws2 = new WebSocket(`${wsBase}/ws?v=${PROTOCOL_VERSION}&token=${token}`);
  await waitFor(ws2, 'welcome');
  assert.equal(await closed, 4001);
  ws2.close();
});

test('WS: 프로토콜 버전이 다르면 426 거부, /health 에 서버 버전 노출', async () => {
  const { token } = await guest('OldClient');
  const ws = new WebSocket(`${wsBase}/ws?v=${PROTOCOL_VERSION - 1}&token=${token}`);
  const status = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode!)));
  assert.equal(status, 426);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.protocolVersion, PROTOCOL_VERSION);
});

test('룸 워커 2개: 서로 다른 룸을 처리하고 재접속과 결과 저장을 유지한다', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-arena-room-workers-'));
  const sockets: WebSocket[] = [];
  let arena: App | undefined;
  try {
    arena = await createApp({
      sqlitePath: join(dir, 'game.db'),
      tokenSecret: 'room-worker-test-secret',
      roomWorkers: 2,
      match: { maxPlayers: 2, botFillTo: 2, botFillAfterMs: 3000, durationSec: 4 },
    });
    const port = await arena.listen(0, '127.0.0.1');
    const origin = `http://127.0.0.1:${port}`;

    async function open(token: string) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?v=${PROTOCOL_VERSION}&token=${token}`);
      sockets.push(ws);
      await waitFor(ws, 'welcome');
      return ws;
    }

    const guests = await Promise.all(['WorkerA', 'WorkerB', 'WorkerC', 'WorkerD'].map(async (nickname) => {
      const res = await fetch(origin + '/api/auth/guest', { method: 'POST', body: JSON.stringify({ nickname }) });
      assert.equal(res.status, 201);
      return (await res.json()) as { token: string; player: { id: string } };
    }));
    const clients = await Promise.all(guests.map(({ token }) => open(token)));
    async function queuePair(first: WebSocket, second: WebSocket) {
      const starts = [waitFor(first, 'match_start'), waitFor(second, 'match_start')];
      for (const ws of [first, second]) ws.send(JSON.stringify({ t: 'queue' }));
      return await Promise.all(starts);
    }
    const [a, b] = await queuePair(clients[0], clients[1]);
    const [c, d] = await queuePair(clients[2], clients[3]);
    assert.equal(a.roomId, b.roomId);
    assert.equal(c.roomId, d.roomId);
    assert.notEqual(a.roomId, c.roomId);
    const metrics = await (await fetch(origin + '/metrics')).text();
    assert.match(metrics, /^game_room_workers_ready 2$/m);
    assert.match(metrics, /^game_room_workers_active 2$/m);

    const closed = new Promise<void>((resolve) => clients[0].once('close', () => resolve()));
    clients[0].close();
    await closed;
    const reconnect = new WebSocket(`ws://127.0.0.1:${port}/ws?v=${PROTOCOL_VERSION}&token=${guests[0].token}`);
    sockets.push(reconnect);
    const rejoined = await waitFor(reconnect, 'match_start');
    assert.equal(rejoined.roomId, a.roomId);
    assert.equal(rejoined.you, a.you);
    const snap = await waitFor(reconnect, 'snap');
    assert.ok(Array.isArray(snap.d.o), '재접속 직후 전체 스냅샷');
    const ends = await Promise.all([waitFor(reconnect, 'match_end'), waitFor(clients[2], 'match_end')]);
    assert.ok(ends.every((end) => end.reason === 'time' && end.results.length === 2));
    for (const { player } of guests) {
      assert.equal((await arena.repo.getPlayer(player.id))?.games, 1);
    }
  } finally {
    for (const ws of sockets) ws.terminate();
    await arena?.close();
    for (const file of ['game.db', 'game.db-shm', 'game.db-wal']) {
      await rm(join(dir, file), { force: true });
    }
    await rmdir(dir);
  }
});
