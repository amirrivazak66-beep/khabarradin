-- Run only after enabling pg_cron, pg_net, and Vault in the Supabase project.
-- Create Vault secrets first:
--   project_url     = https://gtbrkufbsllbosdyogfx.supabase.co
--   publishable_key = the project's publishable/anon key
-- Never put a service_role key in this file or browser code.

select cron.schedule(
  'radin-rss-ingest-every-15-min',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
      || '/functions/v1/rss-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{"trigger":"cron"}'::jsonb
  );
  $job$
);
