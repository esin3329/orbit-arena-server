import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { signToken, verifyToken } from '../src/auth/token.ts';
import { TokenBucket } from '../src/util/rateLimiter.ts';
import { computeRatingDeltas } from '../src/db/rating.ts';
import { parseClientMessage } from '../src/net/protocol.ts';
import { InputBuffer, INPUT_CREDIT_PER_TICK, MAX_INPUT_QUEUE } from '../src/game/inputBuffer.ts';
import { rank } from '../src/game/ranking.ts';
import { config, validateConfig, DEV_TOKEN_SECRET } from '../src/config.ts';
import { clientIp } from '../src/http/api.ts';
import { retry } from '../src/util/retry.ts';
import { OBSTACLES, segmentCircleHit, segmentObstacleHit } from '../shared/sim.js';

process.env.LOG_LEVEL ??= 'silent';
const mkIn = (seq: number) => ({ seq, dx: 1, dy: 0, aim: 0, fire: false, dash: false });

test('토큰: 서명 검증, 변조/만료/다른 시크릿 거부', () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const t = signToken({ sub: 'p1', nick: 'A', exp }, 's3cret');
  assert.equal(verifyToken(t, 's3cret')?.sub, 'p1');
  assert.equal(verifyToken(t, 'other'), null);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', nick: 'A', exp })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${sig}`, 's3cret'), null);
  assert.equal(verifyToken(`${body}.${sig}`, 's3cret', exp + 1), null);
  assert.equal(verifyToken('garbage', 's3cret'), null);
});

test('토큰 버킷: 버스트 후 차단, 시간 경과 시 회복', () => {
  const b = new TokenBucket(3, 10, 0);
  assert.ok(b.take(1, 0) && b.take(1, 0) && b.take(1, 0));
  assert.equal(b.take(1, 0), false);
  assert.equal(b.take(1, 100), true); // 100ms * 10/s = 1 토큰 회복
});

test('레이팅: 1등은 오르고 꼴등은 내리며, 동일 레이팅이면 합이 0', () => {
  const d = computeRatingDeltas([
    { playerId: 'a', rating: 1000, placement: 1 },
    { playerId: 'b', rating: 1000, placement: 2 },
    { playerId: 'c', rating: 1000, placement: 3 },
  ]);
  assert.ok(d.get('a')! > 0 && d.get('c')! < 0);
  assert.equal(d.get('b'), 0);
  assert.equal([...d.values()].reduce((x, y) => x + y, 0), 0);
  assert.equal(computeRatingDeltas([{ playerId: 'solo', rating: 1000, placement: 1 }]).get('solo'), 0);
});

test('레이팅: 약자가 강자를 이기면 더 많이 오른다', () => {
  const upset = computeRatingDeltas([
    { playerId: 'weak', rating: 800, placement: 1 },
    { playerId: 'strong', rating: 1200, placement: 2 },
  ]);
  const expected = computeRatingDeltas([
    { playerId: 'strong', rating: 1200, placement: 1 },
    { playerId: 'weak', rating: 800, placement: 2 },
  ]);
  assert.ok(upset.get('weak')! > expected.get('strong')!);
});

test('프로토콜: 잘못된 메시지 거부, 범위 밖 값은 clamp', () => {
  assert.equal(parseClientMessage('not json'), null);
  assert.equal(parseClientMessage('[]'), null);
  assert.equal(parseClientMessage('{"t":"hack"}'), null);
  assert.equal(parseClientMessage('{"t":"input","seq":0,"dx":0,"dy":0,"aim":0}'), null);
  assert.equal(parseClientMessage('{"t":"input","seq":-1,"dx":0,"dy":0,"aim":0}'), null);
  assert.equal(parseClientMessage('{"t":"input","seq":1.5,"dx":0,"dy":0,"aim":0}'), null);
  assert.equal(parseClientMessage('{"t":"input","seq":1,"dx":"1","dy":0,"aim":0}'), null);
  const m = parseClientMessage('{"t":"input","seq":3,"dx":99,"dy":-99,"aim":1,"fire":"yes"}');
  assert.deepEqual(m, { t: 'input', seq: 3, dx: 1, dy: -1, aim: 1, fire: false, dash: false });
});

test('InputBuffer: 틱당 예산만큼만 꺼내고, 몰아 보내도 장기 처리율은 1.05/틱으로 제한', () => {
  const buf = new InputBuffer();
  assert.equal(buf.lastProcessedSeq, 0);
  assert.equal(buf.push(mkIn(0)), false, 'seq 0 이하 거부');
  for (let i = 1; i <= MAX_INPUT_QUEUE; i++) assert.ok(buf.push(mkIn(i)));
  assert.equal(buf.push(mkIn(3)), false, '역순 seq 거부');
  assert.equal(buf.drain().length, 2, '초기 예산 1 + 회복 1.05 → 2개');
  let processed = 2;
  for (let tick = 0; tick < 100; tick++) {
    for (let k = 0; k < 4; k++) buf.push(mkIn(1000 + tick * 4 + k)); // 틱당 4배 입력 공격
    processed += buf.drain().length;
  }
  assert.ok(processed <= 2 + Math.ceil(100 * INPUT_CREDIT_PER_TICK), `처리량 제한 (processed=${processed})`);
  assert.equal(buf.lastProcessedSeq > 0, true);
  buf.reset();
  assert.equal(buf.lastProcessedSeq, 0);
  assert.ok(buf.push(mkIn(1)), '재접속 후 seq 1 부터 다시 허용');
});

test('순위: 점수→킬→데스 순 정렬, 완전 동점은 같은 순위(1,2,2,4)', () => {
  const r = rank([
    { n: 'c', score: 5, kills: 0, deaths: 0 },
    { n: 'a', score: 9, kills: 0, deaths: 0 },
    { n: 'b2', score: 5, kills: 0, deaths: 0 },
    { n: 'd', score: 5, kills: 0, deaths: 1 },
  ]);
  assert.deepEqual(
    r.map((x) => [x.item.n, x.placement]),
    [
      ['a', 1],
      ['c', 2],
      ['b2', 2],
      ['d', 4],
    ],
  );
});

test('설정 검증: 범위 오류와 운영 환경 기본 시크릿·프록시·워커·OAuth 설정을 검증', () => {
  assert.deepEqual(validateConfig(config, 'development'), []);
  const bad = { ...config, port: 70000, match: { ...config.match, maxPlayers: 1 } };
  assert.equal(validateConfig(bad, 'development').length, 3, 'PORT, MAX_PLAYERS, BOT_FILL_TO(>max)');
  assert.ok(validateConfig({ ...config, tokenSecret: DEV_TOKEN_SECRET }, 'production').some((e) => e.includes('TOKEN_SECRET')));
  assert.ok(validateConfig({ ...config, tokenSecret: 'short' }, 'production').some((e) => e.includes('32')));
  assert.deepEqual(validateConfig({ ...config, tokenSecret: 'x'.repeat(32) }, 'production'), []);

  assert.ok(validateConfig({ ...config, dbDriver: 'supabase' }, 'development').some((e) => e.includes('SUPABASE')));
  assert.ok(validateConfig({ ...config, roomWorkers: 2, sqlitePath: ':memory:' }, 'development').some((e) => e.includes('ROOM_WORKERS')));
  assert.ok(validateConfig({ ...config, trustProxy: -1 }, 'development').some((e) => e.includes('TRUST_PROXY')));
  assert.ok(validateConfig({ ...config, trustProxy: 11 }, 'development').some((e) => e.includes('TRUST_PROXY')));
  assert.deepEqual(validateConfig({ ...config, trustProxy: 2 }, 'development'), []);
  assert.ok(
    validateConfig({ ...config, tokenSecret: 'x'.repeat(32), metricsToken: 'short' }, 'production').some((e) => e.includes('METRICS_TOKEN')),
  );
  assert.deepEqual(validateConfig({ ...config, tokenSecret: 'x'.repeat(32), metricsToken: 'm'.repeat(16) }, 'production'), []);

  const sbBase = {
    ...config,
    tokenSecret: 'x'.repeat(32),
    dbDriver: 'supabase' as const,
    supabaseUrl: 'https://proj.supabase.co',
    supabaseKey: 'service-key',
    supabasePublishableKey: 'pub-key',
  };
  assert.deepEqual(validateConfig({ ...sbBase, githubAuthOrigin: 'https://arena.example.com' }, 'production'), []);
  assert.deepEqual(validateConfig({ ...sbBase, githubAuthOrigin: 'http://localhost:3000' }, 'development'), []);
  assert.ok(validateConfig({ ...sbBase, githubAuthOrigin: 'http://localhost:3000' }, 'production').some((e) => e.includes('GITHUB_AUTH_ORIGIN')));
  assert.ok(validateConfig({ ...sbBase, githubAuthOrigin: 'https://arena.example.com/' }, 'production').some((e) => e.includes('GITHUB_AUTH_ORIGIN')));
  assert.ok(validateConfig({ ...config, githubAuthOrigin: 'https://arena.example.com' }, 'development').some((e) => e.includes('GitHub auth')));
});

test('clientIp: TRUST_PROXY 홉 수에 따라 X-Forwarded-For 에서 신뢰된 클라이언트 IP 를 추출', () => {
  const req = (remoteAddress: string | undefined, xff?: string | string[]) =>
    ({ headers: xff !== undefined ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress } }) as unknown as IncomingMessage;

  assert.equal(clientIp(req('10.0.0.1', '1.2.3.4'), 0), '10.0.0.1');
  assert.equal(clientIp(req('10.0.0.1', '9.9.9.9, 1.2.3.4'), 1), '1.2.3.4');
  assert.equal(clientIp(req('10.0.0.1', '9.9.9.9, 5.6.7.8, 1.2.3.4'), 2), '5.6.7.8');
  assert.equal(clientIp(req('10.0.0.1', '5.6.7.8'), 2), '5.6.7.8');
  assert.equal(clientIp(req('10.0.0.1'), 1), '10.0.0.1');
  assert.equal(clientIp(req(undefined), 1), 'unknown');
});

test('기하: 선분-원 / 선분-사각형 교차 (스윕 충돌, 시야 판정)', () => {
  // 끝점은 둘 다 원 밖이지만 선분이 원을 관통 → 터널링 케이스
  const t = segmentCircleHit(0, 0, 100, 0, 50, 10, 20);
  assert.ok(t > 0 && t < 0.5, `t=${t}`);
  assert.equal(segmentCircleHit(0, 0, 100, 0, 50, 30, 20), -1, '빗나감');
  assert.equal(segmentCircleHit(0, 0, 10, 0, 50, 0, 20), -1, '선분이 원에 못 미침');

  const o = OBSTACLES[0];
  const cy = o.y + o.h / 2;
  const tw = segmentObstacleHit(o.x - 100, cy, o.x + o.w + 100, cy);
  assert.ok(Math.abs(tw - 100 / (o.w + 200)) < 1e-9, '벽 왼쪽 면에서 처음 교차');
  assert.equal(segmentObstacleHit(10, 10, 100, 10), -1, '장애물 없는 경로');
});

test('retry: 실패 후 성공하면 결과 반환, 끝까지 실패하면 마지막 에러', async () => {
  let n = 0;
  assert.equal(await retry(async () => (++n < 3 ? Promise.reject(new Error('x')) : 'ok'), { baseDelayMs: 1 }), 'ok');
  await assert.rejects(retry(async () => Promise.reject(new Error('always')), { attempts: 2, baseDelayMs: 1 }), /always/);
});
