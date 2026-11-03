alter policy "Authenticated admins manage news"
  on public.news_items
  using (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com')
  with check (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com');

alter policy "Admin manages bot settings"
  on public.bot_settings
  using (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com')
  with check (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com');

alter policy "Admin reads bot settings"
  on public.bot_settings
  using (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com');

alter policy "Admin updates bot settings"
  on public.bot_settings
  using (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com')
  with check (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com');

alter policy "Admin manages news sources"
  on public.news_sources
  using (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com')
  with check (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com');

alter policy "Only Radin admin can read bot activity"
  on public.bot_activity
  using (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com');
alter policy "Only Radin admin can record bot activity"
  on public.bot_activity
  with check (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com');

alter policy "Only Radin admin can manage RSS feeds"
  on public.rss_feeds
  using (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com')
  with check (((select auth.jwt()) ->> 'email') = 'amir.rivazak66@gmail.com');

create index if not exists news_items_telegram_chat_created_idx
  on public.news_items (telegram_chat_id, created_at desc)
  where telegram_chat_id is not null;
create index if not exists news_items_feed_id_idx
  on public.news_items (feed_id)
  where feed_id is not null;
