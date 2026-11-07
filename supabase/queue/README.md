# Telegram processing and publication queues

Forwarded stories are persisted before the webhook enqueues a preview job. The
webhook responds without waiting for rendering. `radin-preview-queue` claims one
job in a short database transaction and renders it in an Edge background task.
A five-minute lease prevents concurrent queue renders and permits crash recovery.
Failures retry at most three times, then remain visible with a retry button. A
new request arriving during a leased job is kept for another pass. Successful
jobs wake the next invocation; a once-per-minute cron recovers missed wake-ups.

Publication is separate from processing. When auto publication is enabled,
ready administrator submissions enter the publication queue automatically.
Trial-user previews and videos require separate approval and are excluded.
Priority uses the latest `received` activity timestamp, falling back to creation
time, never the source article's publication date. Future slots are reused when
newer news takes priority; near-due jobs (two minutes) and in-flight publications
are preserved. Repeated refills do not postpone scheduled publication. The
configured queue limit bounds scheduled stories; older ready stories wait for
capacity and remain visible. Turning auto publication off prevents refills.

The Telegram queue screen includes scheduled, preparing, failed, and ready but
waiting stories. Enabling auto publication fills and displays the queue without
requiring a second manual fill action. Automatic newest-first priority replaces
the old up/down buttons.

## Rollout

This change has NOT been applied to production by committing these files.

1. Capture the existing webhook/graphics function versions and active cron job
   metadata. Keep `rss-ingest` unchanged (its separate PR is unrelated).
2. Apply `preview-jobs.sql` with the hosted Supabase migration tool using name
   `durable_telegram_preview_queue`. Record the server-generated migration
   version in migration history; do not invent a timestamped migration filename.
   CLI attempts in the preparation environment failed before file generation.
3. Deploy `radin-graphic-worker` with its existing deno.json and authentication
   settings, then deploy `radin-preview-queue` (verify_jwt=false; internal
   credentials or the service-role-only Vault verifier authenticate requests).
4. Deploy `radin-telegram-webhook` with its existing deno.json and authentication
   settings.
5. Apply `../schedules/preview-queue-every-minute.sql`. The existing Vault names
   are `radin_project_url` and `RADIN_CRON_SECRET`; never copy their values into
   source or chat.
6. Run security advisors and check the new table's grants/RLS. Verify unauthorized
   calls return 401, idle cron calls succeed, and function versions match source.
7. With the owner's approval, test several real forwarded stories. Verify quick
   acknowledgements, one active rendering job, all previews delivered, correct
   newest-first publication order, and the configured interval/capacity.

**Production behavior:** auto publication is already enabled in the inspected
project. Activating the new cron can schedule existing ready administrator news
and eventually publish it through the existing scheduled publisher. Include this
in rollout approval; do not turn the cron on as a test using real stories.

## Validation

With Node 24+, run `npm ci --prefix tests`, then `npm test --prefix tests`.
The database test uses pinned PGlite PostgreSQL with synthetic rows and roles.
No tests send production Telegram messages, publish news, or modify production
rows. Unit tests cover quick acknowledgements, durable enqueuing, failed wake-up,
lease ownership, retries, renderer authorization, queue display and enablement.
Database tests cover latest-first processing, new-request preservation, stale
leases, bounded retries, stable time slots, new-story priority, near-due safety,
capacity, administrator-only scheduling and anonymous access denial.

## Rollback

Disable `radin-preview-queue-every-minute` first. Restore the captured webhook
and graphics versions. Leave the processing table intact to preserve queued
work for recovery. Restore the previous source for publication queue controls.
Do not drop tables or clear existing publication schedules as a rollback shortcut.
