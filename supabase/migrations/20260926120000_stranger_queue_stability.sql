-- Keep a waiting runner in the same distance queue until they leave or change distance.
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
    update public.races set status = 'route_review' where id = target_race_id;
  end if;
  return target_race_id;
end;
$$;

