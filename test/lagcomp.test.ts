import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sim from '../shared/sim.js';
import { GameWorld } from '../src/game/world.ts';
import { parseClientMessage } from '../src/net/protocol.ts';
import type { PlayerInput } from '../src/game/types.ts';
import { createRng } from '../src/util/rng.ts';

/**
 * 시나리오: 사수(100,920)가 오른쪽(aim=0)으로 쏘고, 피격자는 (300,920)에 서 있다가 위로 피한다(y=860, 탄 경로 밖).
 * 탄은 발사 틱 F 에 첫 이동을 하고 F+5 에 피격자 위치(x≈277)에 도달한다.
 *
 * @param victimMovesAt 피격자가 피하는 틱 (F 기준 상대값)
 * @param rtOffset      사수가 보낸 rt (F 기준 상대값), null 이면 rt 없음(보상 없음)
 */
function scenario(victimMovesAt: number, rtOffset: number | null, maxRewind?: number) {
  const world = new GameWorld(createRng(1));
  const shooter = world.spawn('s', 'S', false);
  const victim = world.spawn('v', 'V', false);
  const place = () => {
    Object.assign(shooter, { x: 100, y: 920 });
    if (victim.y !== 860) Object.assign(victim, { x: 300, y: 920 });
  };
  const empty = new Map<string, PlayerInput[]>();
  const F = 30;
  while (world.tick < F + 12) {
    const next = world.tick + 1;
    place();
    if (next === F + victimMovesAt) victim.y = 860;
    if (next === F) {
      const input: PlayerInput = { seq: 1, dx: 0, dy: 0, aim: 0, fire: true, dash: false };
      if (rtOffset !== null) input.rt = F + rtOffset;
      if (maxRewind !== undefined) input.maxRewind = maxRewind;
      world.step(new Map([['s', [input]]]));
    } else world.step(empty);
  }
  return victim.hp;
}

const HIT = sim.MAX_HP - sim.BULLET_DAMAGE;

test('지연 보상 없음: 탄이 도착하기 전에 피하면 빗나간다 (기존 동작)', () => {
  assert.equal(scenario(+1, null), sim.MAX_HP);
});

test('지연 보상: 사수 화면(8틱 전)에서 맞혔으면, 피격자가 지금은 피했어도 맞는다', () => {
  assert.equal(scenario(+1, -sim.LAG_COMP_MAX_TICKS), HIT);
});

test('지연 보상: 이미 오래전에 피한 대상은 되감아도 맞지 않는다', () => {
  // 발사 4틱 전에 피함 → 8틱 되감은 시점(F-3)에도 이미 피해 있음
  assert.equal(scenario(-4, -sim.LAG_COMP_MAX_TICKS), sim.MAX_HP);
});

test('지연 보상 상한: rt 를 조작해 아주 먼 과거를 요구해도 LAG_COMP_MAX_TICKS 까지만 되감는다', () => {
  // 제한이 없다면 20틱 전(피하기 전)으로 되감겨 맞았을 상황
  assert.equal(scenario(-4, -20), sim.MAX_HP);
  // 미래 시점(rt > 현재 틱)은 보상 0 으로 처리
  assert.equal(scenario(+1, +5), sim.MAX_HP);
});

test('positionAt: 기록 사이를 선형 보간하고, 범위 밖/사망 구간은 null', () => {
  const world = new GameWorld(createRng(2));
  const e = world.spawn('a', 'A', false);
  const empty = new Map<string, PlayerInput[]>();
  Object.assign(e, { x: 100, y: 100 });
  world.step(empty); // tick 1 기록: x=100
  e.x = 130;
  world.step(empty); // tick 2 기록: x=130
  e.x = 160; // 현재(tick 2 이후)
  assert.deepEqual(world.positionAt(e, 1.5), { x: 115, y: 100 });
  assert.equal(world.positionAt(e, 2)!.x, 160, '현재 틱 이상은 현재 위치');
  assert.equal(world.positionAt(e, -5), null, '기록 없는 과거');
});

test('프로토콜: rt 는 선택 필드, 음수/비정상 값 및 maxRewind 주입은 버린다', () => {
  const base = { t: 'input', seq: 1, dx: 0, dy: 0, aim: 0, fire: true, dash: false };
  assert.equal((parseClientMessage(JSON.stringify({ ...base, rt: 12.5, maxRewind: 999 })) as any).rt, 12.5);
  assert.equal('maxRewind' in (parseClientMessage(JSON.stringify({ ...base, rt: 12.5, maxRewind: 999 })) as any), false);
  assert.equal('rt' in (parseClientMessage(JSON.stringify({ ...base, rt: -1 })) as any), false);
  assert.equal('rt' in (parseClientMessage(JSON.stringify({ ...base, rt: 'x' })) as any), false);
  assert.equal('rt' in (parseClientMessage(JSON.stringify(base)) as any), false);
});

test('RTT 기반 지연 보상 동적 상한: 저지연 사수는 최대치까지 백트랙할 수 없다', () => {
  assert.equal(sim.maxRewindTicksForRtt(null), sim.LAG_COMP_MAX_TICKS);
  assert.equal(sim.maxRewindTicksForRtt(undefined), sim.LAG_COMP_MAX_TICKS);
  assert.ok(Math.abs(sim.maxRewindTicksForRtt(0) - (sim.INTERP_DELAY_MS + sim.LAG_COMP_MARGIN_MS) / sim.TICK_MS) < 1e-9);
  assert.ok(Math.abs(sim.maxRewindTicksForRtt(-50) - sim.maxRewindTicksForRtt(0)) < 1e-9);
  assert.ok(Math.abs(sim.maxRewindTicksForRtt(50) - (50 + sim.INTERP_DELAY_MS + sim.LAG_COMP_MARGIN_MS) / sim.TICK_MS) < 1e-9);
  assert.equal(sim.maxRewindTicksForRtt(200), sim.LAG_COMP_MAX_TICKS);

  // 피격자가 F-1 시점에 이미 피함: 7틱 되감으면 맞지만(F-2), RTT=0ms 상한(4.8틱)에서는 빗나간다
  assert.equal(scenario(-1, -sim.LAG_COMP_MAX_TICKS), HIT);
  assert.equal(scenario(-1, -sim.LAG_COMP_MAX_TICKS, sim.maxRewindTicksForRtt(0)), sim.MAX_HP);
});
