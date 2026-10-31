create table if not exists public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.news_items(id) on delete set null,
  created_at timestamptz not null default now(),
  provider text not null,
  model text not null,
  task text not null,
  status text not null,
  input_tokens integer,
  output_tokens integer,
  image_input_tokens integer,
  image_output_tokens integer,
  estimated_cost_usd numeric(14,8),
  cost_known boolean not null default false,
  rate_snapshot jsonb not null default '{}'::jsonb,
  raw_usage jsonb
);
alter table public.ai_usage_events enable row level security;
revoke all on table public.ai_usage_events from anon, authenticated;
grant all on table public.ai_usage_events to service_role;
create index if not exists ai_usage_events_created_at_idx on public.ai_usage_events (created_at desc);
create index if not exists ai_usage_events_item_id_idx on public.ai_usage_events (item_id);
