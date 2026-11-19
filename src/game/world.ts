import { createHash } from 'node:crypto';
import * as sim from '../../shared/sim.js';
import type { Rng } from '../util/rng.ts';
import type { PlayerInput } from './types.ts';

export interface Entity extends sim.MoveState {
  readonly eid: number;
  readonly playerId: string;
  readonly nickname: string;
  readonly isBot: boolean;
  aim: number;
  hp: number;
  alive: boolean;
  respawnTick: number;
  fireCd: number;
  score: number;
  kills: number;
  deaths: number;
}

export interface Bullet {
  id: number;
  ownerEid: number;
  ownerPlayerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
}

export interface Orb {
  id: number;
  x: number;
  y: number;
  active: boolean;
  respawnTick: number;
}

export type GameEvent =
  | { k: 'hit'; v: number }
  | { k: 'kill'; by: number; v: number }
  | { k: 'orb'; by: number };

const r2 = (v: number) => Math.round(v * 100) / 100;
const BULLET_HIT_RADIUS = sim.PLAYER_RADIUS + sim.BULLET_RADIUS;

/**
 * 매치 1판의 순수 게임 상태와 규칙.
 *
 * 네트워크·DB·타이머·로깅에 의존하지 않는다. 입력은 step() 인자로만 들어오고,
 * 난수는 주입된 시드 RNG 만 사용하므로 "같은 시드 + 같은 입력열 → 같은 상태"가 보장된다(결정성).
 * 덕분에 수천 틱짜리 시나리오도 실시간 대기 없이 단위 테스트할 수 있고, 리플레이 검증이 가능하다.
 */
export class GameWorld {
  tick = 0;
  readonly entities = new Map<string, Entity>();
  readonly orbs: Orb[] = [];
  private bullets: Bullet[] = [];
  private events: GameEvent[] = [];
  private nextEid = 1;
  private nextBulletId = 1;
  private rand: Rng;

  constructor(rand: Rng) {
    this.rand = rand;
    for (let i = 0; i < sim.ORB_COUNT; i++) {
      const p = this.randomFreePoint(sim.ORB_RADIUS + 6);
      this.orbs.push({ id: i + 1, x: p.x, y: p.y, active: true, respawnTick: 0 });
    }
  }

  // ───────────────────────── 엔티티 ─────────────────────────

  spawn(playerId: string, nickname: string, isBot: boolean): Entity {
    const p = this.findSpawn();
    const e: Entity = {
      eid: this.nextEid++,
      playerId,
      nickname,
      isBot,
      x: p.x,
      y: p.y,
      dashTicks: 0,
      dashCd: 0,
      aim: 0,
      hp: sim.MAX_HP,
      alive: true,
      respawnTick: 0,
      fireCd: 0,
      score: 0,
      kills: 0,
      deaths: 0,
    };
    this.entities.set(playerId, e);
    return e;
  }

  remove(playerId: string): Entity | undefined {
    const e = this.entities.get(playerId);
    this.entities.delete(playerId);
    return e;
  }

  /** 이탈했던 플레이어가 같은 매치에 다시 들어오면 기록(점수/킬/데스)을 이어서 쓴다 */
  restore(e: Entity) {
    const p = this.findSpawn();
    Object.assign(e, { x: p.x, y: p.y, hp: sim.MAX_HP, alive: true, dashTicks: 0, dashCd: 0, fireCd: 0 });
    this.entities.set(e.playerId, e);
  }

  get bulletCount() {
    return this.bullets.length;
  }

  // ───────────────────────── 틱 ─────────────────────────

  /**
   * 한 틱 진행.
   * @param inputs 플레이어별로 이번 틱에 처리할 입력 (InputBuffer 가 예산만큼 꺼낸 것)
   */
  step(inputs: ReadonlyMap<string, readonly PlayerInput[]>) {
    this.tick++;
    for (const e of this.entities.values()) {
      if (e.fireCd > 0) e.fireCd--;
      const list = inputs.get(e.playerId);
      if (list) for (const input of list) this.applyInput(e, input);
    }
    this.stepBullets();
    this.stepOrbs();
    this.stepRespawns();
  }

  private applyInput(e: Entity, input: PlayerInput) {
    e.aim = input.aim;
    if (!e.alive) return;
    sim.stepMovement(e, input); // 클라이언트 예측과 동일한 함수
    if (input.fire && e.fireCd <= 0) {
      e.fireCd = sim.FIRE_COOLDOWN_TICKS;
      const cos = Math.cos(input.aim);
      const sin = Math.sin(input.aim);
      const off = sim.PLAYER_RADIUS + sim.BULLET_RADIUS + 1;
      this.bullets.push({
        id: this.nextBulletId++,
        ownerEid: e.eid,
        ownerPlayerId: e.playerId,
        x: e.x + cos * off,
        y: e.y + sin * off,
        vx: cos * sim.BULLET_SPEED * sim.DT,
        vy: sin * sim.BULLET_SPEED * sim.DT,
        ttl: sim.BULLET_LIFETIME_TICKS,
      });
    }
  }

  /**
   * 탄환 이동은 연속 충돌 검사(swept test): 이번 틱의 이동 선분과
   * 벽/플레이어의 첫 교차 지점(t 최소)을 찾아 그 대상에만 적중시킨다.
   */
  private stepBullets() {
    const alive: Bullet[] = [];
    for (const b of this.bullets) {
      const x1 = b.x + b.vx;
      const y1 = b.y + b.vy;
      const wallT = sim.segmentObstacleHit(b.x, b.y, x1, y1, sim.BULLET_RADIUS);
      let bestT = wallT < 0 ? Infinity : wallT;
      let victim: Entity | null = null;
      for (const e of this.entities.values()) {
        if (!e.alive || e.eid === b.ownerEid) continue;
        const t = sim.segmentCircleHit(b.x, b.y, x1, y1, e.x, e.y, BULLET_HIT_RADIUS);
        if (t >= 0 && t < bestT) {
          bestT = t;
          victim = e;
        }
      }
      if (victim) {
        this.damage(victim, b.ownerPlayerId);
        continue;
      }
      if (wallT >= 0) continue;
      b.x = x1;
      b.y = y1;
      b.ttl--;
      if (b.ttl <= 0 || b.x < 0 || b.y < 0 || b.x > sim.ARENA_W || b.y > sim.ARENA_H) continue;
      alive.push(b);
    }
    this.bullets = alive;
  }

  private damage(victim: Entity, attackerId: string) {
    victim.hp -= sim.BULLET_DAMAGE;
    this.events.push({ k: 'hit', v: victim.eid });
    if (victim.hp > 0) return;
    victim.hp = 0;
    victim.alive = false;
    victim.deaths++;
    victim.respawnTick = this.tick + sim.RESPAWN_TICKS;
    const killer = this.entities.get(attackerId);
    if (killer) {
      killer.kills++;
      killer.score += sim.KILL_SCORE;
    }
    this.events.push({ k: 'kill', by: killer?.eid ?? 0, v: victim.eid });
  }

  private stepOrbs() {
    const pickR2 = (sim.PLAYER_RADIUS + sim.ORB_RADIUS) ** 2;
    for (const o of this.orbs) {
      if (!o.active) {
        if (this.tick >= o.respawnTick) {
          const p = this.randomFreePoint(sim.ORB_RADIUS + 6);
          o.x = p.x;
          o.y = p.y;
          o.active = true;
        }
        continue;
      }
      for (const e of this.entities.values()) {
        if (!e.alive) continue;
        const dx = e.x - o.x;
        const dy = e.y - o.y;
        if (dx * dx + dy * dy <= pickR2) {
          e.score += sim.ORB_SCORE;
          o.active = false;
          o.respawnTick = this.tick + 60 + Math.floor(this.rand() * 90);
          this.events.push({ k: 'orb', by: e.eid });
          break;
        }
      }
    }
  }

  private stepRespawns() {
    for (const e of this.entities.values()) {
      if (!e.alive && this.tick >= e.respawnTick) {
        const p = this.findSpawn();
        Object.assign(e, { x: p.x, y: p.y, hp: sim.MAX_HP, alive: true, dashTicks: 0, dashCd: 0 });
      }
    }
  }

  // ───────────────────────── 직렬화 ─────────────────────────

  /** 직전 스냅샷 이후 쌓인 이벤트를 꺼낸다 */
  takeEvents(): GameEvent[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  /** 모든 플레이어에게 공통인 스냅샷 본문 (좌표는 소수 2자리로 양자화해 대역폭 절감) */
  snapshot(remainingTicks: number) {
    const p: number[][] = [];
    for (const e of this.entities.values()) {
      p.push([e.eid, r2(e.x), r2(e.y), e.hp, e.alive ? 1 : 0, e.score, r2(e.aim), e.dashTicks, e.dashCd, e.kills, e.deaths]);
    }
    return {
      tick: this.tick,
      rem: remainingTicks,
      p,
      b: this.bullets.map((b) => [b.id, r2(b.x), r2(b.y)]),
      o: this.orbs.filter((o) => o.active).map((o) => [o.id, Math.round(o.x), Math.round(o.y)]),
      ev: this.takeEvents(),
    };
  }

  /** 결정성/리플레이 검증용 상태 해시 */
  hash(): string {
    const h = createHash('sha256');
    h.update(String(this.tick));
    for (const e of this.entities.values()) {
      h.update(`|${e.playerId}:${e.x},${e.y},${e.hp},${e.alive},${e.score},${e.kills},${e.deaths},${e.dashCd}`);
    }
    for (const b of this.bullets) h.update(`|b${b.id}:${b.x},${b.y}`);
    for (const o of this.orbs) h.update(`|o${o.id}:${o.x},${o.y},${o.active}`);
    return h.digest('hex').slice(0, 16);
  }

  // ───────────────────────── 헬퍼 ─────────────────────────

  private randomFreePoint(pad: number) {
    for (let i = 0; i < 50; i++) {
      const x = pad + this.rand() * (sim.ARENA_W - pad * 2);
      const y = pad + this.rand() * (sim.ARENA_H - pad * 2);
      if (!sim.pointInObstacle(x, y, pad)) return { x, y };
    }
    return { x: sim.ARENA_W / 2, y: 60 };
  }

  /** 후보 지점 중 살아있는 플레이어와 가장 먼 곳을 고른다 (스폰킬 완화) */
  private findSpawn() {
    let best = this.randomFreePoint(sim.PLAYER_RADIUS + 4);
    let bestScore = -1;
    for (let i = 0; i < 16; i++) {
      const c = this.randomFreePoint(sim.PLAYER_RADIUS + 4);
      let minD = Infinity;
      for (const e of this.entities.values()) if (e.alive) minD = Math.min(minD, Math.hypot(e.x - c.x, e.y - c.y));
      if (minD > bestScore) {
        bestScore = minD;
        best = c;
      }
    }
    return best;
  }
}
