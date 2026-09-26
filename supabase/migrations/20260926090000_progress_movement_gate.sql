-- Keep the last GPS fix that genuinely advanced route progress. Stationary
-- heartbeats must not move this anchor, or slow GPS drift accumulates distance.
alter table public.race_participants
  add column if not exists progress_anchor_latitude double precision,
  add column if not exists progress_anchor_longitude double precision;

-- Anchor races that were already active before this gate was introduced.
update public.race_participants participant
set progress_anchor_latitude = (
    select gps.latitude
    from public.race_gps_points gps
    where gps.race_id = participant.race_id and gps.profile_id = participant.profile_id
      and gps.on_route = true
    order by gps.captured_at desc limit 1
  ),
    progress_anchor_longitude = (
    select gps.longitude
    from public.race_gps_points gps
    where gps.race_id = participant.race_id and gps.profile_id = participant.profile_id
      and gps.on_route = true
    order by gps.captured_at desc limit 1
  )
where participant.progress_m > 0
  and exists (select 1 from public.races race where race.id = participant.race_id and race.status = 'active');

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
      progress_anchor_latitude = case
        when p_on_route and (progress_anchor_latitude is null or p_progress_m > progress_m)
          then p_latitude else progress_anchor_latitude end,
      progress_anchor_longitude = case
        when p_on_route and (progress_anchor_longitude is null or p_progress_m > progress_m)
          then p_longitude else progress_anchor_longitude end,
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

revoke all on function public.record_friend_race_fix(uuid, uuid, double precision, double precision, numeric, integer, boolean, boolean) from public, anon, authenticated;
grant execute on function public.record_friend_race_fix(uuid, uuid, double precision, double precision, numeric, integer, boolean, boolean) to service_role;
