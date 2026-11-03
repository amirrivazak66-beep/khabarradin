create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create or replace function private.is_allowlisted_web_admin_aal2()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal') = 'aal2', false)
    and exists (
      select 1
      from public.web_admin_emails a
      where a.email = lower(coalesce((select auth.jwt() ->> 'email'), ''))
        and a.active
    );
$$;
revoke all on function private.is_allowlisted_web_admin_aal2() from public, anon, authenticated;
grant execute on function private.is_allowlisted_web_admin_aal2() to anon, authenticated;

drop policy if exists "Only Radin admin can read bot activity" on public.bot_activity;
drop policy if exists "Only Radin admin can record bot activity" on public.bot_activity;
create policy "AAL2 web admins can read bot activity" on public.bot_activity
  for select to authenticated using (private.is_allowlisted_web_admin_aal2());
create policy "AAL2 web admins can record bot activity" on public.bot_activity
  for insert to authenticated with check (private.is_allowlisted_web_admin_aal2());

drop policy if exists "Admin manages bot settings" on public.bot_settings;
create policy "AAL2 web admins manage bot settings" on public.bot_settings
  for all to authenticated
  using (private.is_allowlisted_web_admin_aal2())
  with check (private.is_allowlisted_web_admin_aal2());

drop policy if exists "Public can read published news" on public.news_items;
drop policy if exists "Radin admin can delete news" on public.news_items;
drop policy if exists "Radin admin can insert news" on public.news_items;
drop policy if exists "Radin admin can update news" on public.news_items;
create policy "Public reads approved news and AAL2 admins read all" on public.news_items
  for select to anon, authenticated
  using ((published = true and review_status = 'approved') or private.is_allowlisted_web_admin_aal2());
create policy "AAL2 web admins can delete news" on public.news_items
  for delete to authenticated using (private.is_allowlisted_web_admin_aal2());
create policy "AAL2 web admins can insert news" on public.news_items
  for insert to authenticated with check (private.is_allowlisted_web_admin_aal2());
create policy "AAL2 web admins can update news" on public.news_items
  for update to authenticated
  using (private.is_allowlisted_web_admin_aal2())
  with check (private.is_allowlisted_web_admin_aal2());

drop policy if exists "Admin manages news sources" on public.news_sources;
create policy "AAL2 web admins manage news sources" on public.news_sources
  for all to authenticated
  using (private.is_allowlisted_web_admin_aal2())
  with check (private.is_allowlisted_web_admin_aal2());

drop policy if exists "Only Radin admin can delete RSS feeds" on public.rss_feeds;
drop policy if exists "Only Radin admin can insert RSS feeds" on public.rss_feeds;
drop policy if exists "Only Radin admin can update RSS feeds" on public.rss_feeds;
create policy "AAL2 web admins can delete RSS feeds" on public.rss_feeds
  for delete to authenticated using (private.is_allowlisted_web_admin_aal2());
create policy "AAL2 web admins can insert RSS feeds" on public.rss_feeds
  for insert to authenticated with check (private.is_allowlisted_web_admin_aal2());
create policy "AAL2 web admins can update RSS feeds" on public.rss_feeds
  for update to authenticated
  using (private.is_allowlisted_web_admin_aal2())
  with check (private.is_allowlisted_web_admin_aal2());
create policy "AAL2 web admins can read all RSS feeds" on public.rss_feeds
  for select to authenticated using (private.is_allowlisted_web_admin_aal2());

drop policy if exists "Authenticated users update Radin graphics" on storage.objects;
drop policy if exists "Authenticated users upload Radin graphics" on storage.objects;
create policy "AAL2 web admins update Radin graphics" on storage.objects
  for update to authenticated
  using (bucket_id = 'radin-graphics' and private.is_allowlisted_web_admin_aal2())
  with check (bucket_id = 'radin-graphics' and private.is_allowlisted_web_admin_aal2());
create policy "AAL2 web admins upload Radin graphics" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'radin-graphics' and private.is_allowlisted_web_admin_aal2());

drop function if exists public.is_allowlisted_web_admin_aal2();