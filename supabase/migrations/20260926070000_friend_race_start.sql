-- Both friends must explicitly confirm before one shared countdown begins.
alter table public.race_participants
  add column if not exists start_ready_at timestamptz;

create or replace function public.set_friend_race_start_ready(
  p_race_id uuid,
  p_profile_id uuid,
  p_ready boolean
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  current_status text;
  ready_count integer;
begin
  select status into current_status
  from public.races
  where id = p_race_id and mode = 'friends'
  for update;

  if current_status is null then
    raise exception using errcode = 'P0001', message = 'race_unavailable';
  end if;
  if current_status <> 'ready' then
    raise exception using errcode = 'P0001', message = 'race_not_ready_for_start';
  end if;

  update public.race_participants
  set start_ready_at = case when p_ready then coalesce(start_ready_at, now()) else null end,
      state = case when p_ready then 'ready' else 'accepted' end,
      updated_at = now()
  where race_id = p_race_id and profile_id = p_profile_id and route_accepted_at is not null;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_participant';
  end if;

  select count(*) into ready_count
  from public.race_participants
  where race_id = p_race_id and route_accepted_at is not null and start_ready_at is not null;

  if ready_count = 2 then
    update public.races
    set status = 'countdown', scheduled_start_at = now() + interval '15 seconds'
    where id = p_race_id;
    return 'countdown';
  end if;
  return 'ready';
end;
$$;

create or replace function public.advance_friend_race_start(p_race_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  current_status text;
  scheduled_at timestamptz;
begin
  select status, scheduled_start_at into current_status, scheduled_at
  from public.races
  where id = p_race_id and mode = 'friends'
  for update;

  if current_status = 'countdown' and scheduled_at <= now() then
    update public.races
    set status = 'active', started_at = scheduled_at
    where id = p_race_id;
    update public.race_participants
    set state = 'running', updated_at = now()
    where race_id = p_race_id and state = 'ready';
    return 'active';
  end if;
  return coalesce(current_status, 'unavailable');
end;
$$;

revoke all on function public.set_friend_race_start_ready(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.advance_friend_race_start(uuid) from public, anon, authenticated;
grant execute on function public.set_friend_race_start_ready(uuid, uuid, boolean) to service_role;
grant execute on function public.advance_friend_race_start(uuid) to service_role;
