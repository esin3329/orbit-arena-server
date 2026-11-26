import { randomUUID } from 'node:crypto';
import * as sim from '../../shared/sim.js';
import { encodeSnapshot, SNAP_ACK_OFFSET } from '../../shared/codec.js';
import type { Repository } from '../db/types.ts';
import { logger, errorFields } from '../util/logger.ts';
import { metrics } from '../util/metrics.ts';
import { retry } from '../util/retry.ts';
import { createRng, randomSeed } from '../util/rng.ts';
import { BotBrain } from './bot.ts';
import { InputBuffer } from './inputBuffer.ts';
import { rank } from './ranking.ts';
import type { PlayerConnection, PlayerInput } from './types.ts';
import { GameWorld, type Entity } from './world.ts';

export type { Entity } from './world.ts';

/** 매 루프에서 밀린 틱을 최대 몇 개까지 연속 처리할지 (spiral of death 방지) */
const MAX_CATCHUP_STEPS = 5;

/**
 * 좌석(seat) = 룸 안의 참가자 1명. 시뮬레이션 상태(Entity)와 분리된 "세션" 측 정보를 가진다.
 * 사람은 conn, 봇은 bot 컨트롤러를 가지며 둘 다 같은 InputBuffer 를 거쳐 월드에 입력된다.
 */
export interface Seat {
  readonly entity: Entity;
  readonly input: InputBuffer;
  conn: PlayerConnection | null;
  bot: BotBrain | null;
  disconnectedTick: number | null;
  /** 이 연결로 마지막에 보낸 오브 상태 버전 (-1 = 아직 안 보냄 → 다음 스냅샷에 반드시 싣는다) */
  sentOrbVersion: number;
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

export type EndReason = 'time' | 'abandoned' | 'shutdown' | 'error';
export type RoomState = 'playing' | 'ending' | 'ended';

export interface RoomOptions {
  id?: string;
  durationTicks: number;
  maxPlayers: number;
  reconnectGraceTicks: number;
  snapshotEvery: number;
  repo: Repository | null;
  onEnd?: (room: Room) => void;
  /** 재현용 시드. 생략하면 무작위 시드를 만들고 로그에 남긴다 */
  seed?: number;
}

/**
 * 하나의 매치를 진행하는 서버 권위(authoritative) 룸 — 세션/네트워크/영속화 계층.
 * 게임 규칙 자체는 GameWorld(순수 시뮬레이션)에 위임한다.
 *
 * 고정 타임스텝(30Hz) 루프 한 틱:
 *   1) 좌석별 InputBuffer 에서 예산만큼 입력을 꺼냄 (봇은 BotBrain 이 입력 생성)
 *   2) GameWorld.step(inputs) — 이동/사격/충돌/오브/리스폰
 *   3) 재접속 유예 만료 처리, 전원 이탈 시 조기 종료
 *   4) N틱마다 스냅샷 브로드캐스트 (플레이어별 ack 포함)
 *
 * 장애 격리: 틱 처리 중 예외가 나도 프로세스 전체가 죽지 않고 이 룸만 'error' 로 종료된다.
 */
export class Room {
  readonly id: string;
  readonly seed: number;
  readonly startedAt = new Date();
  state: RoomState = 'playing';

  private world: GameWorld;
  private seats = new Map<string, Seat>();
  /** 자발적 이탈/유예 만료로 떠난 사람 — 결과 집계와 같은 매치 재입장 시 기록 복원에 사용 */
  private departed = new Map<string, Entity>();
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
    this.seed = opts.seed ?? randomSeed();
    this.rand = createRng(this.seed);
    this.world = new GameWorld(this.rand);
  }

  // ───────────────────────── 조회 ─────────────────────────

  get tick() {
    return this.world.tick;
  }

  get size() {
    return this.seats.size;
  }

  get humanCount() {
    let n = 0;
    for (const s of this.seats.values()) if (!s.entity.isBot) n++;
    return n;
  }

  get remainingTicks() {
    return Math.max(0, this.opts.durationTicks - this.world.tick);
  }

  hasPlayer(playerId: string) {
    return this.seats.has(playerId);
  }

  /** 진행 중인 매치에 사람이 난입할 수 있는지 (봇 자리는 사람에게 양보) */
  canAccept(minRemainingTicks: number) {
    return this.state === 'playing' && this.humanCount < this.opts.maxPlayers && this.remainingTicks >= minRemainingTicks;
  }

  // ───────────────────────── 참가/이탈 ─────────────────────────

  addPlayer(conn: PlayerConnection) {
    if (this.seats.has(conn.playerId)) return void this.rebind(conn.playerId, conn);
    if (this.seats.size >= this.opts.maxPlayers) this.kickOneBot();

    // 같은 매치에서 나갔다가 다시 들어온 경우: 새 엔티티를 만들면 DB 에 같은 플레이어가 두 번 기록되고
    // (match_players PK 충돌 → 매치 저장 실패), 나갔다 오면 데스가 초기화되는 악용도 가능하므로 기록을 복원한다.
    const prev = this.departed.get(conn.playerId);
    let entity: Entity;
    if (prev) {
      this.departed.delete(conn.playerId);
      this.world.restore(prev);
      entity = prev;
    } else {
      entity = this.world.spawn(conn.playerId, conn.nickname, false);
    }
    this.seats.set(conn.playerId, { entity, input: new InputBuffer(), conn, bot: null, disconnectedTick: null, sentOrbVersion: -1 });
    conn.send(this.matchStartMessage(entity));
    this.broadcastRoster();
  }

  addBot(nickname: string) {
    this.botCount++;
    const entity = this.world.spawn(`bot:${this.botCount}`, nickname, true); // 룸 내부에서만 유일하면 됨 (결정성 유지)
    this.seats.set(entity.playerId, { entity, input: new InputBuffer(), conn: null, bot: new BotBrain(this.rand), disconnectedTick: null, sentOrbVersion: -1 });
    this.broadcastRoster();
  }

  /** 재접속: 기존 엔티티(점수/위치 유지)에 새 연결을 다시 붙인다 */
  rebind(playerId: string, conn: PlayerConnection) {
    const seat = this.seats.get(playerId);
    if (!seat || seat.entity.isBot) return false;
    seat.conn = conn;
    seat.disconnectedTick = null;
    seat.sentOrbVersion = -1;
    seat.input.reset();
    conn.send(this.matchStartMessage(seat.entity));
    logger.info('player reconnected', { roomId: this.id, playerId });
    return true;
  }

  /** 연결 끊김: 즉시 제거하지 않고 reconnectGraceTicks 동안 자리를 유지 */
  detach(playerId: string, conn: PlayerConnection) {
    const seat = this.seats.get(playerId);
    if (!seat || seat.conn !== conn) return; // 이미 새 연결로 교체된 경우 무시
    seat.conn = null;
    seat.disconnectedTick = this.world.tick;
    seat.input.clear();
  }

  /** 자발적 이탈 — 기록은 결과 집계를 위해 departed 에 보관 */
  removePlayer(playerId: string) {
    const seat = this.seats.get(playerId);
    if (!seat) return;
    this.seats.delete(playerId);
    this.world.remove(playerId);
    seat.conn = null;
    if (!seat.entity.isBot) this.departed.set(playerId, seat.entity);
    this.broadcastRoster();
  }

  pushInput(playerId: string, input: PlayerInput) {
    if (this.state !== 'playing') return;
    const seat = this.seats.get(playerId);
    if (!seat || seat.bot) return;
    seat.input.push(input);
  }

  // ───────────────────────── 루프 ─────────────────────────

  start() {
    this.lastTime = performance.now();
    this.timer = setTimeout(this.loop, sim.TICK_MS);
    logger.info('match started', { roomId: this.id, seed: this.seed, players: this.humanCount, bots: this.botCount });
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
    try {
      while (this.acc >= sim.TICK_MS && steps < MAX_CATCHUP_STEPS && this.state === 'playing') {
        const t0 = performance.now();
        this.step();
        metrics.observeTick(performance.now() - t0);
        this.acc -= sim.TICK_MS;
        steps++;
      }
    } catch (err) {
      // 버그 하나가 서버의 모든 매치를 날리지 않도록 이 룸만 격리 종료한다.
      // 시드와 틱을 남겨 두면 같은 조건으로 재현할 수 있다.
      metrics.inc('game_room_crashes_total');
      logger.error('room tick crashed', { roomId: this.id, seed: this.seed, tick: this.world.tick, ...errorFields(err) });
      void this.end('error');
      return;
    }
    if (steps === MAX_CATCHUP_STEPS && this.acc >= sim.TICK_MS) {
      metrics.inc('game_tick_overrun_total');
      this.acc = 0; // 너무 밀렸으면 따라잡기를 포기하고 현재 시점부터 재개
    }
    if (this.state === 'playing') this.timer = setTimeout(this.loop, Math.max(0, sim.TICK_MS - this.acc));
  };

  /** 한 틱 진행. 테스트에서 실시간 대기 없이 직접 호출할 수 있도록 public */
  step() {
    if (this.state !== 'playing') return;
    const nextTick = this.world.tick + 1;
    const inputs = new Map<string, PlayerInput[]>();
    for (const seat of this.seats.values()) {
      if (seat.bot) seat.input.push(seat.bot.think(seat.entity, this.world.entities.values(), this.world.orbs, nextTick));
      const list = seat.input.drain();
      if (list.length) inputs.set(seat.entity.playerId, list);
    }

    this.world.step(inputs);
    this.expireDisconnected();

    if (this.world.tick % this.opts.snapshotEvery === 0) this.broadcastSnapshot();
    if (this.world.tick >= this.opts.durationTicks) void this.end('time');
    else if (this.humanCount === 0) void this.end('abandoned'); // 사람이 모두 떠났으면(유예 중인 사람도 없음) 조기 종료
  }

  private expireDisconnected() {
    for (const seat of this.seats.values()) {
      if (seat.disconnectedTick !== null && this.world.tick - seat.disconnectedTick > this.opts.reconnectGraceTicks) {
        logger.info('reconnect grace expired', { roomId: this.id, playerId: seat.entity.playerId });
        this.removePlayer(seat.entity.playerId);
      }
    }
  }

  // ───────────────────────── 네트워크 메시지 ─────────────────────────

  private roster() {
    return [...this.seats.values()].map(({ entity: e }) => [e.eid, e.nickname, e.isBot ? 1 : 0]);
  }

  private matchStartMessage(e: Entity) {
    return JSON.stringify({
      t: 'match_start',
      roomId: this.id,
      you: e.eid,
      tick: this.world.tick,
      tickRate: sim.TICK_RATE,
      remainingTicks: this.remainingTicks,
      roster: this.roster(),
    });
  }

  private broadcast(data: string) {
    for (const s of this.seats.values()) s.conn?.send(data);
  }

  private broadcastRoster() {
    this.broadcast(JSON.stringify({ t: 'roster', roster: this.roster() }));
  }

  /**
   * 스냅샷은 바이너리 프레임(shared/codec.js)으로 보낸다.
   * - 공통 본문은 "오브 포함/미포함" 두 가지만 필요할 때 한 번씩 인코딩하고, 플레이어별로는 복사 후 ack 4바이트만 덮어쓴다
   * - 오브 목록은 그 연결이 마지막으로 받은 버전과 다를 때만 싣는다(델타). WebSocket(TCP)은 순서를 보장하고,
   *   혼잡으로 건너뛴 스냅샷은 sentOrbVersion 을 올리지 않으므로 다음에 다시 실린다 → 클라이언트 상태가 어긋나지 않는다
   */
  private broadcastSnapshot() {
    const snap = this.world.snapshot(this.remainingTicks);
    let withOrbs: Uint8Array | null = null;
    let withoutOrbs: Uint8Array | null = null;
    for (const seat of this.seats.values()) {
      const conn = seat.conn;
      if (!conn) continue;
      if (conn.isCongested()) {
        metrics.inc('net_snapshots_skipped_total');
        continue;
      }
      const sendOrbs = seat.sentOrbVersion !== snap.ov;
      const body = sendOrbs ? (withOrbs ??= encodeSnapshot(snap, 0, true)) : (withoutOrbs ??= encodeSnapshot(snap, 0, false));
      const frame = Buffer.allocUnsafe(body.byteLength);
      frame.set(body);
      frame.writeUInt32LE(seat.input.lastProcessedSeq >>> 0, SNAP_ACK_OFFSET);
      conn.send(frame);
      seat.sentOrbVersion = snap.ov;
      metrics.inc('net_snapshots_sent_total');
      metrics.inc('net_snapshot_bytes_total', frame.byteLength);
    }
  }

  // ───────────────────────── 종료/영속화 ─────────────────────────

  /** 멱등: 여러 번 호출해도 종료 처리는 한 번만 수행되고 같은 Promise 를 돌려준다 */
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
    const ranked = rank([...[...this.seats.values()].map((s) => s.entity), ...this.departed.values()]);
    const humans = ranked.filter((r) => !r.item.isBot);

    const ratings = new Map<string, { delta: number; after: number }>();
    // 중도 이탈(abandoned)도 기록한다 — 나가서 패배 기록을 회피하는 것을 막기 위해
    if (this.opts.repo && humans.length > 0) {
      const repo = this.opts.repo;
      try {
        // recordMatch 는 matchId 기준으로 멱등하다: 앞선 시도가 실제로는 커밋됐다면(응답 유실) 다시 반영하지 않고 저장된 결과를 돌려준다
        const saved = await retry(
          () =>
            repo.recordMatch({
              matchId: this.id,
              startedAt: this.startedAt,
              endedAt: new Date(),
              botCount: this.botCount,
              participants: humans.map(({ item: e, placement }) => ({
                playerId: e.playerId,
                nickname: e.nickname,
                score: e.score,
                kills: e.kills,
                deaths: e.deaths,
                placement,
              })),
            }),
          {
            onRetry: (err, attempt) => {
              metrics.inc('db_retries_total');
              logger.warn('record match retry', { roomId: this.id, attempt, ...errorFields(err) });
            },
          },
        );
        for (const s of saved) ratings.set(s.playerId, { delta: s.ratingDelta, after: s.ratingAfter });
        metrics.inc('db_matches_recorded_total');
      } catch (err) {
        // DB 장애가 게임 진행을 막지 않도록 로그만 남기고 결과 화면은 그대로 전송
        metrics.inc('db_errors_total');
        logger.error('failed to record match', { roomId: this.id, ...errorFields(err) });
      }
    }

    const results: MatchResultRow[] = ranked.map(({ item: e, placement }) => ({
      eid: e.eid,
      playerId: e.isBot ? null : e.playerId,
      nickname: e.nickname,
      isBot: e.isBot,
      score: e.score,
      kills: e.kills,
      deaths: e.deaths,
      placement,
      ratingDelta: ratings.get(e.playerId)?.delta ?? null,
      ratingAfter: ratings.get(e.playerId)?.after ?? null,
    }));

    this.broadcast(JSON.stringify({ t: 'match_end', reason, results }));
    this.state = 'ended';
    logger.info('match ended', { roomId: this.id, reason, ticks: this.world.tick, humans: humans.length });
    metrics.inc('game_matches_ended_total');
    this.opts.onEnd?.(this);
    return results;
  }

  // ───────────────────────── 헬퍼 ─────────────────────────

  private kickOneBot() {
    for (const s of this.seats.values()) {
      if (s.bot) {
        this.seats.delete(s.entity.playerId);
        this.world.remove(s.entity.playerId);
        return;
      }
    }
  }

  /** 테스트 전용 내부 상태 접근 */
  debugEntity(playerId: string): Entity | undefined {
    return this.seats.get(playerId)?.entity;
  }

  debugSeat(playerId: string): Seat | undefined {
    return this.seats.get(playerId);
  }

  debugWorld(): GameWorld {
    return this.world;
  }
}
