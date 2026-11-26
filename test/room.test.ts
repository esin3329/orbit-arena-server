import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sim from '../shared/sim.js';
import { createSnapshotDecoder } from '../shared/codec.js';
import { Room } from '../src/game/room.ts';
import type { PlayerConnection, PlayerInput } from '../src/game/types.ts';
import { SqliteRepository } from '../src/db/sqlite.ts';
import type { Repository } from '../src/db/types.ts';

process.env.LOG_LEVEL ??= 'silent';

class FakeConn implements PlayerConnection {
  readonly playerId: string;
  readonly nickname: string;
  messages: any[] = [];
  private decodeSnapshot = createSnapshotDecoder();
  constructor(playerId: string, nickname = playerId) {
    this.playerId = playerId;
    this.nickname = nickname;
  }
  bytes: number[] = [];
  send(data: string | Uint8Array) {
    if (typeof data === 'string') return void this.messages.push(JSON.parse(data));
    this.bytes.push(data.byteLength);
    this.messages.push(this.decodeSnapshot(data));
  }
  isCongested() {
    return false;
  }
  last(t: string) {
    return this.messages.filter((m) => m.t === t).at(-1);
  }
}

const makeRoom = (repo: Repository | null = null, durationTicks = 3000, seed = 42) =>
  new Room({ durationTicks, maxPlayers: 8, reconnectGraceTicks: 30, snapshotEvery: 2, repo, seed });

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
  assert.equal(room.debugSeat('a')!.input.length, 8, '큐 상한 초과분은 버려짐');
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
    room.debugSeat('a')!.input.peekSeqs(),
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

  room.detach('b', room.debugSeat('b')!.conn!);
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

test('결정성/리플레이: 같은 시드 + 같은 입력 로그 → 600틱 후 상태 해시 일치, 시드가 다르면 불일치', () => {
  const play = (seed: number) => {
    const room = makeRoom(null, 3000, seed);
    room.addBot('B1');
    room.addBot('B2');
    room.addPlayer(new FakeConn('h'));
    for (let i = 1; i <= 600; i++) {
      room.pushInput('h', mkInput(i, { dx: Math.sin(i / 20), dy: Math.cos(i / 31), aim: i / 10, fire: i % 3 === 0, dash: i % 90 === 0 }));
      room.step();
    }
    return room.debugWorld().hash();
  };
  assert.equal(play(7), play(7));
  assert.notEqual(play(7), play(8));
});

test('같은 매치에서 나갔다 다시 들어오면 기록이 복원되고 DB 에 한 번만 저장된다', async () => {
  const repo = new SqliteRepository(':memory:');
  const [p1, p2] = [await repo.createGuest('Alpha'), await repo.createGuest('Bravo')];
  const room = makeRoom(repo, 20);
  room.addPlayer(new FakeConn(p1.id, 'Alpha'));
  room.addPlayer(new FakeConn(p2.id, 'Bravo'));
  Object.assign(room.debugEntity(p1.id)!, { score: 30, deaths: 4 });

  room.removePlayer(p1.id); // 자발적 이탈
  room.step();
  const back = new FakeConn(p1.id, 'Alpha');
  room.addPlayer(back); // 난입으로 같은 매치에 복귀
  const restored = room.debugEntity(p1.id)!;
  assert.equal(restored.score, 30, '점수 유지');
  assert.equal(restored.deaths, 4, '데스 초기화 악용 불가');
  assert.equal(restored.alive, true);

  for (let i = 0; i < 20; i++) room.step();
  const results = await room.whenEnded()!;
  assert.equal(results.filter((r) => r.playerId === p1.id).length, 1, '결과에 한 번만 등장');
  assert.ok(back.last('match_end').results.find((r: any) => r.playerId === p1.id).ratingAfter !== null, 'DB 저장 성공(레이팅 반영)');
  assert.equal((await repo.getPlayer(p1.id))!.games, 1);
  await repo.close();
});

test('장애 격리: 틱 처리 중 예외가 나면 해당 룸만 error 로 종료되고 결과가 전송된다', async () => {
  const room = makeRoom();
  const a = new FakeConn('a');
  room.addPlayer(a);
  const world = room.debugWorld();
  world.step = () => {
    throw new Error('boom');
  };
  room.start();
  const deadline = Date.now() + 2000;
  while (!room.whenEnded() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  await room.whenEnded();
  assert.equal(room.state, 'ended');
  assert.equal(a.last('match_end').reason, 'error');
});

test('DB 일시 장애: 매치 저장을 재시도해 결국 성공한다', async () => {
  const repo = new SqliteRepository(':memory:');
  const p1 = await repo.createGuest('Alpha');
  let calls = 0;
  const original = repo.recordMatch.bind(repo);
  repo.recordMatch = async (input) => {
    if (++calls === 1) throw new Error('SQLITE_BUSY');
    return original(input);
  };
  const room = makeRoom(repo, 5);
  const c = new FakeConn(p1.id, 'Alpha');
  room.addPlayer(c);
  for (let i = 0; i < 5; i++) room.step();
  await room.whenEnded();
  assert.equal(calls, 2);
  assert.equal(c.last('match_end').results[0].ratingAfter, 1000, '솔로 매치: 레이팅 변동 0 으로 저장됨');
  await repo.close();
});

test('스윕 충돌: 플레이어 가장자리를 스치는 탄도 놓치지 않는다', () => {
  const room = makeRoom();
  room.addPlayer(new FakeConn('a'));
  room.addPlayer(new FakeConn('b'));
  const shooter = room.debugEntity('a')!;
  const victim = room.debugEntity('b')!;
  Object.assign(shooter, { x: 100, y: 920 });
  // 탄 경로(y=920)에서 22px 떨어진 곳: 반경 23 안이지만 끝점 샘플링이면 놓칠 수 있는 위치
  Object.assign(victim, { x: 300, y: 942 });
  room.pushInput('a', mkInput(1, { fire: true }));
  for (let i = 0; i < 20; i++) room.step();
  assert.equal(victim.hp, sim.MAX_HP - sim.BULLET_DAMAGE);
});
