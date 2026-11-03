create table if not exists public.telegram_access_requests (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null references public.telegram_trial_accounts(telegram_user_id) on delete cascade,
  chat_id bigint not null,
  requested_minutes integer not null default 60 check (requested_minutes = 60),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by bigint,
  decision_reason text,
  constraint telegram_access_request_decision_check check (
    (status = 'pending' and decided_at is null and decided_by is null)
    or (status in ('approved', 'rejected') and decided_at is not null and decided_by is not null)
  )
);
create unique index if not exists telegram_access_one_pending_request_per_user
  on public.telegram_access_requests (telegram_user_id) where status = 'pending';
create index if not exists telegram_access_requests_created_at_idx
  on public.telegram_access_requests (created_at desc);

create table if not exists public.telegram_access_grants (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null references public.telegram_trial_accounts(telegram_user_id) on delete cascade,
  chat_id bigint not null,
  request_id uuid unique references public.telegram_access_requests(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by bigint not null,
  revoked_at timestamptz,
  revoked_by bigint,
  revoke_reason text,
  constraint telegram_access_grant_expiry_check check (expires_at > starts_at),
  constraint telegram_access_grant_revoke_check check (
    (status = 'active' and revoked_at is null and revoked_by is null)
    or (status = 'revoked' and revoked_at is not null and revoked_by is not null)
  )
);
create index if not exists telegram_access_grants_user_expiry_idx
  on public.telegram_access_grants (telegram_user_id, expires_at desc);
create index if not exists telegram_access_grants_active_expiry_idx
  on public.telegram_access_grants (expires_at) where status = 'active';

create table if not exists public.telegram_security_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id bigint,
  subject_user_id bigint,
  event_type text not null check (event_type in (
    'session_started',
    'access_request_created',
    'admin_denied',
    'request_approved',
    'request_rejected',
    'grant_revoked'
  )),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists telegram_security_events_created_at_idx
  on public.telegram_security_events (created_at desc);
create index if not exists telegram_security_events_subject_idx
  on public.telegram_security_events (subject_user_id, created_at desc);

alter table public.telegram_access_requests enable row level security;
alter table public.telegram_access_grants enable row level security;
alter table public.telegram_security_events enable row level security;

revoke all on table public.telegram_access_requests from public, anon, authenticated;
revoke all on table public.telegram_access_grants from public, anon, authenticated;
revoke all on table public.telegram_security_events from public, anon, authenticated;
grant all privileges on table public.telegram_access_requests to service_role;
grant all privileges on table public.telegram_access_grants to service_role;
grant all privileges on table public.telegram_security_events to service_role;

drop policy if exists "Telegram access requests service role only" on public.telegram_access_requests;
create policy "Telegram access requests service role only"
  on public.telegram_access_requests for all to service_role using (true) with check (true);
drop policy if exists "Telegram access grants service role only" on public.telegram_access_grants;
create policy "Telegram access grants service role only"
  on public.telegram_access_grants for all to service_role using (true) with check (true);
drop policy if exists "Telegram security events service role only" on public.telegram_security_events;
create policy "Telegram security events service role only"
  on public.telegram_security_events for all to service_role using (true) with check (true);

create or replace function public.decide_telegram_access_request(
  p_request_id uuid,
  p_admin_user_id bigint,
  p_approved boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request public.telegram_access_requests%rowtype;
  v_grant_id uuid;
  v_expires_at timestamptz;
  v_reason text;
begin
  select * into v_request
  from public.telegram_access_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Access request not found';
  end if;
  if v_request.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'Access request is no longer pending';
  end if;

  v_reason := nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_reason, '')), 240), '');

  if p_approved then
    if exists (
      select 1 from public.telegram_trial_accounts a
      where a.telegram_user_id = v_request.telegram_user_id
        and a.phone_verified_at is not null
        and a.trial_expires_at > pg_catalog.clock_timestamp()
    ) then
      raise exception using errcode = 'P0001', message = 'User already has an active trial';
    end if;
    if exists (
      select 1 from public.telegram_access_grants g
      where g.telegram_user_id = v_request.telegram_user_id
        and g.status = 'active'
        and g.expires_at > pg_catalog.clock_timestamp()
    ) then
      raise exception using errcode = 'P0001', message = 'User already has active access';
    end if;

    v_expires_at := pg_catalog.clock_timestamp() + interval '1 hour';
    insert into public.telegram_access_grants (
      telegram_user_id, chat_id, request_id, expires_at, created_by
    ) values (
      v_request.telegram_user_id, v_request.chat_id, v_request.id, v_expires_at, p_admin_user_id
    ) returning id into v_grant_id;

    update public.telegram_access_requests
    set status = 'approved', decided_at = pg_catalog.clock_timestamp(),
        decided_by = p_admin_user_id, decision_reason = v_reason
    where id = v_request.id;

    insert into public.telegram_security_events (
      actor_user_id, subject_user_id, event_type, details
    ) values (
      p_admin_user_id, v_request.telegram_user_id, 'request_approved',
      pg_catalog.jsonb_build_object('request_id', v_request.id, 'grant_id', v_grant_id, 'expires_at', v_expires_at)
    );
    return pg_catalog.jsonb_build_object('grant_id', v_grant_id, 'expires_at', v_expires_at);
  end if;

  update public.telegram_access_requests
  set status = 'rejected', decided_at = pg_catalog.clock_timestamp(),
      decided_by = p_admin_user_id, decision_reason = v_reason
  where id = v_request.id;

  insert into public.telegram_security_events (
    actor_user_id, subject_user_id, event_type, details
  ) values (
    p_admin_user_id, v_request.telegram_user_id, 'request_rejected',
    pg_catalog.jsonb_build_object('request_id', v_request.id, 'reason', v_reason)
  );
  return pg_catalog.jsonb_build_object('rejected', true);
end;
$$;

create or replace function public.revoke_telegram_access_grant(
  p_grant_id uuid,
  p_admin_user_id bigint,
  p_reason text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_subject_user_id bigint;
  v_reason text;
begin
  v_reason := nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_reason, '')), 240), '');
  update public.telegram_access_grants
  set status = 'revoked', revoked_at = pg_catalog.clock_timestamp(),
      revoked_by = p_admin_user_id, revoke_reason = v_reason
  where id = p_grant_id and status = 'active'
  returning telegram_user_id into v_subject_user_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Active access grant not found';
  end if;

  insert into public.telegram_security_events (
    actor_user_id, subject_user_id, event_type, details
  ) values (
    p_admin_user_id, v_subject_user_id, 'grant_revoked',
    pg_catalog.jsonb_build_object('grant_id', p_grant_id, 'reason', v_reason)
  );
  return true;
end;
$$;

revoke all on function public.decide_telegram_access_request(uuid, bigint, boolean, text) from public, anon, authenticated;
revoke all on function public.revoke_telegram_access_grant(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.decide_telegram_access_request(uuid, bigint, boolean, text) to service_role;
grant execute on function public.revoke_telegram_access_grant(uuid, bigint, text) to service_role;

drop policy if exists "Authenticated can read bot activity" on public.bot_activity;
drop policy if exists "Authenticated can record bot activity" on public.bot_activity;
create policy "Only Radin admin can read bot activity"
  on public.bot_activity for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'amir.rivazak66@gmail.com');
create policy "Only Radin admin can record bot activity"
  on public.bot_activity for insert to authenticated
  with check ((select auth.jwt() ->> 'email') = 'amir.rivazak66@gmail.com');

drop policy if exists "Authenticated write access" on public.rss_feeds;
create policy "Only Radin admin can manage RSS feeds"
  on public.rss_feeds for all to authenticated
  using ((select auth.jwt() ->> 'email') = 'amir.rivazak66@gmail.com')
  with check ((select auth.jwt() ->> 'email') = 'amir.rivazak66@gmail.com');
