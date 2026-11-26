import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { createRepository } from '../db/index.ts';
import { TICK_RATE } from '../../shared/sim.js';
import { errorFields, logger } from '../util/logger.ts';
import { metrics } from '../util/metrics.ts';
import type { CreateRoom, MatchRoom } from './matchmaker.ts';
import type { RoomCommand, RoomEvent } from './room-ipc.ts';
import type { RoomOptions, RoomState } from './room.ts';
import type { PlayerConnection, PlayerInput } from './types.ts';

interface Worker {
  child: ChildProcess;
  rooms: Map<string, RemoteRoom>;
  ready: boolean;
  backlog: number;
}

function send(worker: Worker, command: RoomCommand) {
  if (!worker.child.connected) return;
  const queued = worker.child.send(command, (err) => {
    if (err && worker.child.connected) logger.warn('game worker send failed', errorFields(err));
    if (!queued) worker.backlog--;
  });
  if (!queued) worker.backlog++;
}

interface Seat {
  conn: PlayerConnection | null;
  binding: number;
  congested: boolean;
}

class RemoteRoom implements MatchRoom {
  readonly id = randomUUID();
  state: RoomState = 'playing';
  private readonly seats = new Map<string, Seat>();
  private resolveEnd!: () => void;
  private readonly ended = new Promise<void>((resolve) => { this.resolveEnd = resolve; });
  private nextBinding = 0;
  private startsAt = 0;
  private readonly worker: Worker;
  private readonly options: RoomOptions;
  private readonly onEnd: (room: MatchRoom) => void;

  constructor(worker: Worker, options: RoomOptions, onEnd: (room: MatchRoom) => void) {
    this.worker = worker;
    this.options = options;
    this.onEnd = onEnd;
    worker.rooms.set(this.id, this);
    const { durationTicks, maxPlayers, reconnectGraceTicks, snapshotEvery, seed } = options;
    send(worker, { type: 'create', roomId: this.id, options: { durationTicks, maxPlayers, reconnectGraceTicks, snapshotEvery, seed } });
  }

  get humanCount() { return this.seats.size; }

  hasPlayer(playerId: string) { return this.seats.has(playerId); }

  canAccept(minRemainingTicks: number) {
    const elapsedTicks = Math.floor((performance.now() - this.startsAt) * TICK_RATE / 1000);
    return this.state === 'playing' && this.humanCount < this.options.maxPlayers &&
      this.options.durationTicks - elapsedTicks >= minRemainingTicks;
  }

  private bind(type: 'add' | 'rebind', conn: PlayerConnection) {
    const { playerId, nickname } = conn;
    const binding = ++this.nextBinding;
    this.seats.set(playerId, { conn, binding, congested: false });
    send(this.worker, { type, roomId: this.id, playerId, nickname, binding });
  }

  addPlayer(conn: PlayerConnection) { this.bind('add', conn); }

  addBot(nickname: string) { send(this.worker, { type: 'bot', roomId: this.id, nickname }); }

  rebind(playerId: string, conn: PlayerConnection) {
    if (!this.hasPlayer(playerId)) return false;
    this.bind('rebind', conn);
    return true;
  }

  detach(playerId: string, conn: PlayerConnection) {
    const seat = this.seats.get(playerId);
    if (seat?.conn !== conn) return;
    seat.conn = null;
    send(this.worker, { type: 'detach', roomId: this.id, playerId });
  }

  removePlayer(playerId: string) {
    this.seats.delete(playerId);
    send(this.worker, { type: 'remove', roomId: this.id, playerId });
  }

  pushInput(playerId: string, input: PlayerInput) {
    if (this.state === 'playing' && !this.worker.backlog) send(this.worker, { type: 'input', roomId: this.id, playerId, input });
  }

  start() {
    this.startsAt = performance.now();
    send(this.worker, { type: 'start', roomId: this.id });
  }

  end() {
    if (this.state === 'playing') {
      this.state = 'ending';
      send(this.worker, { type: 'end', roomId: this.id });
    }
    return this.ended;
  }

  updateFlow() {
    for (const [playerId, seat] of this.seats) {
      if (!seat.conn) continue;
      const congested = seat.conn.isCongested();
      if (congested === seat.congested) continue;
      seat.congested = congested;
      send(this.worker, { type: 'flow', roomId: this.id, playerId, binding: seat.binding, congested });
    }
  }

  receive(event: Extract<RoomEvent, { roomId: string }>) {
    switch (event.type) {
      case 'ending':
        this.state = 'ending';
        break;
      case 'ended':
        this.finish();
        break;
      case 'expired':
        if (this.seats.get(event.playerId)?.binding === event.binding) this.seats.delete(event.playerId);
        break;
      case 'frame': {
        const seat = this.seats.get(event.playerId);
        if (seat?.binding === event.binding) seat.conn?.send(event.data);
        break;
      }
    }
  }

  fail() {
    const message = JSON.stringify({ t: 'match_end', reason: 'error', results: [] });
    for (const { conn } of this.seats.values()) conn?.send(message);
    this.finish();
  }

  private finish() {
    this.state = 'ended';
    this.worker.rooms.delete(this.id);
    this.onEnd(this);
    this.seats.clear();
    this.resolveEnd();
  }
}

export class RoomPool {
  private readonly workers: Worker[] = [];
  private readonly count: number;
  private readonly db: Parameters<typeof createRepository>[0];
  private readonly flow = setInterval(() => {
    for (const worker of this.workers) for (const room of worker.rooms.values()) room.updateFlow();
  }, 50).unref();

  constructor(count: number, db: Parameters<typeof createRepository>[0]) {
    this.count = count;
    this.db = db;
  }

  get readyCount() { return this.workers.filter((worker) => worker.ready).length; }
  get activeCount() { return this.workers.filter((worker) => worker.rooms.size > 0).length; }
  workerPidOf(roomId: string): number | undefined {
    return this.workers.find((worker) => worker.rooms.has(roomId))?.child.pid;
  }

  async start() {
    try {
      await Promise.all(Array.from({ length: this.count }, () => this.spawn()));
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  create: CreateRoom = (options, onEnd) => {
    while (this.workers.length < this.count) {
      void this.spawn().catch((err) => logger.error('room worker restart failed', errorFields(err)));
    }
    const worker = this.workers.reduce((a, b) => a.rooms.size <= b.rooms.size ? a : b);
    return new RemoteRoom(worker, options, onEnd);
  };

  private spawn() {
    const child = fork(new URL('./room-worker.ts', import.meta.url), [], { serialization: 'advanced', execArgv: [] });
    const worker: Worker = { child, rooms: new Map(), ready: false, backlog: 0 };
    this.workers.push(worker);
    return new Promise<void>((resolve, reject) => {
      const startupTimeout = setTimeout(() => {
        reject(new Error('Room worker startup timed out'));
        child.kill();
      }, 10_000).unref();
      child.on('message', (event: RoomEvent) => {
        if (event.type === 'ready') {
          clearTimeout(startupTimeout);
          worker.ready = true;
          resolve();
        } else if (event.type === 'metrics') {
          for (const ms of event.samples) metrics.observeTick(ms);
          for (const [name, delta] of Object.entries(event.counters)) metrics.inc(name, delta);
        } else {
          worker.rooms.get(event.roomId)?.receive(event);
        }
      });
      child.on('error', (err) => {
        logger.error('room worker process error', errorFields(err));
        if (!worker.ready) reject(err);
      });
      child.once('close', (code) => {
        clearTimeout(startupTimeout);
        if (!worker.ready) reject(new Error(`Room worker startup failed (exit ${code})`));
        this.workers.splice(this.workers.indexOf(worker), 1);
        for (const room of worker.rooms.values()) room.fail();
      });
      send(worker, { type: 'init', db: this.db });
    });
  }

  async close() {
    clearInterval(this.flow);
    await Promise.all([...this.workers].map((worker) => new Promise<void>((resolve) => {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) return resolve();
      worker.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => worker.child.kill(), 3000).unref();
      send(worker, { type: 'close' });
    })));
  }
}
