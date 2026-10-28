alter table public.bot_settings
  add column if not exists rewrite_enabled boolean not null default true,
  add column if not exists image_mode text not null default 'template' check (image_mode in ('original','template','ai')),
  add column if not exists default_review_mode text not null default 'sensitive' check (default_review_mode in ('all','sensitive','none')),
  add column if not exists brand_voice text not null default 'خبر رادین: فارسی روان، دقیق، بی‌طرف در بازنویسی خبر، تیتر کوتاه و روشن؛ بدون افزودن ادعای تأییدنشده.',
  add column if not exists source_channel_username text not null default '@radinnews';

create table if not exists public.news_sources (
  id uuid primary key default gen_random_uuid(),
  source_type text not null default 'rss' check (source_type in ('rss','telegram','website')),
  name text not null,
  source_url text not null,
  category text not null default 'عمومی',
  enabled boolean not null default true,
  fetch_interval_minutes integer not null default 15 check (fetch_interval_minutes between 5 and 1440),
  include_images boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_type, source_url)
);

alter table public.news_items
  add column if not exists original_title text,
  add column if not exists original_summary text,
  add column if not exists rewritten_title text,
  add column if not exists rewritten_text text,
  add column if not exists original_image_url text,
  add column if not exists graphic_image_url text,
  add column if not exists source_type text not null default 'rss',
  add column if not exists sensitivity text not null default 'normal' check (sensitivity in ('normal','sensitive','high')),
  add column if not exists editorial_notes text,
  add column if not exists telegram_message_id bigint,
  add column if not exists processed_at timestamptz;

alter table public.news_sources enable row level security;
drop policy if exists "Admin manages news sources" on public.news_sources;
create policy "Admin manages news sources" on public.news_sources
 for all to authenticated
 using ((auth.jwt() ->> 'email') = 'amir.rivazak66@gmail.com')
 with check ((auth.jwt() ->> 'email') = 'amir.rivazak66@gmail.com');

drop policy if exists "Admin manages bot settings" on public.bot_settings;
create policy "Admin manages bot settings" on public.bot_settings
 for all to authenticated
 using ((auth.jwt() ->> 'email') = 'amir.rivazak66@gmail.com')
 with check ((auth.jwt() ->> 'email') = 'amir.rivazak66@gmail.com');
