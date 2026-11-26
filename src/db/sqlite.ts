import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeRatingDeltas } from './rating.ts';
import type {
  MatchParticipantResult,
  MatchRecordInput,
  MatchSummary,
  PlayerMatchRow,
  PlayerRecord,
  Repository,
} from './types.ts';

/**
 * 버전별 마이그레이션. PRAGMA user_version 으로 적용 여부를 추적한다.
 * (새 스키마 변경은 배열 끝에 추가만 한다)
 */
const MIGRATIONS = [
  `
  CREATE TABLE players (
    id           TEXT PRIMARY KEY,
    nickname     TEXT NOT NULL,
    rating       INTEGER NOT NULL DEFAULT 1000,
    games        INTEGER NOT NULL DEFAULT 0,
    wins         INTEGER NOT NULL DEFAULT 0,
    kills        INTEGER NOT NULL DEFAULT 0,
    deaths       INTEGER NOT NULL DEFAULT 0,
    best_score   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT
  );
  CREATE INDEX idx_players_leaderboard ON players (rating DESC, wins DESC, best_score DESC) WHERE games > 0;

  CREATE TABLE matches (
    id           TEXT PRIMARY KEY,
    started_at   TEXT NOT NULL,
    ended_at     TEXT NOT NULL,
    player_count INTEGER NOT NULL,
    bot_count    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_matches_ended ON matches (ended_at DESC);

  CREATE TABLE match_players (
    match_id     TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    nickname     TEXT NOT NULL,
    score        INTEGER NOT NULL,
    kills        INTEGER NOT NULL,
    deaths       INTEGER NOT NULL,
    placement    INTEGER NOT NULL,
    rating_delta INTEGER NOT NULL,
    PRIMARY KEY (match_id, player_id)
  );
  CREATE INDEX idx_match_players_player ON match_players (player_id);
  `,
];

const PLAYER_COLS = `id, nickname, rating, games, wins, kills, deaths, best_score AS bestScore, created_at AS createdAt`;

export class SqliteRepository implements Repository {
  readonly driver = 'sqlite';
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL: 읽기와 쓰기가 서로 블로킹하지 않음 / NORMAL: WAL 에서 안전하면서 fsync 횟수 감소
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 3000;
    `);
    this.migrate();
  }

  private migrate() {
    this.tx(() => {
      const { user_version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      for (let v = user_version; v < MIGRATIONS.length; v++) {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      }
    });
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async createGuest(nickname: string): Promise<PlayerRecord> {
    const id = randomUUID();
    this.db.prepare('INSERT INTO players (id, nickname) VALUES (?, ?)').run(id, nickname);
    return (await this.getPlayer(id))!;
  }

  async getPlayer(id: string): Promise<PlayerRecord | null> {
    const row = this.db.prepare(`SELECT ${PLAYER_COLS} FROM players WHERE id = ?`).get(id);
    return row ? ({ ...row } as unknown as PlayerRecord) : null;
  }

  async recordMatch(input: MatchRecordInput): Promise<MatchParticipantResult[]> {
    // 레이팅 읽기 → 계산 → 쓰기를 한 트랜잭션(BEGIN IMMEDIATE)에서 처리해 동시 매치 종료 시에도 일관성 보장
    return this.tx(() => {
      // 멱등: 이미 기록된 매치(재시도)면 다시 반영하지 않고 저장된 결과를 돌려준다 (Supabase record_match 와 동일한 계약)
      if (this.db.prepare('SELECT 1 FROM matches WHERE id = ?').get(input.matchId)) {
        const saved = this.db.prepare(
          `SELECT mp.rating_delta AS ratingDelta, p.rating AS rating
           FROM match_players mp JOIN players p ON p.id = mp.player_id
           WHERE mp.match_id = ? AND mp.player_id = ?`,
        );
        return input.participants.map((p) => {
          const row = saved.get(input.matchId, p.playerId) as { ratingDelta: number; rating: number } | undefined;
          return { ...p, ratingDelta: row?.ratingDelta ?? 0, ratingAfter: row?.rating ?? 1000 };
        });
      }

      const getRating = this.db.prepare('SELECT rating FROM players WHERE id = ?');
      const entries = input.participants.map((p) => {
        const row = getRating.get(p.playerId) as { rating: number } | undefined;
        return { playerId: p.playerId, placement: p.placement, rating: row?.rating ?? 1000 };
      });
      const deltas = computeRatingDeltas(entries);
      const endedAt = input.endedAt.toISOString();

      this.db
        .prepare('INSERT INTO matches (id, started_at, ended_at, player_count, bot_count) VALUES (?, ?, ?, ?, ?)')
        .run(input.matchId, input.startedAt.toISOString(), endedAt, input.participants.length, input.botCount);

      const insertMp = this.db.prepare(
        `INSERT INTO match_players (match_id, player_id, nickname, score, kills, deaths, placement, rating_delta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const updatePlayer = this.db.prepare(
        `UPDATE players SET
           rating = rating + ?, games = games + 1, wins = wins + ?,
           kills = kills + ?, deaths = deaths + ?, best_score = MAX(best_score, ?), last_seen_at = ?
         WHERE id = ?
         RETURNING rating`,
      );

      return input.participants.map((p) => {
        const delta = deltas.get(p.playerId) ?? 0;
        insertMp.run(input.matchId, p.playerId, p.nickname, p.score, p.kills, p.deaths, p.placement, delta);
        const row = updatePlayer.get(delta, p.placement === 1 ? 1 : 0, p.kills, p.deaths, p.score, endedAt, p.playerId) as
          | { rating: number }
          | undefined;
        return { ...p, ratingDelta: delta, ratingAfter: row?.rating ?? 1000 + delta };
      });
    });
  }

  async leaderboard(limit: number): Promise<PlayerRecord[]> {
    const rows = this.db
      .prepare(`SELECT ${PLAYER_COLS} FROM players WHERE games > 0 ORDER BY rating DESC, wins DESC, best_score DESC LIMIT ?`)
      .all(limit);
    return rows.map((r) => ({ ...r }) as unknown as PlayerRecord);
  }

  async recentMatches(limit: number): Promise<MatchSummary[]> {
    const matches = this.db
      .prepare('SELECT id, started_at AS startedAt, ended_at AS endedAt, bot_count AS botCount FROM matches ORDER BY ended_at DESC LIMIT ?')
      .all(limit) as unknown as Omit<MatchSummary, 'participants'>[];
    const parts = this.db.prepare(
      `SELECT player_id AS playerId, nickname, score, kills, deaths, placement, rating_delta AS ratingDelta
       FROM match_players WHERE match_id = ? ORDER BY placement ASC`,
    );
    return matches.map((m) => ({
      ...m,
      participants: parts.all(m.id).map((r) => ({ ...r })) as unknown as MatchSummary['participants'],
    }));
  }

  async playerMatches(playerId: string, limit: number): Promise<PlayerMatchRow[]> {
    const rows = this.db
      .prepare(
        `SELECT m.id AS matchId, m.ended_at AS endedAt, mp.score, mp.kills, mp.deaths, mp.placement, mp.rating_delta AS ratingDelta
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.player_id = ? ORDER BY m.ended_at DESC LIMIT ?`,
      )
      .all(playerId, limit);
    return rows.map((r) => ({ ...r }) as unknown as PlayerMatchRow);
  }

  async ping(): Promise<boolean> {
    return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
