-- Let runners keep refining a route during review. Preserve the generation
-- count for observability without imposing a per-race application limit.
alter table public.race_participants
  drop constraint if exists race_participants_route_generation_count_check;

alter table public.race_participants
  alter column route_generation_count type integer;

alter table public.race_participants
  add constraint race_participants_route_generation_count_nonnegative
  check (route_generation_count >= 0);

create or replace function public.claim_route_preview_generation(
  p_race_id uuid,
  p_profile_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  update public.race_participants
  set route_generation_count = route_generation_count + 1
  where race_id = p_race_id
    and profile_id = p_profile_id;

  return found;
end;
$$;

revoke all on function public.claim_route_preview_generation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_route_preview_generation(uuid, uuid) to service_role;
