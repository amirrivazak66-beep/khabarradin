alter table public.news_items
  add column if not exists telegram_edit_type text,
  add column if not exists telegram_edit_user_id bigint,
  add column if not exists telegram_edit_prompt_message_id bigint,
  add column if not exists telegram_edit_requested_at timestamptz,
  add column if not exists telegram_headline_edited boolean not null default false,
  add column if not exists telegram_caption_edited boolean not null default false;
