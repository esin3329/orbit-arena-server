/**
 * Durable Object 내장 SQLite(`ctx.storage.sql`)를 쓰는 Repository 구현.
 *
 * `cloudflare:workers` 런타임에 의존하지 않도록 worker.ts 에서 분리했다. 덕분에 Node 테스트에서
 * node:sqlite 로 만든 같은 모양의 storage 를 넣어 Repository 계약 테스트를 그대로 돌릴 수 있다.
 */
import { randomUUID } from 'node:crypto';
import { computeRatingDeltas } from '../src/db/rating.ts';
import type {
  MatchParticipantResult,
  MatchRecordInput,
  MatchSummary,
  PlayerMatchRow,
  PlayerRecord,
  Repository,
} from '../src/db/types.ts';

export interface SqlCursor {
  toArray(): Array<Record<string, unknown>>;
}

export interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlCursor;
}

/** Durable Object storage 중 이 저장소가 쓰는 부분 */
export interface DurableObjectStorage {
  sql: SqlStorage;
  transactionSync<T>(callback: () => T): T;
}

export class DoSqliteRepository implements Repository {
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
