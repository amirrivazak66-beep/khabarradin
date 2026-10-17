-- Radin News: secure RSS ingestion schema and read policies
-- Idempotent bootstrap. Existing content is preserved.
create extension if not exists pgcrypto;

create table if not exists public.rss_feeds (
  id uuid primary key default gen_random_uuid(),
  category text not null default 'عمومی',
  url text not null unique,
  item_count integer not null default 10 check (item_count between 1 and 50),
  update_interval_minutes integer not null default 15 check (update_interval_minutes between 5 and 1440),
  include_media boolean not null default true,
  enabled boolean not null default true,
  last_fetched_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

alter table public.rss_feeds add column if not exists enabled boolean not null default true;
alter table public.rss_feeds add column if not exists last_fetched_at timestamptz;
alter table public.rss_feeds add column if not exists last_error text;

create table if not exists public.news_items (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid references public.rss_feeds(id) on delete set null,
  category text not null default 'عمومی',
  title text not null,
  summary text,
  image_url text,
  source_url text not null unique,
  source_name text,
  pub_date timestamptz not null default now(),
  published boolean not null default false,
  review_status text not null default 'pending' check (review_status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.news_items add column if not exists review_status text not null default 'pending';
alter table public.news_items add column if not exists updated_at timestamptz not null default now();
alter table public.news_items add column if not exists feed_id uuid references public.rss_feeds(id) on delete set null;
create unique index if not exists news_items_source_url_uidx on public.news_items(source_url);
create index if not exists news_items_published_date_idx on public.news_items(published, pub_date desc);
create index if not exists news_items_review_status_idx on public.news_items(review_status, created_at desc);

alter table public.rss_feeds enable row level security;
alter table public.news_items enable row level security;

drop policy if exists "Public can read enabled RSS feeds" on public.rss_feeds;
create policy "Public can read enabled RSS feeds"
  on public.rss_feeds for select to anon, authenticated
  using (enabled = true);

drop policy if exists "Public can read published news" on public.news_items;
create policy "Public can read published news"
  on public.news_items for select to anon, authenticated
  using (published = true and review_status = 'approved');

-- No public insert/update/delete policies: writes are performed by trusted server-side code.
grant select on public.rss_feeds to anon, authenticated;
grant select on public.news_items to anon, authenticated;
