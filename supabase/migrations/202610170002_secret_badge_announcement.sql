-- One additional content-free own-account receipt. Ownership rules stay the same.
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';
alter table public.account_announcement_receipts drop constraint account_announcement_receipts_announcement_id_check;
alter table public.account_announcement_receipts add constraint account_announcement_receipts_announcement_id_check
  check(announcement_id in('free-study-groups-2026-10-07','social-launch-2026-10-15','join-study-group-2026-10-16','secret-six-seven-2026-10-17'));
alter policy "Record own announcement receipt" on public.account_announcement_receipts with check(
  user_id=(select auth.uid()) and (
    announcement_id in('free-study-groups-2026-10-07','join-study-group-2026-10-16','secret-six-seven-2026-10-17')
    or (announcement_id='social-launch-2026-10-15' and clock_timestamp()>='2026-10-15T10:10:00Z'::timestamptz)
  )
);
commit;
