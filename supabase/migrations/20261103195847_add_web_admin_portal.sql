create table if not exists public.web_admin_emails (
  email text primary key,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint web_admin_emails_normalized check (
    email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  )
);

alter table public.web_admin_emails enable row level security;
revoke all on table public.web_admin_emails from public, anon, authenticated;
grant all privileges on table public.web_admin_emails to service_role;
drop policy if exists "Web admins service role only" on public.web_admin_emails;
create policy "Web admins service role only" on public.web_admin_emails
  for all to service_role using (true) with check (true);

-- Provision administrator allowlist entries privately in Supabase SQL Editor; never commit personal email addresses.

alter table public.telegram_access_requests
  add column if not exists decided_by_web_email text;
alter table public.telegram_access_requests
  drop constraint if exists telegram_access_request_decision_check;
alter table public.telegram_access_requests
  add constraint telegram_access_request_decision_check check (
    (status = 'pending' and decided_at is null and decided_by is null and decided_by_web_email is null)
    or (
      status in ('approved', 'rejected') and decided_at is not null and
      ((decided_by is not null and decided_by_web_email is null)
        or (decided_by is null and decided_by_web_email is not null))
    )
  );

alter table public.telegram_access_grants
  add column if not exists created_by_web_email text,
  add column if not exists revoked_by_web_email text;
alter table public.telegram_access_grants alter column created_by drop not null;
alter table public.telegram_access_grants
  drop constraint if exists telegram_access_grant_revoke_check;
alter table public.telegram_access_grants
  add constraint telegram_access_grant_revoke_check check (
    (status = 'active' and revoked_at is null and revoked_by is null and revoked_by_web_email is null)
    or (
      status = 'revoked' and revoked_at is not null and
      ((revoked_by is not null and revoked_by_web_email is null)
        or (revoked_by is null and revoked_by_web_email is not null))
    )
  );
alter table public.telegram_access_grants
  add constraint telegram_access_grant_created_by_check check (
    (created_by is not null) <> (created_by_web_email is not null)
  );

create or replace function public.decide_telegram_access_request_web(
  p_request_id uuid,
  p_admin_email text,
  p_approved boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_admin_email, '')));
  v_result jsonb;
  v_grant_id uuid;
begin
  if not exists (
    select 1 from public.web_admin_emails a where a.email = v_email and a.active
  ) then
    raise exception using errcode = '42501', message = 'Web admin not authorized';
  end if;

  v_result := public.decide_telegram_access_request(p_request_id, 0, p_approved, p_reason);
  update public.telegram_access_requests
  set decided_by = null, decided_by_web_email = v_email
  where id = p_request_id;

  if p_approved then
    v_grant_id := (v_result ->> 'grant_id')::uuid;
    update public.telegram_access_grants
    set created_by = null, created_by_web_email = v_email
    where id = v_grant_id;
  end if;

  update public.telegram_security_events
  set actor_user_id = null,
      details = details || pg_catalog.jsonb_build_object('web_admin_email', v_email)
  where event_type = case when p_approved then 'request_approved' else 'request_rejected' end
    and details ->> 'request_id' = p_request_id::text
    and actor_user_id = 0;

  return v_result;
end;
$$;

create or replace function public.revoke_telegram_access_grant_web(
  p_grant_id uuid,
  p_admin_email text,
  p_reason text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_admin_email, '')));
  v_result boolean;
begin
  if not exists (
    select 1 from public.web_admin_emails a where a.email = v_email and a.active
  ) then
    raise exception using errcode = '42501', message = 'Web admin not authorized';
  end if;

  v_result := public.revoke_telegram_access_grant(p_grant_id, 0, p_reason);
  update public.telegram_access_grants
  set revoked_by = null, revoked_by_web_email = v_email
  where id = p_grant_id;
  update public.telegram_security_events
  set actor_user_id = null,
      details = details || pg_catalog.jsonb_build_object('web_admin_email', v_email)
  where event_type = 'grant_revoked'
    and details ->> 'grant_id' = p_grant_id::text
    and actor_user_id = 0;

  return v_result;
end;
$$;

revoke all on function public.decide_telegram_access_request_web(uuid, text, boolean, text) from public, anon, authenticated;
revoke all on function public.revoke_telegram_access_grant_web(uuid, text, text) from public, anon, authenticated;
grant execute on function public.decide_telegram_access_request_web(uuid, text, boolean, text) to service_role;
grant execute on function public.revoke_telegram_access_grant_web(uuid, text, text) to service_role;



