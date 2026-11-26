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
  /** 지연 보상: 이 탄은 (현재 틱 - rewind) 시점의 플레이어 위치와 충돌 판정한다 (0 = 보상 없음) */
  rewind: number;
}

/** 한 틱이 끝난 시점의 엔티티 위치 기록 (지연 보상 되감기용) */
interface HistoryFrame {
  tick: number;
  pos: Map<number, { x: number; y: number; alive: boolean }>;
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
  /** 최근 LAG_COMP_MAX_TICKS+1 틱의 위치 링버퍼 (tick % 길이 로 인덱싱) */
  private history: Array<HistoryFrame | undefined> = new Array(sim.LAG_COMP_MAX_TICKS + 2);
  private nextEid = 1;
  private nextBulletId = 1;
  /** 오브 활성/위치가 바뀔 때마다 증가 (스냅샷 델타용) */
  private orbVersion = 0;
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
    this.recordHistory();
  }

  private recordHistory() {
    const pos = new Map<number, { x: number; y: number; alive: boolean }>();
    for (const e of this.entities.values()) pos.set(e.eid, { x: e.x, y: e.y, alive: e.alive });
    this.history[this.tick % this.history.length] = { tick: this.tick, pos };
  }

  private frame(tick: number): HistoryFrame | undefined {
    const f = this.history[tick % this.history.length];
    return f && f.tick === tick ? f : undefined;
  }

  /**
   * 과거 시점(소수 틱 가능)의 엔티티 위치. 두 기록 사이를 선형 보간한다 — 클라이언트가 보간해서 그린 위치와 같게.
   * 그 시점에 죽어 있었거나 기록이 없으면(아직 스폰 전 등) null → 판정 대상 아님.
   * 현재 틱(이번 틱 이동이 이미 반영된 상태)은 엔티티 자체를 쓴다.
   */
  positionAt(e: Entity, tick: number): { x: number; y: number } | null {
    if (tick >= this.tick) return e.alive ? e : null;
    const t0 = Math.floor(tick);
    const a = this.frame(t0)?.pos.get(e.eid);
    // 틱 진행 도중(탄환 처리 시점)에는 현재 틱 기록이 아직 없으므로 현재 엔티티가 그 틱의 위치다
    const b = this.frame(t0 + 1)?.pos.get(e.eid) ?? (t0 + 1 >= this.tick && e.alive ? { x: e.x, y: e.y, alive: true } : undefined);
    if (!a || !a.alive || !b || !b.alive) return null; // 사망/리스폰/스폰 경계에서는 판정하지 않는다(보수적)
    const f = tick - t0;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
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
        rewind: this.rewindFor(input),
      });
    }
  }

  /**
   * 지연 보상(lag compensation) 되감기 양.
   * 사수의 화면에서 다른 플레이어는 (보간 지연 + 네트워크 지연)만큼 과거 모습이다.
   * 클라이언트가 보낸 rt(그때 화면에 그리던 서버 틱)와 처리 시점의 차이만큼 판정 시점을 되돌려
   * "내 화면에서 맞혔으면 맞는다"를 보장한다. rt 는 조작 가능하므로 [0, LAG_COMP_MAX_TICKS] 로 제한.
   */
  private rewindFor(input: PlayerInput): number {
    if (input.rt === undefined) return 0;
    const r = this.tick - input.rt;
    return r <= 0 ? 0 : Math.min(r, sim.LAG_COMP_MAX_TICKS);
  }

  /**
   * 탄환 이동은 연속 충돌 검사(swept test): 이번 틱의 이동 선분과
   * 벽/플레이어의 첫 교차 지점(t 최소)을 찾아 그 대상에만 적중시킨다.
   * 지연 보상 탄은 플레이어를 현재 위치가 아니라 (현재 틱 - rewind) 시점 위치로 판정한다.
   * 벽은 움직이지 않으므로 되감기와 무관하다.
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
        if (!e.alive || e.eid === b.ownerEid) continue; // 지금 죽어 있는 대상은 과거 위치로도 맞지 않는다
        const p = b.rewind > 0 ? this.positionAt(e, this.tick - b.rewind) : e;
        if (!p) continue;
        const t = sim.segmentCircleHit(b.x, b.y, x1, y1, p.x, p.y, BULLET_HIT_RADIUS);
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
          this.orbVersion++;
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
          this.orbVersion++;
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

  /**
   * 모든 플레이어에게 공통인 스냅샷 본문. 양자화는 와이어 코덱(shared/codec.js)이 맡는다.
   * `ov` 는 오브 상태 버전 — 룸이 클라이언트별로 마지막에 보낸 버전과 비교해 오브 목록을 실을지 정한다.
   */
  snapshot(remainingTicks: number) {
    const p: number[][] = [];
    for (const e of this.entities.values()) {
      p.push([e.eid, e.x, e.y, e.hp, e.alive ? 1 : 0, e.score, e.aim, e.dashTicks, e.dashCd, e.kills, e.deaths]);
    }
    return {
      tick: this.tick,
      rem: remainingTicks,
      p,
      b: this.bullets.map((b) => [b.id, b.x, b.y]),
      o: this.orbs.filter((o) => o.active).map((o) => [o.id, Math.round(o.x), Math.round(o.y)]),
      ov: this.orbVersion,
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
    for (const b of this.bullets) h.update(`|b${b.id}:${b.x},${b.y},${b.rewind}`);
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
