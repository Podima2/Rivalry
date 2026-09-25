-- Rivalry's first server-side schema.
-- App users authenticate with Privy, not Supabase Auth. All writes and reads
-- go through Edge Functions that verify Privy access tokens and use a server key.

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  privy_user_id text not null unique,
  runner_handle text not null unique
    check (runner_handle ~ '^[a-z0-9_]{3,20}$'),
  wallet_address text,
  ens_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.races (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('friends', 'strangers')),
  distance_km smallint not null check (distance_km in (1, 3, 5, 10)),
  status text not null default 'waiting_for_opponent'
    check (status in (
      'waiting_for_opponent', 'route_review', 'ready', 'verification',
      'countdown', 'active', 'completed', 'cancelled'
    )),
  created_by uuid not null references public.profiles(id),
  invite_token_hash text unique,
  invite_expires_at timestamptz,
  scheduled_start_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((mode = 'friends') or invite_token_hash is null)
);

create table if not exists public.race_participants (
  race_id uuid not null references public.races(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  state text not null default 'invited'
    check (state in ('invited', 'accepted', 'declined', 'ready', 'running', 'finished', 'dnf')),
  route_accepted_at timestamptz,
  route_distance_m integer check (route_distance_m is null or route_distance_m > 0),
  elevation_gain_m numeric(8,2) check (elevation_gain_m is null or elevation_gain_m >= 0),
  route_polyline text,
  route_elevation_profile jsonb,
  start_latitude double precision check (start_latitude is null or start_latitude between -90 and 90),
  start_longitude double precision check (start_longitude is null or start_longitude between -180 and 180),
  elapsed_ms bigint check (elapsed_ms is null or elapsed_ms >= 0),
  result_valid boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (race_id, profile_id)
);

create table if not exists public.race_verifications (
  id uuid primary key default gen_random_uuid(),
  race_id uuid not null references public.races(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  check_kind text not null check (check_kind in ('selfie', 'official_id')),
  environment text not null check (environment in ('staging', 'production', 'demo')),
  verified boolean not null,
  credential_type text,
  checked_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (race_id, profile_id, check_kind)
);

-- Precise location is temporary race data. A server finalization function must
-- delete these points when it writes the permanent summary.
create table if not exists public.race_gps_points (
  race_id uuid not null references public.races(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  captured_at timestamptz not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy_m numeric(8,2),
  progress_m integer check (progress_m is null or progress_m >= 0),
  on_route boolean,
  primary key (race_id, profile_id, captured_at)
);

create table if not exists public.race_summaries (
  race_id uuid not null references public.races(id),
  profile_id uuid not null references public.profiles(id),
  distance_km smallint not null check (distance_km in (1, 3, 5, 10)),
  elapsed_ms bigint check (elapsed_ms is null or elapsed_ms >= 0),
  elevation_gain_m numeric(8,2) check (elevation_gain_m is null or elevation_gain_m >= 0),
  outcome text not null check (outcome in ('win', 'loss', 'draw', 'dnf', 'invalid')),
  finalized_at timestamptz not null default now(),
  primary key (race_id, profile_id)
);

create index if not exists race_queue_lookup
  on public.races (distance_km, created_at)
  where mode = 'strangers' and status = 'waiting_for_opponent';

create index if not exists race_gps_points_retention
  on public.race_gps_points (captured_at);

-- Privy JWT verification and race-specific privacy checks will live in
-- Edge Functions. Do not expose these tables directly through the Data API.
alter table public.profiles enable row level security;
alter table public.races enable row level security;
alter table public.race_participants enable row level security;
alter table public.race_verifications enable row level security;
alter table public.race_gps_points enable row level security;
alter table public.race_summaries enable row level security;

revoke all on table
  public.profiles,
  public.races,
  public.race_participants,
  public.race_verifications,
  public.race_gps_points,
  public.race_summaries
from anon, authenticated;

grant all on table
  public.profiles,
  public.races,
  public.race_participants,
  public.race_verifications,
  public.race_gps_points,
  public.race_summaries
to service_role;

-- Keep friend invite creation and joining atomic. These RPCs are server-only;
-- the Edge Function verifies the Privy user and passes its internal profile id.
create or replace function public.create_friend_race(
  p_creator_profile_id uuid,
  p_distance_km smallint,
  p_invite_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  created_race_id uuid;
begin
  if p_distance_km not in (1, 3, 5, 10) or p_invite_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_race_request';
  end if;

  insert into public.races (mode, distance_km, status, created_by, invite_token_hash, invite_expires_at)
  values ('friends', p_distance_km, 'waiting_for_opponent', p_creator_profile_id, p_invite_token_hash, now() + interval '48 hours')
  returning id into created_race_id;

  insert into public.race_participants (race_id, profile_id, state)
  values (created_race_id, p_creator_profile_id, 'accepted');

  return created_race_id;
end;
$$;

create or replace function public.join_friend_race(
  p_joining_profile_id uuid,
  p_invite_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_race_id uuid;
  creator_profile_id uuid;
  participant_count integer;
begin
  if p_invite_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invite_unavailable';
  end if;

  select id, created_by into target_race_id, creator_profile_id
  from public.races
  where invite_token_hash = p_invite_token_hash
    and mode = 'friends'
    and status = 'waiting_for_opponent'
    and invite_expires_at > now()
  for update;

  if target_race_id is null or creator_profile_id = p_joining_profile_id then
    raise exception using errcode = 'P0001', message = 'invite_unavailable';
  end if;

  select count(*) into participant_count
  from public.race_participants
  where race_id = target_race_id;

  if participant_count >= 2 then
    raise exception using errcode = 'P0001', message = 'invite_unavailable';
  end if;

  insert into public.race_participants (race_id, profile_id, state)
  values (target_race_id, p_joining_profile_id, 'accepted');

  update public.races
  set status = 'route_review', invite_token_hash = null, invite_expires_at = null
  where id = target_race_id;

  return target_race_id;
end;
$$;

revoke all on function public.create_friend_race(uuid, smallint, text) from public, anon, authenticated;
revoke all on function public.join_friend_race(uuid, text) from public, anon, authenticated;
grant execute on function public.create_friend_race(uuid, smallint, text) to service_role;
grant execute on function public.join_friend_race(uuid, text) to service_role;
