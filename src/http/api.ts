import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueToken, verifyToken } from '../auth/token.ts';
import type { PlayerRecord, Repository } from '../db/types.ts';
import type { Matchmaker } from '../game/matchmaker.ts';
import { errorFields, logger } from '../util/logger.ts';
import { metrics } from '../util/metrics.ts';
import { PROTOCOL_VERSION } from '../../shared/sim.js';
import { KeyedRateLimiter } from '../util/rateLimiter.ts';
import { GITHUB_CALLBACK, GITHUB_SESSION, type createGitHubAuth } from '../auth/github.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const STATIC_DIRS: Record<string, string> = { '/shared/': join(ROOT, 'shared'), '/': join(ROOT, 'public') };
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json',
};
const NICK_RE = /^[\p{L}\p{N}_ -]{2,16}$/u;
const MAX_BODY = 4 * 1024;

export interface ApiDeps {
  repo: Repository;
  matchmaker: Matchmaker;
  secret: string;
  tokenTtlSec: number;
  apiRatePerSec: number;
  guestRatePerMin: number;
  onlineCount: () => number;
  github?: ReturnType<typeof createGitHubAuth> & { getPlayer(id: string, nickname: string): Promise<PlayerRecord> };
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'payload too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

const clampLimit = (v: string | null, d: number, max: number) => {
  const n = Number(v ?? d);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : d;
};

const VERIFIER_COOKIE = 'oa_github_pkce';
const SESSION_COOKIE = 'oa_github_session';

function readCookie(req: IncomingMessage, name: string) {
  const prefix = name + '=';
  return req.headers.cookie?.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function authCookie(name: string, value: string, age: number, secure: boolean) {
  return `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function createHttpHandler(deps: ApiDeps) {
  const { repo, matchmaker, secret } = deps;
  const limiter = new KeyedRateLimiter(deps.apiRatePerSec * 3, deps.apiRatePerSec); // IP 당 버스트 3초분
  const guestLimiter = new KeyedRateLimiter(deps.guestRatePerMin, deps.guestRatePerMin / 60); // 게스트 생성 남용 방지
  setInterval(() => {
    limiter.sweep();
    guestLimiter.sweep(10 * 60_000);
  }, 60_000).unref();

  const authed = async (req: IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    const payload = h.startsWith('Bearer ') ? verifyToken(h.slice(7), secret) : null;
    if (!payload) throw new HttpError(401, 'unauthorized');
    const player = await repo.getPlayer(payload.sub);
    if (!player) throw new HttpError(401, 'unknown player');
    return player;
  };

  async function route(req: IncomingMessage, res: ServerResponse, url: URL) {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (pathname === '/health') {
      const dbOk = await repo.ping().catch(() => false);
      return json(res, dbOk ? 200 : 503, {
        status: dbOk ? 'ok' : 'degraded',
        db: repo.driver,
        dbOk,
        protocolVersion: PROTOCOL_VERSION,
        uptimeSec: Math.round(process.uptime()),
      });
    }
    if (pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      return res.end(metrics.toPrometheus());
    }

    if (pathname.startsWith('/api/')) {
      if (!limiter.take(ip)) throw new HttpError(429, 'too many requests');
      metrics.inc('http_api_requests_total');

      const github = deps.github;
      if (method === 'GET' && pathname === '/api/auth/providers') {
        return json(res, 200, { github: !!github });
      }
      const cookiePrefix = github?.secure ? '__Host-' : '';
      const verifierCookie = cookiePrefix + VERIFIER_COOKIE;
      const sessionCookie = cookiePrefix + SESSION_COOKIE;
      if (github && method === 'POST' && pathname === '/api/auth/github') {
        if (req.headers.origin !== github.origin) throw new HttpError(403, 'invalid origin');
        const { url: providerUrl, verifier } = await github.start();
        res.setHeader('set-cookie', authCookie(verifierCookie, verifier, 600, github.secure));
        return json(res, 200, { url: providerUrl });
      }
      if (github && method === 'GET' && pathname === GITHUB_CALLBACK) {
        const cookies = [authCookie(verifierCookie, '', 0, github.secure)];
        const code = url.searchParams.get('code');
        const verifier = readCookie(req, verifierCookie);
        let handoff = '';
        try {
          const identity = code && verifier ? await github.exchange(code, verifier) : null;
          if (identity) {
            const player = await github.getPlayer(identity.id, identity.nickname);
            handoff = issueToken(player.id, player.nickname, secret + ':github-handoff', 60);
          }
        } catch (err) {
          logger.error('GitHub callback failed', errorFields(err));
        }
        res.writeHead(303, {
          location: github.origin + (handoff ? '/?github=ok' : '/?github=error'),
          'set-cookie': [...cookies, authCookie(sessionCookie, handoff, handoff ? 60 : 0, github.secure)],
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        return res.end();
      }
      if (github && method === 'POST' && pathname === GITHUB_SESSION) {
        if (req.headers.origin !== github.origin) throw new HttpError(403, 'invalid origin');
        const handoff = readCookie(req, sessionCookie);
        res.setHeader('set-cookie', authCookie(sessionCookie, '', 0, github.secure));
        const payload = handoff ? verifyToken(handoff, secret + ':github-handoff') : null;
        const player = payload && await repo.getPlayer(payload.sub);
        if (!player) throw new HttpError(401, 'GitHub 로그인 세션이 만료되었습니다');
        const token = issueToken(player.id, player.nickname, secret, deps.tokenTtlSec);
        return json(res, 200, { token, player });
      }

      if (method === 'POST' && pathname === '/api/auth/guest') {
        if (!guestLimiter.take(ip)) throw new HttpError(429, 'too many guest accounts');
        const body = await readJson(req);
        const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
        if (!NICK_RE.test(nickname)) throw new HttpError(400, '닉네임은 2~16자의 문자/숫자/공백/_/- 만 가능합니다');
        const player = await repo.createGuest(nickname);
        const token = issueToken(player.id, player.nickname, secret, deps.tokenTtlSec);
        return json(res, 201, { token, player });
      }

      if (method === 'GET' && pathname === '/api/me') {
        const player = await authed(req);
        const matches = await repo.playerMatches(player.id, 10);
        return json(res, 200, { player, matches });
      }

      if (method === 'GET' && pathname === '/api/leaderboard') {
        return json(res, 200, { players: await repo.leaderboard(clampLimit(url.searchParams.get('limit'), 20, 100)) });
      }

      if (method === 'GET' && pathname === '/api/matches/recent') {
        return json(res, 200, { matches: await repo.recentMatches(clampLimit(url.searchParams.get('limit'), 10, 50)) });
      }

      const m = /^\/api\/players\/([0-9a-f-]{36})$/.exec(pathname);
      if (method === 'GET' && m) {
        const player = await repo.getPlayer(m[1]);
        if (!player) throw new HttpError(404, 'player not found');
        return json(res, 200, { player, matches: await repo.playerMatches(player.id, 20) });
      }

      if (method === 'GET' && pathname === '/api/stats') {
        return json(res, 200, {
          online: deps.onlineCount(),
          rooms: matchmaker.rooms.size,
          inMatch: matchmaker.playersInRooms,
          queue: matchmaker.queueSize,
          tick: metrics.tickStats(),
          db: repo.driver,
        });
      }

      throw new HttpError(404, 'not found');
    }

    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    return serveStatic(res, pathname);
  }

  async function serveStatic(res: ServerResponse, pathname: string) {
    const prefix = Object.keys(STATIC_DIRS).find((p) => pathname.startsWith(p))!;
    const base = STATIC_DIRS[prefix];
    let rel = decodeURIComponent(pathname.slice(prefix.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(base, rel));
    // 경로 탈출(../) 방지
    if (!file.startsWith(base + sep)) throw new HttpError(403, 'forbidden');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'not found');
    }
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('x-content-type-options', 'nosniff');
    route(req, res, url).catch((err) => {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      if (err instanceof URIError) return json(res, 400, { error: 'bad path' });
      metrics.inc('http_errors_total');
      logger.error('http handler failed', { path: url.pathname, ...errorFields(err) });
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
  };
}
