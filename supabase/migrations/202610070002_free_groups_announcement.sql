-- A private one-time receipt for the free study-groups announcement.
-- Apply after 202610070001_free_study_groups.sql. No profile, membership,
-- billing, entitlement or academic permissions are changed by this migration.
begin;

do $$
begin
  if to_regprocedure('public.xelay_free_groups_available()') is null then
    raise exception 'Apply 202610070001_free_study_groups before the free-groups announcement';
  end if;
end;
$$;

create table if not exists public.account_announcement_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  announcement_id text not null check (announcement_id = 'free-study-groups-2026-10-07'),
  seen_at timestamptz not null default clock_timestamp(),
  primary key (user_id, announcement_id)
);

alter table public.account_announcement_receipts enable row level security;
revoke all on public.account_announcement_receipts from public, anon, authenticated;
grant select (user_id, announcement_id) on public.account_announcement_receipts to authenticated;
grant insert (user_id, announcement_id) on public.account_announcement_receipts to authenticated;

drop policy if exists "Read own announcement receipt" on public.account_announcement_receipts;
create policy "Read own announcement receipt" on public.account_announcement_receipts
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Record own announcement receipt" on public.account_announcement_receipts;
create policy "Record own announcement receipt" on public.account_announcement_receipts
  for insert to authenticated with check (
    user_id = (select auth.uid()) and announcement_id = 'free-study-groups-2026-10-07'
  );

comment on table public.account_announcement_receipts is
  'Private immutable per-account receipt of a displayed free-groups announcement. No anonymous access, user updates/deletes, client timestamps or permission changes.';

commit;
