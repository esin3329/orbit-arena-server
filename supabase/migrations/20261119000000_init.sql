-- Orbit Arena 스키마 (Supabase / PostgreSQL)
-- 적용: Supabase 대시보드 SQL Editor 에 붙여넣거나 `supabase db push`

create table if not exists public.players (
  id           uuid primary key,
  nickname     text not null check (char_length(nickname) between 2 and 16),
  rating       integer not null default 1000,
  games        integer not null default 0,
  wins         integer not null default 0,
  kills        integer not null default 0,
  deaths       integer not null default 0,
  best_score   integer not null default 0,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);
create index if not exists players_leaderboard_idx
  on public.players (rating desc, wins desc, best_score desc) where games > 0;

create table if not exists public.matches (
  id           uuid primary key,
  started_at   timestamptz not null,
  ended_at     timestamptz not null,
  player_count integer not null,
  bot_count    integer not null default 0
);
create index if not exists matches_ended_idx on public.matches (ended_at desc);

create table if not exists public.match_players (
  match_id     uuid not null references public.matches(id) on delete cascade,
  player_id    uuid not null references public.players(id) on delete cascade,
  nickname     text not null,
  score        integer not null,
  kills        integer not null,
  deaths       integer not null,
  placement    integer not null,
  rating_delta integer not null,
  primary key (match_id, player_id)
);
create index if not exists match_players_player_idx on public.match_players (player_id);

-- RLS: 리더보드/전적은 공개 읽기 허용, 쓰기는 service_role(게임 서버)만 가능
alter table public.players       enable row level security;
alter table public.matches       enable row level security;
alter table public.match_players enable row level security;

drop policy if exists "public read players" on public.players;
create policy "public read players" on public.players for select using (true);
drop policy if exists "public read matches" on public.matches;
create policy "public read matches" on public.matches for select using (true);
drop policy if exists "public read match_players" on public.match_players;
create policy "public read match_players" on public.match_players for select using (true);

-- 매치 결과 저장 + 누적 스탯/레이팅 갱신을 단일 트랜잭션으로 처리
create or replace function public.record_match(
  p_match_id   uuid,
  p_started_at timestamptz,
  p_ended_at   timestamptz,
  p_bot_count  integer,
  p_results    jsonb
)
returns table (out_player_id uuid, out_rating integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
begin
  insert into matches (id, started_at, ended_at, player_count, bot_count)
  values (p_match_id, p_started_at, p_ended_at, jsonb_array_length(p_results), p_bot_count);

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

  return query
    select p.id, p.rating from players p
    where p.id in (select (e->>'player_id')::uuid from jsonb_array_elements(p_results) e);
end;
$$;

revoke execute on function public.record_match(uuid, timestamptz, timestamptz, integer, jsonb) from public, anon, authenticated;
