-- Four-digit friend codes need short lives and a per-account attempt limit.
create table if not exists public.friend_invite_join_attempts (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index if not exists friend_invite_join_attempts_profile_time_idx
  on public.friend_invite_join_attempts (profile_id, attempted_at desc);

alter table public.friend_invite_join_attempts enable row level security;
revoke all on public.friend_invite_join_attempts from public, anon, authenticated;
grant select, insert on public.friend_invite_join_attempts to service_role;

create or replace function public.record_friend_invite_join_attempt(p_profile_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  recent_attempts integer;
begin
  -- Serialize attempts from the same account before counting them.
  perform 1 from public.profiles where id = p_profile_id for update;
  if not found then return false; end if;

  select count(*) into recent_attempts
  from public.friend_invite_join_attempts
  where profile_id = p_profile_id
    and attempted_at > now() - interval '15 minutes';
  if recent_attempts >= 5 then return false; end if;

  insert into public.friend_invite_join_attempts (profile_id) values (p_profile_id);
  return true;
end;
$$;

revoke all on function public.record_friend_invite_join_attempt(uuid) from public, anon, authenticated;
grant execute on function public.record_friend_invite_join_attempt(uuid) to service_role;

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
  where status = 'waiting_for_opponent' and invite_expires_at <= now();

  insert into public.races (mode, distance_km, status, created_by, invite_token_hash, invite_expires_at)
  values ('friends', p_distance_km, 'waiting_for_opponent', p_creator_profile_id, p_invite_token_hash, now() + interval '10 minutes')
  returning id into created_race_id;

  insert into public.race_participants (race_id, profile_id, state)
  values (created_race_id, p_creator_profile_id, 'accepted');

  return created_race_id;
end;
$$;
