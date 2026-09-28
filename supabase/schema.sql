-- ═══════════════════════════════════════════════════════════════════
-- Orbit — database setup. Paste into Supabase → SQL Editor → Run.
-- Safe to run in an existing project: every object is prefixed "orbit_".
-- ═══════════════════════════════════════════════════════════════════

-- 1. Links (one row per URL; the schedule lives on the link)
create table if not exists public.orbit_links (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 80),
  url           text not null,
  position      int  not null default 0,
  schedule      jsonb,                 -- see schedule-core.js for the shape
  next_run_at   timestamptz,           -- when the next reminder is due (null = off)
  pending_count int  not null default 0, -- reminders fired since you last opened it
  last_sent_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists orbit_links_due on public.orbit_links (next_run_at) where next_run_at is not null;
create index if not exists orbit_links_user on public.orbit_links (user_id, position);

-- 2. Push subscriptions (one row per device/browser you enable alerts on)
create table if not exists public.orbit_push_subs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  device     text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);

-- 3. Keep updated_at fresh
create or replace function public.orbit_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists orbit_links_touch on public.orbit_links;
create trigger orbit_links_touch before update on public.orbit_links
  for each row execute function public.orbit_touch();

-- 4. Row-level security: you only ever see your own rows
alter table public.orbit_links     enable row level security;
alter table public.orbit_push_subs enable row level security;

drop policy if exists "own links" on public.orbit_links;
create policy "own links" on public.orbit_links
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own subs" on public.orbit_push_subs;
create policy "own subs" on public.orbit_push_subs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 5. Live sync between devices
do $$ begin
  alter publication supabase_realtime add table public.orbit_links;
exception when duplicate_object then null; end $$;

-- 6. The heartbeat: every minute, ask the send-due function to fire whatever is due.
--    Project URL and cron secret are pre-filled; if you use a different Supabase project, change the URL below.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('orbit-send-due')
where exists (select 1 from cron.job where jobname = 'orbit-send-due');

select cron.schedule(
  'orbit-send-due',
  '* * * * *',
  $cron$
  select net.http_post(
    url     := 'https://semwmaqblicvgxmxhwqm.supabase.co/functions/v1/send-due',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-orbit-cron', 'b064c9ff784a1ac7e248cc9e29a75a8eef7a8c3a6a18c3fe'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $cron$
);
