-- Apply after the migration and radin-preview-queue deployment.
-- Vault references only; never include secret values in this file.
select cron.schedule('radin-preview-queue-every-minute','* * * * *',$job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='radin_project_url') || '/functions/v1/radin-preview-queue',
    headers := jsonb_build_object('Content-Type','application/json','x-radin-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='RADIN_CRON_SECRET')),
    body := '{}'::jsonb,timeout_milliseconds := 15000
  );
$job$);
