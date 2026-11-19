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
  /** N틱마다 스냅샷 전송 (30Hz 틱 / 2 = 15Hz 스냅샷) */
  snapshotEvery: number;
  /** IP 당 REST 요청 허용량(초당) */
  apiRatePerSec: number;
  /** IP 당 게스트 계정 생성 허용량(분당) */
  guestRatePerMin: number;
  match: MatchConfig;
}

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const config: Config = {
  port: num(env.PORT, 3000),
  host: env.HOST ?? '0.0.0.0',
  tokenSecret: env.TOKEN_SECRET ?? 'dev-only-secret-change-me',
  tokenTtlSec: num(env.TOKEN_TTL_SEC, 60 * 60 * 24 * 7),
  dbDriver: env.DB_DRIVER === 'supabase' ? 'supabase' : 'sqlite',
  sqlitePath: env.SQLITE_PATH ?? 'data/game.db',
  supabaseUrl: env.SUPABASE_URL,
  supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY,
  snapshotEvery: num(env.SNAPSHOT_EVERY, 2),
  apiRatePerSec: num(env.API_RATE_PER_SEC, 10),
  guestRatePerMin: num(env.GUEST_RATE_PER_MIN, 5),
  match: {
    durationSec: num(env.MATCH_DURATION_SEC, 120),
    maxPlayers: num(env.MATCH_MAX_PLAYERS, 8),
    botFillAfterMs: num(env.MATCH_BOT_FILL_AFTER_MS, 4000),
    botFillTo: num(env.MATCH_BOT_FILL_TO, 4),
    reconnectGraceMs: num(env.MATCH_RECONNECT_GRACE_MS, 10000),
    lateJoinMinRemainingSec: num(env.MATCH_LATE_JOIN_MIN_SEC, 30),
  },
};
