alter table public.news_items
  add column if not exists telegram_chat_id bigint,
  add column if not exists telegram_preview_message_id bigint;
