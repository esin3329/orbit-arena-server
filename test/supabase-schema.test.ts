/**
 * supabase/migrations/*.sql 을 실제 PostgreSQL 엔진(PGlite = WASM 빌드)에 적용해 검증한다.
 * Docker·Supabase 프로젝트 없이도 스키마, record_match() 의 원자성·멱등성, RLS·권한을 매 커밋 확인할 수 있다.
 *
 * Supabase 가 프로젝트마다 미리 만들어 두는 역할(anon/authenticated/service_role)과
 * 기본 권한(default privileges)을 먼저 재현한 뒤 마이그레이션을 순서대로 적용한다.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'supabase', 'migrations');

const SUPABASE_BOOTSTRAP = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

let db: PGlite;

before(async () => {
  db = await PGlite.create();
  await db.exec(SUPABASE_BOOTSTRAP);
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
});

after(async () => {
  await db?.close();
});

/** 지정한 역할로 실행 (PostgREST 가 JWT 의 role 클레임으로 하는 것과 같다) */
async function as<T>(role: 'anon' | 'authenticated' | 'service_role', fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}

async function newPlayer(nickname: string, rating = 1000) {
  const id = randomUUID();
  await db.query('insert into players (id, nickname, rating) values ($1, $2, $3)', [id, nickname, rating]);
  return id;
}

type Result = { player_id: string; nickname: string; score: number; kills: number; deaths: number; placement: number };

const recordMatch = (matchId: string, results: Result[], botCount = 2) =>
  db.query<{ out_player_id: string; out_rating: number; out_rating_delta: number }>(
    'select * from record_match($1, $2, $3, $4, $5)',
    [matchId, '2026-11-26T00:00:00Z', '2026-11-26T00:02:00Z', botCount, JSON.stringify(results)],
  );

const player = async (id: string) =>
  (await db.query<any>('select rating, games, wins, kills, deaths, best_score from players where id = $1', [id])).rows[0];

test('Supabase 스키마: record_match 가 매치·참가자·누적 스탯·레이팅을 한 번에 반영하고 결과를 돌려준다', async () => {
  const a = await newPlayer('alpha', 1100);
  const b = await newPlayer('bravo', 1000);
  const matchId = randomUUID();

  const res = await as('service_role', () =>
    recordMatch(matchId, [
      { player_id: a, nickname: 'alpha', score: 42, kills: 4, deaths: 1, placement: 1 },
      { player_id: b, nickname: 'bravo', score: 7, kills: 1, deaths: 4, placement: 3 },
    ]),
  );

  const out = new Map(res.rows.map((r) => [r.out_player_id, r]));
  assert.deepEqual({ ...out.get(a) }, { out_player_id: a, out_rating: 1112, out_rating_delta: 12 });
  assert.deepEqual({ ...out.get(b) }, { out_player_id: b, out_rating: 988, out_rating_delta: -12 });

  assert.deepEqual({ ...(await player(a)) }, { rating: 1112, games: 1, wins: 1, kills: 4, deaths: 1, best_score: 42 });
  assert.deepEqual({ ...(await player(b)) }, { rating: 988, games: 1, wins: 0, kills: 1, deaths: 4, best_score: 7 });

  const m = (await db.query<any>('select player_count, bot_count from matches where id = $1', [matchId])).rows[0];
  assert.deepEqual({ ...m }, { player_count: 2, bot_count: 2 });
});

test('Supabase 스키마: 같은 matchId 재호출(응답 유실 후 재시도)은 이중 반영 없이 저장된 결과를 돌려준다', async () => {
  const a = await newPlayer('charlie');
  const b = await newPlayer('delta');
  const matchId = randomUUID();
  const results: Result[] = [
    { player_id: a, nickname: 'charlie', score: 30, kills: 3, deaths: 0, placement: 1 },
    { player_id: b, nickname: 'delta', score: 10, kills: 0, deaths: 3, placement: 2 },
  ];

  const first = await as('service_role', () => recordMatch(matchId, results));
  // 이후 다른 매치가 반영되어 레이팅이 변한 뒤에도 matchId 재호출은 원래 저장된 델타를 돌려준다
  await as('service_role', () =>
    recordMatch(randomUUID(), [
      { player_id: a, nickname: 'charlie', score: 1, kills: 0, deaths: 2, placement: 2 },
      { player_id: b, nickname: 'delta', score: 20, kills: 2, deaths: 0, placement: 1 },
    ]),
  );
  const afterSecond = await player(a);
  const retried = await as('service_role', () => recordMatch(matchId, results));

  const outFirst = new Map(first.rows.map((r) => [r.out_player_id, r]));
  const outRetried = new Map(retried.rows.map((r) => [r.out_player_id, r]));
  assert.equal(outRetried.get(a)!.out_rating_delta, outFirst.get(a)!.out_rating_delta);
  assert.equal(outRetried.get(b)!.out_rating_delta, outFirst.get(b)!.out_rating_delta);
  assert.equal(outRetried.get(a)!.out_rating, afterSecond.rating);
  assert.equal((await player(a)).games, 2, '스탯이 이중 반영되지 않음');
  assert.equal(Number((await db.query<any>('select count(*) as n from match_players where match_id = $1', [matchId])).rows[0].n), 2);
});

test('Supabase 스키마: 참가자 하나라도 실패하면 매치 전체가 롤백된다(원자성)', async () => {
  const a = await newPlayer('echo');
  const ghost = randomUUID(); // players 에 없는 ID → FK 위반
  const matchId = randomUUID();

  await assert.rejects(
    as('service_role', () =>
      recordMatch(matchId, [
        { player_id: a, nickname: 'echo', score: 5, kills: 0, deaths: 0, placement: 1 },
        { player_id: ghost, nickname: 'ghost', score: 0, kills: 0, deaths: 0, placement: 2 },
      ]),
    ),
  );
  assert.equal((await db.query('select 1 from matches where id = $1', [matchId])).rows.length, 0);
  assert.deepEqual({ ...(await player(a)) }, { rating: 1000, games: 0, wins: 0, kills: 0, deaths: 0, best_score: 0 });
});

test('Supabase 스키마: RLS — anon/authenticated 는 읽기만, 쓰기와 record_match 호출은 거부', async () => {
  const a = await newPlayer('foxtrot');

  for (const role of ['anon', 'authenticated'] as const) {
    const rows = await as(role, () => db.query('select id, nickname, rating from players where id = $1', [a]));
    assert.equal(rows.rows.length, 1, `${role} 는 리더보드를 읽을 수 있다`);

    await assert.rejects(
      as(role, () => db.query('insert into players (id, nickname) values ($1, $2)', [randomUUID(), 'hacker'])),
      /row-level security/,
      `${role} 는 플레이어를 만들 수 없다`,
    );

    // RLS 에서 정책이 없는 UPDATE/DELETE 는 에러 대신 "대상 0행"이 된다
    const upd = await as(role, () => db.query('update players set rating = 9999 where id = $1', [a]));
    assert.equal(upd.affectedRows, 0);
    const del = await as(role, () => db.query('delete from players where id = $1', [a]));
    assert.equal(del.affectedRows, 0);

    await assert.rejects(
      as(role, () => recordMatch(randomUUID(), [{ player_id: a, nickname: 'foxtrot', score: 999, kills: 99, deaths: 0, placement: 1 }])),
      /permission denied/,
      `${role} 는 record_match 를 호출할 수 없다`,
    );
  }
  assert.deepEqual({ ...(await player(a)) }, { rating: 1000, games: 0, wins: 0, kills: 0, deaths: 0, best_score: 0 });
});

test('Supabase 스키마: player_matches 는 종료 시각 최신순으로 정렬한 "뒤" limit 을 적용한다', async () => {
  const a = await newPlayer('golf');
  const b = await newPlayer('hotel');
  const ids: string[] = [];
  // 오래된 매치를 나중에 삽입해 "삽입 순서 ≠ 시간 순서"로 만든다
  for (const [hour, ord] of [
    [12, 1],
    [9, 2],
    [15, 3],
    [8, 4],
  ]) {
    const id = randomUUID();
    ids[ord] = id;
    await as('service_role', () =>
      db.query('select * from record_match($1, $2, $3, 0, $4)', [
        id,
        `2026-11-20T${hour}:00:00Z`,
        `2026-11-20T${hour}:05:00Z`,
        JSON.stringify([
          { player_id: a, nickname: 'golf', score: ord, kills: 0, deaths: 0, placement: 1 },
          { player_id: b, nickname: 'hotel', score: 0, kills: 0, deaths: 0, placement: 2 },
        ]),
      ]),
    );
  }

  const rows = await as('service_role', () => db.query<{ match_id: string }>('select * from player_matches($1, $2)', [a, 2]));
  assert.deepEqual(
    rows.rows.map((r) => r.match_id),
    [ids[3], ids[1]],
    '15시 → 12시',
  );
  await assert.rejects(
    as('anon', () => db.query('select * from player_matches($1, 10)', [a])),
    /permission denied/,
  );
});

test('Supabase 스키마: github_accounts 는 service_role 전용이며 get_or_create_github_player 는 멱등하다', async () => {
  const authUserId = randomUUID();

  const first = await as('service_role', () =>
    db.query<{ id: string }>('select get_or_create_github_player($1, $2) as id', [authUserId, 'octocat']),
  );
  const playerId = first.rows[0].id;
  assert.ok(playerId);
  assert.equal((await db.query<{ nickname: string }>('select nickname from players where id = $1', [playerId])).rows[0].nickname, 'octocat');

  const second = await as('service_role', () =>
    db.query<{ id: string }>('select get_or_create_github_player($1, $2) as id', [authUserId, 'octocat-renamed']),
  );
  assert.equal(second.rows[0].id, playerId, '동일 auth_user_id 재호출 시 기존 player_id 반환');
  assert.equal(
    Number((await db.query<{ n: string }>('select count(*) as n from github_accounts where auth_user_id = $1', [authUserId])).rows[0].n),
    1,
  );

  for (const role of ['anon', 'authenticated'] as const) {
    await assert.rejects(
      as(role, () => db.query('select * from github_accounts')),
      /permission denied/,
      `${role} 는 github_accounts 를 읽을 수 없다`,
    );
    await assert.rejects(
      as(role, () => db.query('insert into github_accounts (auth_user_id, player_id) values ($1, $2)', [randomUUID(), playerId])),
      /permission denied/,
      `${role} 는 github_accounts 에 쓸 수 없다`,
    );
    await assert.rejects(
      as(role, () => db.query('select get_or_create_github_player($1, $2)', [randomUUID(), 'hacker'])),
      /permission denied/,
      `${role} 는 get_or_create_github_player 를 호출할 수 없다`,
    );
  }
});

test('Supabase 스키마: 닉네임 길이 제약과 리더보드 부분 인덱스', async () => {
  await assert.rejects(newPlayer('x'), /check constraint/);
  await assert.rejects(newPlayer('x'.repeat(17)), /check constraint/);

  const idx = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'players_leaderboard_idx'");
  assert.match(idx.rows[0].indexdef, /WHERE \(games > 0\)/);
});
