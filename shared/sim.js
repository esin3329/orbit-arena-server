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

/** 클라이언트/서버 메시지 형식이 바뀌면 올린다. 불일치 시 서버가 WS 업그레이드를 426 으로 거부 */
export const PROTOCOL_VERSION = 3;

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

/**
 * 지연 보상 최대 되감기 시간. 클라이언트가 rt 를 조작해도 이 이상은 과거로 갈 수 없다.
 * 값이 클수록 고지연 사수에게 유리하고 피격자는 "이미 숨었는데 맞는" 체감이 커지는 트레이드오프.
 */
export const LAG_COMP_MAX_MS = 250;
export const LAG_COMP_MAX_TICKS = Math.round(LAG_COMP_MAX_MS / TICK_MS);

export const KILL_SCORE = 10;
export const ORB_SCORE = 1;

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/**
 * rt: 입력을 만들 때 클라이언트 화면에 보이던 서버 틱(보간 시점, 소수 가능) — 지연 보상에 사용
 * @typedef {{ seq: number, dx: number, dy: number, aim: number, fire: boolean, dash: boolean, rt?: number }} PlayerInput
 */
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

/**
 * 선분 P0→P1 이 원(c, r)에 처음 닿는 지점의 매개변수 t∈[0,1] 를 반환한다. 닿지 않으면 -1.
 * 탄환은 한 틱에 ~27px 이동하므로 끝점만 검사하면 원 가장자리를 스치는 탄이 빠져나간다(터널링).
 * 이동 구간 전체를 검사(swept test)해 이를 막는다.
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 */
export function segmentCircleHit(x0, y0, x1, y1, cx, cy, r) {
  const fx = x0 - cx;
  const fy = y0 - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0; // 시작점이 이미 원 안
  const dx = x1 - x0;
  const dy = y1 - y0;
  const a = dx * dx + dy * dy;
  if (a === 0) return -1;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

/**
 * 선분 P0→P1 이 장애물(pad 만큼 부풀린 사각형)에 처음 닿는 t∈[0,1], 없으면 -1 (Liang–Barsky 클리핑).
 * 탄환-벽 충돌과 봇의 시야(line of sight) 판정에 공용으로 쓴다.
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} [pad]
 */
export function segmentObstacleHit(x0, y0, x1, y1, pad = 0) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let best = -1;
  for (const o of OBSTACLES) {
    const p = [-dx, dx, -dy, dy];
    const q = [x0 - (o.x - pad), o.x + o.w + pad - x0, y0 - (o.y - pad), o.y + o.h + pad - y0];
    let t0 = 0;
    let t1 = 1;
    let hit = true;
    for (let i = 0; i < 4 && hit; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) hit = false; // 해당 축과 평행하고 슬랩 바깥
        continue;
      }
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) hit = false;
        else if (t > t0) t0 = t;
      } else if (t < t0) hit = false;
      else if (t < t1) t1 = t;
    }
    if (hit && (best < 0 || t0 < best)) best = t0;
  }
  return best;
}
