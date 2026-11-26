import { createRepository } from '../db/index.ts';
import { errorFields, logger } from '../util/logger.ts';
import { metrics } from '../util/metrics.ts';
import type { RoomCommand, RoomEvent } from './room-ipc.ts';
import { Room } from './room.ts';
import type { PlayerConnection } from './types.ts';

class WorkerConnection implements PlayerConnection {
  congested = false;
  readonly roomId: string;
  readonly playerId: string;
  readonly nickname: string;
  readonly binding: number;

  constructor(roomId: string, playerId: string, nickname: string, binding: number) {
    this.roomId = roomId;
    this.playerId = playerId;
    this.nickname = nickname;
    this.binding = binding;
  }

  send(data: string | Uint8Array) {
    send({ type: 'frame', roomId: this.roomId, playerId: this.playerId, binding: this.binding, data });
  }

  isCongested() {
    return this.congested || ipcBacklog > 0;
  }
}

const rooms = new Map<string, { room: Room; players: Map<string, WorkerConnection> }>();
let ipcBacklog = 0;
let repoReady: ReturnType<typeof createRepository> | undefined;
let tickSamples: number[] = [];

function flushMetrics(force = false) {
  if (!force && ipcBacklog > 0) {
    if (tickSamples.length > 1024) tickSamples = tickSamples.slice(-1024);
    return;
  }
  const samples = tickSamples;
  tickSamples = [];
  const counters = metrics.drainCounters();
  if (samples.length || Object.keys(counters).length) {
    send({ type: 'metrics', samples, counters });
  }
}

setInterval(() => flushMetrics(), 250).unref();

function send(event: RoomEvent) {
  if (!process.connected || !process.send) return;
  const queued = process.send(event, (err) => {
    if (err && process.connected) logger.warn('room worker channel error', errorFields(err));
    if (!queued) ipcBacklog--;
  });
  if (!queued) ipcBacklog++;
}

async function receive(command: RoomCommand) {
  if (command.type === 'init') {
    repoReady = createRepository(command.db);
    await repoReady;
    send({ type: 'ready' });
    return;
  }
  const repo = await repoReady;
  if (!repo) throw new Error('Room worker was not initialized');
  if (command.type === 'close') {
    await Promise.all([...rooms.values()].map(({ room }) => room.end('shutdown')));
    await repo.close();
    flushMetrics(true);
    process.disconnect?.();
    return;
  }
  const { roomId } = command;
  if (command.type === 'create') {
    const players = new Map<string, WorkerConnection>();
    rooms.set(roomId, {
      players,
      room: new Room({
        ...command.options, id: roomId, repo,
        onEnding: () => send({ type: 'ending', roomId }),
        onTick: (ms) => tickSamples.push(ms),
        onEnd: () => {
          rooms.delete(roomId);
          flushMetrics(true);
          send({ type: 'ended', roomId });
        },
        onPlayerExpired: (playerId) => {
          const conn = players.get(playerId);
          players.delete(playerId);
          if (conn) send({ type: 'expired', roomId, playerId, binding: conn.binding });
        },
      }),
    });
    return;
  }

  const entry = rooms.get(roomId);
  if (!entry) return;
  const { room, players } = entry;
  switch (command.type) {
    case 'add':
    case 'rebind': {
      const { playerId, nickname, binding } = command;
      if (room.state !== 'playing') {
        send({ type: 'expired', roomId, playerId, binding });
        break;
      }
      const conn = new WorkerConnection(roomId, playerId, nickname, binding);
      players.set(playerId, conn);
      if (command.type === 'add') room.addPlayer(conn);
      else if (!room.rebind(playerId, conn)) {
        players.delete(playerId);
        send({ type: 'expired', roomId, playerId, binding });
      }
      break;
    }
    case 'bot':
      room.addBot(command.nickname);
      break;
    case 'detach': {
      const conn = players.get(command.playerId);
      if (conn) room.detach(command.playerId, conn);
      break;
    }
    case 'remove':
      room.removePlayer(command.playerId);
      players.delete(command.playerId);
      break;
    case 'input':
      room.pushInput(command.playerId, command.input);
      break;
    case 'flow': {
      const conn = players.get(command.playerId);
      if (conn && conn.binding === command.binding) conn.congested = command.congested;
      break;
    }
    case 'start':
      room.start();
      break;
    case 'end':
      await room.end('shutdown');
      break;
  }
}

process.on('message', (command: RoomCommand) => {
  void receive(command).catch((err) => {
    logger.error('room worker failed', errorFields(err));
    process.exit(1);
  });
});
process.on('disconnect', () => process.exit(0));
// The gateway handles console/service shutdown and lets each worker persist its rooms first.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
