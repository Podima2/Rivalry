-- Routes are now trimmed to the exact preset along their own path. Accept a
-- route only when it is within 5 m of the preset (so both runners' routes are
-- within 10 m of each other). Same as 20260926100000 otherwise.
create or replace function public.accept_friend_race_route(p_race_id uuid, p_profile_id uuid)
returns text
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare current_status text; accepted_count integer; target_meters integer;
  my_distance integer; other_distance integer;
  tolerance constant integer := 5;
begin
  select status, distance_km * 1000 into current_status, target_meters
  from public.races where id = p_race_id for update;
  if current_status is null then raise exception using errcode = 'P0001', message = 'race_unavailable'; end if;
  if current_status not in ('route_review', 'ready') then
    raise exception using errcode = 'P0001', message = 'race_not_in_route_review';
  end if;
  select route_distance_m into my_distance from public.race_participants
  where race_id = p_race_id and profile_id = p_profile_id;
  if my_distance is null then raise exception using errcode = 'P0001', message = 'route_missing'; end if;
  if abs(my_distance - target_meters) > tolerance then
    raise exception using errcode = 'P0001', message = 'route_distance_mismatch';
  end if;
  select route_distance_m into other_distance from public.race_participants
  where race_id = p_race_id and profile_id <> p_profile_id;
  if other_distance is not null and abs(other_distance - target_meters) > tolerance then
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
