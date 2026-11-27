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
import { DoSqliteRepository, type DurableObjectStorage } from './do-sqlite-repository.ts';

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
