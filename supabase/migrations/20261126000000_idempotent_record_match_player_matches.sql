-- 1) record_match() 를 멱등하게 바꾼다.
-- 2) 플레이어 전적 조회 함수 player_matches() 를 추가한다.
--
-- ── 1) record_match 멱등성 ──
-- 게임 서버는 매치 저장이 실패하면 재시도한다. Supabase 는 HTTP 로 호출하므로
-- "DB 에는 커밋됐는데 응답만 유실"되는 경우가 있고, 이때 재시도는 matches PK 충돌로 계속 실패해
-- 플레이어가 레이팅 변동을 받지 못했다. 이미 기록된 매치면 다시 반영하지 않고 저장된 결과를 돌려준다.
--
-- 반환 컬럼(out_rating_delta)이 늘어나 시그니처가 바뀌므로 drop → create 한다.

drop function if exists public.record_match(uuid, timestamptz, timestamptz, integer, jsonb);

create function public.record_match(
  p_match_id   uuid,
  p_started_at timestamptz,
  p_ended_at   timestamptz,
  p_bot_count  integer,
  p_results    jsonb
)
returns table (out_player_id uuid, out_rating integer, out_rating_delta integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
begin
  -- 같은 matchId 의 동시 호출은 PK 가 직렬화한다: 한쪽은 삽입, 다른 쪽은 아무것도 하지 않음
  insert into matches (id, started_at, ended_at, player_count, bot_count)
  values (p_match_id, p_started_at, p_ended_at, jsonb_array_length(p_results), p_bot_count)
  on conflict (id) do nothing;

  if found then
    for r in select * from jsonb_array_elements(p_results) loop
      insert into match_players (match_id, player_id, nickname, score, kills, deaths, placement, rating_delta)
      values (
        p_match_id,
        (r->>'player_id')::uuid,
        r->>'nickname',
        (r->>'score')::int,
        (r->>'kills')::int,
        (r->>'deaths')::int,
        (r->>'placement')::int,
        (r->>'rating_delta')::int
      );

      update players p set
        rating       = p.rating + (r->>'rating_delta')::int,
        games        = p.games + 1,
        wins         = p.wins + case when (r->>'placement')::int = 1 then 1 else 0 end,
        kills        = p.kills + (r->>'kills')::int,
        deaths       = p.deaths + (r->>'deaths')::int,
        best_score   = greatest(p.best_score, (r->>'score')::int),
        last_seen_at = p_ended_at
      where p.id = (r->>'player_id')::uuid;
    end loop;
  end if;

  -- 처음 기록이든 재시도든 "저장된" 변동값을 돌려준다
  return query
    select mp.player_id, p.rating, mp.rating_delta
    from match_players mp join players p on p.id = mp.player_id
    where mp.match_id = p_match_id;
end;
$$;

-- 기본 EXECUTE 권한(PUBLIC)을 회수하고 게임 서버(service_role)에만 명시적으로 부여한다.
-- Supabase 의 기본 권한(default privileges) 설정에 기대지 않는다.
revoke execute on function public.record_match(uuid, timestamptz, timestamptz, integer, jsonb) from public, anon, authenticated;
grant execute on function public.record_match(uuid, timestamptz, timestamptz, integer, jsonb) to service_role;

-- ── 2) player_matches ──
-- 기존 어댑터는 PostgREST 로 match_players 를 읽으며 `order(..., { referencedTable: 'matches' })` 를 썼는데,
-- 이는 "임베드된 matches 내부"만 정렬할 뿐 부모 행 순서는 바꾸지 않는다. 그래서 limit 이 정렬 전에 적용되어
-- 전적이 limit 보다 많은 플레이어는 최신 매치가 빠질 수 있었다. 정렬과 limit 을 SQL 한곳에서 처리한다.
create or replace function public.player_matches(p_player_id uuid, p_limit integer)
returns table (
  match_id     uuid,
  ended_at     timestamptz,
  score        integer,
  kills        integer,
  deaths       integer,
  placement    integer,
  rating_delta integer
)
language sql
stable
set search_path = public
as $$
  select mp.match_id, m.ended_at, mp.score, mp.kills, mp.deaths, mp.placement, mp.rating_delta
  from match_players mp
  join matches m on m.id = mp.match_id
  where mp.player_id = p_player_id
  order by m.ended_at desc, mp.match_id
  limit greatest(0, least(p_limit, 100));
$$;

revoke execute on function public.player_matches(uuid, integer) from public, anon, authenticated;
grant execute on function public.player_matches(uuid, integer) to service_role;
