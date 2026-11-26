import { DurableObject } from 'cloudflare:workers';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import * as sim from '../shared/sim.js';
import { issueToken, verifyToken, type TokenPayload } from '../src/auth/token.ts';
import type { MatchConfig } from '../src/config.ts';
import { computeRatingDeltas } from '../src/db/rating.ts';
import { createSupabaseRepository } from '../src/db/supabase.ts';
import type {
  MatchParticipantResult,
  MatchRecordInput,
  MatchSummary,
  PlayerMatchRow,
  PlayerRecord,
  Repository,
} from '../src/db/types.ts';
import { Matchmaker } from '../src/game/matchmaker.ts';
import type { PlayerConnection } from '../src/game/types.ts';
import { parseClientMessage, type ClientMessage } from '../src/net/protocol.ts';
import { errorFields, logger } from '../src/util/logger.ts';
import { metrics } from '../src/util/metrics.ts';
import { KeyedRateLimiter, TokenBucket } from '../src/util/rateLimiter.ts';

interface SqlCursor {
  toArray(): Array<Record<string, unknown>>;
}

interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlCursor;
}

interface DurableObjectStorage {
  sql: SqlStorage;
  transactionSync<T>(callback: () => T): T;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
}

interface CfWebSocket {
  readyState: number;
  bufferedAmount?: number;
  accept(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: Fetcher;
  ARENA: DurableObjectNamespace;
  TOKEN_SECRET?: string;
  METRICS_TOKEN?: string;
  DB_DRIVER?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  TOKEN_TTL_SEC?: string;
  API_RATE_PER_SEC?: string;
  GUEST_RATE_PER_MIN?: string;
  MATCH_DURATION_SEC?: string;
  MATCH_MAX_PLAYERS?: string;
  MATCH_BOT_FILL_AFTER_MS?: string;
  MATCH_BOT_FILL_TO?: string;
  MATCH_RECONNECT_GRACE_MS?: string;
  MATCH_LATE_JOIN_MIN_SEC?: string;
}

declare const WebSocketPair: {
  new (): { 0: CfWebSocket; 1: CfWebSocket };
};

const NICK_RE = /^[\p{L}\p{N}_ -]{2,16}$/u;
const MAX_BODY = 4 * 1024;
const CONGESTION_BYTES = 128 * 1024;
const MAX_VIOLATIONS = 200;
const STALE_SESSION_MS = 35_000;
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://cdn.jsdelivr.net",
    "font-src 'self' https://cdn.jsdelivr.net",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const clampLimit = (v: string | null, d: number, max: number) => {
  const n = Number(v ?? d);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : d;
};
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const safeEq = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY) throw new HttpError(413, 'payload too large');
  try {
    const parsed = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

class DoSqliteRepository implements Repository {
  readonly driver = 'do-sqlite';
  private storage: DurableObjectStorage;
  private sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.initSchema();
  }

  private initSchema() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      rating INTEGER NOT NULL DEFAULT 1000,
      games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      kills INTEGER NOT NULL DEFAULT 0,
      deaths INTEGER NOT NULL DEFAULT 0,
      best_score INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen_at TEXT
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_players_leaderboard ON players (rating DESC, wins DESC, best_score DESC) WHERE games > 0`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      player_count INTEGER NOT NULL,
      bot_count INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_matches_ended ON matches (ended_at DESC)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS match_players (
      match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      nickname TEXT NOT NULL,
      score INTEGER NOT NULL,
      kills INTEGER NOT NULL,
      deaths INTEGER NOT NULL,
      placement INTEGER NOT NULL,
      rating_delta INTEGER NOT NULL,
      PRIMARY KEY (match_id, player_id)
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_match_players_player ON match_players (player_id)`);
  }

  async createGuest(nickname: string): Promise<PlayerRecord> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.sql.exec('INSERT INTO players (id, nickname, created_at) VALUES (?, ?, ?)', id, nickname, createdAt);
    return (await this.getPlayer(id))!;
  }

  async getPlayer(id: string): Promise<PlayerRecord | null> {
    const rows = this.sql
      .exec('SELECT id, nickname, rating, games, wins, kills, deaths, best_score AS bestScore, created_at AS createdAt FROM players WHERE id = ?', id)
      .toArray();
    return rows.length ? (rows[0] as unknown as PlayerRecord) : null;
  }

  async recordMatch(input: MatchRecordInput): Promise<MatchParticipantResult[]> {
    return this.storage.transactionSync(() => {
      const existing = this.sql.exec('SELECT 1 FROM matches WHERE id = ?', input.matchId).toArray();
      if (existing.length > 0) {
        return input.participants.map((p) => {
          const saved = this.sql
            .exec(
              `SELECT mp.rating_delta AS ratingDelta, p.rating AS rating
               FROM match_players mp JOIN players p ON p.id = mp.player_id
               WHERE mp.match_id = ? AND mp.player_id = ?`,
              input.matchId,
              p.playerId,
            )
            .toArray() as Array<{ ratingDelta: number; rating: number }>;
          return {
            ...p,
            ratingDelta: saved[0]?.ratingDelta ?? 0,
            ratingAfter: saved[0]?.rating ?? 1000,
          };
        });
      }

      const entries = input.participants.map((p) => {
        const rows = this.sql.exec('SELECT rating FROM players WHERE id = ?', p.playerId).toArray() as Array<{ rating: number }>;
        return { playerId: p.playerId, placement: p.placement, rating: rows[0]?.rating ?? 1000 };
      });
      const deltas = computeRatingDeltas(entries);
      const endedAt = input.endedAt.toISOString();

      this.sql.exec(
        'INSERT INTO matches (id, started_at, ended_at, player_count, bot_count) VALUES (?, ?, ?, ?, ?)',
        input.matchId,
        input.startedAt.toISOString(),
        endedAt,
        input.participants.length,
        input.botCount,
      );

      return input.participants.map((p) => {
        const delta = deltas.get(p.playerId) ?? 0;
        this.sql.exec(
          `INSERT INTO match_players (match_id, player_id, nickname, score, kills, deaths, placement, rating_delta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          input.matchId,
          p.playerId,
          p.nickname,
          p.score,
          p.kills,
          p.deaths,
          p.placement,
          delta,
        );
        this.sql.exec(
          `UPDATE players SET
             rating = rating + ?, games = games + 1, wins = wins + ?,
             kills = kills + ?, deaths = deaths + ?, best_score = MAX(best_score, ?), last_seen_at = ?
           WHERE id = ?`,
          delta,
          p.placement === 1 ? 1 : 0,
          p.kills,
          p.deaths,
          p.score,
          endedAt,
          p.playerId,
        );
        const updated = this.sql.exec('SELECT rating FROM players WHERE id = ?', p.playerId).toArray() as Array<{ rating: number }>;
        return { ...p, ratingDelta: delta, ratingAfter: updated[0]?.rating ?? 1000 + delta };
      });
    });
  }

  async leaderboard(limit: number): Promise<PlayerRecord[]> {
    const rows = this.sql
      .exec(
        `SELECT id, nickname, rating, games, wins, kills, deaths, best_score AS bestScore, created_at AS createdAt
         FROM players WHERE games > 0 ORDER BY rating DESC, wins DESC, best_score DESC LIMIT ?`,
        limit,
      )
      .toArray();
    return rows as unknown as PlayerRecord[];
  }

  async recentMatches(limit: number): Promise<MatchSummary[]> {
    const matches = this.sql
      .exec('SELECT id, started_at AS startedAt, ended_at AS endedAt, bot_count AS botCount FROM matches ORDER BY ended_at DESC LIMIT ?', limit)
      .toArray() as unknown as Array<Omit<MatchSummary, 'participants'>>;
    return matches.map((m) => ({
      ...m,
      participants: this.sql
        .exec(
          `SELECT player_id AS playerId, nickname, score, kills, deaths, placement, rating_delta AS ratingDelta
           FROM match_players WHERE match_id = ? ORDER BY placement ASC`,
          m.id,
        )
        .toArray() as unknown as MatchSummary['participants'],
    }));
  }

  async playerMatches(playerId: string, limit: number): Promise<PlayerMatchRow[]> {
    const rows = this.sql
      .exec(
        `SELECT m.id AS matchId, m.ended_at AS endedAt, mp.score, mp.kills, mp.deaths, mp.placement, mp.rating_delta AS ratingDelta
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.player_id = ? ORDER BY m.ended_at DESC LIMIT ?`,
        playerId,
        limit,
      )
      .toArray();
    return rows as unknown as PlayerMatchRow[];
  }

  async ping(): Promise<boolean> {
    const rows = this.sql.exec('SELECT 1 AS ok').toArray() as Array<{ ok: number }>;
    return rows[0]?.ok === 1;
  }

  async close(): Promise<void> {}
}

class WorkerWsConnection implements PlayerConnection {
  readonly playerId: string;
  readonly nickname: string;
  readonly ws: CfWebSocket;
  readonly bucket = new TokenBucket(90, 45);
  violations = 0;
  lastSeenAt = Date.now();
  closed = false;

  constructor(ws: CfWebSocket, payload: TokenPayload) {
    this.ws = ws;
    this.playerId = payload.sub;
    this.nickname = payload.nick;
  }

  send(data: string | Uint8Array) {
    if (this.closed || this.ws.readyState !== 1) return;
    try {
      if (typeof data === 'string') {
        this.ws.send(data);
      } else {
        const buf =
          data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
            ? (data.buffer as ArrayBuffer)
            : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
        this.ws.send(buf);
      }
    } catch (err) {
      logger.warn('cf ws send failed', { playerId: this.playerId, ...errorFields(err) });
      this.closed = true;
    }
  }

  isCongested() {
    return (this.ws.bufferedAmount ?? 0) > CONGESTION_BYTES;
  }

  close(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(code, reason);
    } catch {
      /* 이미 닫힌 소켓 무시 */
    }
  }
}

export class ArenaDO extends DurableObject<Env> {
  private readonly startedAtMs = Date.now();
  private repo: Repository | null = null;
  private repoInit: Promise<Repository> | null = null;
  private matchmaker: Matchmaker | null = null;
  private readonly sessions = new Map<string, WorkerWsConnection>();
  private apiLimiter: KeyedRateLimiter | null = null;
  private guestLimiter: KeyedRateLimiter | null = null;
  private reqCount = 0;
  private mmTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private metricsBound = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async ensureReady(): Promise<{ repo: Repository; matchmaker: Matchmaker }> {
    if (!this.repoInit) {
      this.repoInit = (async () => {
        const repo: Repository =
          this.env.DB_DRIVER === 'supabase' && this.env.SUPABASE_URL && this.env.SUPABASE_SERVICE_ROLE_KEY
            ? await createSupabaseRepository(this.env.SUPABASE_URL, this.env.SUPABASE_SERVICE_ROLE_KEY)
            : new DoSqliteRepository(this.ctx.storage);
        this.repo = repo;

        const matchCfg: MatchConfig = {
          durationSec: num(this.env.MATCH_DURATION_SEC, 120),
          maxPlayers: num(this.env.MATCH_MAX_PLAYERS, 8),
          botFillAfterMs: num(this.env.MATCH_BOT_FILL_AFTER_MS, 4000),
          botFillTo: num(this.env.MATCH_BOT_FILL_TO, 4),
          reconnectGraceMs: num(this.env.MATCH_RECONNECT_GRACE_MS, 10000),
          lateJoinMinRemainingSec: num(this.env.MATCH_LATE_JOIN_MIN_SEC, 30),
        };
        const mm = new Matchmaker(repo, matchCfg, 2);
        this.matchmaker = mm;

        const apiRate = num(this.env.API_RATE_PER_SEC, 10);
        const guestRate = num(this.env.GUEST_RATE_PER_MIN, 5);
        this.apiLimiter = new KeyedRateLimiter(apiRate * 3, apiRate);
        this.guestLimiter = new KeyedRateLimiter(guestRate, guestRate / 60);

        if (!this.metricsBound) {
          this.metricsBound = true;
          metrics.gauge('players_online', () => this.sessions.size);
          metrics.gauge('rooms_active', () => this.matchmaker?.rooms.size ?? 0);
          metrics.gauge('matchmaking_queue_size', () => this.matchmaker?.queueSize ?? 0);
        }
        return repo;
      })();
    }
    const repo = await this.repoInit;
    return { repo, matchmaker: this.matchmaker! };
  }

  private syncTimers() {
    if (this.matchmaker && this.matchmaker.queueSize > 0 && this.mmTimer === null) {
      this.mmTimer = setInterval(() => {
        this.matchmaker?.process();
        if (!this.matchmaker || this.matchmaker.queueSize === 0) {
          if (this.mmTimer !== null) clearInterval(this.mmTimer);
          this.mmTimer = null;
        }
      }, 250);
    } else if ((!this.matchmaker || this.matchmaker.queueSize === 0) && this.mmTimer !== null) {
      clearInterval(this.mmTimer);
      this.mmTimer = null;
    }

    if (this.sessions.size > 0 && this.sweepTimer === null) {
      this.sweepTimer = setInterval(() => {
        const now = Date.now();
        for (const conn of this.sessions.values()) {
          if (now - conn.lastSeenAt > STALE_SESSION_MS) conn.close(1001, 'heartbeat timeout');
        }
        if (this.sessions.size === 0 && this.sweepTimer !== null) {
          clearInterval(this.sweepTimer);
          this.sweepTimer = null;
        }
      }, 15_000);
    } else if (this.sessions.size === 0 && this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async fetch(request: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return jsonResponse(400, { error: 'bad url' });
    }
    try {
      return await this.route(request, url);
    } catch (err) {
      if (err instanceof HttpError) return jsonResponse(err.status, { error: err.message });
      metrics.inc('http_errors_total');
      logger.error('cf request failed', { path: url.pathname, ...errorFields(err) });
      return jsonResponse(500, { error: 'internal error' });
    }
  }

  private async route(request: Request, url: URL): Promise<Response> {
    const { repo, matchmaker } = await this.ensureReady();
    const { pathname } = url;
    const method = request.method;
    const secret = this.env.TOKEN_SECRET;
    const ip =
      request.headers.get('cf-connecting-ip') ??
      request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() ??
      'unknown';

    if (++this.reqCount % 256 === 0) {
      this.apiLimiter?.sweep();
      this.guestLimiter?.sweep(10 * 60_000);
    }

    if (pathname === '/health') {
      const dbOk = await repo.ping().catch(() => false);
      const ok = dbOk && !!secret;
      return jsonResponse(ok ? 200 : 503, {
        status: ok ? 'ok' : 'degraded',
        db: repo.driver,
        dbOk,
        protocolVersion: sim.PROTOCOL_VERSION,
        uptimeSec: Math.round((Date.now() - this.startedAtMs) / 1000),
      });
    }

    if (pathname === '/metrics') {
      if (!this.apiLimiter!.take(ip)) throw new HttpError(429, 'too many requests');
      const metricsToken = this.env.METRICS_TOKEN;
      if (!metricsToken) throw new HttpError(403, 'forbidden');
      const h = request.headers.get('authorization') ?? '';
      const provided = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (!provided || !safeEq(provided, metricsToken)) {
        return jsonResponse(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      }
      return new Response(metrics.toPrometheus(), {
        status: 200,
        headers: { ...SECURITY_HEADERS, 'content-type': 'text/plain; version=0.0.4' },
      });
    }

    if (pathname === '/ws') {
      return this.handleWs(request, url, repo, matchmaker, secret);
    }

    if (pathname.startsWith('/api/')) {
      if (!this.apiLimiter!.take(ip)) throw new HttpError(429, 'too many requests');
      metrics.inc('http_api_requests_total');

      if (method === 'GET' && pathname === '/api/auth/providers') {
        return jsonResponse(200, { github: false });
      }

      if (method === 'POST' && pathname === '/api/auth/guest') {
        if (!secret) throw new HttpError(503, 'TOKEN_SECRET not configured');
        if (!this.guestLimiter!.take(ip)) throw new HttpError(429, 'too many guest accounts');
        const body = await readJsonBody(request);
        const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
        if (!NICK_RE.test(nickname)) throw new HttpError(400, '닉네임은 2~16자의 문자/숫자/공백/_/- 만 가능합니다');
        const player = await repo.createGuest(nickname);
        const tokenTtlSec = num(this.env.TOKEN_TTL_SEC, 60 * 60 * 24 * 7);
        const token = issueToken(player.id, player.nickname, secret, tokenTtlSec);
        return jsonResponse(201, { token, player });
      }

      if (method === 'GET' && pathname === '/api/me') {
        if (!secret) throw new HttpError(503, 'TOKEN_SECRET not configured');
        const h = request.headers.get('authorization') ?? '';
        const payload = h.startsWith('Bearer ') ? verifyToken(h.slice(7), secret) : null;
        if (!payload) throw new HttpError(401, 'unauthorized');
        const player = await repo.getPlayer(payload.sub);
        if (!player) throw new HttpError(401, 'unknown player');
        const matches = await repo.playerMatches(player.id, 10);
        return jsonResponse(200, { player, matches });
      }

      if (method === 'GET' && pathname === '/api/leaderboard') {
        return jsonResponse(200, { players: await repo.leaderboard(clampLimit(url.searchParams.get('limit'), 20, 100)) });
      }

      if (method === 'GET' && pathname === '/api/matches/recent') {
        return jsonResponse(200, { matches: await repo.recentMatches(clampLimit(url.searchParams.get('limit'), 10, 50)) });
      }

      const m = /^\/api\/players\/([0-9a-f-]{36})$/.exec(pathname);
      if (method === 'GET' && m) {
        const player = await repo.getPlayer(m[1]);
        if (!player) throw new HttpError(404, 'player not found');
        return jsonResponse(200, { player, matches: await repo.playerMatches(player.id, 20) });
      }

      if (method === 'GET' && pathname === '/api/stats') {
        return jsonResponse(200, {
          online: this.sessions.size,
          rooms: matchmaker.rooms.size,
          inMatch: matchmaker.playersInRooms,
          queue: matchmaker.queueSize,
          tick: metrics.tickStats(),
          db: repo.driver,
        });
      }

      throw new HttpError(404, 'not found');
    }

    throw new HttpError(404, 'not found');
  }

  private async handleWs(
    request: Request,
    url: URL,
    repo: Repository,
    matchmaker: Matchmaker,
    secret: string | undefined,
  ): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426, headers: SECURITY_HEADERS });
    }
    if (!secret) {
      return new Response('TOKEN_SECRET not configured', { status: 503, headers: SECURITY_HEADERS });
    }
    if (url.searchParams.get('v') !== String(sim.PROTOCOL_VERSION)) {
      metrics.inc('ws_protocol_mismatch_total');
      return new Response('Upgrade Required', { status: 426, headers: SECURITY_HEADERS });
    }
    const payload = verifyToken(url.searchParams.get('token') ?? '', secret);
    if (!payload) {
      metrics.inc('ws_auth_failures_total');
      return new Response('Unauthorized', { status: 401, headers: SECURITY_HEADERS });
    }
    const player = await repo.getPlayer(payload.sub);
    if (!player) {
      metrics.inc('ws_auth_failures_total');
      return new Response('Unauthorized', { status: 401, headers: SECURITY_HEADERS });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const prev = this.sessions.get(player.id);
    if (prev) prev.close(4001, 'replaced by a new connection');

    const conn = new WorkerWsConnection(server, { ...payload, nick: player.nickname });
    this.sessions.set(conn.playerId, conn);
    metrics.inc('ws_connections_total');
    conn.send(JSON.stringify({ t: 'welcome', playerId: conn.playerId, nickname: conn.nickname, tickRate: sim.TICK_RATE, pv: sim.PROTOCOL_VERSION }));

    matchmaker.roomOf(conn.playerId)?.rebind(conn.playerId, conn);
    this.syncTimers();

    server.addEventListener('message', (ev) => {
      conn.lastSeenAt = Date.now();
      if (typeof ev.data !== 'string') return;
      if (!conn.bucket.take()) {
        metrics.inc('ws_rate_limited_total');
        if (++conn.violations > MAX_VIOLATIONS) conn.close(4008, 'rate limit exceeded');
        return;
      }
      const msg = parseClientMessage(ev.data);
      if (!msg) {
        metrics.inc('ws_bad_messages_total');
        return;
      }
      try {
        this.dispatchWs(conn, matchmaker, msg);
      } catch (err) {
        metrics.inc('ws_handler_errors_total');
        logger.error('ws message handler failed', { playerId: conn.playerId, t: msg.t, ...errorFields(err) });
      }
    });

    const cleanup = () => {
      conn.closed = true;
      if (this.sessions.get(conn.playerId) === conn) this.sessions.delete(conn.playerId);
      matchmaker.onDisconnect(conn);
      this.syncTimers();
    };
    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
  }

  private dispatchWs(conn: WorkerWsConnection, matchmaker: Matchmaker, msg: ClientMessage) {
    switch (msg.t) {
      case 'input':
        matchmaker.roomOf(conn.playerId)?.pushInput(conn.playerId, msg);
        break;
      case 'ping':
        conn.send(`{"t":"pong","ts":${msg.ts},"st":${Date.now()}}`);
        break;
      case 'queue':
        matchmaker.enqueue(conn);
        this.syncTimers();
        break;
      case 'leave':
        matchmaker.leave(conn);
        this.syncTimers();
        break;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/') || pathname === '/ws' || pathname === '/health' || pathname === '/metrics') {
      const id = env.ARENA.idFromName('global');
      return env.ARENA.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
