import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotDecoder, decodeSnapshot, encodeSnapshot, encodeSnapshotDelta, MSG_SNAPSHOT, MSG_SNAPSHOT_DELTA, SNAP_ACK_OFFSET } from '../shared/codec.js';
import { Room } from '../src/game/room.ts';
import type { PlayerConnection } from '../src/game/types.ts';

process.env.LOG_LEVEL ??= 'silent';

class FakeConn implements PlayerConnection {
  readonly playerId: string;
  readonly nickname: string;
  snaps: Array<{ ack: number; bytes: number; kind: number; d: any }> = [];
  private decodeSnapshot = createSnapshotDecoder();
  congested = false;
  constructor(playerId: string) {
    this.playerId = playerId;
    this.nickname = playerId;
  }
  send(data: string | Uint8Array) {
    if (typeof data === 'string') return;
    const m = this.decodeSnapshot(data);
    this.snaps.push({ ack: m.ack, bytes: data.byteLength, kind: data[0], d: m.d });
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
  assert.equal(a.snaps[0].kind, MSG_SNAPSHOT);
  assert.equal(a.snaps[1].kind, MSG_SNAPSHOT_DELTA);
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
  assert.equal(a.snaps.at(-1)!.kind, MSG_SNAPSHOT);
  room.step();
  assert.equal(a.snaps.at(-1)!.d.o, undefined);

  // 재접속(새 연결)은 클라이언트 상태가 비어 있으므로 다시 전체 오브
  const a2 = new FakeConn('a');
  room.detach('a', a);
  room.rebind('a', a2);
  room.step();
  assert.ok(a2.snaps[0].d.o, '재접속 직후 오브 포함');
  assert.equal(a2.snaps[0].kind, MSG_SNAPSHOT);
});

test('v5 델타: 일부 플레이어·탄환의 생성/이동/소멸이 섞여도 정확히 복원되고 크기가 줄어든다', () => {
  const baseState = sample();
  const base = encodeSnapshot(baseState, 20, false);

  // 플레이어 1 은 이동+조준, 플레이어 7 은 완전 정지(0B), 탄환 70001 제거, 70002 이동, 70003 추가
  const nextState = {
    tick: baseState.tick + 1,
    rem: baseState.rem - 1,
    p: [
      [1, 820.5, 102.25, 100, 1, 42, -2.5, 2, 16, 4, 2],
      [...baseState.p[1]],
    ],
    b: [
      [70002, 12.25, 514.5],
      [70003, 500, 400],
    ],
    o: baseState.o,
    ev: [{ k: 'hit' as const, v: 7 }],
  };
  const full = encodeSnapshot(nextState, 21, true);
  const delta = encodeSnapshotDelta(full, base)!;
  assert.ok(delta);
  assert.equal(delta[0], MSG_SNAPSHOT_DELTA);
  assert.ok(delta.length < full.length, `delta ${delta.length}B < full ${full.length}B`);

  const read = createSnapshotDecoder();
  assert.throws(() => read(delta), /baseline/);
  read(base);
  assert.deepEqual(read(delta), decodeSnapshot(full));
  assert.throws(() => read(delta), /baseline mismatch/);
});

test('v5 델타: 플레이어 이탈·참가 및 무변화 프레임을 정확히 복원하고 손상된 델타를 거부한다', () => {
  const s0 = sample();
  const base = encodeSnapshot(s0, 10, true);

  // 무변화(tick/rem 만 변경): 최소 크기 델타
  const sIdle = { ...s0, tick: s0.tick + 1, rem: s0.rem - 1, ev: [] };
  const fullIdle = encodeSnapshot(sIdle, 11, false);
  const deltaIdle = encodeSnapshotDelta(fullIdle, base)!;
  assert.ok(deltaIdle.length < 40, `idle delta=${deltaIdle.length}B`);

  const read = createSnapshotDecoder();
  read(base);
  assert.deepEqual(read(deltaIdle), decodeSnapshot(fullIdle));

  // 플레이어 7 이탈 + 플레이어 9 신규 참가 + 탄환 전부 소멸
  const sJoinLeave = {
    tick: sIdle.tick + 1,
    rem: sIdle.rem - 1,
    p: [
      [...sIdle.p[0]],
      [9, 400, 500, 100, 1, 0, 1.25, 0, 0, 0, 0],
    ],
    b: [],
    ev: [],
  };
  const fullJL = encodeSnapshot(sJoinLeave, 12, false);
  const deltaJL = encodeSnapshotDelta(fullJL, fullIdle)!;
  assert.ok(deltaJL);
  assert.ok(deltaJL.length < fullJL.length);
  for (let cut = 0; cut < deltaJL.length; cut++) {
    const check = createSnapshotDecoder();
    check(fullIdle);
    assert.throws(() => check(deltaJL.subarray(0, cut)), `truncated at ${cut}`);
  }
  assert.deepEqual(read(deltaJL), decodeSnapshot(fullJL));
});

test('v5 델타: 8인 교전(탄환 수시 변동)에서도 델타 프레임이 적용되고 평균 전송량이 줄어든다', () => {
  const room = new Room({ durationTicks: 3000, maxPlayers: 8, reconnectGraceTicks: 30, snapshotEvery: 2, repo: null, seed: 11 });
  const a = new FakeConn('a');
  room.addPlayer(a);
  for (let i = 0; i < 7; i++) room.addBot(`bot${i}`);

  for (let i = 1; i <= 180; i++) {
    room.pushInput('a', { seq: i, dx: Math.cos(i / 15), dy: Math.sin(i / 19), aim: i / 10, fire: i % 6 === 0, dash: false });
    room.step();
  }

  const deltaSnaps = a.snaps.filter((s) => s.kind === MSG_SNAPSHOT_DELTA);
  assert.ok(deltaSnaps.length > a.snaps.length * 0.6, `expected majority deltas (${deltaSnaps.length}/${a.snaps.length})`);

  const totalSent = a.snaps.reduce((sum, s) => sum + s.bytes, 0);
  const totalIfFull = a.snaps.reduce((sum, s) => sum + encodeSnapshot(s.d, 0, !!s.d.o).byteLength, 0);
  assert.ok(totalSent < totalIfFull, `delta total ${totalSent}B < full total ${totalIfFull}B`);
});
