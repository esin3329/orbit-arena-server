/**
 * Repository 계약 테스트 — 같은 시나리오를 모든 저장소 구현에 돌린다.
 *
 * - SQLite: 항상 실행 (인메모리)
 * - Cloudflare Durable Object SQLite(`cloudflare/do-sqlite-repository.ts`): 항상 실행.
 *   DO 의 `storage.sql.exec` / `transactionSync` 와 같은 모양의 어댑터를 node:sqlite 위에 만들어 넣는다.
 *   (라이브 데모가 실제로 쓰는 저장소이므로 Node 서버용 SqliteRepository 와 같은 계약을 지켜야 한다)
 * - Supabase: SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY 가 있을 때만 실행.
 *   CI 에서는 `supabase start`(로컬 Supabase 스택: Postgres + PostgREST + Kong)에 마이그레이션을 적용한 뒤 실행해
 *   supabase-js 쿼리(임베드 조인, 정렬, RPC)까지 실제 서버로 검증한다.
 *
 * 공유 DB에서도 돌 수 있도록 매 실행마다 새 플레이어/매치 ID 를 만들고, 전역 상태(리더보드 전체 내용)에는 의존하지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRepository } from '../src/db/sqlite.ts';
import { DoSqliteRepository, type DurableObjectStorage } from '../cloudflare/do-sqlite-repository.ts';
import { createSupabaseRepository } from '../src/db/supabase.ts';
import { computeRatingDeltas } from '../src/db/rating.ts';
import type { MatchRecordInput, Repository } from '../src/db/types.ts';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL;
const SUPABASE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
// CI 의 Supabase job 은 이 값을 켠다 → 자격 증명 전달에 실패했을 때 "건너뜀"으로 조용히 통과하지 않도록
if (process.env.REQUIRE_SUPABASE === '1' && !(SUPABASE_URL && SUPABASE_KEY)) {
  throw new Error('REQUIRE_SUPABASE=1 인데 SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY 가 없습니다');
}

const nick = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}`;

function contract(name: string, make: () => Promise<Repository>, skip: string | false = false) {
  test(`[${name}] Repository 계약: 게스트·매치 기록·멱등 재시도·조회`, { skip }, async () => {
    const repo = await make();
    try {
      assert.equal(await repo.ping(), true);

      // ── 게스트 생성/조회 ──
      const [p1, p2, p3] = await Promise.all([repo.createGuest(nick('a')), repo.createGuest(nick('b')), repo.createGuest(nick('c'))]);
      const idle = await repo.createGuest(nick('idle'));
      assert.equal(p1.rating, 1000);
      assert.equal(p1.games, 0);
      assert.deepEqual(await repo.getPlayer(p1.id), p1);
      assert.equal(await repo.getPlayer(randomUUID()), null);

      // ── 매치 기록: 1등 1명 + 공동 2등 2명, 모두 1000 → 델타 합 0 ──
      const match1: MatchRecordInput = {
        matchId: randomUUID(),
        startedAt: new Date('2026-11-26T10:00:00Z'),
        endedAt: new Date('2026-11-26T10:02:00Z'),
        botCount: 1,
        participants: [
          { playerId: p1.id, nickname: p1.nickname, score: 40, kills: 4, deaths: 0, placement: 1 },
          { playerId: p2.id, nickname: p2.nickname, score: 12, kills: 1, deaths: 2, placement: 2 },
          { playerId: p3.id, nickname: p3.nickname, score: 12, kills: 1, deaths: 2, placement: 2 },
        ],
      };
      const res1 = await repo.recordMatch(match1);
      const by = new Map(res1.map((r) => [r.playerId, r]));
      assert.ok(by.get(p1.id)!.ratingDelta > 0);
      assert.equal(by.get(p2.id)!.ratingDelta, by.get(p3.id)!.ratingDelta, '같은 순위·같은 레이팅이면 같은 변동');
      assert.equal(res1.reduce((s, r) => s + r.ratingDelta, 0), 0);
      for (const r of res1) assert.equal(r.ratingAfter, 1000 + r.ratingDelta);

      const after1 = (await repo.getPlayer(p1.id))!;
      assert.deepEqual(
        { rating: after1.rating, games: after1.games, wins: after1.wins, kills: after1.kills, deaths: after1.deaths, bestScore: after1.bestScore },
        { rating: 1000 + by.get(p1.id)!.ratingDelta, games: 1, wins: 1, kills: 4, deaths: 0, bestScore: 40 },
      );

      // ── 멱등: 같은 matchId 재기록(응답 유실 후 재시도)은 이중 반영 없이 같은 결과 ──
      const replay = await repo.recordMatch(match1);
      assert.deepEqual(
        replay.map((r) => [r.playerId, r.ratingDelta, r.ratingAfter]),
        res1.map((r) => [r.playerId, r.ratingDelta, r.ratingAfter]),
      );
      assert.equal((await repo.getPlayer(p1.id))!.games, 1);

      // ── 두 번째 매치 (p1 이 꼴등) ──
      const match2: MatchRecordInput = {
        matchId: randomUUID(),
        startedAt: new Date('2026-11-26T11:00:00Z'),
        endedAt: new Date('2026-11-26T11:02:00Z'),
        botCount: 0,
        participants: [
          { playerId: p2.id, nickname: p2.nickname, score: 20, kills: 2, deaths: 0, placement: 1 },
          { playerId: p1.id, nickname: p1.nickname, score: 3, kills: 0, deaths: 2, placement: 2 },
        ],
      };
      await repo.recordMatch(match2);
      const after2 = (await repo.getPlayer(p1.id))!;
      assert.equal(after2.games, 2);
      assert.equal(after2.bestScore, 40, 'best_score 는 최댓값 유지');

      // ── 플레이어 전적: 최신순 ──
      const history = await repo.playerMatches(p1.id, 10);
      assert.deepEqual(
        history.map((h) => h.matchId),
        [match2.matchId, match1.matchId],
      );
      assert.equal(history[1].placement, 1);
      assert.equal(history[1].ratingDelta, by.get(p1.id)!.ratingDelta);
      assert.equal(Date.parse(history[0].endedAt), match2.endedAt.getTime());
      // limit 은 정렬 "후"에 적용되어야 한다 (정렬 전에 자르면 오래된 매치가 나올 수 있음)
      assert.deepEqual(
        (await repo.playerMatches(p1.id, 1)).map((h) => h.matchId),
        [match2.matchId],
      );

      // ── 최근 매치: 참가자는 순위순 ──
      const recent = await repo.recentMatches(50);
      const m1 = recent.find((m) => m.id === match1.matchId);
      assert.ok(m1, 'recentMatches 에 포함');
      assert.equal(m1.botCount, 1);
      assert.deepEqual(
        m1.participants.map((p) => p.placement),
        [1, 2, 2],
      );
      assert.equal(m1.participants[0].playerId, p1.id);

      // ── 리더보드: 게임을 한 플레이어만, 레이팅 내림차순 ──
      const board = await repo.leaderboard(100);
      assert.ok(board.every((p) => p.games > 0));
      assert.ok(!board.some((p) => p.id === idle.id), '게임 수 0 인 플레이어는 제외');
      for (let i = 1; i < board.length; i++) assert.ok(board[i - 1].rating >= board[i].rating, '레이팅 내림차순');
    } finally {
      await repo.close();
    }
  });

  test(`[${name}] 동시 매치의 레이팅은 앞서 커밋된 매치 결과를 반영한다`, { skip }, async () => {
    const repo = await make();
    try {
      const winner = await repo.createGuest(nick('win'));
      const loser = await repo.createGuest(nick('lose'));
      const match: MatchRecordInput = {
        matchId: randomUUID(),
        startedAt: new Date(),
        endedAt: new Date(),
        botCount: 0,
        participants: [
          { playerId: winner.id, nickname: winner.nickname, score: 10, kills: 1, deaths: 0, placement: 1 },
          { playerId: loser.id, nickname: loser.nickname, score: 0, kills: 0, deaths: 1, placement: 2 },
        ],
      };
      const [first, second] = await Promise.all([
        repo.recordMatch(match),
        repo.recordMatch({ ...match, matchId: randomUUID(), participants: [...match.participants].reverse() }),
      ]);

      const results = [first, second].map((rows) => rows.find((row) => row.playerId === winner.id)!);
      results.sort((a, b) => a.ratingAfter - b.ratingAfter);
      const expected = computeRatingDeltas([
        { playerId: winner.id, rating: 1016, placement: 1 },
        { playerId: loser.id, rating: 984, placement: 2 },
      ]).get(winner.id)!;
      assert.deepEqual(results.map(({ ratingDelta, ratingAfter }) => [ratingDelta, ratingAfter]), [
        [16, 1016], [expected, 1016 + expected],
      ]);
      const player = await repo.getPlayer(winner.id);
      assert.equal(player?.rating, 1016 + expected);
      assert.equal(player?.games, 2);
    } finally {
      await repo.close();
    }
  });
}

contract('sqlite', async () => new SqliteRepository(':memory:'));
contract('do-sqlite', async () => new DoSqliteRepository(nodeDoStorage()));
contract(
  'supabase',
  async () => createSupabaseRepository(SUPABASE_URL!, SUPABASE_KEY!),
  SUPABASE_URL && SUPABASE_KEY ? false : 'SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY 미설정',
);

/**
 * Durable Object storage 흉내: `sql.exec(query, ...bindings).toArray()` 와 `transactionSync(fn)`.
 * DO 와 마찬가지로 동기 트랜잭션이며, 콜백이 throw 하면 롤백한다.
 */
function nodeDoStorage(): DurableObjectStorage {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const stmt = db.prepare(query);
        const args = bindings as never[];
        const rows = stmt.columns().length > 0 ? stmt.all(...args) : (stmt.run(...args), []);
        return { toArray: () => rows as Array<Record<string, unknown>> };
      },
    },
    transactionSync<T>(callback: () => T): T {
      db.exec('BEGIN');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
