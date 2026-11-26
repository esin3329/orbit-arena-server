import type { createRepository } from '../db/index.ts';
import type { RoomOptions } from './room.ts';
import type { PlayerInput } from './types.ts';

type WorkerRoomOptions = Omit<RoomOptions, 'id' | 'repo' | 'onEnd' | 'onEnding' | 'onPlayerExpired' | 'onTick'>;

export type RoomCommand =
  | { type: 'init'; db: Parameters<typeof createRepository>[0] }
  | { type: 'close' }
  | { type: 'create'; roomId: string; options: WorkerRoomOptions }
  | { type: 'add' | 'rebind'; roomId: string; playerId: string; nickname: string; binding: number }
  | { type: 'bot'; roomId: string; nickname: string }
  | { type: 'detach' | 'remove'; roomId: string; playerId: string }
  | { type: 'flow'; roomId: string; playerId: string; binding: number; congested: boolean }
  | { type: 'input'; roomId: string; playerId: string; input: PlayerInput }
  | { type: 'start' | 'end'; roomId: string };

export type RoomEvent =
  | { type: 'ready' }
  | { type: 'metrics'; samples: number[]; counters: Record<string, number> }
  | { type: 'ending' | 'ended'; roomId: string }
  | { type: 'expired'; roomId: string; playerId: string; binding: number }
  | { type: 'frame'; roomId: string; playerId: string; binding: number; data: string | Uint8Array };
