drop policy if exists "Admin reads bot settings" on public.bot_settings;
drop policy if exists "Admin updates bot settings" on public.bot_settings;

drop policy if exists "Authenticated admins manage news" on public.news_items;
alter policy "Public can read published news"
  on public.news_items
  using (
    (published = true and review_status = 'approved')
    or ((select auth.jwt()) ->> 'email' = 'amir.rivazak66@gmail.com')
  );
create policy "Radin admin can insert news"
  on public.news_items for insert to authenticated
  with check ((select auth.jwt()) ->> 'email' = 'amir.rivazak66@gmail.com');
create policy "Radin admin can update news"
  on public.news_items for update to authenticated
  using ((select auth.jwt()) ->> 'email' = 'amir.rivazak66@gmail.com')
  with check ((select auth.jwt()) ->> 'email' = 'amir.rivazak66@gmail.com');
create policy "Radin admin can delete news"
  on public.news_items for delete to authenticated
  using ((select auth.jwt()) ->> 'email' = 'amir.rivazak66@gmail.com');

drop policy if exists "Only Radin admin can manage RSS feeds" on public.rss_feeds;
create policy "Only Radin admin can insert RSS feeds"
  on public.rss_feeds for insert to authenticated
  with check ((select auth.jwt()) ->> 'email' = 'amir.rivazak66@gmail.com');
create policy "Only Radin admin can update RSS feeds"
  on public.rss_feeds for update to authenticated
  using ((select auth.jwt()) ->> 'email' = 'amir.rivazak66@gmail.com')
  with check ((select auth.jwt()) ->> 'email' = 'amir.rivazak66@gmail.com');
create policy "Only Radin admin can delete RSS feeds"
  on public.rss_feeds for delete to authenticated
  using ((select auth.jwt()) ->> 'email' = 'amir.rivazak66@gmail.com');
