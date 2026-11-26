-- Compute Elo while holding the participant rows in a consistent order.
create or replace function public.record_match(
  p_match_id uuid,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_bot_count integer,
  p_results jsonb
)
returns table (out_player_id uuid, out_rating integer, out_rating_delta integer)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.matches (id, started_at, ended_at, player_count, bot_count)
  values (p_match_id, p_started_at, p_ended_at, jsonb_array_length(p_results), p_bot_count)
  on conflict (id) do nothing;

  if found then
    perform p.id
    from public.players p
    where p.id in (select (result->>'player_id')::uuid from jsonb_array_elements(p_results) as result)
    order by p.id
    for no key update;

    with participants as materialized (
      select r.ordinality, (r.result->>'player_id')::uuid as player_id,
        r.result->>'nickname' as nickname, (r.result->>'score')::int as score,
        (r.result->>'kills')::int as kills, (r.result->>'deaths')::int as deaths,
        (r.result->>'placement')::int as placement, coalesce(p.rating, 1000) as rating
      from jsonb_array_elements(p_results) with ordinality as r(result, ordinality)
      left join public.players p on p.id = (r.result->>'player_id')::uuid
    ), recorded as (
      insert into public.match_players (match_id, player_id, nickname, score, kills, deaths, placement, rating_delta)
      select p_match_id, a.player_id, a.nickname, a.score, a.kills, a.deaths, a.placement,
        -- JavaScript Math.round rounds halves toward positive infinity.
        coalesce(floor(32 * (
          select avg(
            (case when a.placement < b.placement then 1.0
                  when a.placement = b.placement then 0.5 else 0.0 end)
            - 1 / (1 + power(10::double precision, (b.rating::double precision - a.rating) / 400))
            order by b.ordinality
          )
          from participants b
          where a.ordinality <> b.ordinality
        ) + 0.5)::int, 0)
      from participants a
      returning player_id, score, kills, deaths, placement, rating_delta
    )
    update public.players p set
      rating = p.rating + r.rating_delta,
      games = p.games + 1,
      wins = p.wins + case when r.placement = 1 then 1 else 0 end,
      kills = p.kills + r.kills,
      deaths = p.deaths + r.deaths,
      best_score = greatest(p.best_score, r.score),
      last_seen_at = p_ended_at
    from recorded r
    where p.id = r.player_id;
  end if;

  return query
    select mp.player_id, p.rating, mp.rating_delta
    from public.match_players mp join public.players p on p.id = mp.player_id
    where mp.match_id = p_match_id;
end;
$$;

revoke execute on function public.record_match(uuid, timestamptz, timestamptz, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_match(uuid, timestamptz, timestamptz, integer, jsonb)
  to service_role;
