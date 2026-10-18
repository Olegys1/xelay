-- Public community total only. Individual pickups, accounts and rewards stay
-- private under the existing table permissions; collecting/rewards are unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$ begin
  if to_regclass('public.halloween_2026_collections') is null then
    raise exception 'HALLOWEEN_COMMUNITY_TOTAL_PREREQUISITES_MISSING';
  end if;
end $$;

create or replace function public.xelay_halloween_community_total()
returns bigint language sql stable security definer set search_path='' as $$
  -- The existing (user_id,pumpkin_id) primary key already excludes repeat
  -- pickups. COUNT returns a nonnegative bigint, including zero for no rows.
  select pg_catalog.count(*) from public.halloween_2026_collections;
$$;
revoke all on function public.xelay_halloween_community_total()
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_halloween_community_total() to anon,authenticated;

notify pgrst,'reload schema';
commit;
