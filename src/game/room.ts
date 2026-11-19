import { randomUUID } from 'node:crypto';
import * as sim from '../../shared/sim.js';
import type { Repository } from '../db/types.ts';
import { logger, errorFields } from '../util/logger.ts';
import { metrics } from '../util/metrics.ts';
import { BotBrain } from './bot.ts';
import type { PlayerConnection, PlayerInput } from './types.ts';

/** 틱당 입력 예산 회복량. 1.0 이면 정확히 30Hz, 5% 여유를 둬 클럭 오차를 흡수한다. */
const INPUT_CREDIT_PER_TICK = 1.05;
/** 네트워크 지터로 몰려온 입력을 한 틱에 최대 몇 개까지 따라잡을지 */
const MAX_INPUT_CREDIT = 4;
/** 입력 큐 상한 — 초과 시 가장 오래된 입력을 버려 지연이 무한히 쌓이지 않게 한다 */
const MAX_INPUT_QUEUE = 8;
/** 매 루프에서 밀린 틱을 최대 몇 개까지 연속 처리할지 (spiral of death 방지) */
const MAX_CATCHUP_STEPS = 5;

export interface Entity extends sim.MoveState {
  eid: number;
  playerId: string;
  nickname: string;
  isBot: boolean;
  conn: PlayerConnection | null;
  aim: number;
  hp: number;
  alive: boolean;
  respawnTick: number;
  fireCd: number;
  score: number;
  kills: number;
  deaths: number;
  inputs: PlayerInput[];
  inputCredit: number;
  lastSeq: number;
  disconnectedTick: number | null;
  bot: BotBrain | null;
}

interface Bullet {
  id: number;
  ownerEid: number;
  ownerPlayerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
  dead: boolean;
}

interface Orb {
  id: number;
  x: number;
  y: number;
  active: boolean;
  respawnTick: number;
}

export interface MatchResultRow {
  eid: number;
  playerId: string | null;
  nickname: string;
  isBot: boolean;
  score: number;
  kills: number;
  deaths: number;
  placement: number;
  ratingDelta: number | null;
  ratingAfter: number | null;
}

export type EndReason = 'time' | 'abandoned' | 'shutdown';

export interface RoomOptions {
  id?: string;
  durationTicks: number;
  maxPlayers: number;
  reconnectGraceTicks: number;
  snapshotEvery: number;
  repo: Repository | null;
  onEnd?: (room: Room) => void;
  random?: () => number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 하나의 매치를 시뮬레이션하는 서버 권위(authoritative) 룸.
 *
 * 고정 타임스텝(30Hz) 루프:
 *   1) 플레이어별 입력 큐에서 입력 예산만큼 꺼내 공유 시뮬레이션(shared/sim.js)으로 이동 적용
 *   2) 탄환 이동/충돌, 피격/사망 처리
 *   3) 오브 획득, 리스폰, 재접속 유예 만료 처리
 *   4) N틱마다 스냅샷 브로드캐스트 (플레이어별 마지막 처리 입력 seq = ack 포함)
 */
export class Room {
  readonly id: string;
  readonly startedAt = new Date();
  state: 'playing' | 'ending' | 'ended' = 'playing';
  tick = 0;

  private entities = new Map<string, Entity>();
  private departed: Entity[] = [];
  private bullets: Bullet[] = [];
  private orbs: Orb[] = [];
  private events: Array<Record<string, unknown>> = [];
  private nextEid = 1;
  private nextBulletId = 1;
  private botCount = 0;
  private opts: RoomOptions;
  private rand: () => number;

  private timer: NodeJS.Timeout | null = null;
  private lastTime = 0;
  private acc = 0;
  private endPromise: Promise<MatchResultRow[]> | null = null;

  constructor(opts: RoomOptions) {
    this.opts = opts;
    this.id = opts.id ?? randomUUID();
    this.rand = opts.random ?? Math.random;
    for (let i = 0; i < sim.ORB_COUNT; i++) {
      const p = this.randomFreePoint(sim.ORB_RADIUS + 6);
      this.orbs.push({ id: i + 1, x: p.x, y: p.y, active: true, respawnTick: 0 });
    }
  }

  // ───────────────────────── 참가/이탈 ─────────────────────────

  get size() {
    return this.entities.size;
  }

  get humanCount() {
    let n = 0;
    for (const e of this.entities.values()) if (!e.isBot) n++;
    return n;
  }

  get remainingTicks() {
    return Math.max(0, this.opts.durationTicks - this.tick);
  }

  hasPlayer(playerId: string) {
    return this.entities.has(playerId);
  }

  /** 진행 중인 매치에 사람이 난입할 수 있는지 (봇 자리는 사람에게 양보) */
  canAccept(minRemainingTicks: number) {
    return this.state === 'playing' && this.humanCount < this.opts.maxPlayers && this.remainingTicks >= minRemainingTicks;
  }

  addPlayer(conn: PlayerConnection) {
    if (this.entities.size >= this.opts.maxPlayers) this.kickOneBot();
    const e = this.createEntity(conn.playerId, conn.nickname, false, conn);
    this.entities.set(e.playerId, e);
    conn.send(this.matchStartMessage(e));
    this.broadcastRoster();
  }

  addBot(nickname: string) {
    this.botCount++;
    const e = this.createEntity(`bot:${randomUUID()}`, nickname, true, null);
    e.bot = new BotBrain(this.rand);
    this.entities.set(e.playerId, e);
    this.broadcastRoster();
  }

  /** 재접속: 기존 엔티티(점수/위치 유지)에 새 연결을 다시 붙인다 */
  rebind(playerId: string, conn: PlayerConnection) {
    const e = this.entities.get(playerId);
    if (!e) return false;
    e.conn = conn;
    e.disconnectedTick = null;
    e.inputs.length = 0;
    e.lastSeq = -1; // 새 클라이언트는 seq 를 처음부터 다시 센다
    conn.send(this.matchStartMessage(e));
    logger.info('player reconnected', { roomId: this.id, playerId });
    return true;
  }

  /** 연결 끊김: 즉시 제거하지 않고 reconnectGraceTicks 동안 자리를 유지 */
  detach(playerId: string, conn: PlayerConnection) {
    const e = this.entities.get(playerId);
    if (!e || e.conn !== conn) return; // 이미 새 연결로 교체된 경우 무시
    e.conn = null;
    e.disconnectedTick = this.tick;
    e.inputs.length = 0;
  }

  /** 자발적 이탈 — 기록은 결과 집계를 위해 departed 에 보관 */
  removePlayer(playerId: string) {
    const e = this.entities.get(playerId);
    if (!e) return;
    this.entities.delete(playerId);
    e.conn = null;
    if (!e.isBot) this.departed.push(e);
    this.broadcastRoster();
  }

  pushInput(playerId: string, input: PlayerInput) {
    const e = this.entities.get(playerId);
    if (!e || e.isBot || this.state !== 'playing') return;
    const lastQueued = e.inputs.length ? e.inputs[e.inputs.length - 1].seq : e.lastSeq;
    if (input.seq <= lastQueued) {
      metrics.inc('game_inputs_out_of_order_total');
      return; // 중복/역순 입력(리플레이 공격 포함) 무시
    }
    if (e.inputs.length >= MAX_INPUT_QUEUE) {
      e.inputs.shift();
      metrics.inc('game_inputs_dropped_total');
    }
    e.inputs.push(input);
  }

  // ───────────────────────── 루프 ─────────────────────────

  start() {
    this.lastTime = performance.now();
    this.timer = setTimeout(this.loop, sim.TICK_MS);
    logger.info('match started', { roomId: this.id, players: this.humanCount, bots: this.botCount });
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 고정 타임스텝 + 누산기: setTimeout 지터가 있어도 장기적으로 정확히 30Hz 를 유지 */
  private loop = () => {
    const now = performance.now();
    this.acc += now - this.lastTime;
    this.lastTime = now;
    let steps = 0;
    while (this.acc >= sim.TICK_MS && steps < MAX_CATCHUP_STEPS && this.state === 'playing') {
      const t0 = performance.now();
      this.step();
      metrics.observeTick(performance.now() - t0);
      this.acc -= sim.TICK_MS;
      steps++;
    }
    if (steps === MAX_CATCHUP_STEPS && this.acc >= sim.TICK_MS) {
      metrics.inc('game_tick_overrun_total');
      this.acc = 0; // 너무 밀렸으면 따라잡기를 포기하고 현재 시점부터 재개
    }
    if (this.state === 'playing') this.timer = setTimeout(this.loop, Math.max(0, sim.TICK_MS - this.acc));
  };

  /** 한 틱 진행. 테스트에서 직접 호출할 수 있도록 public */
  step() {
    if (this.state !== 'playing') return;
    this.tick++;

    for (const e of this.entities.values()) {
      if (e.fireCd > 0) e.fireCd--;
      if (e.bot) e.inputs.push(e.bot.think(e, this.entities.values(), this.orbs, this.tick));
      e.inputCredit = Math.min(MAX_INPUT_CREDIT, e.inputCredit + INPUT_CREDIT_PER_TICK);
      while (e.inputs.length > 0 && e.inputCredit >= 1) {
        e.inputCredit -= 1;
        this.applyInput(e, e.inputs.shift()!);
      }
    }

    this.stepBullets();
    this.stepOrbs();
    this.stepLifecycle();

    if (this.tick % this.opts.snapshotEvery === 0) this.broadcastSnapshot();
    if (this.tick >= this.opts.durationTicks) void this.end('time');
  }

  private applyInput(e: Entity, input: PlayerInput) {
    e.lastSeq = input.seq;
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
        dead: false,
      });
    }
  }

  private stepBullets() {
    const hitR2 = (sim.PLAYER_RADIUS + sim.BULLET_RADIUS) ** 2;
    for (const b of this.bullets) {
      b.x += b.vx;
      b.y += b.vy;
      b.ttl--;
      if (b.ttl <= 0 || b.x < 0 || b.y < 0 || b.x > sim.ARENA_W || b.y > sim.ARENA_H || sim.pointInObstacle(b.x, b.y)) {
        b.dead = true;
        continue;
      }
      for (const e of this.entities.values()) {
        if (!e.alive || e.eid === b.ownerEid) continue;
        const dx = e.x - b.x;
        const dy = e.y - b.y;
        if (dx * dx + dy * dy <= hitR2) {
          b.dead = true;
          this.damage(e, b.ownerPlayerId);
          break;
        }
      }
    }
    if (this.bullets.some((b) => b.dead)) this.bullets = this.bullets.filter((b) => !b.dead);
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

  private stepLifecycle() {
    for (const e of this.entities.values()) {
      if (!e.alive && this.tick >= e.respawnTick) {
        const p = this.findSpawn();
        Object.assign(e, { x: p.x, y: p.y, hp: sim.MAX_HP, alive: true, dashTicks: 0, dashCd: 0 });
      }
      if (!e.isBot && e.disconnectedTick !== null && this.tick - e.disconnectedTick > this.opts.reconnectGraceTicks) {
        logger.info('reconnect grace expired', { roomId: this.id, playerId: e.playerId });
        this.removePlayer(e.playerId);
      }
    }
    // 사람이 모두 떠났다면(유예 중인 사람도 없음) 매치를 조기 종료
    if (this.humanCount === 0 && this.state === 'playing') void this.end('abandoned');
  }

  // ───────────────────────── 네트워크 메시지 ─────────────────────────

  private roster() {
    return [...this.entities.values()].map((e) => [e.eid, e.nickname, e.isBot ? 1 : 0]);
  }

  private matchStartMessage(e: Entity) {
    return JSON.stringify({
      t: 'match_start',
      roomId: this.id,
      you: e.eid,
      tick: this.tick,
      tickRate: sim.TICK_RATE,
      remainingTicks: this.remainingTicks,
      roster: this.roster(),
    });
  }

  private broadcast(data: string) {
    for (const e of this.entities.values()) e.conn?.send(data);
  }

  private broadcastRoster() {
    this.broadcast(JSON.stringify({ t: 'roster', roster: this.roster() }));
  }

  /**
   * 스냅샷은 모든 플레이어에게 공통인 본문을 한 번만 직렬화하고,
   * 플레이어별로 다른 ack(마지막 처리 입력 seq) 부분만 문자열로 이어 붙인다 → O(N) 직렬화
   */
  private broadcastSnapshot() {
    const players: number[][] = [];
    for (const e of this.entities.values()) {
      players.push([e.eid, r2(e.x), r2(e.y), e.hp, e.alive ? 1 : 0, e.score, r2(e.aim), e.dashTicks, e.dashCd, e.kills, e.deaths]);
    }
    const body = JSON.stringify({
      tick: this.tick,
      rem: this.remainingTicks,
      p: players,
      b: this.bullets.map((b) => [b.id, r2(b.x), r2(b.y)]),
      o: this.orbs.filter((o) => o.active).map((o) => [o.id, Math.round(o.x), Math.round(o.y)]),
      ev: this.events,
    });
    this.events = [];
    for (const e of this.entities.values()) {
      if (!e.conn) continue;
      if (e.conn.isCongested()) {
        metrics.inc('net_snapshots_skipped_total');
        continue;
      }
      e.conn.send(`{"t":"snap","ack":${e.lastSeq},"d":${body}}`);
      metrics.inc('net_snapshots_sent_total');
    }
  }

  // ───────────────────────── 종료/영속화 ─────────────────────────

  end(reason: EndReason): Promise<MatchResultRow[]> {
    if (!this.endPromise) this.endPromise = this.finish(reason);
    return this.endPromise;
  }

  whenEnded(): Promise<MatchResultRow[]> | null {
    return this.endPromise;
  }

  private async finish(reason: EndReason): Promise<MatchResultRow[]> {
    this.state = 'ending';
    this.stop();
    const all = [...this.entities.values(), ...this.departed];
    all.sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);

    // 경쟁 순위(1,2,2,4): 점수/킬/데스가 모두 같으면 같은 순위
    const placements = new Map<Entity, number>();
    all.forEach((e, i) => {
      const prev = all[i - 1];
      const same = prev && prev.score === e.score && prev.kills === e.kills && prev.deaths === e.deaths;
      placements.set(e, same ? placements.get(prev)! : i + 1);
    });

    const humans = all.filter((e) => !e.isBot);
    const ratings = new Map<string, { delta: number; after: number }>();
    // 중도 이탈(abandoned)도 기록한다 — 나가서 패배 기록을 회피하는 것을 막기 위해
    if (this.opts.repo && humans.length > 0) {
      try {
        const saved = await this.opts.repo.recordMatch({
          matchId: this.id,
          startedAt: this.startedAt,
          endedAt: new Date(),
          botCount: this.botCount,
          participants: humans.map((e) => ({
            playerId: e.playerId,
            nickname: e.nickname,
            score: e.score,
            kills: e.kills,
            deaths: e.deaths,
            placement: placements.get(e)!,
          })),
        });
        for (const s of saved) ratings.set(s.playerId, { delta: s.ratingDelta, after: s.ratingAfter });
        metrics.inc('db_matches_recorded_total');
      } catch (err) {
        // DB 장애가 게임 진행을 막지 않도록 로그만 남기고 결과 화면은 그대로 전송
        metrics.inc('db_errors_total');
        logger.error('failed to record match', { roomId: this.id, ...errorFields(err) });
      }
    }

    const results: MatchResultRow[] = all.map((e) => ({
      eid: e.eid,
      playerId: e.isBot ? null : e.playerId,
      nickname: e.nickname,
      isBot: e.isBot,
      score: e.score,
      kills: e.kills,
      deaths: e.deaths,
      placement: placements.get(e)!,
      ratingDelta: ratings.get(e.playerId)?.delta ?? null,
      ratingAfter: ratings.get(e.playerId)?.after ?? null,
    }));

    this.broadcast(JSON.stringify({ t: 'match_end', reason, results }));
    this.state = 'ended';
    logger.info('match ended', { roomId: this.id, reason, ticks: this.tick, humans: humans.length });
    metrics.inc('game_matches_ended_total');
    this.opts.onEnd?.(this);
    return results;
  }

  // ───────────────────────── 헬퍼 ─────────────────────────

  private createEntity(playerId: string, nickname: string, isBot: boolean, conn: PlayerConnection | null): Entity {
    const p = this.findSpawn();
    return {
      eid: this.nextEid++,
      playerId,
      nickname,
      isBot,
      conn,
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
      inputs: [],
      inputCredit: 1,
      lastSeq: -1,
      disconnectedTick: null,
      bot: null,
    };
  }

  private kickOneBot() {
    for (const e of this.entities.values()) {
      if (e.isBot) {
        this.entities.delete(e.playerId);
        return;
      }
    }
  }

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

  /** 테스트 전용 내부 상태 접근 */
  debugEntity(playerId: string): Entity | undefined {
    return this.entities.get(playerId);
  }
}
