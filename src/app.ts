import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { config as baseConfig, validateConfig, type Config, type MatchConfig } from './config.ts';
import { createRepository } from './db/index.ts';
import type { Repository } from './db/types.ts';
import { Matchmaker } from './game/matchmaker.ts';
import { RoomPool } from './game/room-pool.ts';
import { createHttpHandler } from './http/api.ts';
import { attachGateway } from './net/gateway.ts';
import { metrics } from './util/metrics.ts';
import { createGitHubAuth } from './auth/github.ts';

export type AppOverrides = Partial<Omit<Config, 'match'>> & { match?: Partial<MatchConfig> };

export interface App {
  server: Server;
  repo: Repository;
  matchmaker: Matchmaker;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/** 조립(composition root): 설정 → 저장소 → 매치메이커 → HTTP/WS 서버 */
export async function createApp(overrides: AppOverrides = {}): Promise<App> {
  const cfg: Config = { ...baseConfig, ...overrides, match: { ...baseConfig.match, ...overrides.match } };
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(`invalid configuration:\n  - ${errors.join('\n  - ')}`);
  const repo = await createRepository(cfg);
  const github = cfg.githubAuthOrigin && cfg.supabaseUrl && cfg.supabasePublishableKey && 'getOrCreateGitHubPlayer' in repo
    ? { ...createGitHubAuth(cfg.supabaseUrl, cfg.supabasePublishableKey, cfg.githubAuthOrigin), getPlayer: repo.getOrCreateGitHubPlayer.bind(repo) }
    : undefined;
  const pool = cfg.roomWorkers ? new RoomPool(cfg.roomWorkers, {
    dbDriver: cfg.dbDriver, sqlitePath: cfg.sqlitePath, supabaseUrl: cfg.supabaseUrl, supabaseKey: cfg.supabaseKey,
  }) : undefined;
  try {
    await pool?.start();
  } catch (err) {
    await repo.close();
    throw err;
  }
  const matchmaker = new Matchmaker(repo, cfg.match, cfg.snapshotEvery, pool?.create);

  let onlineCount = () => 0;
  const server = createServer(
    createHttpHandler({
      repo,
      matchmaker,
      secret: cfg.tokenSecret,
      tokenTtlSec: cfg.tokenTtlSec,
      apiRatePerSec: cfg.apiRatePerSec,
      guestRatePerMin: cfg.guestRatePerMin,
      github,
      onlineCount: () => onlineCount(),
    }),
  );
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  const gateway = attachGateway(server, { matchmaker, secret: cfg.tokenSecret });
  onlineCount = () => gateway.sessions.size;

  metrics.gauge('players_online', () => gateway.sessions.size);
  metrics.gauge('rooms_active', () => matchmaker.rooms.size);
  metrics.gauge('matchmaking_queue_size', () => matchmaker.queueSize);
  metrics.gauge('game_room_workers_ready', () => pool?.readyCount ?? 0);
  metrics.gauge('game_room_workers_active', () => pool?.activeCount ?? 0);

  matchmaker.start();

  return {
    server,
    repo,
    matchmaker,
    listen(port = cfg.port, host = cfg.host) {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
      });
    },
    async close() {
      await matchmaker.shutdown(); // 진행 중 매치 결과를 먼저 저장
      await pool?.close();
      gateway.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    },
  };
}
