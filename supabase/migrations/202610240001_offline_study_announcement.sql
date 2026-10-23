-- One content-free own-account receipt for the small homepage offline notice.
-- Preserve the live allowlist and all existing policy branches verbatim.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '15s';
lock table public.account_announcement_receipts in access exclusive mode;

do $migration$
declare
  existing_check text;
  existing_insert_check text;
begin
  select pg_get_expr(c.conbin, c.conrelid) into strict existing_check
  from pg_constraint c
  where c.conrelid = 'public.account_announcement_receipts'::regclass
    and c.conname = 'account_announcement_receipts_announcement_id_check'
    and c.contype = 'c';

  select pg_get_expr(p.polwithcheck, p.polrelid) into strict existing_insert_check
  from pg_policy p
  where p.polrelid = 'public.account_announcement_receipts'::regclass
    and p.polname = 'Record own announcement receipt'
    and p.polcmd = 'a'
    and p.polpermissive
    and (select oid from pg_roles where rolname = 'authenticated') = any(p.polroles);

  if existing_check is null or existing_insert_check is null then
    raise exception 'Existing announcement receipt ownership rules are missing';
  end if;

  if position('offline-study-2026-10-24' in existing_check) = 0 then
    alter table public.account_announcement_receipts
      drop constraint account_announcement_receipts_announcement_id_check;
    execute format('alter table public.account_announcement_receipts add constraint account_announcement_receipts_announcement_id_check check ((%s) or announcement_id = %L)',
      existing_check, 'offline-study-2026-10-24');
  end if;

  if position('offline-study-2026-10-24' in existing_insert_check) = 0 then
    execute format('alter policy %I on public.account_announcement_receipts with check ((%s) or (user_id = (select auth.uid()) and announcement_id = %L))',
      'Record own announcement receipt', existing_insert_check, 'offline-study-2026-10-24');
  end if;
end
$migration$;

commit;
