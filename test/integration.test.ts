import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../shared/sim.js';
import { createSnapshotDecoder } from '../shared/codec.js';
import { createApp, type App } from '../src/app.ts';
import { signToken } from '../src/auth/token.ts';
import { SqliteRepository } from '../src/db/sqlite.ts';
import { Matchmaker } from '../src/game/matchmaker.ts';
import { createHttpHandler } from '../src/http/api.ts';
import { GITHUB_CALLBACK, GITHUB_SESSION } from '../src/auth/github.ts';

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

  const healthRes = await fetch(`${base}/health`);
  assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(healthRes.headers.get('x-frame-options'), 'DENY');
  assert.equal(healthRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const csp = healthRes.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const health = await healthRes.json();
  assert.equal(health.status, 'ok');
  assert.equal((await fetch(`${base}/../../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%ZZ`)).status, 400);
});

test('WS: 토큰 없으면 핸드셰이크 단계에서 401 거부, DB 에 없는 플레이어 토큰도 401 거부', async () => {
  const ws = new WebSocket(`${wsBase}/ws?v=${PROTOCOL_VERSION}&token=invalid`);
  const status = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode!)));
  assert.equal(status, 401);

  const missingToken = signToken(
    { sub: randomUUID(), nick: 'Ghost', exp: Math.floor(Date.now() / 1000) + 600 },
    'test-secret',
  );
  const wsMissing = new WebSocket(`${wsBase}/ws?v=${PROTOCOL_VERSION}&token=${missingToken}`);
  const statusMissing = await new Promise<number>((resolve) => wsMissing.on('unexpected-response', (_req, res) => resolve(res.statusCode!)));
  assert.equal(statusMissing, 401);
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
  assert.ok(snap2.ack > 0 && snap2.ack <= seq, '서버가 입력을 처리하고 정상 범위의 ack 를 돌려줌');

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

    const beforeMetrics = await (await fetch(origin + '/metrics')).text();
    const metricVal = (text: string, name: string) => Number(new RegExp(`^${name} (\\d+)$`, 'm').exec(text)?.[1] ?? 0);
    const snapBefore = metricVal(beforeMetrics, 'net_snapshots_sent_total');
    const endedBefore = metricVal(beforeMetrics, 'game_matches_ended_total');
    const recordedBefore = metricVal(beforeMetrics, 'db_matches_recorded_total');

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
    while (arena.matchmaker.rooms.size > 0) await new Promise((r) => setTimeout(r, 10));

    const afterMetrics = await (await fetch(origin + '/metrics')).text();
    assert.ok(metricVal(afterMetrics, 'net_snapshots_sent_total') > snapBefore, '워커 스냅샷 전송 카운터 집계');
    assert.ok(metricVal(afterMetrics, 'net_snapshot_bytes_total') > 0, '워커 스냅샷 바이트 카운터 집계');
    assert.ok(metricVal(afterMetrics, 'game_matches_ended_total') >= endedBefore + 2, '워커 매치 종료 카운터 집계');
    assert.ok(metricVal(afterMetrics, 'db_matches_recorded_total') >= recordedBefore + 2, '워커 DB 저장 카운터 집계');
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

test('룸 워커 크래시 복구: 워커 종료 시 error 종료 후 새 워커를 띄워 다음 매치를 완료한다', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-arena-worker-crash-'));
  const sockets: WebSocket[] = [];
  let arena: App | undefined;
  try {
    arena = await createApp({
      sqlitePath: join(dir, 'game.db'),
      tokenSecret: 'worker-crash-test-secret',
      roomWorkers: 2,
      match: { maxPlayers: 2, botFillTo: 2, botFillAfterMs: 3000, durationSec: 2 },
    });
    const port = await arena.listen(0, '127.0.0.1');
    const origin = `http://127.0.0.1:${port}`;

    const guests = await Promise.all(['CrashA', 'CrashB'].map(async (nickname) => {
      const res = await fetch(origin + '/api/auth/guest', { method: 'POST', body: JSON.stringify({ nickname }) });
      assert.equal(res.status, 201);
      return (await res.json()) as { token: string; player: { id: string } };
    }));
    const clients = await Promise.all(guests.map(async ({ token }) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?v=${PROTOCOL_VERSION}&token=${token}`);
      sockets.push(ws);
      await waitFor(ws, 'welcome');
      return ws;
    }));

    const starts1 = [waitFor(clients[0], 'match_start'), waitFor(clients[1], 'match_start')];
    clients.forEach((ws) => ws.send(JSON.stringify({ t: 'queue' })));
    const [m1] = await Promise.all(starts1);
    await waitFor(clients[0], 'snap');

    const pid = arena.pool!.workerPidOf(m1.roomId);
    assert.ok(pid);
    const errEnds = [waitFor(clients[0], 'match_end'), waitFor(clients[1], 'match_end')];
    process.kill(pid);
    const ended1 = await Promise.all(errEnds);
    assert.ok(ended1.every((e) => e.reason === 'error'));

    while (arena.matchmaker.rooms.size > 0) await new Promise((r) => setTimeout(r, 10));

    const starts2 = [waitFor(clients[0], 'match_start'), waitFor(clients[1], 'match_start')];
    clients.forEach((ws) => ws.send(JSON.stringify({ t: 'queue' })));
    const [m2] = await Promise.all(starts2);
    assert.notEqual(m2.roomId, m1.roomId);

    const deadline = Date.now() + 5000;
    while (arena.pool!.readyCount < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(arena.pool!.readyCount, 2, '크래시된 워커가 재시작됨');

    const ended2 = await Promise.all([waitFor(clients[0], 'match_end', 5000), waitFor(clients[1], 'match_end', 5000)]);
    assert.ok(ended2.every((e) => e.reason === 'time' && e.results.length === 2));
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

test('/metrics 접근 제어(METRICS_TOKEN·비루프백 거부)와 TRUST_PROXY 레이트 리밋', async () => {
  const secured = await createApp({
    sqlitePath: ':memory:',
    tokenSecret: 'metrics-test-secret',
    metricsToken: 'metrics-secret-token-1234',
    trustProxy: 1,
    guestRatePerMin: 1,
    apiRatePerSec: 100,
  });
  try {
    const port = await secured.listen(0, '127.0.0.1');
    const origin = `http://127.0.0.1:${port}`;

    const noAuth = await fetch(`${origin}/metrics`);
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await fetch(`${origin}/metrics`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const ok = await fetch(`${origin}/metrics`, { headers: { authorization: 'Bearer metrics-secret-token-1234' } });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /process_heap_used_bytes/);

    // TRUST_PROXY=1: 가장 오른쪽 신뢰 IP 기준으로 게스트 생성 제한 적용
    const g1 = await fetch(`${origin}/api/auth/guest`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.5' },
      body: JSON.stringify({ nickname: 'ProxyA' }),
    });
    assert.equal(g1.status, 201);
    const gSpoof = await fetch(`${origin}/api/auth/guest`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.5' },
      body: JSON.stringify({ nickname: 'ProxyB' }),
    });
    assert.equal(gSpoof.status, 429, '가장 왼쪽 스푸핑 헤더로는 우회 불가');
    const g2 = await fetch(`${origin}/api/auth/guest`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.6' },
      body: JSON.stringify({ nickname: 'ProxyC' }),
    });
    assert.equal(g2.status, 201, '다른 클라이언트 IP 는 별도 버킷');
  } finally {
    await secured.close();
  }

  // metricsToken 미설정 시 비루프백 소켓 IP 의 /metrics 요청은 403 거부, 잘못된 URL 은 400
  const repo = new SqliteRepository(':memory:');
  const mm = new Matchmaker(repo, {
    durationSec: 60, maxPlayers: 4, botFillAfterMs: 4000, botFillTo: 2, reconnectGraceMs: 1000, lateJoinMinRemainingSec: 30,
  });
  const handler = createHttpHandler({
    repo, matchmaker: mm, secret: 'handler-test', tokenTtlSec: 600, apiRatePerSec: 10, guestRatePerMin: 5, onlineCount: () => 0,
  });
  try {
    const call = (url: string, remoteAddress: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const headers: Record<string, string> = {};
        let status = 200;
        const res = {
          setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
          writeHead: (s: number) => { status = s; return res; },
          end: (chunk?: string | Buffer) => resolve({ status, body: chunk ? String(chunk) : '' }),
        } as unknown as ServerResponse;
        const req = { url, method: 'GET', headers: {}, socket: { remoteAddress } } as unknown as IncomingMessage;
        handler(req, res);
      });

    assert.equal((await call('/metrics', '203.0.113.10')).status, 403);
    assert.equal((await call('/metrics', '127.0.0.1')).status, 200);
    assert.equal((await call('http://[::1', '127.0.0.1')).status, 400);
  } finally {
    await mm.shutdown();
    await repo.close();
  }
});

test('GitHub OAuth HTTP 흐름: Origin 검증, PKCE 쿠키, 콜백 303 리다이렉트, 세션 발급 및 1회용 소멸', async () => {
  const repo = new SqliteRepository(':memory:');
  const mm = new Matchmaker(repo, {
    durationSec: 60, maxPlayers: 4, botFillAfterMs: 4000, botFillTo: 2, reconnectGraceMs: 1000, lateJoinMinRemainingSec: 30,
  });
  const githubMap = new Map<string, string>();
  let origin = '';
  const server = createServer((req, res) => handler(req, res));
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  origin = `http://127.0.0.1:${port}`;

  const handler = createHttpHandler({
    repo,
    matchmaker: mm,
    secret: 'oauth-test-secret',
    tokenTtlSec: 600,
    apiRatePerSec: 100,
    guestRatePerMin: 5,
    onlineCount: () => 0,
    github: {
      origin,
      secure: false,
      async start() {
        return { url: 'https://github.com/login/oauth/authorize?client_id=test', verifier: 'pkce-verifier-value' };
      },
      async exchange(code: string, verifier: string) {
        if (code !== 'valid-code' || verifier !== 'pkce-verifier-value') return null;
        return { id: 'gh-auth-user-1', nickname: 'octocat' };
      },
      async getPlayer(authId: string, nickname: string) {
        const existing = githubMap.get(authId);
        if (existing) return (await repo.getPlayer(existing))!;
        const created = await repo.createGuest(nickname);
        githubMap.set(authId, created.id);
        return created;
      },
    },
  });

  try {
    const prov = await (await fetch(`${origin}/api/auth/providers`)).json();
    assert.deepEqual(prov, { github: true });

    const badOrigin = await fetch(`${origin}/api/auth/github`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(badOrigin.status, 403);

    const startRes = await fetch(`${origin}/api/auth/github`, { method: 'POST', headers: { origin } });
    assert.equal(startRes.status, 200);
    assert.match((await startRes.json()).url, /github\.com/);
    const pkceCookie = startRes.headers.getSetCookie().find((c) => c.startsWith('oa_github_pkce='));
    assert.ok(pkceCookie);
    assert.match(pkceCookie, /HttpOnly/);
    assert.match(pkceCookie, /SameSite=Lax/);
    const pkcePair = pkceCookie.split(';')[0];

    const cbRes = await fetch(`${origin}${GITHUB_CALLBACK}?code=valid-code`, {
      headers: { cookie: pkcePair },
      redirect: 'manual',
    });
    assert.equal(cbRes.status, 303);
    assert.equal(cbRes.headers.get('location'), `${origin}/?github=ok`);
    assert.equal(cbRes.headers.get('referrer-policy'), 'no-referrer');
    const cbCookies = cbRes.headers.getSetCookie();
    assert.ok(cbCookies.some((c) => c.startsWith('oa_github_pkce=;') && c.includes('Max-Age=0')));
    const sessionCookie = cbCookies.find((c) => c.startsWith('oa_github_session=') && !c.includes('Max-Age=0'));
    assert.ok(sessionCookie);
    const sessionPair = sessionCookie.split(';')[0];

    assert.equal((await fetch(`${origin}${GITHUB_SESSION}`, { method: 'POST', headers: { origin: 'https://evil.example', cookie: sessionPair } })).status, 403);

    const sessRes = await fetch(`${origin}${GITHUB_SESSION}`, { method: 'POST', headers: { origin, cookie: sessionPair } });
    assert.equal(sessRes.status, 200);
    assert.ok(sessRes.headers.getSetCookie().some((c) => c.startsWith('oa_github_session=;') && c.includes('Max-Age=0')));
    const sessBody = await sessRes.json();
    assert.equal(sessBody.player.nickname, 'octocat');
    assert.ok(sessBody.token);

    const replayRes = await fetch(`${origin}${GITHUB_SESSION}`, { method: 'POST', headers: { origin } });
    assert.equal(replayRes.status, 401);
  } finally {
    await mm.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await repo.close();
  }
});
