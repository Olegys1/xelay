-- Additional earned badge for one exactly-67-UAH approved LIVE order.
-- No payment rows, policies, table grants or provider functions are changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$ begin
  if to_regprocedure('public.xelay_supporter_tier(uuid)') is null
    or to_regprocedure('public.xelay_supporter_summary(uuid)') is null then
    raise exception 'Apply cumulative supporter tiers first';
  end if;
end $$;

create function public.xelay_supporter_badges(p_user_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'tier',public.xelay_private_supporter_tier(coalesce(sum(o.amount_kopiykas),0)),
    'sixSeven',coalesce(bool_or(o.amount_kopiykas=6700),false))
  from public.support_orders o
  where o.user_id=p_user_id and o.mode='live' and o.status='approved';
$$;

create or replace function public.xelay_supporter_summary(p_user_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'tier',public.xelay_private_supporter_tier(coalesce(sum(o.amount_kopiykas),0)),
    'totalKopiykas',coalesce(sum(o.amount_kopiykas),0),
    'sixSeven',coalesce(bool_or(o.amount_kopiykas=6700),false))
  from public.support_orders o
  where o.user_id=p_user_id and o.mode='live' and o.status='approved';
$$;

revoke all on function public.xelay_supporter_badges(uuid),public.xelay_supporter_summary(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_supporter_badges(uuid) to anon,authenticated,service_role;
grant execute on function public.xelay_supporter_summary(uuid) to service_role;

comment on function public.xelay_supporter_badges(uuid) is
  'Public earned tier 0..5 plus sixSeven boolean for an exactly-67-UAH approved LIVE contribution. No total, dates, references or history. No additional rights.';
comment on function public.xelay_supporter_summary(uuid) is
  'Server-only lifetime total, tier and earned secret badge. Billing returns it only to the authenticated owner.';
commit;
