-- Reuse the private, content-free per-account announcement receipt.
-- No new tables or access to other accounts are added.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '15s';

alter table public.account_announcement_receipts
  drop constraint account_announcement_receipts_announcement_id_check;
alter table public.account_announcement_receipts
  add constraint account_announcement_receipts_announcement_id_check
  check (announcement_id in ('free-study-groups-2026-10-07', 'social-launch-2026-10-15'));

alter policy "Record own announcement receipt"
  on public.account_announcement_receipts
  with check (
    user_id = (select auth.uid()) and (
      announcement_id = 'free-study-groups-2026-10-07'
      or (announcement_id = 'social-launch-2026-10-15'
        and clock_timestamp() >= '2026-10-15T10:10:00Z'::timestamptz)
    )
  );

comment on table public.account_announcement_receipts is
  'Private immutable per-account receipts for displayed platform announcements. Only own SELECT/INSERT; no content, user updates/deletes, client timestamps or permission changes.';

-- The browser must verify server time before showing the scheduled notice.
-- This invoker function reads no data and exposes only a public launch flag.
create function public.xelay_social_launch_available()
returns boolean
language sql stable security invoker
set search_path = ''
as $$ select current_timestamp >= '2026-10-15T10:10:00Z'::timestamptz $$;
revoke all on function public.xelay_social_launch_available() from public, anon;
grant execute on function public.xelay_social_launch_available() to authenticated;

commit;
