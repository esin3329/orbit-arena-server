import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { config as baseConfig, type Config, type MatchConfig } from './config.ts';
import { createRepository } from './db/index.ts';
import type { Repository } from './db/types.ts';
import { Matchmaker } from './game/matchmaker.ts';
import { createHttpHandler } from './http/api.ts';
import { attachGateway } from './net/gateway.ts';
import { metrics } from './util/metrics.ts';

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
  const repo = await createRepository(cfg);
  const matchmaker = new Matchmaker(repo, cfg.match, cfg.snapshotEvery);

  let onlineCount = () => 0;
  const server = createServer(
    createHttpHandler({
      repo,
      matchmaker,
      secret: cfg.tokenSecret,
      tokenTtlSec: cfg.tokenTtlSec,
      apiRatePerSec: cfg.apiRatePerSec,
      guestRatePerMin: cfg.guestRatePerMin,
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
      gateway.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    },
  };
}
