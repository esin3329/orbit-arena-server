import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
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
 * Supabase(PostgreSQL) 구현.
 * - 서버에서만 service_role 키를 사용한다 (브라우저에 절대 노출하지 않음)
 * - 매치 기록 + 스탯 갱신은 Postgres 함수 record_match() 하나로 처리해 원자성 보장
 *   (스키마: supabase/migrations/*.sql)
 */
export async function createSupabaseRepository(url: string, serviceKey: string): Promise<Repository> {
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return new SupabaseRepository(client);
}

const PLAYER_SELECT = 'id, nickname, rating, games, wins, kills, deaths, best_score, created_at';

interface PlayerRow {
  id: string;
  nickname: string;
  rating: number;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  best_score: number;
  created_at: string;
}

const mapPlayer = (r: PlayerRow): PlayerRecord => ({
  id: r.id,
  nickname: r.nickname,
  rating: r.rating,
  games: r.games,
  wins: r.wins,
  kills: r.kills,
  deaths: r.deaths,
  bestScore: r.best_score,
  createdAt: r.created_at,
});

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`supabase: ${res.error.message}`);
  return res.data;
}

class SupabaseRepository implements Repository {
  readonly driver = 'supabase';
  private sb: SupabaseClient;

  constructor(sb: SupabaseClient) {
    this.sb = sb;
  }

  async createGuest(nickname: string): Promise<PlayerRecord> {
    const row = check(await this.sb.from('players').insert({ id: randomUUID(), nickname }).select(PLAYER_SELECT).single());
    return mapPlayer(row as PlayerRow);
  }

  async getPlayer(id: string): Promise<PlayerRecord | null> {
    const row = check(await this.sb.from('players').select(PLAYER_SELECT).eq('id', id).maybeSingle());
    return row ? mapPlayer(row as PlayerRow) : null;
  }

  async recordMatch(input: MatchRecordInput): Promise<MatchParticipantResult[]> {
    const ids = input.participants.map((p) => p.playerId);
    const current = check(await this.sb.from('players').select('id, rating').in('id', ids)) as { id: string; rating: number }[];
    const ratingOf = new Map(current.map((r) => [r.id, r.rating]));
    const deltas = computeRatingDeltas(
      input.participants.map((p) => ({ playerId: p.playerId, placement: p.placement, rating: ratingOf.get(p.playerId) ?? 1000 })),
    );

    // rating = rating + delta 형태의 상대 갱신이라 동시 매치가 겹쳐도 갱신이 유실되지 않는다
    const rows = check(
      await this.sb.rpc('record_match', {
        p_match_id: input.matchId,
        p_started_at: input.startedAt.toISOString(),
        p_ended_at: input.endedAt.toISOString(),
        p_bot_count: input.botCount,
        p_results: input.participants.map((p) => ({
          player_id: p.playerId,
          nickname: p.nickname,
          score: p.score,
          kills: p.kills,
          deaths: p.deaths,
          placement: p.placement,
          rating_delta: deltas.get(p.playerId) ?? 0,
        })),
      }),
    ) as { out_player_id: string; out_rating: number }[];
    const after = new Map(rows.map((r) => [r.out_player_id, r.out_rating]));

    return input.participants.map((p) => {
      const delta = deltas.get(p.playerId) ?? 0;
      return { ...p, ratingDelta: delta, ratingAfter: after.get(p.playerId) ?? (ratingOf.get(p.playerId) ?? 1000) + delta };
    });
  }

  async leaderboard(limit: number): Promise<PlayerRecord[]> {
    const rows = check(
      await this.sb
        .from('players')
        .select(PLAYER_SELECT)
        .gt('games', 0)
        .order('rating', { ascending: false })
        .order('wins', { ascending: false })
        .order('best_score', { ascending: false })
        .limit(limit),
    );
    return (rows as PlayerRow[]).map(mapPlayer);
  }

  async recentMatches(limit: number): Promise<MatchSummary[]> {
    const rows = check(
      await this.sb
        .from('matches')
        .select('id, started_at, ended_at, bot_count, match_players(player_id, nickname, score, kills, deaths, placement, rating_delta)')
        .order('ended_at', { ascending: false })
        .limit(limit),
    ) as any[];
    return rows.map((m) => ({
      id: m.id,
      startedAt: m.started_at,
      endedAt: m.ended_at,
      botCount: m.bot_count,
      participants: (m.match_players as any[])
        .map((p) => ({
          playerId: p.player_id,
          nickname: p.nickname,
          score: p.score,
          kills: p.kills,
          deaths: p.deaths,
          placement: p.placement,
          ratingDelta: p.rating_delta,
        }))
        .sort((a, b) => a.placement - b.placement),
    }));
  }

  async playerMatches(playerId: string, limit: number): Promise<PlayerMatchRow[]> {
    const rows = check(
      await this.sb
        .from('match_players')
        .select('match_id, score, kills, deaths, placement, rating_delta, matches!inner(ended_at)')
        .eq('player_id', playerId)
        .order('ended_at', { ascending: false, referencedTable: 'matches' })
        .limit(limit),
    ) as any[];
    return rows
      .map((r) => ({
        matchId: r.match_id,
        endedAt: r.matches.ended_at,
        score: r.score,
        kills: r.kills,
        deaths: r.deaths,
        placement: r.placement,
        ratingDelta: r.rating_delta,
      }))
      .sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  }

  async ping(): Promise<boolean> {
    const res = await this.sb.from('players').select('id', { head: true, count: 'exact' }).limit(1);
    return !res.error;
  }

  async close(): Promise<void> {
    /* HTTP 기반 클라이언트라 닫을 커넥션이 없음 */
  }
}
