create table if not exists public.telegram_trial_accounts (
  telegram_user_id bigint primary key,
  chat_id bigint not null,
  first_name text,
  last_name text,
  username text,
  registration_source text not null default 'telegram'
    check (registration_source in ('site', 'telegram')),
  consent_at timestamptz not null,
  phone_fingerprint text unique,
  phone_verified_at timestamptz,
  trial_started_at timestamptz,
  trial_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_trial_verification_window_check check (
    (phone_verified_at is null and trial_started_at is null and trial_expires_at is null)
    or
    (phone_verified_at is not null and trial_started_at is not null and trial_expires_at > trial_started_at)
  )
);
create index if not exists telegram_trial_accounts_chat_id_idx
  on public.telegram_trial_accounts (chat_id);
alter table public.telegram_trial_accounts enable row level security;
revoke all on table public.telegram_trial_accounts from public, anon, authenticated;
grant select, insert, update on table public.telegram_trial_accounts to service_role;
comment on table public.telegram_trial_accounts is
  'Telegram registration consent, verified-phone fingerprint, and one-time 24-hour trial; accessed only by Edge Functions using service_role.';
comment on column public.telegram_trial_accounts.phone_fingerprint is
  'HMAC-SHA-256 fingerprint of the normalized Telegram contact phone; raw phone number is not stored.';