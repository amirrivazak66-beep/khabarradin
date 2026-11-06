-- Require a verified allowlisted administrator session to complete the
-- second factor before protected web-admin data can be read or changed.
create or replace function private.is_allowlisted_web_admin_aal2()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      (select auth.jwt() ->> 'aal') = 'aal2'
      and exists (
        select 1
        from auth.users u
        where u.id = (select auth.uid())
          and u.email_confirmed_at is not null
          and lower(u.email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))
      )
      and exists (
        select 1
        from public.web_admin_emails a
        where a.email = lower(coalesce((select auth.jwt() ->> 'email'), ''))
          and a.active
      )
    ),
    false
  );
$$;

revoke all on function private.is_allowlisted_web_admin_aal2() from public, anon, authenticated;
grant execute on function private.is_allowlisted_web_admin_aal2() to anon, authenticated;
