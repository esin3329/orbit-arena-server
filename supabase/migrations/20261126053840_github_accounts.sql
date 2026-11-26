create table public.github_accounts (
  auth_user_id uuid primary key,
  player_id uuid not null unique references public.players(id) on delete cascade
);

alter table public.github_accounts enable row level security;
revoke all on table public.github_accounts from public, anon, authenticated;
grant select, insert on table public.github_accounts to service_role;

create function public.get_or_create_github_player(p_auth_user_id uuid, p_nickname text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('orbit-arena:github:' || p_auth_user_id::text, 0));

  select a.player_id into result
  from public.github_accounts a
  where a.auth_user_id = p_auth_user_id;

  if not found then
    result := gen_random_uuid();
    insert into public.players (id, nickname) values (result, p_nickname);
    insert into public.github_accounts (auth_user_id, player_id) values (p_auth_user_id, result);
  end if;
  return result;
end;
$$;

revoke execute on function public.get_or_create_github_player(uuid, text) from public, anon, authenticated;
grant execute on function public.get_or_create_github_player(uuid, text) to service_role;
