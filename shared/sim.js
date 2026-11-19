// @ts-check
/**
 * 서버와 브라우저 클라이언트가 "같은 파일"을 공유하는 결정적(deterministic) 시뮬레이션.
 *
 * - 서버: 권위 있는(authoritative) 게임 상태 계산에 사용
 * - 클라이언트: 입력 예측(client-side prediction)과 서버 보정(reconciliation) 재시뮬레이션에 사용
 *
 * 두 쪽이 완전히 동일한 연산 순서로 계산하므로, 패킷 손실/지연이 없다면 예측 결과와 서버 결과가 일치한다.
 * 브라우저에서 그대로 import 할 수 있도록 빌드 없는 순수 ES 모듈 + JSDoc 타입으로 작성했다.
 */

export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
export const DT = 1 / TICK_RATE;

export const ARENA_W = 1600;
export const ARENA_H = 1000;

export const PLAYER_RADIUS = 18;
export const PLAYER_SPEED = 240; // px/s
export const MAX_HP = 100;

export const DASH_TICKS = 6;
export const DASH_MULT = 2.8;
export const DASH_COOLDOWN_TICKS = 45;

export const BULLET_SPEED = 820; // px/s
export const BULLET_RADIUS = 5;
export const BULLET_DAMAGE = 20;
export const BULLET_LIFETIME_TICKS = 36;
export const FIRE_COOLDOWN_TICKS = 6;

export const ORB_RADIUS = 10;
export const ORB_COUNT = 14;
export const RESPAWN_TICKS = 60;

export const KILL_SCORE = 10;
export const ORB_SCORE = 1;

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {{ seq: number, dx: number, dy: number, aim: number, fire: boolean, dash: boolean }} PlayerInput */
/** @typedef {{ x: number, y: number, dashTicks: number, dashCd: number }} MoveState */

/**
 * 맵 중심 기준 점대칭 장애물 배치 (공정한 스폰을 위해)
 * @type {ReadonlyArray<Rect>}
 */
export const OBSTACLES = Object.freeze([
  { x: 380, y: 200, w: 60, h: 220 },
  { x: 1160, y: 580, w: 60, h: 220 },
  { x: 700, y: 460, w: 200, h: 80 },
  { x: 260, y: 700, w: 200, h: 50 },
  { x: 1140, y: 250, w: 200, h: 50 },
]);

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 입력 1개를 1틱(DT) 동안 적용한다. 서버/클라이언트 공용.
 * 상태 객체를 제자리에서 변경한다(할당 최소화).
 * @param {MoveState} s
 * @param {PlayerInput} input
 */
export function stepMovement(s, input) {
  let dx = input.dx;
  let dy = input.dy;
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    dx /= len;
    dy /= len;
  }
  if (input.dash && s.dashCd <= 0 && len > 0.1) {
    s.dashTicks = DASH_TICKS;
    s.dashCd = DASH_COOLDOWN_TICKS;
  }
  const speed = PLAYER_SPEED * (s.dashTicks > 0 ? DASH_MULT : 1);
  s.x += dx * speed * DT;
  s.y += dy * speed * DT;
  if (s.dashTicks > 0) s.dashTicks--;
  if (s.dashCd > 0) s.dashCd--;
  resolveCircle(s, PLAYER_RADIUS);
}

/**
 * 원(플레이어)과 사각 장애물/맵 경계의 충돌을 밀어내기 방식으로 해소한다.
 * @param {{ x: number, y: number }} s
 * @param {number} r
 */
export function resolveCircle(s, r) {
  for (const o of OBSTACLES) {
    const cx = clamp(s.x, o.x, o.x + o.w);
    const cy = clamp(s.y, o.y, o.y + o.h);
    const ddx = s.x - cx;
    const ddy = s.y - cy;
    const d2 = ddx * ddx + ddy * ddy;
    if (d2 >= r * r) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      s.x = cx + (ddx / d) * r;
      s.y = cy + (ddy / d) * r;
    } else {
      // 중심이 사각형 내부: 가장 얕은 축으로 밀어낸다
      const left = s.x - o.x;
      const right = o.x + o.w - s.x;
      const top = s.y - o.y;
      const bottom = o.y + o.h - s.y;
      const m = Math.min(left, right, top, bottom);
      if (m === left) s.x = o.x - r;
      else if (m === right) s.x = o.x + o.w + r;
      else if (m === top) s.y = o.y - r;
      else s.y = o.y + o.h + r;
    }
  }
  s.x = clamp(s.x, r, ARENA_W - r);
  s.y = clamp(s.y, r, ARENA_H - r);
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} [pad]
 */
export function pointInObstacle(x, y, pad = 0) {
  for (const o of OBSTACLES) {
    if (x > o.x - pad && x < o.x + o.w + pad && y > o.y - pad && y < o.y + o.h + pad) return true;
  }
  return false;
}
