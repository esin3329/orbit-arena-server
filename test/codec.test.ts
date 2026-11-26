import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSnapshot, encodeSnapshot, SNAP_ACK_OFFSET } from '../shared/codec.js';
import { Room } from '../src/game/room.ts';
import type { PlayerConnection } from '../src/game/types.ts';

process.env.LOG_LEVEL ??= 'silent';

class FakeConn implements PlayerConnection {
  readonly playerId: string;
  readonly nickname: string;
  snaps: Array<{ ack: number; bytes: number; d: any }> = [];
  congested = false;
  constructor(playerId: string) {
    this.playerId = playerId;
    this.nickname = playerId;
  }
  send(data: string | Uint8Array) {
    if (typeof data === 'string') return;
    const m = decodeSnapshot(data);
    this.snaps.push({ ack: m.ack, bytes: data.byteLength, d: m.d });
  }
  isCongested() {
    return this.congested;
  }
}

const sample = () => ({
  tick: 123456,
  rem: 100_000,
  p: [
    [1, 812.3456789, 99.125, 100, 1, 42, -2.75, 3, 17, 4, 2],
    [7, 0.5, 999.99, 0, 0, 0, 12.5, 0, 0, 0, 9],
  ],
  b: [
    [70001, 1599.97, 0.03],
    [70002, -3.2, 512.5],
  ],
  o: [
    [1, 400, 300],
    [14, 1590, 990],
  ],
  ev: [
    { k: 'hit' as const, v: 7 },
    { k: 'kill' as const, by: 1, v: 7 },
    { k: 'orb' as const, by: 1 },
  ],
});

test('코덱: 왕복(encode→decode) 시 정수 필드는 그대로, 좌표는 정해진 정밀도 이내로 복원', () => {
  const d = sample();
  const m = decodeSnapshot(encodeSnapshot(d, 0x7fffffff, true));
  assert.equal(m.t, 'snap');
  assert.equal(m.ack, 0x7fffffff);
  assert.equal(m.d.tick, d.tick);
  assert.equal(m.d.rem, d.rem);
  assert.deepEqual(m.d.ev, d.ev);
  assert.deepEqual(m.d.o, d.o);

  for (let i = 0; i < d.p.length; i++) {
    const [a, b] = [d.p[i], m.d.p[i]];
    for (const k of [0, 3, 4, 5, 7, 8, 9, 10]) assert.equal(b[k], a[k], `player field ${k}`);
    assert.ok(Math.abs(b[1] - a[1]) < 1e-3 && Math.abs(b[2] - a[2]) < 1e-3, 'player 좌표는 f32');
    assert.ok(Math.abs(b[6] - a[6]) <= 0.5 / 2000 + 1e-9, 'aim 은 1/2000 rad');
  }
  for (let i = 0; i < d.b.length; i++) {
    assert.equal(m.d.b[i][0], d.b[i][0]);
    assert.ok(Math.abs(m.d.b[i][1] - d.b[i][1]) <= 1 / 32 && Math.abs(m.d.b[i][2] - d.b[i][2]) <= 1 / 32, '탄환 좌표는 1/16px');
  }
});

test('코덱: 오브 미포함 프레임은 o 가 undefined, ack 만 덮어써도 나머지는 동일', () => {
  const frame = encodeSnapshot(sample(), 0, false);
  const m = decodeSnapshot(frame);
  assert.equal(m.d.o, undefined);

  const patched = new Uint8Array(frame);
  new DataView(patched.buffer).setUint32(SNAP_ACK_OFFSET, 99, true);
  const m2 = decodeSnapshot(patched);
  assert.equal(m2.ack, 99);
  assert.deepEqual(m2.d, m.d);
});

test('코덱: 잘린 프레임/다른 타입은 거부', () => {
  const frame = encodeSnapshot(sample(), 1, true);
  assert.throws(() => decodeSnapshot(frame.subarray(0, frame.length - 1)));
  assert.throws(() => decodeSnapshot(new Uint8Array([2, 0, 0])));
});

test('대역폭: 8인 매치 스냅샷이 기존 JSON 대비 절반 이하, 오브 델타로 평소 프레임은 더 작다', () => {
  const room = new Room({ durationTicks: 3000, maxPlayers: 8, reconnectGraceTicks: 30, snapshotEvery: 2, repo: null, seed: 7 });
  const a = new FakeConn('a');
  room.addPlayer(a);
  for (let i = 0; i < 7; i++) room.addBot(`bot${i}`);
  for (let i = 0; i < 120; i++) room.step();

  // 프로토콜 v2 의 JSON 스냅샷 형식으로 같은 상태를 직렬화해 비교
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const s = room.debugWorld().snapshot(1000);
  const json = JSON.stringify({
    t: 'snap',
    ack: 1234,
    d: {
      tick: s.tick,
      rem: s.rem,
      p: s.p.map((p) => [p[0], r2(p[1]), r2(p[2]), p[3], p[4], p[5], r2(p[6]), p[7], p[8], p[9], p[10]]),
      b: s.b.map((b) => [b[0], r2(b[1]), r2(b[2])]),
      o: s.o,
      ev: s.ev,
    },
  });
  const full = encodeSnapshot(s, 1234, true).byteLength;
  const delta = encodeSnapshot(s, 1234, false).byteLength;
  assert.ok(full * 2 <= Buffer.byteLength(json), `binary ${full}B vs json ${Buffer.byteLength(json)}B`);
  assert.ok(delta < full);
});

test('오브 델타: 첫 스냅샷·오브 변화·재접속·혼잡으로 건너뛴 뒤에만 오브를 싣는다', () => {
  const room = new Room({ durationTicks: 3000, maxPlayers: 8, reconnectGraceTicks: 30, snapshotEvery: 1, repo: null, seed: 3 });
  const a = new FakeConn('a');
  room.addPlayer(a);
  room.addPlayer(new FakeConn('b'));

  room.step();
  room.step();
  assert.ok(a.snaps[0].d.o, '첫 스냅샷에는 오브 포함');
  assert.equal(a.snaps[1].d.o, undefined, '변화가 없으면 생략');
  assert.ok(a.snaps[1].bytes < a.snaps[0].bytes);

  // 오브 하나를 플레이어 위치로 옮겨 획득시킨다 → 다음 스냅샷에 갱신된 목록
  const world = room.debugWorld();
  const me = room.debugEntity('a')!;
  const orb = world.orbs.find((o) => o.active)!;
  orb.x = me.x;
  orb.y = me.y;
  room.step();
  const afterPickup = a.snaps.at(-1)!.d.o;
  assert.ok(afterPickup, '오브 변화 시 포함');
  assert.ok(!afterPickup.some((o: number[]) => o[0] === orb.id), '획득한 오브는 목록에서 빠짐');

  // 혼잡으로 건너뛰는 동안 오브가 바뀌면, 다음에 보낼 수 있을 때 실린다
  a.congested = true;
  const sentBefore = a.snaps.length;
  const other = world.orbs.find((o) => o.active && o.id !== orb.id)!;
  other.x = me.x;
  other.y = me.y;
  room.step();
  room.step();
  assert.equal(a.snaps.length, sentBefore, '혼잡 중에는 전송 안 함');
  a.congested = false;
  room.step();
  assert.ok(a.snaps.at(-1)!.d.o, '혼잡 해소 후 첫 스냅샷에 오브 포함');
  room.step();
  assert.equal(a.snaps.at(-1)!.d.o, undefined);

  // 재접속(새 연결)은 클라이언트 상태가 비어 있으므로 다시 전체 오브
  const a2 = new FakeConn('a');
  room.detach('a', a);
  room.rebind('a', a2);
  room.step();
  assert.ok(a2.snaps[0].d.o, '재접속 직후 오브 포함');
});
