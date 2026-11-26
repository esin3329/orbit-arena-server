export type DbDriver = 'sqlite' | 'supabase';

export interface MatchConfig {
  /** 매치 길이(초) */
  durationSec: number;
  /** 한 룸 최대 인원 (사람 + 봇) */
  maxPlayers: number;
  /** 대기열 최장 대기 시간이 이 값을 넘으면 현재 인원 + 봇으로 매치 시작 */
  botFillAfterMs: number;
  /** 봇 채움 목표 인원 */
  botFillTo: number;
  /** 연결이 끊긴 플레이어를 룸에 유지하는 시간(재접속 허용) */
  reconnectGraceMs: number;
  /** 난입(late join) 허용 최소 남은 시간(초) */
  lateJoinMinRemainingSec: number;
}

export interface Config {
  port: number;
  host: string;
  tokenSecret: string;
  tokenTtlSec: number;
  dbDriver: DbDriver;
  sqlitePath: string;
  supabaseUrl?: string;
  supabaseKey?: string;
  supabasePublishableKey?: string;
  githubAuthOrigin?: string;
  /** N틱마다 스냅샷 전송 (30Hz 틱 / 2 = 15Hz 스냅샷) */
  snapshotEvery: number;
  roomWorkers: number;
  /** IP 당 REST 요청 허용량(초당) */
  apiRatePerSec: number;
  /** IP 당 게스트 계정 생성 허용량(분당) */
  guestRatePerMin: number;
  /** 신뢰할 리버스 프록시 홉 수 (0 = X-Forwarded-For 무시) */
  trustProxy: number;
  /** /metrics 엔드포인트용 Bearer 토큰 (미설정 시 루프백에서만 접근 허용) */
  metricsToken?: string;
  match: MatchConfig;
}

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const parseTrustProxy = (v: string | undefined) => (v === 'true' ? 1 : v === 'false' ? 0 : num(v, 0));

export const config: Config = {
  port: num(env.PORT, 3000),
  host: env.HOST ?? '0.0.0.0',
  tokenSecret: env.TOKEN_SECRET || 'dev-only-secret-change-me',
  tokenTtlSec: num(env.TOKEN_TTL_SEC, 60 * 60 * 24 * 7),
  dbDriver: env.DB_DRIVER === 'supabase' ? 'supabase' : 'sqlite',
  sqlitePath: env.SQLITE_PATH ?? 'data/game.db',
  supabaseUrl: env.SUPABASE_URL,
  supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY,
  supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY,
  githubAuthOrigin: env.GITHUB_AUTH_ORIGIN || undefined,
  snapshotEvery: num(env.SNAPSHOT_EVERY, 2),
  roomWorkers: num(env.ROOM_WORKERS, 0),
  apiRatePerSec: num(env.API_RATE_PER_SEC, 10),
  guestRatePerMin: num(env.GUEST_RATE_PER_MIN, 5),
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  metricsToken: env.METRICS_TOKEN || undefined,
  match: {
    durationSec: num(env.MATCH_DURATION_SEC, 120),
    maxPlayers: num(env.MATCH_MAX_PLAYERS, 8),
    botFillAfterMs: num(env.MATCH_BOT_FILL_AFTER_MS, 4000),
    botFillTo: num(env.MATCH_BOT_FILL_TO, 4),
    reconnectGraceMs: num(env.MATCH_RECONNECT_GRACE_MS, 10000),
    lateJoinMinRemainingSec: num(env.MATCH_LATE_JOIN_MIN_SEC, 30),
  },
};

export const DEV_TOKEN_SECRET = 'dev-only-secret-change-me';

/**
 * 설정 검증 — 잘못된 값으로 "조용히" 기동하는 대신 시작 시점에 실패한다(fail fast).
 * 운영(NODE_ENV=production)에서는 기본 시크릿/짧은 시크릿을 거부한다.
 */
export function validateConfig(cfg: Config, nodeEnv = process.env.NODE_ENV): string[] {
  const errors: string[] = [];
  const int = (name: string, v: number, lo: number, hi: number) => {
    if (!Number.isInteger(v) || v < lo || v > hi) errors.push(`${name} must be an integer in [${lo}, ${hi}] (got ${v})`);
  };
  int('PORT', cfg.port, 0, 65535);
  int('TOKEN_TTL_SEC', cfg.tokenTtlSec, 60, 60 * 60 * 24 * 90);
  int('SNAPSHOT_EVERY', cfg.snapshotEvery, 1, 30);
  int('ROOM_WORKERS', cfg.roomWorkers, 0, 32);
  if (cfg.roomWorkers > 0 && cfg.dbDriver === 'sqlite' && cfg.sqlitePath === ':memory:') {
    errors.push('ROOM_WORKERS requires a shared on-disk SQLite database or Supabase');
  }
  if (!(cfg.apiRatePerSec > 0)) errors.push('API_RATE_PER_SEC must be > 0');
  if (!(cfg.guestRatePerMin > 0)) errors.push('GUEST_RATE_PER_MIN must be > 0');
  int('TRUST_PROXY', cfg.trustProxy, 0, 10);

  const m = cfg.match;
  int('MATCH_DURATION_SEC', m.durationSec, 1, 3600);
  int('MATCH_MAX_PLAYERS', m.maxPlayers, 2, 32);
  int('MATCH_BOT_FILL_TO', m.botFillTo, 0, m.maxPlayers);
  int('MATCH_BOT_FILL_AFTER_MS', m.botFillAfterMs, 0, 600_000);
  int('MATCH_RECONNECT_GRACE_MS', m.reconnectGraceMs, 0, 600_000);
  if (!(m.lateJoinMinRemainingSec >= 0)) errors.push('MATCH_LATE_JOIN_MIN_SEC must be >= 0');

  if (cfg.dbDriver === 'supabase' && (!cfg.supabaseUrl || !cfg.supabaseKey)) {
    errors.push('DB_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  if (cfg.githubAuthOrigin) {
    const url = URL.parse(cfg.githubAuthOrigin);
    if (!url || url.origin !== cfg.githubAuthOrigin || (
      url.protocol !== 'https:' &&
      (nodeEnv === 'production' || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )) {
      errors.push('GITHUB_AUTH_ORIGIN must be an HTTPS origin or a loopback HTTP origin for development');
    }
    if (cfg.dbDriver !== 'supabase' || !cfg.supabasePublishableKey) {
      errors.push('GitHub auth requires DB_DRIVER=supabase and SUPABASE_PUBLISHABLE_KEY');
    }
  }
  if (nodeEnv === 'production') {
    if (cfg.tokenSecret === DEV_TOKEN_SECRET) errors.push('TOKEN_SECRET must be set in production');
    else if (cfg.tokenSecret.length < 32) errors.push('TOKEN_SECRET must be at least 32 characters in production');
    if (cfg.metricsToken !== undefined && cfg.metricsToken.length < 16) {
      errors.push('METRICS_TOKEN must be at least 16 characters in production');
    }
  }
  return errors;
}
