-- One admin-only ledger for subscriptions, legacy group orders and voluntary
-- support. Amounts retain their source of truth; no payment is replayed or edited.
begin;

create or replace function public.xelay_admin_billing_transactions(
  p_limit integer default 50,
  p_offset integer default 0,
  p_product text default null,
  p_status text default null,
  p_mode text default null,
  p_query text default null,
  p_before timestamptz default null
)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_limit integer := coalesce(p_limit, 50);
  v_offset integer := coalesce(p_offset, 0);
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_before timestamptz := coalesce(p_before, now());
  v_result jsonb;
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then
    raise exception 'Admin permission required' using errcode = '42501';
  end if;
  if v_limit not between 1 and 200 or v_offset < 0
    or (p_product is not null and p_product not in ('participant', 'group', 'support'))
    or (p_status is not null and p_status not in ('pending', 'approved', 'declined', 'expired', 'refunded', 'voided'))
    or (p_mode is not null and p_mode not in ('test', 'live'))
    or length(coalesce(v_query, '')) > 120 or not isfinite(v_before) or v_before > now() then
    raise exception 'Invalid transaction filters' using errcode = '22023';
  end if;
  with orders as (
    select b.id, 'billing'::text as source, b.user_id, b.product, b.amount,
      b.currency, b.mode, b.status, b.created_at, b.approved_at,
      b.order_reference, b.provider_fee as fee_amount
    from public.billing_orders b where b.created_at <= v_before
    union all
    select s.id, 'support'::text, s.user_id, 'support'::text,
      s.amount_kopiykas::numeric / 100, s.currency, s.mode, s.status,
      s.created_at, s.approved_at, s.order_reference, null::numeric
    from public.support_orders s where s.created_at <= v_before
  ), filtered as materialized (
    select o.*, p.full_name, p.username
    from orders o left join public.profiles p on p.id = o.user_id
    where (p_product is null or o.product = p_product)
      and (p_status is null or o.status = p_status)
      and (p_mode is null or o.mode = p_mode)
      and (v_query is null or position(lower(v_query) in lower(concat_ws(' ',
        o.order_reference, o.user_id::text, p.full_name, p.username, o.amount::text))) > 0)
  ), page as (
    select * from filtered order by created_at desc, source, id desc
    limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'transactions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc, t.source, t.id desc), '[]'::jsonb) from page t),
    'total', (select count(*) from filtered),
    'limit', v_limit, 'offset', v_offset, 'snapshot_at', v_before
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.xelay_admin_billing_overview()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_result jsonb;
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then
    raise exception 'Admin permission required' using errcode = '42501';
  end if;
  with orders as materialized (
    select 'billing'::text as source, b.amount, b.mode, b.status, b.provider_fee as fee_amount
    from public.billing_orders b
    union all
    select 'support'::text, s.amount_kopiykas::numeric / 100, s.mode, s.status, null::numeric
    from public.support_orders s
  ), totals as (
    select
      coalesce(sum(amount) filter (where mode = 'live' and status = 'approved'), 0) as revenue,
      coalesce(sum(amount) filter (where source = 'billing' and mode = 'live' and status = 'approved'), 0) as subscription_revenue,
      coalesce(sum(amount) filter (where source = 'support' and mode = 'live' and status = 'approved'), 0) as support_revenue,
      coalesce(sum(amount) filter (where mode = 'live' and status = 'refunded'), 0) as refunds,
      coalesce(sum(fee_amount) filter (where mode = 'live' and status = 'approved'), 0) as fees,
      count(*) filter (where mode = 'live' and status = 'approved' and fee_amount is null) as fees_pending,
      count(*) as transaction_count
    from orders
  )
  select jsonb_build_object(
    'active_participants', (select count(distinct e.user_id) from public.participant_entitlements e
      where e.revoked_at is null and e.valid_from <= now() and e.valid_until > now()),
    'active_groups', (select count(*) from public.study_groups g where public.xelay_group_has_access(g.id)),
    'paid_groups', (select count(*) from public.study_groups g
      where exists (select 1 from public.group_entitlements e where e.group_id = g.id and e.source = 'payment' and e.revoked_at is null)
        or exists (select 1 from public.group_annual_entitlements e where e.group_id = g.id and e.revoked_at is null and e.valid_from <= now() and e.valid_until > now())),
    'live_revenue', t.revenue, 'subscription_revenue', t.subscription_revenue,
    'support_revenue', t.support_revenue, 'refunds', t.refunds,
    'fees', t.fees, 'fees_pending', t.fees_pending, 'fees_known', t.fees_pending = 0,
    'transaction_count', t.transaction_count,
    'enforcement_enabled', (select b.enforce_group_payment from public.billing_settings b where b.singleton),
    -- Compatibility for an older open admin tab; new clients use the paginated
    -- ledger above. Never mislabel support as a Participant subscription there.
    'orders', (select coalesce(jsonb_agg(to_jsonb(o) order by o.created_at desc, o.id desc), '[]'::jsonb) from
      (select b.id,b.user_id,b.product,b.group_id,b.order_reference,b.amount,b.currency,b.mode,b.status,
        b.provider_fee,b.created_at,b.approved_at,b.group_term_months,b.terms_version,b.terms_accepted_at
        from public.billing_orders b order by b.created_at desc,b.id desc limit 50) o),
    'audit', (select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id desc), '[]'::jsonb) from
      (select a.* from public.billing_audit_log a order by a.created_at desc,a.id desc limit 30) a)
  ) into v_result from totals t;
  return v_result;
end;
$$;

-- No direct table grants. The existing platform ADMIN predicate is checked in
-- each function, including every page of an export. Its definition is unchanged.
revoke all on function public.xelay_admin_billing_transactions(integer,integer,text,text,text,text,timestamptz),
  public.xelay_admin_billing_overview() from public,anon,authenticated,service_role;
grant execute on function public.xelay_admin_billing_transactions(integer,integer,text,text,text,text,timestamptz),
  public.xelay_admin_billing_overview() to authenticated;
-- Preserve the pre-existing overview ACL; service-role execution still needs
-- the same authenticated platform admin identity inside the function.
grant execute on function public.xelay_admin_billing_overview() to service_role;

comment on function public.xelay_admin_billing_transactions(integer,integer,text,text,text,text,timestamptz)
  is 'Existing platform admins only: paginated read-only subscription/group/support orders. No card data or provider payloads; support amounts converted from kopiykas.';
comment on function public.xelay_admin_billing_overview()
  is 'Existing platform admins only: confirmed live subscription/group/support totals, excluding test, pending, declined, voided and refunded orders from revenue. Unknown fees are not assumed to be zero.';
commit;
