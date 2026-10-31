-- Bot publishing queue, editable Telegram captions, and action history.
alter table public.news_items
  add column if not exists scheduled_at timestamptz;

create index if not exists news_items_scheduled_queue_idx
  on public.news_items (scheduled_at)
  where published = false and scheduled_at is not null;

create table if not exists public.bot_activity (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.news_items(id) on delete set null,
  event_type text not null,
  actor text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists bot_activity_created_at_idx on public.bot_activity (created_at desc);
create index if not exists bot_activity_item_id_idx on public.bot_activity (item_id, created_at desc);

alter table public.bot_activity enable row level security;
drop policy if exists "Authenticated can read bot activity" on public.bot_activity;
create policy "Authenticated can read bot activity"
  on public.bot_activity for select to authenticated using (true);
drop policy if exists "Authenticated can record bot activity" on public.bot_activity;
create policy "Authenticated can record bot activity"
  on public.bot_activity for insert to authenticated with check (true);
