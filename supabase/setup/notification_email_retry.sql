-- Run in Supabase SQL Editor after 202610070008_notification_email_unread.sql.
-- First enable pg_cron + pg_net and create these secrets using Vault's UI:
--   xelay_public_url               = https://www.xelay.ink
--   xelay_notification_webhook_secret = same NOTIFICATION_WEBHOOK_SECRET as Vercel
-- Do not put the secret value into this file or commit it.

begin;

do $$
declare
  v_origin text;
  v_secret text;
begin
  if to_regclass('public.notification_email_outbox') is null then
    raise exception 'Apply the notification/email migration first';
  end if;
  if to_regprocedure('public.xelay_notification_email_worker_heartbeat()') is null then
    raise exception 'Apply 202610070008_notification_email_unread.sql first';
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regclass('cron.job') is null then
    raise exception 'Enable Supabase Vault and pg_cron first';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'Enable pg_net first';
  end if;
  select decrypted_secret into v_origin from vault.decrypted_secrets where name = 'xelay_public_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'xelay_notification_webhook_secret';
  if v_origin is null or v_origin !~ '^https://[A-Za-z0-9.-]+(:443)?/?$' then
    raise exception 'Set xelay_public_url in Vault to the HTTPS production origin';
  end if;
  if v_secret is null or length(v_secret) < 32 or v_secret ~ '\s' then
    raise exception 'Set a 32+ character webhook secret in Vault';
  end if;
end;
$$;

-- Naming the job makes re-running this setup update the same scheduled job.
select cron.schedule(
  'xelay-notification-email-retry',
  '* * * * *',
  $task$
    select net.http_post(
      url := rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'xelay_public_url'), '/') || '/api/notifications/retry',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'xelay_notification_webhook_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    ) as request_id;
  $task$
);

commit;
