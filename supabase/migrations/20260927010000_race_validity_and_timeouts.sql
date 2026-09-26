-- Time-based result validity and stale-race expiry.
--
-- A result is valid only when the runner's track is verifiable:
--   * no more than 60 s spent off route in total,
--   * no single GPS gap longer than 120 s after reaching the start,
--   * total GPS gap time (beyond a 30 s allowance per interval) no more than
--     max(60 s, 10% of elapsed time).
-- Fixes rejected for poor accuracy never reach the database, so repeated poor
-- accuracy shows up here as GPS gaps.
alter table public.race_participants
  add column if not exists last_fix_at timestamptz,
  add column if not exists last_fix_on_route boolean,
  add column if not exists off_route_ms bigint not null default 0 check (off_route_ms >= 0),
  add column if not exists gps_gap_ms bigint not null default 0 check (gps_gap_ms >= 0),
  add column if not exists longest_gps_gap_ms bigint not null default 0 check (longest_gps_gap_ms >= 0),
  add column if not exists dnf_reason text check (dnf_reason is null or dnf_reason in ('quit', 'inactive', 'time_limit'));

alter table public.races
  add column if not exists verification_started_at timestamptz;

create or replace function public.race_result_is_valid(
  p_elapsed_ms bigint, p_off_route_ms bigint, p_gps_gap_ms bigint, p_longest_gps_gap_ms bigint)
returns boolean
language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select p_off_route_ms <= 60000
    and p_longest_gps_gap_ms <= 120000
    and p_gps_gap_ms <= greatest(60000, p_elapsed_ms / 10);
$$;

-- p_on_route is null while the runner has not yet reached their start. Those
-- fixes are stored but neither advance progress nor count as off route.
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
  fix_time timestamptz := clock_timestamp();
  race_status text;
  start_time timestamptz;
  runner_state text;
  route_length integer;
  previous_fix_at timestamptz;
  previous_on_route boolean;
  has_started boolean;
  total_off_route bigint;
  total_gap bigint;
  longest_gap bigint;
  interval_ms bigint;
  elapsed bigint;
  finishing boolean;
  terminal_count integer;
begin
  select status, started_at into race_status, start_time
  from public.races where id = p_race_id and mode in ('friends', 'strangers') for update;
  if race_status <> 'active' or start_time is null then
    raise exception using errcode = 'P0001', message = 'race_not_active';
  end if;
  if p_latitude not between -90 and 90 or p_longitude not between -180 and 180
      or p_accuracy_m is null or p_accuracy_m < 0 or p_accuracy_m > 500
      or p_progress_m is null or p_progress_m < 0 then
    raise exception using errcode = '22023', message = 'invalid_location';
  end if;

  select state, route_distance_m, last_fix_at, last_fix_on_route,
         progress_anchor_latitude is not null, off_route_ms, gps_gap_ms, longest_gps_gap_ms
    into runner_state, route_length, previous_fix_at, previous_on_route,
         has_started, total_off_route, total_gap, longest_gap
  from public.race_participants
  where race_id = p_race_id and profile_id = p_profile_id for update;
  if runner_state is null then
    raise exception using errcode = 'P0001', message = 'not_a_participant';
  end if;
  if runner_state <> 'running' then return runner_state; end if;
  if p_progress_m > coalesce(route_length, 0) + 20 then
    raise exception using errcode = '22023', message = 'invalid_progress';
  end if;

  -- The interval since the previous fix is attributed to that fix's state.
  interval_ms := greatest(0, floor(extract(epoch from (fix_time - coalesce(previous_fix_at, start_time))) * 1000)::bigint);
  if previous_on_route is false then
    total_off_route := total_off_route + least(interval_ms, 30000);
  end if;
  if has_started then
    total_gap := total_gap + greatest(0, interval_ms - 30000);
    longest_gap := greatest(longest_gap, interval_ms);
  end if;
  elapsed := floor(extract(epoch from (fix_time - start_time)) * 1000)::bigint;
  finishing := p_finish and p_on_route is true and p_progress_m >= route_length - 25;

  insert into public.race_gps_points
    (race_id, profile_id, captured_at, latitude, longitude, accuracy_m, progress_m, on_route)
  values (p_race_id, p_profile_id, fix_time, p_latitude, p_longitude,
          p_accuracy_m, p_progress_m, p_on_route);

  update public.race_participants
  set progress_m = greatest(progress_m, p_progress_m),
      progress_anchor_latitude = case
        when p_on_route is true and (progress_anchor_latitude is null or p_progress_m > progress_m)
          then p_latitude else progress_anchor_latitude end,
      progress_anchor_longitude = case
        when p_on_route is true and (progress_anchor_longitude is null or p_progress_m > progress_m)
          then p_longitude else progress_anchor_longitude end,
      off_route_count = off_route_count + case when p_on_route is false then 1 else 0 end,
      off_route_ms = total_off_route,
      gps_gap_ms = total_gap,
      longest_gps_gap_ms = longest_gap,
      last_fix_at = fix_time,
      last_fix_on_route = p_on_route,
      state = case when finishing then 'finished' else state end,
      finished_at = case when finishing then fix_time else finished_at end,
      elapsed_ms = case when finishing then elapsed else elapsed_ms end,
      result_valid = case when finishing
        then public.race_result_is_valid(elapsed, total_off_route, total_gap, longest_gap)
        else result_valid end,
      updated_at = now()
  where race_id = p_race_id and profile_id = p_profile_id;

  select count(*) into terminal_count from public.race_participants
  where race_id = p_race_id and state in ('finished', 'dnf');
  if terminal_count = 2 then
    perform public.finalize_friend_race(p_race_id);
    return 'completed';
  end if;
  if finishing then return 'finished'; end if;
  return 'running';
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
  select status into race_status from public.races where id = p_race_id and mode in ('friends', 'strangers') for update;
  if race_status <> 'active' then
    raise exception using errcode = 'P0001', message = 'race_not_active';
  end if;
  select state into runner_state from public.race_participants
  where race_id = p_race_id and profile_id = p_profile_id for update;
  if runner_state is null then
    raise exception using errcode = 'P0001', message = 'not_a_participant';
  end if;
  if runner_state <> 'running' then return runner_state; end if;
  update public.race_participants set state = 'dnf', dnf_reason = 'quit', updated_at = now()
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

-- Same as 20260926100000, plus a timestamp for the verification deadline.
create or replace function public.set_friend_race_start_ready(
  p_race_id uuid, p_profile_id uuid, p_ready boolean)
returns text
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare current_status text; race_mode text; ready_count integer;
begin
  select status, mode into current_status, race_mode from public.races
  where id = p_race_id for update;
  if current_status is null then raise exception using errcode = 'P0001', message = 'race_unavailable'; end if;
  if current_status <> 'ready' then
    raise exception using errcode = 'P0001', message = 'race_not_ready_for_start';
  end if;
  update public.race_participants
  set start_ready_at = case when p_ready then coalesce(start_ready_at, now()) else null end,
      state = case when p_ready then 'ready' else 'accepted' end,
      updated_at = now()
  where race_id = p_race_id and profile_id = p_profile_id and route_accepted_at is not null;
  if not found then raise exception using errcode = 'P0001', message = 'not_a_participant'; end if;
  select count(*) into ready_count from public.race_participants
  where race_id = p_race_id and route_accepted_at is not null and start_ready_at is not null;
  if ready_count = 2 then
    if race_mode = 'strangers' then
      update public.races set status = 'verification', verification_started_at = now() where id = p_race_id;
      return 'verification';
    end if;
    update public.races set status = 'countdown', scheduled_start_at = now() + interval '15 seconds'
    where id = p_race_id;
    return 'countdown';
  end if;
  return 'ready';
end;
$$;

-- Apply every time-based transition for one race:
--   countdown    -> active once the scheduled start passes
--   active       -> running runners DNF after 10 min without a fix, or when
--                   the race exceeds 20 min + 15 min/km; finalize when all done
--   route_review/ready -> cancelled after 30 min without participant activity
--   verification -> cancelled after 6 min; runners who completed their checks
--                   return to the stranger queue
create or replace function public.expire_stale_race(p_race_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  race record;
  last_activity timestamptz;
  terminal_count integer;
  requeue_profile_id uuid;
  next_race_id uuid;
begin
  select id, mode, status, distance_km, created_at, started_at, scheduled_start_at, verification_started_at
    into race
  from public.races where id = p_race_id for update;
  if not found then return 'unavailable'; end if;

  if race.status = 'countdown' then
    return public.advance_friend_race_start(p_race_id);
  end if;

  if race.status = 'active' then
    update public.race_participants participant
    set state = 'dnf',
        dnf_reason = case when now() > race.started_at + make_interval(mins => 20 + race.distance_km * 15)
          then 'time_limit' else 'inactive' end,
        updated_at = now()
    where participant.race_id = p_race_id
      and participant.state = 'running'
      and (now() > race.started_at + make_interval(mins => 20 + race.distance_km * 15)
        or coalesce(participant.last_fix_at, race.started_at) < now() - interval '10 minutes');
    if found then
      select count(*) into terminal_count from public.race_participants
      where race_id = p_race_id and state in ('finished', 'dnf');
      if terminal_count = 2 then
        perform public.finalize_friend_race(p_race_id);
        return 'completed';
      end if;
    end if;
    return 'active';
  end if;

  if race.status in ('route_review', 'ready') then
    select max(updated_at) into last_activity from public.race_participants where race_id = p_race_id;
    if greatest(race.created_at, last_activity) < now() - interval '30 minutes' then
      update public.races set status = 'cancelled' where id = p_race_id;
      return 'cancelled';
    end if;
    return race.status;
  end if;

  if race.status = 'verification' and race.mode = 'strangers'
      and coalesce(race.verification_started_at, race.created_at) < now() - interval '6 minutes' then
    update public.races set status = 'cancelled' where id = p_race_id;
    for requeue_profile_id in
      select participant.profile_id from public.race_participants participant
      where participant.race_id = p_race_id
        and exists (select 1 from public.race_verifications check_row
          where check_row.race_id = p_race_id and check_row.profile_id = participant.profile_id
            and check_row.check_kind = 'selfie' and check_row.verified)
        and (race.distance_km <= 6 or exists (select 1 from public.race_verifications check_row
          where check_row.race_id = p_race_id and check_row.profile_id = participant.profile_id
            and check_row.check_kind = 'official_id' and check_row.verified))
    loop
      insert into public.races (mode, distance_km, status, created_by)
      values ('strangers', race.distance_km, 'waiting_for_opponent', requeue_profile_id)
      returning id into next_race_id;
      insert into public.race_participants (race_id, profile_id, state)
      values (next_race_id, requeue_profile_id, 'accepted');
    end loop;
    return 'cancelled';
  end if;

  return race.status;
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
  loop
    perform public.expire_stale_race(candidate);
    checked := checked + 1;
  end loop;
  return checked;
end;
$$;

revoke all on function public.race_result_is_valid(bigint, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function public.expire_stale_race(uuid) from public, anon, authenticated;
revoke all on function public.expire_stale_races() from public, anon, authenticated;
grant execute on function public.race_result_is_valid(bigint, bigint, bigint, bigint) to service_role;
grant execute on function public.expire_stale_race(uuid) to service_role;
grant execute on function public.expire_stale_races() to service_role;

-- Status polling also applies these transitions, but a sweep covers races that
-- nobody is watching, so precise GPS points are deleted even if both runners leave.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('rivalry-expire-stale-races', '* * * * *', 'select public.expire_stale_races()');
