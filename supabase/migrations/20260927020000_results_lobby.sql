-- A pairing lasts through the race and its results screen only. Each runner
-- leaves the results lobby explicitly, or implicitly by starting a new race.
alter table public.race_participants
  add column if not exists result_dismissed_at timestamptz;

create or replace function public.dismiss_completed_races(p_profile_id uuid)
returns void
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  update public.race_participants participant
  set result_dismissed_at = now()
  from public.races race
  where race.id = participant.race_id
    and participant.profile_id = p_profile_id
    and participant.result_dismissed_at is null
    and race.status in ('completed', 'cancelled');
$$;

-- Same as 20260926030000, but a new invite also retires the creator's
-- earlier unjoined invites and finished races.
create or replace function public.create_friend_race(
  p_creator_profile_id uuid,
  p_distance_km smallint,
  p_invite_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  created_race_id uuid;
begin
  if p_distance_km not in (1, 3, 5, 10) or p_invite_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_race_request';
  end if;

  update public.races
  set status = 'cancelled', invite_token_hash = null, invite_expires_at = null
  where status = 'waiting_for_opponent'
    and mode = 'friends'
    and (invite_expires_at <= now() or created_by = p_creator_profile_id);

  perform public.dismiss_completed_races(p_creator_profile_id);

  insert into public.races (mode, distance_km, status, created_by, invite_token_hash, invite_expires_at)
  values ('friends', p_distance_km, 'waiting_for_opponent', p_creator_profile_id, p_invite_token_hash, now() + interval '10 minutes')
  returning id into created_race_id;

  insert into public.race_participants (race_id, profile_id, state)
  values (created_race_id, p_creator_profile_id, 'accepted');

  return created_race_id;
end;
$$;

revoke all on function public.dismiss_completed_races(uuid) from public, anon, authenticated;
grant execute on function public.dismiss_completed_races(uuid) to service_role;
