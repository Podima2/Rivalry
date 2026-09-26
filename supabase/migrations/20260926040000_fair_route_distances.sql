-- The route provider's round-trip length is approximate. Require both routes
-- to stay within 5% of the preset and of each other before either is accepted.
create or replace function public.accept_friend_race_route(
  p_race_id uuid,
  p_profile_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  current_status text;
  target_meters integer;
  tolerance_meters integer;
  my_distance integer;
  other_distance integer;
  accepted_count integer;
begin
  select status, distance_km * 1000 into current_status, target_meters
  from public.races
  where id = p_race_id and mode = 'friends'
  for update;

  if current_status is null then
    raise exception using errcode = 'P0001', message = 'race_unavailable';
  end if;

  if current_status not in ('route_review', 'ready') then
    raise exception using errcode = 'P0001', message = 'race_not_in_route_review';
  end if;

  tolerance_meters := greatest(50, round(target_meters * 0.05)::integer);

  select route_distance_m into my_distance
  from public.race_participants
  where race_id = p_race_id
    and profile_id = p_profile_id
    and route_coordinates is not null;

  if not found then
    if not exists (select 1 from public.race_participants where race_id = p_race_id and profile_id = p_profile_id) then
      raise exception using errcode = 'P0001', message = 'not_a_participant';
    end if;
    raise exception using errcode = 'P0001', message = 'route_missing';
  end if;

  if my_distance is null or abs(my_distance - target_meters) > tolerance_meters then
    raise exception using errcode = 'P0001', message = 'route_distance_mismatch';
  end if;

  select route_distance_m into other_distance
  from public.race_participants
  where race_id = p_race_id
    and profile_id <> p_profile_id;

  if other_distance is not null and
    (abs(other_distance - target_meters) > tolerance_meters or
     abs(other_distance - my_distance) > tolerance_meters) then
    raise exception using errcode = 'P0001', message = 'route_distance_mismatch';
  end if;

  update public.race_participants
  set route_accepted_at = coalesce(route_accepted_at, now()), updated_at = now()
  where race_id = p_race_id and profile_id = p_profile_id;

  select count(*) into accepted_count
  from public.race_participants
  where race_id = p_race_id and route_accepted_at is not null;

  if accepted_count = 2 then
    update public.races set status = 'ready' where id = p_race_id;
    return 'ready';
  end if;
  return 'route_review';
end;
$$;

revoke all on function public.accept_friend_race_route(uuid, uuid) from public, anon, authenticated;
grant execute on function public.accept_friend_race_route(uuid, uuid) to service_role;
