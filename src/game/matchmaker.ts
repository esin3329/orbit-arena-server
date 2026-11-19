import type { MatchConfig } from '../config.ts';
import type { Repository } from '../db/types.ts';
import { TICK_RATE } from '../../shared/sim.js';
import { logger } from '../util/logger.ts';
import { metrics } from '../util/metrics.ts';
import { Room } from './room.ts';
import type { PlayerConnection } from './types.ts';

const BOT_NAMES = ['Bot Nova', 'Bot Pixel', 'Bot Quark', 'Bot Ember', 'Bot Drift', 'Bot Volt', 'Bot Echo', 'Bot Flux'];

interface QueueEntry {
  conn: PlayerConnection;
  since: number;
}

/**
 * 매치메이커 — 대기열과 룸 수명주기를 관리한다.
 *  1) 진행 중이고 자리가 남은 룸이 있으면 난입(late join)
 *  2) 대기 인원이 maxPlayers 에 도달하면 즉시 새 룸 생성
 *  3) 최장 대기자가 botFillAfterMs 이상 기다렸으면 현재 인원 + 봇으로 시작
 */
export class Matchmaker {
  readonly rooms = new Map<string, Room>();
  private queue: QueueEntry[] = [];
  private byPlayer = new Map<string, Room>();
  private timer: NodeJS.Timeout | null = null;
  private repo: Repository | null;
  private cfg: MatchConfig;
  private snapshotEvery: number;

  constructor(repo: Repository | null, cfg: MatchConfig, snapshotEvery = 2) {
    this.repo = repo;
    this.cfg = cfg;
    this.snapshotEvery = snapshotEvery;
  }

  start(intervalMs = 250) {
    this.timer = setInterval(() => this.process(), intervalMs);
  }

  get queueSize() {
    return this.queue.length;
  }

  get playersInRooms() {
    let n = 0;
    for (const r of this.rooms.values()) n += r.humanCount;
    return n;
  }

  roomOf(playerId: string): Room | undefined {
    const room = this.byPlayer.get(playerId);
    return room && room.state === 'playing' && room.hasPlayer(playerId) ? room : undefined;
  }

  enqueue(conn: PlayerConnection) {
    if (this.roomOf(conn.playerId)) {
      conn.send(JSON.stringify({ t: 'error', code: 'already_in_match' }));
      return;
    }
    const existing = this.queue.find((q) => q.conn.playerId === conn.playerId);
    if (existing) existing.conn = conn;
    else this.queue.push({ conn, since: Date.now() });
    conn.send(JSON.stringify({ t: 'queued', size: this.queue.length, botFillAfterMs: this.cfg.botFillAfterMs }));
    this.process();
  }

  /** 대기열 취소 또는 매치 이탈 */
  leave(conn: PlayerConnection) {
    this.dequeue(conn);
    const room = this.roomOf(conn.playerId);
    if (room) {
      room.removePlayer(conn.playerId);
      this.byPlayer.delete(conn.playerId);
    }
    conn.send(JSON.stringify({ t: 'left' }));
  }

  onDisconnect(conn: PlayerConnection) {
    this.dequeue(conn);
    this.roomOf(conn.playerId)?.detach(conn.playerId, conn);
  }

  private dequeue(conn: PlayerConnection) {
    const i = this.queue.findIndex((q) => q.conn === conn);
    if (i >= 0) this.queue.splice(i, 1);
  }

  process(now = Date.now()) {
    if (this.queue.length === 0) return;
    const minRemaining = this.cfg.lateJoinMinRemainingSec * TICK_RATE;

    // 1) 난입
    for (let i = 0; i < this.queue.length; ) {
      let open: Room | undefined;
      for (const r of this.rooms.values()) if (r.canAccept(minRemaining)) open = r;
      if (!open) break;
      const { conn } = this.queue.splice(i, 1)[0];
      open.addPlayer(conn);
      this.byPlayer.set(conn.playerId, open);
      metrics.inc('mm_late_joins_total');
    }

    // 2) 꽉 찬 룸
    while (this.queue.length >= this.cfg.maxPlayers) {
      this.createRoom(this.queue.splice(0, this.cfg.maxPlayers), 0);
    }

    // 3) 대기 시간 초과 → 봇 채움
    if (this.queue.length > 0 && now - this.queue[0].since >= this.cfg.botFillAfterMs) {
      const batch = this.queue.splice(0, this.cfg.maxPlayers);
      this.createRoom(batch, Math.max(0, this.cfg.botFillTo - batch.length));
    }
  }

  private createRoom(batch: QueueEntry[], bots: number) {
    const room = new Room({
      durationTicks: this.cfg.durationSec * TICK_RATE,
      maxPlayers: this.cfg.maxPlayers,
      reconnectGraceTicks: Math.round((this.cfg.reconnectGraceMs / 1000) * TICK_RATE),
      snapshotEvery: this.snapshotEvery,
      repo: this.repo,
      onEnd: (r) => this.onRoomEnd(r),
    });
    this.rooms.set(room.id, room);
    // 봇을 먼저 넣어야 사람에게 가는 match_start 에 완성된 로스터가 담긴다
    for (let i = 0; i < bots; i++) room.addBot(BOT_NAMES[i % BOT_NAMES.length]);
    for (const { conn, since } of batch) {
      room.addPlayer(conn);
      this.byPlayer.set(conn.playerId, room);
      metrics.inc('mm_wait_ms_total', Date.now() - since);
    }
    room.start();
    metrics.inc('game_matches_started_total');
    logger.info('room created', { roomId: room.id, humans: batch.length, bots });
    return room;
  }

  private onRoomEnd(room: Room) {
    this.rooms.delete(room.id);
    for (const [pid, r] of this.byPlayer) if (r === room) this.byPlayer.delete(pid);
  }

  /** 서버 종료 시 진행 중인 매치를 모두 마무리(결과 저장)한 뒤 멈춘다 */
  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.rooms.values()].map((r) => r.end('shutdown')));
  }
}
