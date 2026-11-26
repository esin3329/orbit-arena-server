import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 외부 의존성 없는 HMAC-SHA256 서명 토큰 (JWT HS256 과 같은 원리, 헤더 생략).
 * 형식: base64url(payload).base64url(signature)
 */
export interface TokenPayload {
  sub: string; // player id
  nick: string;
  exp: number; // unix seconds
}

const sign = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url');

export function signToken(payload: TokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

export function verifyToken(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): TokenPayload | null {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(body, secret), 'base64url');
  // 타이밍 공격 방지를 위한 상수 시간 비교
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof p.sub !== 'string' || typeof p.nick !== 'string' || typeof p.exp !== 'number') return null;
    if (p.exp <= nowSec) return null;
    return p;
  } catch {
    return null;
  }
}

export function issueToken(playerId: string, nickname: string, secret: string, ttlSec: number): string {
  return signToken({ sub: playerId, nick: nickname, exp: Math.floor(Date.now() / 1000) + ttlSec }, secret);
}
