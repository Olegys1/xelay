-- New group purchases: UAH 750 for twelve calendar months, renewed manually.
-- Apply after 202609300001_participant_billing.sql and before publishing the
-- annual checkout. Existing lifetime/free/admin licenses remain unchanged.
begin;

do $$
begin
  if to_regclass('public.billing_orders') is null
    or to_regclass('public.group_entitlements') is null
    or to_regclass('public.participant_entitlements') is null
    or to_regprocedure('public.xelay_reflow_participant_access(uuid)') is null
    or to_regprocedure('public.xelay_can_view_study_group(uuid)') is null
    or to_regprocedure('public.xelay_is_study_group_representative(uuid)') is null then
    raise exception 'Apply participant billing and study-group migrations before annual group billing';
  end if;
end;
$$;

-- NULL preserves the contract of every order created before this migration,
-- including a still-pending lifetime checkout already opened at WayForPay.
-- Only the server order function writes twelve months for new group orders.
alter table public.billing_orders add column if not exists group_term_months integer;
alter table public.billing_orders drop constraint if exists billing_orders_group_term_check;
alter table public.billing_orders add constraint billing_orders_group_term_check
  check (group_term_months is null or (product='group' and group_term_months=12));
alter table public.billing_orders add column if not exists terms_version text;
alter table public.billing_orders add column if not exists terms_accepted_at timestamptz;
alter table public.billing_orders drop constraint if exists billing_orders_terms_acceptance_check;
alter table public.billing_orders add constraint billing_orders_terms_acceptance_check
  check ((terms_version is null and terms_accepted_at is null)
    or (terms_version is not null and length(btrim(terms_version)) between 1 and 100
      and terms_accepted_at is not null));

-- Keep annual periods per order so refunding a renewal cannot revoke a
-- separate purchase, a promotional license, or a previously paid lifetime.
create table if not exists public.group_annual_entitlements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  order_id uuid not null unique references public.billing_orders(id) on delete restrict,
  term_months integer not null default 12 check (term_months=12),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (valid_until>valid_from)
);
create index if not exists group_annual_entitlements_period_idx
  on public.group_annual_entitlements(group_id,valid_until) where revoked_at is null;
alter table public.group_annual_entitlements enable row level security;
revoke all on public.group_annual_entitlements from public,anon,authenticated;
grant all on public.group_annual_entitlements to service_role;

create or replace function public.xelay_group_has_access(p_group_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$
  select exists(select 1 from public.group_entitlements
    where group_id=p_group_id and revoked_at is null)
    or exists(select 1 from public.group_annual_entitlements
      where group_id=p_group_id and revoked_at is null
        and valid_from<=now() and valid_until>now());
$$;

-- Close gaps left by refunded current/queued years while preserving time
-- already consumed in an unrefunded current period. Expired grants stay intact.
create or replace function public.xelay_reflow_group_access(p_group_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_entitlement record; v_cursor timestamptz := now(); v_until timestamptz;
begin
  if p_group_id is null then raise exception 'Group required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:group-order:' || p_group_id::text,0));
  for v_entitlement in
    select id,valid_from,valid_until,term_months from public.group_annual_entitlements
    where group_id=p_group_id and revoked_at is null and valid_until>now()
    order by valid_from,created_at,id for update
  loop
    if v_entitlement.valid_from<=now() then
      v_cursor := greatest(v_cursor,v_entitlement.valid_until);
    else
      v_until := ((v_cursor at time zone 'Europe/Kyiv')
        + make_interval(months=>v_entitlement.term_months)) at time zone 'Europe/Kyiv';
      update public.group_annual_entitlements
        set valid_from=v_cursor,valid_until=v_until where id=v_entitlement.id;
      v_cursor := v_until;
    end if;
  end loop;
end;
$$;

create or replace function public.xelay_group_billing_status(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp
as $$
declare v_active boolean; v_enforced boolean; v_source text; v_rep boolean;
  v_lifetime boolean; v_expires_at timestamptz;
begin
  if auth.uid() is null or not public.xelay_can_view_study_group(p_group_id) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  select source into v_source from public.group_entitlements
    where group_id=p_group_id and revoked_at is null;
  v_lifetime := v_source is not null;
  if not v_lifetime then
    select max(valid_until) into v_expires_at from public.group_annual_entitlements
      where group_id=p_group_id and revoked_at is null;
    if exists(select 1 from public.group_annual_entitlements
      where group_id=p_group_id and revoked_at is null
        and valid_from<=now() and valid_until>now()) then v_source := 'payment'; end if;
  end if;
  v_active := public.xelay_group_has_access(p_group_id);
  select enforce_group_payment into v_enforced from public.billing_settings where singleton;
  v_enforced := coalesce(v_enforced,false);
  v_rep := public.xelay_is_study_group_representative(p_group_id);
  return jsonb_build_object('is_active',v_active,'source',v_source,'price',750,
    'is_representative',v_rep,'enforcement_enabled',v_enforced,
    'payment_required',v_enforced and not v_active,
    'can_edit',v_rep and (v_active or not v_enforced),
    'expires_at',v_expires_at,'is_lifetime',v_lifetime,
    'can_renew',v_rep and not v_lifetime,'billing_period_months',12);
end;
$$;

create or replace function public.xelay_create_billing_order(
  p_user_id uuid,p_product text,p_mode text,p_order_reference text,p_group_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_order public.billing_orders%rowtype; v_count integer;
begin
  if p_user_id is null or p_mode is null or p_product is null
    or p_mode not in('test','live') or p_product not in('participant','group') then
    raise exception 'Invalid billing product/mode';
  end if;
  if p_order_reference is null or length(p_order_reference)>100 then
    raise exception 'Order reference required';
  end if;
  if not exists(select 1 from public.profiles where id=p_user_id) then raise exception 'Profile required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:checkout:' || p_user_id::text,0));
  if p_product='group' then
    if not exists(select 1 from public.study_groups
      where id=p_group_id and representative_id=p_user_id) then raise exception 'Group representative required'; end if;
    perform pg_advisory_xact_lock(hashtextextended('xelay:group-order:' || p_group_id::text,0));
    -- Lifetime, promotional, and admin licenses do not need paid renewals.
    -- A currently active annual license may be extended before it expires.
    if exists(select 1 from public.group_entitlements
      where group_id=p_group_id and revoked_at is null) then raise exception 'GROUP_ALREADY_ACTIVE'; end if;
  elsif p_group_id is not null then raise exception 'Participant order cannot include group'; end if;
  select * into v_order from public.billing_orders
    where user_id=p_user_id and product=p_product and mode=p_mode
      and group_id is not distinct from p_group_id
      and (p_product<>'group' or group_term_months=12)
      and status='pending' and created_at>now()-interval '1 hour'
    order by created_at desc limit 1;
  if found then return to_jsonb(v_order); end if;
  -- Wait out a recently opened checkout from the former lifetime tariff or
  -- a former representative instead of creating two payable group orders.
  if p_product='group' and exists(select 1 from public.billing_orders
    where product='group' and group_id=p_group_id and mode=p_mode
      and status='pending' and created_at>now()-interval '1 hour') then
    raise exception 'GROUP_CHECKOUT_PENDING';
  end if;
  select count(*) into v_count from public.billing_orders
    where user_id=p_user_id and created_at>now()-interval '1 hour';
  if v_count>=10 then raise exception 'CHECKOUT_RATE_LIMIT'; end if;
  insert into public.billing_orders(user_id,product,group_id,order_reference,amount,mode,group_term_months)
    values(p_user_id,p_product,p_group_id,p_order_reference,
      case when p_product='participant' then 100 else 750 end,p_mode,
      case when p_product='group' then 12 else null end)
    returning * into v_order;
  return to_jsonb(v_order);
end;
$$;

create or replace function public.xelay_apply_billing_event(
  p_reference text,p_mode text,p_fingerprint text,p_status text,p_amount numeric,p_currency text,p_fee numeric default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_order public.billing_orders%rowtype; v_from timestamptz; v_rows integer;
  v_duplicate_group boolean := false;
begin
  select * into v_order from public.billing_orders where order_reference=p_reference for update;
  if not found or v_order.mode is distinct from p_mode
    or v_order.amount is distinct from p_amount or p_currency is distinct from 'UAH' then
    raise exception 'Payment order mismatch';
  end if;
  if p_fingerprint is null or length(p_fingerprint)<>64 or p_status is null then
    raise exception 'Payment event required';
  end if;
  if v_order.product='participant' then
    perform pg_advisory_xact_lock(hashtextextended('xelay:premium:' || v_order.user_id::text,0));
  else
    perform pg_advisory_xact_lock(hashtextextended('xelay:group-order:' || v_order.group_id::text,0));
  end if;
  insert into public.billing_payment_events(order_id,fingerprint,provider_status,amount,mode)
    values(v_order.id,p_fingerprint,p_status,p_amount,p_mode) on conflict(fingerprint) do nothing;
  get diagnostics v_rows=row_count;
  if v_rows=0 then return jsonb_build_object('duplicate',true,'status',v_order.status); end if;
  if p_status='Approved' and v_order.status not in('approved','refunded','voided') then
    update public.billing_orders set status='approved',provider_status=p_status,
      provider_fee=p_fee,approved_at=now(),updated_at=now() where id=v_order.id;
    -- Test orders remain history entries and never grant production access.
    if p_mode='live' then
      if v_order.product='participant' then
        perform public.xelay_reflow_participant_access(v_order.user_id);
        select greatest(now(),coalesce(max(valid_until),now())) into v_from
          from public.participant_entitlements
          where user_id=v_order.user_id and revoked_at is null and valid_until>now();
        insert into public.participant_entitlements(user_id,order_id,source,term_months,valid_from,valid_until)
          values(v_order.user_id,v_order.id,'payment',1,v_from,
            ((v_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv')
          on conflict(order_id) do nothing;
      elsif exists(select 1 from public.group_entitlements
        where group_id=v_order.group_id and revoked_at is null) then
        v_duplicate_group := true;
        insert into public.billing_audit_log(action,target_user_id,group_id,detail)
          values('duplicate_group_payment',v_order.user_id,v_order.group_id,
            jsonb_build_object('order_id',v_order.id,'order_reference',p_reference,
              'reason','Група вже має безстроковий доступ. Перевірте повторну оплату та повернення коштів.'));
      elsif v_order.group_term_months=12 then
        perform public.xelay_reflow_group_access(v_order.group_id);
        select greatest(now(),coalesce(max(valid_until),now())) into v_from
          from public.group_annual_entitlements
          where group_id=v_order.group_id and revoked_at is null and valid_until>now();
        insert into public.group_annual_entitlements(group_id,order_id,term_months,valid_from,valid_until)
          values(v_order.group_id,v_order.id,12,v_from,
            ((v_from at time zone 'Europe/Kyiv')+interval '1 year') at time zone 'Europe/Kyiv')
          on conflict(order_id) do nothing;
      else
        -- A checkout opened before this migration keeps its lifetime contract.
        insert into public.group_entitlements(group_id,source,order_id)
          values(v_order.group_id,'payment',v_order.id)
          on conflict(group_id) do update set source='payment',order_id=excluded.order_id,
            revoked_at=null,created_at=now() where group_entitlements.revoked_at is not null;
      end if;
    end if;
  elsif p_status in('Refunded','Voided') then
    update public.billing_orders
      set status=case when p_status='Refunded' or v_order.status='refunded' then 'refunded' else 'voided' end,
        provider_status=case when v_order.status='refunded' then 'Refunded' else p_status end,updated_at=now()
      where id=v_order.id;
    update public.participant_entitlements set revoked_at=now()
      where order_id=v_order.id and revoked_at is null;
    update public.group_entitlements set revoked_at=now()
      where order_id=v_order.id and source='payment' and revoked_at is null;
    update public.group_annual_entitlements set revoked_at=now()
      where order_id=v_order.id and revoked_at is null;
    if p_mode='live' and v_order.product='participant' then
      perform public.xelay_reflow_participant_access(v_order.user_id);
    elsif p_mode='live' and v_order.product='group' then
      perform public.xelay_reflow_group_access(v_order.group_id);
    end if;
  elsif p_status in('Declined','Expired') and v_order.status<>'approved'
    and v_order.status not in('refunded','voided') then
    update public.billing_orders set status=case when p_status='Expired' then 'expired' else 'declined' end,
      provider_status=p_status,updated_at=now() where id=v_order.id;
  else
    update public.billing_orders set provider_status=p_status,updated_at=now() where id=v_order.id;
  end if;
  return jsonb_build_object('duplicate',false,'mode',p_mode,'duplicate_group_payment',v_duplicate_group);
end;
$$;

create or replace function public.xelay_admin_billing_overview()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp
as $$
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then
    raise exception 'Admin permission required' using errcode='42501';
  end if;
  return jsonb_build_object(
    'active_participants',(select count(distinct user_id) from public.participant_entitlements
      where revoked_at is null and valid_from<=now() and valid_until>now()),
    'active_groups',(select count(*) from public.study_groups g where public.xelay_group_has_access(g.id)),
    'paid_groups',(select count(*) from public.study_groups g
      where exists(select 1 from public.group_entitlements e
        where e.group_id=g.id and e.source='payment' and e.revoked_at is null)
        or exists(select 1 from public.group_annual_entitlements e
          where e.group_id=g.id and e.revoked_at is null and e.valid_from<=now() and e.valid_until>now())),
    'live_revenue',(select coalesce(sum(amount),0) from public.billing_orders where mode='live' and status='approved'),
    'refunds',(select coalesce(sum(amount),0) from public.billing_orders where mode='live' and status='refunded'),
    'fees',(select coalesce(sum(provider_fee),0) from public.billing_orders where mode='live' and status='approved'),
    'fees_pending',(select count(*) from public.billing_orders where mode='live' and status='approved' and provider_fee is null),
    'fees_known',not exists(select 1 from public.billing_orders where mode='live' and status='approved' and provider_fee is null),
    'enforcement_enabled',(select enforce_group_payment from public.billing_settings where singleton),
    'orders',(select coalesce(jsonb_agg(to_jsonb(o)),'[]'::jsonb) from
      (select id,user_id,product,group_id,order_reference,amount,currency,mode,status,
        provider_fee,created_at,approved_at,group_term_months,terms_version,terms_accepted_at
        from public.billing_orders order by created_at desc limit 50)o),
    'audit',(select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) from
      (select * from public.billing_audit_log order by created_at desc limit 30)a)
  );
end;
$$;

revoke all on function public.xelay_group_has_access(uuid),public.xelay_group_billing_status(uuid),
  public.xelay_reflow_group_access(uuid),public.xelay_create_billing_order(uuid,text,text,text,uuid),
  public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric),public.xelay_admin_billing_overview()
  from public,anon,authenticated;
grant execute on function public.xelay_group_has_access(uuid),public.xelay_group_billing_status(uuid),
  public.xelay_admin_billing_overview() to authenticated;
grant execute on function public.xelay_group_has_access(uuid),public.xelay_group_billing_status(uuid),
  public.xelay_reflow_group_access(uuid),public.xelay_create_billing_order(uuid,text,text,text,uuid),
  public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric),public.xelay_admin_billing_overview()
  to service_role;

commit;
