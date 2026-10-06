-- Separate, one-time team support. Does not change subscriptions, group access,
-- profiles or existing billing functions. Run this entire file in one transaction.
begin;

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'Apply the profiles schema before team support';
  end if;
end;
$$;

create table if not exists public.support_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  order_reference text not null unique check (
    order_reference ~ '^xelay_support_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  amount_kopiykas integer not null check (amount_kopiykas between 100 and 14999900),
  currency text not null default 'UAH' check (currency = 'UAH'),
  mode text not null check (mode in ('test','live')),
  status text not null default 'pending' check (status in ('pending','approved','declined','expired','refunded','voided')),
  terms_version text not null check (length(terms_version) between 1 and 80),
  terms_accepted_at timestamptz not null default now(),
  provider_status text,
  last_status_check_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.support_orders enable row level security;
revoke all on table public.support_orders from public, anon, authenticated;
grant select on table public.support_orders to authenticated;
grant select, insert, update on table public.support_orders to service_role;
drop policy if exists support_orders_owner_read on public.support_orders;
create policy support_orders_owner_read on public.support_orders for select to authenticated
  using (user_id = (select auth.uid()));
create index if not exists support_orders_user_created_idx on public.support_orders(user_id, created_at desc);
create index if not exists support_orders_badge_idx on public.support_orders(user_id)
  where mode='live' and status='approved';

create table if not exists public.support_payment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.support_orders(id) on delete restrict,
  fingerprint text not null unique check (fingerprint ~ '^[a-f0-9]{64}$'),
  provider_status text not null check (length(provider_status) between 1 and 64),
  amount numeric(12,2) not null check (amount between 1 and 149999),
  mode text not null check (mode in ('test','live')),
  created_at timestamptz not null default now()
);
alter table public.support_payment_events enable row level security;
revoke all on table public.support_payment_events from public, anon, authenticated;
grant select, insert on table public.support_payment_events to service_role;
create index if not exists support_payment_events_order_idx on public.support_payment_events(order_id, created_at);

create or replace function public.xelay_create_support_order(
  p_user_id uuid, p_mode text, p_reference text, p_amount_kopiykas integer, p_terms_version text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_order public.support_orders%rowtype;
begin
  if p_user_id is null or p_mode is null or p_mode not in ('test','live')
    or p_amount_kopiykas is null or p_amount_kopiykas not between 100 and 14999900
    or p_reference is null or p_reference !~ '^xelay_support_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    or p_terms_version is null or length(p_terms_version) not between 1 and 80 then
    raise exception 'Invalid support order';
  end if;
  if not exists (select 1 from public.profiles where id=p_user_id) then raise exception 'Profile required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:support-checkout:' || p_user_id::text, 0));
  -- Reuse an unexpired matching checkout rather than generate another charge.
  select * into v_order from public.support_orders
    where user_id=p_user_id and mode=p_mode and amount_kopiykas=p_amount_kopiykas
      and terms_version=p_terms_version and status='pending' and created_at>now()-interval '1 hour'
    order by created_at desc limit 1;
  if found then return to_jsonb(v_order); end if;
  if (select count(*) from public.support_orders where user_id=p_user_id and created_at>now()-interval '1 hour') >= 8 then
    raise exception 'CHECKOUT_RATE_LIMIT';
  end if;
  insert into public.support_orders(user_id,mode,order_reference,amount_kopiykas,terms_version,terms_accepted_at)
    values (p_user_id,p_mode,p_reference,p_amount_kopiykas,p_terms_version,now()) returning * into v_order;
  return to_jsonb(v_order);
end;
$$;

create or replace function public.xelay_apply_support_event(
  p_reference text, p_mode text, p_fingerprint text, p_status text, p_amount numeric, p_currency text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_order public.support_orders%rowtype;
  v_rows integer;
begin
  select * into v_order from public.support_orders where order_reference=p_reference for update;
  if not found or v_order.mode is distinct from p_mode or p_currency is distinct from 'UAH'
    or p_amount is distinct from (v_order.amount_kopiykas::numeric / 100) then
    raise exception 'Payment order mismatch';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
    or p_status is null or length(p_status) not between 1 and 64 then raise exception 'Invalid payment event'; end if;
  insert into public.support_payment_events(order_id,fingerprint,provider_status,amount,mode)
    values(v_order.id,p_fingerprint,p_status,p_amount,p_mode) on conflict(fingerprint) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows=0 then return jsonb_build_object('duplicate',true,'status',v_order.status); end if;
  -- A late Approved callback cannot resurrect refunded/voided support.
  if p_status='Approved' and v_order.status not in ('approved','refunded','voided') then
    update public.support_orders set status='approved', provider_status=p_status,
      approved_at=now(), updated_at=now() where id=v_order.id;
  elsif p_status in ('Refunded','Voided') then
    update public.support_orders set status=case when p_status='Refunded' then 'refunded' else 'voided' end,
      provider_status=p_status,updated_at=now() where id=v_order.id;
  elsif v_order.status not in ('approved','refunded','voided') then
    update public.support_orders set
      status=case p_status when 'Declined' then 'declined' when 'Expired' then 'expired' else status end,
      provider_status=p_status, updated_at=now() where id=v_order.id;
  end if;
  -- The public badge is derived from approved LIVE orders; test/refund events
  -- never grant paid access or write to participant/group entitlements.
  return (select jsonb_build_object('duplicate',false,'status',status) from public.support_orders where id=v_order.id);
end;
$$;

create or replace function public.xelay_claim_support_reconciliation(p_user_id uuid, p_reference text, p_mode text)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_order public.support_orders%rowtype;
begin
  select * into v_order from public.support_orders
    where user_id=p_user_id and order_reference=p_reference and mode=p_mode for update;
  if not found then raise exception 'Payment order mismatch'; end if;
  if v_order.last_status_check_at is not null and v_order.last_status_check_at>now()-interval '1 minute' then return false; end if;
  update public.support_orders set last_status_check_at=now() where id=v_order.id;
  return true;
end;
$$;

create or replace function public.xelay_supporter_badge(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists(select 1 from public.support_orders where user_id=p_user_id and mode='live' and status='approved');
$$;

revoke all on function public.xelay_create_support_order(uuid,text,text,integer,text),
  public.xelay_apply_support_event(text,text,text,text,numeric,text),
  public.xelay_claim_support_reconciliation(uuid,text,text),
  public.xelay_supporter_badge(uuid) from public, anon, authenticated, service_role;
grant execute on function public.xelay_create_support_order(uuid,text,text,integer,text),
  public.xelay_apply_support_event(text,text,text,text,numeric,text),
  public.xelay_claim_support_reconciliation(uuid,text,text) to service_role;
-- Only the presence of a badge is public. Amounts, dates, email and orders are not.
grant execute on function public.xelay_supporter_badge(uuid) to anon, authenticated, service_role;

comment on table public.support_orders is 'One-time voluntary support, server-authoritative amount/consent/payment state. Never grants subscription or academic permissions.';
comment on function public.xelay_supporter_badge(uuid) is 'Public thank-you badge only; true while at least one live support order remains approved. No financial details.';
commit;
