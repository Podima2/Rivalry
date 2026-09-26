-- World ID 4 verification attempts. Raw IDKit proofs are never persisted.

create table if not exists public.world_verification_attempts (
  id uuid primary key default gen_random_uuid(),
  race_id uuid references public.races(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  purpose text not null check (purpose in ('device_test', 'race')),
  check_kind text not null check (check_kind in ('selfie', 'official_id')),
  action text not null,
  request_nonce text not null unique,
  signal_hash text not null,
  environment text not null check (environment in ('sandbox', 'staging', 'production')),
  status text not null default 'pending' check (status in ('pending', 'verified', 'failed', 'expired')),
  credential_type text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  check ((purpose = 'device_test' and race_id is null) or (purpose = 'race' and race_id is not null))
);

create index if not exists world_verification_attempts_profile_recent
  on public.world_verification_attempts (profile_id, created_at desc);

create index if not exists world_verification_attempts_pending_expiry
  on public.world_verification_attempts (expires_at)
  where status = 'pending';

alter table public.world_verification_attempts enable row level security;
revoke all on table public.world_verification_attempts from anon, authenticated;
grant all on table public.world_verification_attempts to service_role;

alter table public.race_verifications
  drop constraint if exists race_verifications_environment_check;
alter table public.race_verifications
  add constraint race_verifications_environment_check
  check (environment in ('sandbox', 'staging', 'production', 'demo'));

create or replace function public.complete_world_verification(p_race_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  race_distance smallint;
  race_status text;
  ready_count integer;
begin
  select distance_km, status into race_distance, race_status
  from public.races
  where id = p_race_id and mode = 'strangers'
  for update;

  if not found or race_status <> 'verification' then
    return 'unavailable';
  end if;

  select count(*) into ready_count
  from public.race_participants
  where race_id = p_race_id and state = 'ready';

  if ready_count <> 2 then
    return 'verification';
  end if;

  if exists (
    select 1
    from public.race_participants participant
    where participant.race_id = p_race_id
      and participant.state = 'ready'
      and not exists (
        select 1 from public.race_verifications verification
        where verification.race_id = p_race_id
          and verification.profile_id = participant.profile_id
          and verification.check_kind = 'selfie'
          and verification.verified
      )
  ) then
    return 'verification';
  end if;

  if race_distance > 6 and exists (
    select 1
    from public.race_participants participant
    where participant.race_id = p_race_id
      and participant.state = 'ready'
      and not exists (
        select 1 from public.race_verifications verification
        where verification.race_id = p_race_id
          and verification.profile_id = participant.profile_id
          and verification.check_kind = 'official_id'
          and verification.verified
      )
  ) then
    return 'verification';
  end if;

  update public.races
  set status = 'countdown', scheduled_start_at = now() + interval '10 seconds'
  where id = p_race_id and status = 'verification';
  return 'countdown';
end;
$$;

revoke all on function public.complete_world_verification(uuid) from public, anon, authenticated;
grant execute on function public.complete_world_verification(uuid) to service_role;
