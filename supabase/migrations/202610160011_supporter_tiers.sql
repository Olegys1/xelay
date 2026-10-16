-- Cumulative support tiers. Public callers receive only 0..5; exact lifetime
-- totals stay server-only and the existing private order policies stay intact.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$ begin
  if to_regclass('public.support_orders') is null
    or to_regprocedure('public.xelay_supporter_badge(uuid)') is null then
    raise exception 'Apply the existing team-support migration first';
  end if;
end $$;

create function public.xelay_private_supporter_tier(p_total bigint)
returns smallint language sql immutable security invoker set search_path='' as $$
  select case when p_total>=100000 then 5 when p_total>=50000 then 4
    when p_total>=25000 then 3 when p_total>=10000 then 2
    when p_total>=100 then 1 else 0 end::smallint;
$$;

create function public.xelay_supporter_tier(p_user_id uuid)
returns smallint language sql stable security definer set search_path='' as $$
  select public.xelay_private_supporter_tier(coalesce(sum(o.amount_kopiykas),0))
  from public.support_orders o where o.user_id=p_user_id and o.mode='live' and o.status='approved';
$$;

create function public.xelay_supporter_summary(p_user_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('tier',public.xelay_private_supporter_tier(coalesce(sum(o.amount_kopiykas),0)),
    'totalKopiykas',coalesce(sum(o.amount_kopiykas),0))
  from public.support_orders o where o.user_id=p_user_id and o.mode='live' and o.status='approved';
$$;

revoke all on function public.xelay_private_supporter_tier(bigint),public.xelay_supporter_tier(uuid),
  public.xelay_supporter_summary(uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_supporter_tier(uuid) to anon,authenticated,service_role;
grant execute on function public.xelay_supporter_summary(uuid) to service_role;

comment on function public.xelay_supporter_tier(uuid) is
  'Public support level 0..5 from cumulative approved LIVE orders. No exact total, history, payment dates or entitlements.';
comment on function public.xelay_supporter_summary(uuid) is
  'Server-only lifetime support total and tier. The billing endpoint returns it only to the authenticated owner.';
commit;
