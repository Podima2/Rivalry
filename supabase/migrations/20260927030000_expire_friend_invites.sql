-- Expired friend invites were only cancelled when someone created a new one,
-- so the creator's home kept showing a dead "waiting for your friend" card.
-- Wrap the existing expiry so status polling and the cron sweep also cancel them.
alter function public.expire_stale_race(uuid) rename to expire_stale_race_core;

create or replace function public.expire_stale_race(p_race_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  update public.races
  set status = 'cancelled', invite_token_hash = null, invite_expires_at = null
  where id = p_race_id and mode = 'friends' and status = 'waiting_for_opponent'
    and invite_expires_at <= now();
  if found then return 'cancelled'; end if;
  return public.expire_stale_race_core(p_race_id);
end;
$$;

create or replace function public.expire_stale_races()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  candidate uuid;
  checked integer := 0;
begin
  for candidate in
    select id from public.races
    where status in ('countdown', 'active', 'route_review', 'ready', 'verification')
      or (mode = 'friends' and status = 'waiting_for_opponent' and invite_expires_at <= now())
  loop
    perform public.expire_stale_race(candidate);
    checked := checked + 1;
  end loop;
  return checked;
end;
$$;

revoke all on function public.expire_stale_race_core(uuid) from public, anon, authenticated;
revoke all on function public.expire_stale_race(uuid) from public, anon, authenticated;
grant execute on function public.expire_stale_race_core(uuid) to service_role;
grant execute on function public.expire_stale_race(uuid) to service_role;
