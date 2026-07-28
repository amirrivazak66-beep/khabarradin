-- ============================================================================
-- خبر رادین — migration_002_news_items.sql
-- Run this in Supabase → SQL Editor. Safe to run once.
-- Adds per-feed settings (item count / update interval / include media)
-- and a news_items cache table so the public site never exposes the
-- original RSS source link to visitors.
-- ============================================================================

-- ---- 1. Extra settings on each RSS feed ----
alter table public.rss_feeds
  add column if not exists item_count integer not null default 5,
  add column if not exists update_interval_minutes integer not null default 60,
  add column if not exists include_media boolean not null default true;

-- ---- 2. News cache table (source of truth for the public site) ----
create table if not exists public.news_items (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid references public.rss_feeds(id) on delete set null,
  category text not null,
  title text not null,
  summary text,
  image_url text,
  source_url text,      -- internal only — never rendered on the public site
  source_name text,     -- internal only — never rendered on the public site
  pub_date timestamptz not null default now(),
  fetched_at timestamptz not null default now(),
  published boolean not null default true
);

alter table public.news_items enable row level security;

drop policy if exists "Public read published" on public.news_items;
create policy "Public read published"
  on public.news_items for select
  using (published = true);

drop policy if exists "Admin full access on news_items" on public.news_items;
create policy "Admin full access on news_items"
  on public.news_items for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Prevents the same article being imported twice across pulls.
-- (Postgres unique indexes treat NULLs as distinct, so manual items
-- without a source_url are unaffected.)
create unique index if not exists news_items_source_url_key
  on public.news_items (source_url);

create index if not exists news_items_category_idx on public.news_items (category);
create index if not exists news_items_pub_date_idx on public.news_items (pub_date desc);
