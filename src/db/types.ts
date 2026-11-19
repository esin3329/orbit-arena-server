export interface PlayerRecord {
  id: string;
  nickname: string;
  rating: number;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  bestScore: number;
  createdAt: string;
}

/** 매치에 참가한 "사람" 플레이어 1명의 결과 (봇은 영속화하지 않는다) */
export interface MatchParticipant {
  playerId: string;
  nickname: string;
  score: number;
  kills: number;
  deaths: number;
  /** 봇을 포함한 전체 순위 (동점은 같은 순위) */
  placement: number;
}

export interface MatchRecordInput {
  matchId: string;
  startedAt: Date;
  endedAt: Date;
  botCount: number;
  participants: MatchParticipant[];
}

export interface MatchParticipantResult extends MatchParticipant {
  ratingDelta: number;
  ratingAfter: number;
}

export interface MatchSummary {
  id: string;
  startedAt: string;
  endedAt: string;
  botCount: number;
  participants: Array<MatchParticipant & { ratingDelta: number }>;
}

export interface PlayerMatchRow {
  matchId: string;
  endedAt: string;
  score: number;
  kills: number;
  deaths: number;
  placement: number;
  ratingDelta: number;
}

/**
 * 저장소 추상화 — 게임 로직은 이 인터페이스에만 의존한다.
 * SQLite(로컬/단일 인스턴스)와 Supabase(Postgres, 관리형/수평 확장) 구현을 환경변수로 교체할 수 있다.
 */
export interface Repository {
  readonly driver: string;
  createGuest(nickname: string): Promise<PlayerRecord>;
  getPlayer(id: string): Promise<PlayerRecord | null>;
  /** 매치 결과 저장 + 플레이어 누적 스탯/레이팅 갱신을 하나의 트랜잭션으로 처리 */
  recordMatch(input: MatchRecordInput): Promise<MatchParticipantResult[]>;
  leaderboard(limit: number): Promise<PlayerRecord[]>;
  recentMatches(limit: number): Promise<MatchSummary[]>;
  playerMatches(playerId: string, limit: number): Promise<PlayerMatchRow[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
