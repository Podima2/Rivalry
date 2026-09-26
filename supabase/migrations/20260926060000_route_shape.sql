alter table public.race_participants
  add column route_shape text not null default 'loop'
  check (route_shape in ('loop', 'out_and_back'));
