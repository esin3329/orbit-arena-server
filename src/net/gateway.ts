import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken, type TokenPayload } from '../auth/token.ts';
import type { Matchmaker } from '../game/matchmaker.ts';
import type { PlayerConnection } from '../game/types.ts';
import { PROTOCOL_VERSION, TICK_RATE } from '../../shared/sim.js';
import { errorFields, logger } from '../util/logger.ts';
import { metrics } from '../util/metrics.ts';
import { TokenBucket } from '../util/rateLimiter.ts';
import { parseClientMessage, type ClientMessage } from './protocol.ts';

const HEARTBEAT_MS = 10_000;
/** 송신 버퍼가 이 크기를 넘으면 스냅샷을 건너뛴다 */
const CONGESTION_BYTES = 128 * 1024;
/** 레이트 리밋 위반이 이 횟수를 넘으면 연결 종료 */
const MAX_VIOLATIONS = 200;

export class WsConnection implements PlayerConnection {
  readonly playerId: string;
  readonly nickname: string;
  readonly ws: WebSocket;
  /** 입력 30Hz + ping 등을 감안: 초당 45개, 버스트 90개 */
  readonly bucket = new TokenBucket(90, 45);
  alive = true;
  violations = 0;

  constructor(ws: WebSocket, payload: TokenPayload) {
    this.ws = ws;
    this.playerId = payload.sub;
    this.nickname = payload.nick;
  }

  send(data: string) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  isCongested() {
    return this.ws.bufferedAmount > CONGESTION_BYTES;
  }
}

function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * WebSocket 게이트웨이.
 * - HTTP Upgrade 단계에서 토큰을 검증해 인증되지 않은 연결은 핸드셰이크 전에 거부
 * - 같은 계정의 중복 접속은 이전 연결을 4001 코드로 종료 (세션 하이재킹/멀티 클라이언트 방지)
 * - ping/pong 하트비트로 죽은 연결(half-open TCP) 정리
 */
export function attachGateway(server: Server, deps: { matchmaker: Matchmaker; secret: string }) {
  const { matchmaker, secret } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024, perMessageDeflate: false });
  const sessions = new Map<string, WsConnection>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return reject(socket, 404, 'Not Found');
    // 배포 직후 캐시된 구버전 클라이언트가 바뀐 메시지 형식으로 오동작하지 않도록 핸드셰이크에서 차단
    if (url.searchParams.get('v') !== String(PROTOCOL_VERSION)) {
      metrics.inc('ws_protocol_mismatch_total');
      return reject(socket, 426, 'Upgrade Required');
    }
    const payload = verifyToken(url.searchParams.get('token') ?? '', secret);
    if (!payload) {
      metrics.inc('ws_auth_failures_total');
      return reject(socket, 401, 'Unauthorized');
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, payload));
  });

  function onConnection(ws: WebSocket, payload: TokenPayload) {
    const prev = sessions.get(payload.sub);
    if (prev) prev.ws.close(4001, 'replaced by a new connection');

    const conn = new WsConnection(ws, payload);
    sessions.set(conn.playerId, conn);
    metrics.inc('ws_connections_total');
    conn.send(JSON.stringify({ t: 'welcome', playerId: conn.playerId, nickname: conn.nickname, tickRate: TICK_RATE, pv: PROTOCOL_VERSION }));

    // 진행 중인 매치가 있으면 자동 재접속
    matchmaker.roomOf(conn.playerId)?.rebind(conn.playerId, conn);

    ws.on('pong', () => {
      conn.alive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (!conn.bucket.take()) {
        metrics.inc('ws_rate_limited_total');
        if (++conn.violations > MAX_VIOLATIONS) ws.close(4008, 'rate limit exceeded');
        return;
      }
      const msg = parseClientMessage(data.toString());
      if (!msg) {
        metrics.inc('ws_bad_messages_total');
        return;
      }
      // 이벤트 리스너에서 던져진 예외는 프로세스를 종료시킨다 → 메시지 1개의 문제는 그 메시지에서 끝낸다
      try {
        dispatch(conn, msg);
      } catch (err) {
        metrics.inc('ws_handler_errors_total');
        logger.error('ws message handler failed', { playerId: conn.playerId, t: msg.t, ...errorFields(err) });
      }
    });

    ws.on('close', (code) => {
      if (sessions.get(conn.playerId) === conn) sessions.delete(conn.playerId);
      matchmaker.onDisconnect(conn);
      logger.debug('ws closed', { playerId: conn.playerId, code });
    });

    ws.on('error', (err) => logger.warn('ws error', { playerId: conn.playerId, err: err.message }));
  }

  function dispatch(conn: WsConnection, msg: ClientMessage) {
    switch (msg.t) {
      case 'input':
        matchmaker.roomOf(conn.playerId)?.pushInput(conn.playerId, msg);
        break;
      case 'ping':
        conn.send(`{"t":"pong","ts":${msg.ts},"st":${Date.now()}}`);
        break;
      case 'queue':
        matchmaker.enqueue(conn);
        break;
      case 'leave':
        matchmaker.leave(conn);
        break;
    }
  }

  const heartbeat = setInterval(() => {
    for (const conn of sessions.values()) {
      if (!conn.alive) {
        metrics.inc('ws_heartbeat_timeouts_total');
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, HEARTBEAT_MS);

  return {
    sessions,
    close() {
      clearInterval(heartbeat);
      for (const c of sessions.values()) c.ws.close(1001, 'server shutting down');
      wss.close();
    },
  };
}
