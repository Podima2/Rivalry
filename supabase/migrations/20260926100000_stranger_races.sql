-- Match strangers at the same distance. Serialize each distance queue so two
-- simultaneous joiners cannot create separate waiting races.
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
    update public.races set status = 'route_review' where id = target_race_id;
  end if;
  return target_race_id;
end;
$$;

-- A runner can leave the queue or decline a match. If already matched, the
-- other runner returns to a fresh queue entry with the same distance.
create or replace function public.leave_stranger_race(p_race_id uuid, p_profile_id uuid)
returns text
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  current_status text;
  race_distance smallint;
  other_profile_id uuid;
  next_race_id uuid;
begin
  select status, distance_km into current_status, race_distance
  from public.races where id = p_race_id and mode = 'strangers' for update;
  if current_status is null then
    raise exception using errcode = 'P0001', message = 'race_unavailable';
  end if;
  if not exists (select 1 from public.race_participants
      where race_id = p_race_id and profile_id = p_profile_id) then
    raise exception using errcode = 'P0001', message = 'not_a_participant';
  end if;
  if current_status = 'active' then
    raise exception using errcode = 'P0001', message = 'race_already_active';
  end if;
  if current_status in ('cancelled', 'completed') then return current_status; end if;
  select profile_id into other_profile_id from public.race_participants
  where race_id = p_race_id and profile_id <> p_profile_id;
  update public.races set status = 'cancelled' where id = p_race_id;
  if other_profile_id is not null then
    insert into public.races (mode, distance_km, status, created_by)
    values ('strangers', race_distance, 'waiting_for_opponent', other_profile_id)
    returning id into next_race_id;
    insert into public.race_participants (race_id, profile_id, state)
    values (next_race_id, other_profile_id, 'accepted');
  end if;
  return 'cancelled';
end;
$$;

-- Reuse route and start state transitions for both modes. Friends proceed
-- directly to countdown; strangers must complete World verification first.
create or replace function public.accept_friend_race_route(p_race_id uuid, p_profile_id uuid)
returns text
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare current_status text; accepted_count integer; target_meters integer;
  my_distance integer; other_distance integer; tolerance integer;
begin
  select status, distance_km * 1000 into current_status, target_meters
  from public.races where id = p_race_id for update;
  if current_status is null then raise exception using errcode = 'P0001', message = 'race_unavailable'; end if;
  if current_status not in ('route_review', 'ready') then
    raise exception using errcode = 'P0001', message = 'race_not_in_route_review';
  end if;
  tolerance := greatest(50, round(target_meters * 0.05)::integer);
  select route_distance_m into my_distance from public.race_participants
  where race_id = p_race_id and profile_id = p_profile_id;
  if my_distance is null then raise exception using errcode = 'P0001', message = 'route_missing'; end if;
  if abs(my_distance - target_meters) > tolerance then
    raise exception using errcode = 'P0001', message = 'route_distance_mismatch';
  end if;
  select route_distance_m into other_distance from public.race_participants
  where race_id = p_race_id and profile_id <> p_profile_id;
  if other_distance is not null and
      (abs(other_distance - target_meters) > tolerance or abs(my_distance - other_distance) > tolerance) then
    raise exception using errcode = 'P0001', message = 'route_distance_mismatch';
  end if;
  update public.race_participants
  set route_accepted_at = coalesce(route_accepted_at, now()), updated_at = now()
  where race_id = p_race_id and profile_id = p_profile_id and route_coordinates is not null;
  if not found then raise exception using errcode = 'P0001', message = 'route_missing'; end if;
  select count(*) into accepted_count from public.race_participants
  where race_id = p_race_id and route_accepted_at is not null;
  if accepted_count = 2 then
    update public.races set status = 'ready' where id = p_race_id;
    return 'ready';
  end if;
  return 'route_review';
end;
$$;

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
      update public.races set status = 'verification' where id = p_race_id;
      return 'verification';
    end if;
    update public.races set status = 'countdown', scheduled_start_at = now() + interval '15 seconds'
    where id = p_race_id;
    return 'countdown';
  end if;
  return 'ready';
end;
$$;

create or replace function public.advance_friend_race_start(p_race_id uuid)
returns text
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare current_status text; scheduled_at timestamptz;
begin
  select status, scheduled_start_at into current_status, scheduled_at
  from public.races where id = p_race_id for update;
  if current_status = 'countdown' and scheduled_at <= now() then
    update public.races set status = 'active', started_at = scheduled_at where id = p_race_id;
    update public.race_participants set state = 'running', updated_at = now()
    where race_id = p_race_id and state = 'ready';
    return 'active';
  end if;
  return coalesce(current_status, 'unavailable');
end;
$$;

revoke all on function public.join_stranger_queue(uuid, smallint) from public, anon, authenticated;
revoke all on function public.leave_stranger_race(uuid, uuid) from public, anon, authenticated;
grant execute on function public.join_stranger_queue(uuid, smallint) to service_role;
grant execute on function public.leave_stranger_race(uuid, uuid) to service_role;
