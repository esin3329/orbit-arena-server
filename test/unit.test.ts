import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../src/auth/token.ts';
import { TokenBucket } from '../src/util/rateLimiter.ts';
import { computeRatingDeltas } from '../src/db/rating.ts';
import { parseClientMessage } from '../src/net/protocol.ts';

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
  assert.equal(parseClientMessage('{"t":"input","seq":-1,"dx":0,"dy":0,"aim":0}'), null);
  assert.equal(parseClientMessage('{"t":"input","seq":1.5,"dx":0,"dy":0,"aim":0}'), null);
  assert.equal(parseClientMessage('{"t":"input","seq":1,"dx":"1","dy":0,"aim":0}'), null);
  const m = parseClientMessage('{"t":"input","seq":3,"dx":99,"dy":-99,"aim":1,"fire":"yes"}');
  assert.deepEqual(m, { t: 'input', seq: 3, dx: 1, dy: -1, aim: 1, fire: false, dash: false });
});
