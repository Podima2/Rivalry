alter table public.race_participants
  add column if not exists progress_m integer not null default 0 check (progress_m >= 0),
  add column if not exists off_route_count integer not null default 0 check (off_route_count >= 0),
  add column if not exists finished_at timestamptz;

-- Called only by the authenticated Edge Function with service_role. The race
-- row lock serializes fixes and finalization, including near-simultaneous ends.
create or replace function public.record_friend_race_fix(
  p_race_id uuid, p_profile_id uuid,
  p_latitude double precision, p_longitude double precision,
  p_accuracy_m numeric, p_progress_m integer, p_on_route boolean,
  p_finish boolean
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  race_status text;
  start_time timestamptz;
  runner_state text;
  previous_progress integer;
  route_length integer;
  terminal_count integer;
begin
  select status, started_at into race_status, start_time
  from public.races where id = p_race_id and mode = 'friends' for update;
  if race_status <> 'active' or start_time is null then
    raise exception using errcode = 'P0001', message = 'race_not_active';
  end if;
  if p_latitude not between -90 and 90 or p_longitude not between -180 and 180
      or p_accuracy_m is null or p_accuracy_m < 0 or p_accuracy_m > 500
      or p_progress_m is null or p_progress_m < 0 then
    raise exception using errcode = '22023', message = 'invalid_location';
  end if;

  select state, progress_m, route_distance_m into runner_state, previous_progress, route_length
  from public.race_participants
  where race_id = p_race_id and profile_id = p_profile_id for update;
  if runner_state is null then
    raise exception using errcode = 'P0001', message = 'not_a_participant';
  end if;
  if runner_state <> 'running' then return runner_state; end if;
  if p_progress_m > coalesce(route_length, 0) + 20 then
    raise exception using errcode = '22023', message = 'invalid_progress';
  end if;

  insert into public.race_gps_points
    (race_id, profile_id, captured_at, latitude, longitude, accuracy_m, progress_m, on_route)
  values (p_race_id, p_profile_id, clock_timestamp(), p_latitude, p_longitude,
          p_accuracy_m, p_progress_m, p_on_route);

  update public.race_participants
  set progress_m = greatest(progress_m, p_progress_m),
      off_route_count = off_route_count + case when p_on_route then 0 else 1 end,
      state = case when p_finish and p_on_route and p_progress_m >= route_length - 25 then 'finished' else state end,
      finished_at = case when p_finish and p_on_route and p_progress_m >= route_length - 25 then now() else finished_at end,
      elapsed_ms = case when p_finish and p_on_route and p_progress_m >= route_length - 25
        then floor(extract(epoch from (now() - start_time)) * 1000)::bigint else elapsed_ms end,
      result_valid = case when p_finish and p_on_route and p_progress_m >= route_length - 25
        then off_route_count < 3 else result_valid end,
      updated_at = now()
  where race_id = p_race_id and profile_id = p_profile_id;

  select count(*) into terminal_count from public.race_participants
  where race_id = p_race_id and state in ('finished', 'dnf');
  if terminal_count = 2 then
    perform public.finalize_friend_race(p_race_id);
    return 'completed';
  end if;
  if p_finish and p_on_route and p_progress_m >= route_length - 25 then return 'finished'; end if;
  return 'running';
end;
$$;

create or replace function public.finalize_friend_race(p_race_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  race_status text;
  terminal_count integer;
begin
  select status into race_status from public.races where id = p_race_id and mode = 'friends' for update;
  if race_status <> 'active' then return; end if;
  select count(*) into terminal_count from public.race_participants
  where race_id = p_race_id and state in ('finished', 'dnf');
  if terminal_count <> 2 then return; end if;

  insert into public.race_summaries
    (race_id, profile_id, distance_km, elapsed_ms, elevation_gain_m, outcome)
  select p.race_id, p.profile_id, r.distance_km, p.elapsed_ms, p.elevation_gain_m,
    case
      when p.state = 'dnf' then 'dnf'
      when p.result_valid is not true then 'invalid'
      when other.state = 'dnf' or other.result_valid is not true then 'win'
      when p.elapsed_ms < other.elapsed_ms then 'win'
      when p.elapsed_ms > other.elapsed_ms then 'loss'
      else 'draw'
    end
  from public.race_participants p
  join public.race_participants other on other.race_id = p.race_id and other.profile_id <> p.profile_id
  join public.races r on r.id = p.race_id
  where p.race_id = p_race_id
  on conflict (race_id, profile_id) do nothing;

  delete from public.race_gps_points where race_id = p_race_id;
  update public.races set status = 'completed', completed_at = now() where id = p_race_id;
end;
$$;

create or replace function public.forfeit_friend_race(p_race_id uuid, p_profile_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  race_status text;
  runner_state text;
  terminal_count integer;
begin
  select status into race_status from public.races where id = p_race_id and mode = 'friends' for update;
  if race_status <> 'active' then
    raise exception using errcode = 'P0001', message = 'race_not_active';
  end if;
  select state into runner_state from public.race_participants
  where race_id = p_race_id and profile_id = p_profile_id for update;
  if runner_state is null then
    raise exception using errcode = 'P0001', message = 'not_a_participant';
  end if;
  if runner_state <> 'running' then return runner_state; end if;
  update public.race_participants set state = 'dnf', updated_at = now()
  where race_id = p_race_id and profile_id = p_profile_id;
  select count(*) into terminal_count from public.race_participants
  where race_id = p_race_id and state in ('finished', 'dnf');
  if terminal_count = 2 then
    perform public.finalize_friend_race(p_race_id);
    return 'completed';
  end if;
  return 'dnf';
end;
$$;

revoke all on function public.record_friend_race_fix(uuid, uuid, double precision, double precision, numeric, integer, boolean, boolean) from public, anon, authenticated;
revoke all on function public.finalize_friend_race(uuid) from public, anon, authenticated;
revoke all on function public.forfeit_friend_race(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_friend_race_fix(uuid, uuid, double precision, double precision, numeric, integer, boolean, boolean) to service_role;
grant execute on function public.finalize_friend_race(uuid) to service_role;
grant execute on function public.forfeit_friend_race(uuid, uuid) to service_role;
