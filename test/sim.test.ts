import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sim from '../shared/sim.js';

const input = (o: Partial<sim.PlayerInput> = {}): sim.PlayerInput => ({ seq: 1, dx: 0, dy: 0, aim: 0, fire: false, dash: false, ...o });

test('이동: 1틱에 speed*DT 만큼 이동, 대각선은 정규화', () => {
  const s = { x: 100, y: 100, dashTicks: 0, dashCd: 0 };
  sim.stepMovement(s, input({ dx: 1 }));
  assert.equal(s.x, 100 + sim.PLAYER_SPEED * sim.DT);

  const d = { x: 100, y: 100, dashTicks: 0, dashCd: 0 };
  sim.stepMovement(d, input({ dx: 1, dy: 1 }));
  assert.ok(Math.abs(Math.hypot(d.x - 100, d.y - 100) - sim.PLAYER_SPEED * sim.DT) < 1e-9);
});

test('대시: 쿨다운 동안 재사용 불가', () => {
  const s = { x: 100, y: 100, dashTicks: 0, dashCd: 0 };
  sim.stepMovement(s, input({ dx: 1, dash: true }));
  assert.equal(s.dashTicks, sim.DASH_TICKS - 1);
  assert.equal(s.dashCd, sim.DASH_COOLDOWN_TICKS - 1);
  const cd = s.dashCd;
  sim.stepMovement(s, input({ dx: 1, dash: true }));
  assert.equal(s.dashCd, cd - 1, '쿨다운 중 대시 재발동 안 됨');
});

test('충돌: 맵 경계와 장애물을 통과할 수 없다', () => {
  const s = { x: sim.PLAYER_RADIUS, y: 500, dashTicks: 0, dashCd: 0 };
  for (let i = 0; i < 30; i++) sim.stepMovement(s, input({ dx: -1 }));
  assert.equal(s.x, sim.PLAYER_RADIUS);

  const o = sim.OBSTACLES[0];
  const p = { x: o.x - 60, y: o.y + o.h / 2, dashTicks: 0, dashCd: 0 };
  for (let i = 0; i < 60; i++) sim.stepMovement(p, input({ dx: 1 }));
  assert.ok(p.x <= o.x - sim.PLAYER_RADIUS + 1e-9, `장애물 왼쪽 면에서 멈춰야 함 (x=${p.x})`);
});

test('결정성: 같은 입력열은 항상 같은 결과', () => {
  const run = () => {
    const s = { x: 300, y: 300, dashTicks: 0, dashCd: 0 };
    for (let i = 0; i < 200; i++) sim.stepMovement(s, input({ seq: i, dx: Math.sin(i * 0.3), dy: Math.cos(i * 0.17), dash: i % 50 === 0 }));
    return s;
  };
  assert.deepEqual(run(), run());
});
