alter table public.bot_settings
  add column if not exists schedule_interval_minutes integer not null default 60
    check (schedule_interval_minutes between 5 and 1440),
  add column if not exists queue_limit integer not null default 10
    check (queue_limit between 1 and 50);
