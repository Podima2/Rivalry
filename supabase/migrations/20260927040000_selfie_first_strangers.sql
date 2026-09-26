-- Stranger races: Selfie Check is the only World credential, at every distance,
-- and it comes first. Order: match -> Selfie Check -> route -> ready -> countdown.
-- races.verification_started_at now records when a stranger match was made;
-- each runner has 6 minutes from then to pass their Selfie Check.

-- Same as 20260926120000, plus the match timestamp.
create or replace function public.join_stranger_queue(p_profile_id uuid, p_distance_km smallint)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  target_race_id uuid;
begin
  if p_distance_km not in (1, 3, 5, 10) then
    raise exception using errcode = '22023', message = 'invalid_distance';
  end if;
  perform pg_advisory_xact_lock(72914, p_distance_km::integer);

  select r.id into target_race_id
  from public.races r join public.race_participants p on p.race_id = r.id
  where p.profile_id = p_profile_id and r.mode = 'strangers'
    and r.status in ('route_review', 'ready', 'verification', 'countdown', 'active')
  order by r.created_at desc limit 1;
  if target_race_id is not null then return target_race_id; end if;

  select r.id into target_race_id
  from public.races r join public.race_participants p on p.race_id = r.id
  where p.profile_id = p_profile_id and r.mode = 'strangers'
    and r.status = 'waiting_for_opponent' and r.distance_km = p_distance_km
  order by r.created_at desc limit 1;
  if target_race_id is not null then return target_race_id; end if;

  update public.races r set status = 'cancelled'
  where r.mode = 'strangers' and r.status = 'waiting_for_opponent'
    and exists (select 1 from public.race_participants p
      where p.race_id = r.id and p.profile_id = p_profile_id);

  select r.id into target_race_id
  from public.races r join public.race_participants p on p.race_id = r.id
  where r.mode = 'strangers' and r.status = 'waiting_for_opponent'
    and r.distance_km = p_distance_km and p.profile_id <> p_profile_id
  order by r.created_at asc limit 1 for update of r;

  if target_race_id is null then
    insert into public.races (mode, distance_km, status, created_by)
    values ('strangers', p_distance_km, 'waiting_for_opponent', p_profile_id)
    returning id into target_race_id;
    insert into public.race_participants (race_id, profile_id, state)
    values (target_race_id, p_profile_id, 'accepted');
  else
    insert into public.race_participants (race_id, profile_id, state)
    values (target_race_id, p_profile_id, 'accepted');
    update public.races set status = 'route_review', verification_started_at = now()
    where id = target_race_id;
  end if;
  return target_race_id;
end;
$$;

-- Strangers must pass their Selfie Check before confirming the start. Both
-- modes then share one 15-second countdown.
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
  if p_ready and race_mode = 'strangers' and not exists (
      select 1 from public.race_verifications check_row
      where check_row.race_id = p_race_id and check_row.profile_id = p_profile_id
        and check_row.check_kind = 'selfie' and check_row.verified) then
    raise exception using errcode = 'P0001', message = 'verification_required';
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
    update public.races set status = 'countdown', scheduled_start_at = now() + interval '15 seconds'
    where id = p_race_id;
    return 'countdown';
  end if;
  return 'ready';
end;
$$;

-- Verification no longer drives a status change; the ready step does.
create or replace function public.complete_world_verification(p_race_id uuid)
returns text
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select status from public.races where id = p_race_id), 'unavailable');
$$;

-- Same as 20260927010000's expire_stale_race, with the stranger Selfie Check
-- deadline measured from the match instead of a separate verification state.
create or replace function public.expire_stale_race_core(p_race_id uuid)
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

  if race.mode = 'strangers' and race.status in ('route_review', 'ready', 'verification')
      and coalesce(race.verification_started_at, race.created_at) < now() - interval '6 minutes'
      and exists (select 1 from public.race_participants participant
        where participant.race_id = p_race_id
          and not exists (select 1 from public.race_verifications check_row
            where check_row.race_id = p_race_id and check_row.profile_id = participant.profile_id
              and check_row.check_kind = 'selfie' and check_row.verified)) then
    update public.races set status = 'cancelled' where id = p_race_id;
    -- Runners who did verify go back to the queue at the same distance.
    for requeue_profile_id in
      select participant.profile_id from public.race_participants participant
      where participant.race_id = p_race_id
        and exists (select 1 from public.race_verifications check_row
          where check_row.race_id = p_race_id and check_row.profile_id = participant.profile_id
            and check_row.check_kind = 'selfie' and check_row.verified)
    loop
      insert into public.races (mode, distance_km, status, created_by)
      values ('strangers', race.distance_km, 'waiting_for_opponent', requeue_profile_id)
      returning id into next_race_id;
      insert into public.race_participants (race_id, profile_id, state)
      values (next_race_id, requeue_profile_id, 'accepted');
    end loop;
    return 'cancelled';
  end if;

  if race.status in ('route_review', 'ready', 'verification') then
    select max(updated_at) into last_activity from public.race_participants where race_id = p_race_id;
    if greatest(race.created_at, last_activity) < now() - interval '30 minutes' then
      update public.races set status = 'cancelled' where id = p_race_id;
      return 'cancelled';
    end if;
  end if;

  return race.status;
end;
$$;

-- Either friend can call off a race before it starts; the other sees it cancelled.
create or replace function public.cancel_friend_race(p_race_id uuid, p_profile_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare current_status text;
begin
  select status into current_status from public.races
  where id = p_race_id and mode = 'friends' for update;
  if current_status is null then raise exception using errcode = 'P0001', message = 'race_unavailable'; end if;
  if not exists (select 1 from public.race_participants where race_id = p_race_id and profile_id = p_profile_id) then
    raise exception using errcode = 'P0001', message = 'not_a_participant';
  end if;
  if current_status in ('active', 'completed', 'cancelled') then return current_status; end if;
  update public.races set status = 'cancelled', invite_token_hash = null, invite_expires_at = null
  where id = p_race_id;
  return 'cancelled';
end;
$$;

revoke all on function public.cancel_friend_race(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_friend_race(uuid, uuid) to service_role;
