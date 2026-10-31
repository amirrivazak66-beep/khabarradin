-- Check the independent scheduler every minute. Publication remains gated by bot_settings.auto_publish.
select cron.schedule(
  'radin-scheduled-publisher-every-minute',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://gtbrkufbsllbosdyogfx.supabase.co/functions/v1/radin-scheduled-publisher',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-radin-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='RADIN_CRON_SECRET' order by created_at desc limit 1)
    ),
    body := '{}'::jsonb
  );
  $job$
);
