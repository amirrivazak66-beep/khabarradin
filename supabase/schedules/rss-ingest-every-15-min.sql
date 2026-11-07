-- Use the same Vault-backed credential as radin-automation-runner.
-- Required existing Vault secrets: radin_project_url, RADIN_CRON_SECRET.
-- The verifier RPC is executable only by service_role; rss-ingest calls it
-- internally. No service-role key or secret value belongs in this file.
-- Reusing the production job name updates the job rather than adding another.
select cron.schedule(
  'radin-rss-ingest-15min',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'radin_project_url')
      || '/functions/v1/rss-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-radin-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'RADIN_CRON_SECRET')
    ),
    body := '{"trigger":"cron"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);
