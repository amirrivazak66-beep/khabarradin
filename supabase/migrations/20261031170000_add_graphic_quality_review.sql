alter table public.news_items
  add column if not exists graphic_quality_status text,
  add column if not exists graphic_quality_score integer,
  add column if not exists graphic_quality_notes text;
