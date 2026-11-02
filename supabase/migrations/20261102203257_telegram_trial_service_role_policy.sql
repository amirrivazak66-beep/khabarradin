create policy "Telegram trial accounts service role access"
on public.telegram_trial_accounts
for all
to service_role
using (true)
with check (true);