import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MatchConfig } from '../src/config.ts';
import { Matchmaker } from '../src/game/matchmaker.ts';
import { Room } from '../src/game/room.ts';
import type { PlayerConnection } from '../src/game/types.ts';

process.env.LOG_LEVEL ??= 'silent';

class FakeConn implements PlayerConnection {
  readonly playerId: string;
  readonly nickname: string;
  messages: any[] = [];

  constructor(playerId: string, nickname = playerId) {
    this.playerId = playerId;
    this.nickname = nickname;
  }

  send(data: string | Uint8Array) {
    if (typeof data === 'string') this.messages.push(JSON.parse(data));
  }

  isCongested() {
    return false;
  }

  last(t: string) {
    return this.messages.filter((m) => m.t === t).at(-1);
  }
}

const cfg: MatchConfig = {
  durationSec: 60,
  maxPlayers: 4,
  botFillAfterMs: 4000,
  botFillTo: 3,
  reconnectGraceMs: 1000,
  lateJoinMinRemainingSec: 30,
};

test('Matchmaker: maxPlayers 에 도달하면 봇 없이 즉시 매치 시작', async () => {
  const mm = new Matchmaker(null, cfg);
  const conns = ['p1', 'p2', 'p3', 'p4'].map((id) => new FakeConn(id));
  for (const c of conns) mm.enqueue(c);

  assert.equal(mm.queueSize, 0);
  assert.equal(mm.rooms.size, 1);
  assert.equal(mm.playersInRooms, 4);
  const roster = conns[0].last('roster');
  assert.equal(roster.roster.length, 4);
  assert.equal(conns[3].last('match_start').roster.length, 4);
  assert.ok(roster.roster.every((r: any[]) => r[2] === 0), '봇 없음');
  await mm.shutdown();
});

test('Matchmaker: 대기 시간 초과 시 봇을 채워 시작하고 난입 시 봇 자리를 양보한다', async () => {
  const mm = new Matchmaker(null, cfg);
  const p1 = new FakeConn('p1');
  mm.enqueue(p1);
  assert.equal(p1.last('queued').size, 1);
  assert.equal(mm.rooms.size, 0);

  // 대기 시간 초과 처리
  mm.process(Date.now() + cfg.botFillAfterMs + 100);
  assert.equal(mm.queueSize, 0);
  assert.equal(mm.rooms.size, 1);
  const room = [...mm.rooms.values()][0] as Room;
  assert.equal(room.size, 3, '사람 1 + 봇 2');
  assert.equal(room.humanCount, 1);

  // 난입: 새 플레이어 2명이 들어와 봇을 대체(최대 4인 중 3인 매치 → p2 추가 후 p3 가 들어올 때 봇 1명 제거)
  const p2 = new FakeConn('p2');
  const p3 = new FakeConn('p3');
  mm.enqueue(p2);
  mm.enqueue(p3);
  assert.equal(mm.rooms.size, 1);
  assert.equal(room.size, 4);
  assert.equal(room.humanCount, 3);
  assert.equal(p3.last('match_start').roomId, room.id);

  // 남은 시간이 lateJoinMinRemainingSec 미만이면 난입 거부 → 대기열에 남음
  while (room.remainingTicks >= cfg.lateJoinMinRemainingSec * 30) room.step();
  const p4 = new FakeConn('p4');
  mm.enqueue(p4);
  assert.equal(mm.queueSize, 1);
  assert.equal(room.humanCount, 3);
  await mm.shutdown();
});

test('Matchmaker: 중복 enqueue, already_in_match, leave, shutdown 동작', async () => {
  const mm = new Matchmaker(null, { ...cfg, maxPlayers: 2, botFillTo: 2 });
  const a1 = new FakeConn('a');
  const a2 = new FakeConn('a');
  mm.enqueue(a1);
  mm.enqueue(a2);
  assert.equal(mm.queueSize, 1, '같은 playerId 중복 enqueue 시 대기열 크기 유지');

  // leave 로 대기열 취소
  mm.leave(a2);
  assert.equal(mm.queueSize, 0);
  assert.equal(a2.last('left').t, 'left');

  // 매치 시작 후 already_in_match 에러
  const b = new FakeConn('b');
  mm.enqueue(a2);
  mm.enqueue(b);
  assert.equal(mm.rooms.size, 1);
  mm.enqueue(a2);
  assert.equal(a2.last('error').code, 'already_in_match');

  // 룸에서 leave 후 shutdown 시 새 enqueue 거부
  mm.leave(a2);
  assert.equal(mm.roomOf('a'), undefined);
  assert.equal(mm.roomOf('b')?.id !== undefined, true);
  await mm.shutdown();
  assert.equal(mm.rooms.size, 0);

  const late = new FakeConn('late');
  mm.enqueue(late);
  assert.equal(late.last('error').code, 'server_shutting_down');
});
