ALTER TABLE public.news_items
  ADD COLUMN IF NOT EXISTS telegram_translation_language text
    CHECK (telegram_translation_language IN ('ar', 'en'));

ALTER TABLE public.news_items
  ADD COLUMN IF NOT EXISTS telegram_generate_graphic boolean NOT NULL DEFAULT true;
