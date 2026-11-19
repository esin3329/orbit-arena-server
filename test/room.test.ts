import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sim from '../shared/sim.js';
import { Room } from '../src/game/room.ts';
import type { PlayerConnection, PlayerInput } from '../src/game/types.ts';
import { SqliteRepository } from '../src/db/sqlite.ts';
import type { Repository } from '../src/db/types.ts';

process.env.LOG_LEVEL ??= 'silent';

class FakeConn implements PlayerConnection {
  readonly playerId: string;
  readonly nickname: string;
  messages: any[] = [];
  constructor(playerId: string, nickname = playerId) {
    this.playerId = playerId;
    this.nickname = nickname;
  }
  send(data: string) {
    this.messages.push(JSON.parse(data));
  }
  isCongested() {
    return false;
  }
  last(t: string) {
    return this.messages.filter((m) => m.t === t).at(-1);
  }
}

/** 재현 가능한 테스트를 위한 시드 RNG (mulberry32) */
function seeded(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const makeRoom = (repo: Repository | null = null, durationTicks = 3000) =>
  new Room({ durationTicks, maxPlayers: 8, reconnectGraceTicks: 30, snapshotEvery: 2, repo, random: seeded(42) });

const mkInput = (seq: number, o: Partial<PlayerInput> = {}): PlayerInput => ({ seq, dx: 0, dy: 0, aim: 0, fire: false, dash: false, ...o });

test('서버 이동 결과 == 클라이언트 예측(같은 shared/sim.js) — 완전 일치', () => {
  const room = makeRoom();
  const a = new FakeConn('a');
  room.addPlayer(a);
  room.addPlayer(new FakeConn('b'));
  const e = room.debugEntity('a')!;
  const predicted = { x: e.x, y: e.y, dashTicks: 0, dashCd: 0 };

  for (let i = 1; i <= 40; i++) {
    const inp = mkInput(i, { dx: Math.cos(i / 5), dy: Math.sin(i / 7), dash: i === 10 });
    room.pushInput('a', inp);
    sim.stepMovement(predicted, inp); // 클라이언트가 하는 일
    room.step();
  }
  assert.equal(e.x, predicted.x);
  assert.equal(e.y, predicted.y);
  assert.equal(a.last('snap').ack, 40, '스냅샷 ack 는 마지막 처리 입력 seq');
});

test('입력 예산: 한꺼번에 입력을 몰아 보내도(스피드핵) 이동량이 제한된다', () => {
  const room = makeRoom();
  room.addPlayer(new FakeConn('a'));
  room.addPlayer(new FakeConn('b'));
  const e = room.debugEntity('a')!;
  Object.assign(e, { x: 800, y: 150 });
  for (let i = 1; i <= 100; i++) room.pushInput('a', mkInput(i, { dx: 1 }));
  assert.equal(e.inputs.length, 8, '큐 상한 초과분은 버려짐');
  room.step();
  assert.ok(e.x - 800 <= 2 * sim.PLAYER_SPEED * sim.DT + 1e-9, '첫 틱에는 예산만큼만 처리');
});

test('중복/역순 seq 입력은 무시된다', () => {
  const room = makeRoom();
  room.addPlayer(new FakeConn('a'));
  room.addPlayer(new FakeConn('b'));
  room.pushInput('a', mkInput(5));
  room.pushInput('a', mkInput(3));
  room.pushInput('a', mkInput(5));
  assert.deepEqual(
    room.debugEntity('a')!.inputs.map((i) => i.seq),
    [5],
  );
});

test('사격 → 피격 → 사망 → 킬 점수, 일정 시간 후 리스폰', () => {
  const room = makeRoom();
  const a = new FakeConn('a');
  room.addPlayer(a);
  room.addPlayer(new FakeConn('b'));
  const shooter = room.debugEntity('a')!;
  const victim = room.debugEntity('b')!;
  Object.assign(shooter, { x: 100, y: 920 });
  Object.assign(victim, { x: 300, y: 920 });

  let seq = 0;
  while (victim.alive && seq < 120) {
    room.pushInput('a', mkInput(++seq, { aim: 0, fire: true }));
    room.step();
  }
  assert.equal(victim.alive, false);
  assert.equal(victim.deaths, 1);
  assert.equal(shooter.kills, 1);
  assert.ok(shooter.score >= sim.KILL_SCORE);
  const killEvent = a.messages.filter((m) => m.t === 'snap').flatMap((m) => m.d.ev).find((ev: any) => ev.k === 'kill');
  assert.deepEqual(killEvent, { k: 'kill', by: shooter.eid, v: victim.eid });

  for (let i = 0; i < sim.RESPAWN_TICKS; i++) room.step();
  assert.equal(victim.alive, true);
  assert.equal(victim.hp, sim.MAX_HP);
});

test('재접속: 유예 시간 내 rebind 하면 점수 유지, 초과하면 제거', () => {
  const room = makeRoom();
  const a1 = new FakeConn('a');
  room.addPlayer(a1);
  room.addPlayer(new FakeConn('b'));
  room.debugEntity('a')!.score = 7;
  room.detach('a', a1);
  for (let i = 0; i < 10; i++) room.step();
  const a2 = new FakeConn('a');
  assert.equal(room.rebind('a', a2), true);
  assert.equal(room.debugEntity('a')!.score, 7);
  assert.equal(a2.last('match_start').roomId, room.id);

  room.detach('b', room.debugEntity('b')!.conn!);
  for (let i = 0; i < 40; i++) room.step();
  assert.equal(room.hasPlayer('b'), false, '유예(30틱) 초과 후 제거');
});

test('매치 종료: 순위 계산 + DB 저장 + 레이팅 변동 전송', async () => {
  const repo = new SqliteRepository(':memory:');
  const [p1, p2] = [await repo.createGuest('Alpha'), await repo.createGuest('Bravo')];
  const room = makeRoom(repo, 10);
  const c1 = new FakeConn(p1.id, 'Alpha');
  const c2 = new FakeConn(p2.id, 'Bravo');
  room.addPlayer(c1);
  room.addPlayer(c2);
  room.addBot('Bot');
  room.debugEntity(p1.id)!.score = 50;
  room.debugEntity(p2.id)!.score = 10;

  for (let i = 0; i < 10; i++) room.step();
  const results = await room.whenEnded()!;
  assert.equal(room.state, 'ended');
  assert.equal(results.find((r) => r.playerId === p1.id)!.placement, 1);

  const end = c1.last('match_end');
  const mine = end.results.find((r: any) => r.playerId === p1.id);
  assert.ok(mine.ratingDelta > 0);
  assert.equal(end.results.find((r: any) => r.isBot).ratingDelta, null, '봇은 레이팅 없음');

  const lb = await repo.leaderboard(10);
  assert.deepEqual(
    lb.map((p) => [p.nickname, p.games, p.wins]),
    [
      ['Alpha', 1, 1],
      ['Bravo', 1, 0],
    ],
  );
  const recent = await repo.recentMatches(5);
  assert.equal(recent[0].botCount, 1);
  assert.equal(recent[0].participants.length, 2);
  await repo.close();
});
