-- Purchased AI credits are a separate, non-expiring wallet. Existing subscription
-- allowances, gifts, official tests, grades and previous requests are preserved.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $$begin
 if to_regclass('xelay_student_private.period_usage')is null
 or to_regprocedure('xelay_student_private.entitlement(uuid)')is null
 or to_regclass('xelay_student_private.credit_wallets')is not null then raise exception 'MAX_CREDITS_PREREQUISITE_OR_DRIFT';end if;
end$$;
create table xelay_student_private.credit_wallets(
 user_id uuid primary key references public.profiles(id)on delete cascade,
 granted_micros bigint not null default 0 check(granted_micros between 0 and 1000000000000),
 spent_micros bigint not null default 0 check(spent_micros between 0 and 1000000000000),
 reserved_micros bigint not null default 0 check(reserved_micros between 0 and 1000000000000)
);
create table xelay_student_private.credit_orders(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id)on delete restrict,
 order_reference text not null unique check(order_reference~'^xtop_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
 package_id text not null,amount numeric(12,2)not null,credit_micros bigint not null,currency text not null default'UAH'check(currency='UAH'),
 mode text not null check(mode in('live','test')),status text not null default'pending'check(status in('pending','approved','declined','expired','refunded','voided')),
 terms_version text not null check(length(terms_version)between 1 and 100),terms_accepted_at timestamptz not null default clock_timestamp(),
 created_at timestamptz not null default clock_timestamp(),approved_at timestamptz,credited_at timestamptz,revoked_at timestamptz,last_reconciled_at timestamptz,
 constraint credit_order_catalog check((package_id='credits_1000'and amount=99 and credit_micros=1000000)
 or(package_id='credits_3000'and amount=249 and credit_micros=3000000)
 or(package_id='credits_10000'and amount=749 and credit_micros=10000000))
);
create index max_credit_orders_owner on xelay_student_private.credit_orders(user_id,created_at desc);
create table xelay_student_private.credit_events(
 id bigint generated always as identity primary key,order_id uuid not null references xelay_student_private.credit_orders(id)on delete restrict,
 fingerprint text not null unique check(fingerprint~'^[a-f0-9]{64}$'),provider_status text not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table xelay_student_private.credit_wallets enable row level security;
alter table xelay_student_private.credit_orders enable row level security;
alter table xelay_student_private.credit_events enable row level security;
revoke all on xelay_student_private.credit_wallets,xelay_student_private.credit_orders,xelay_student_private.credit_events from public,anon,authenticated,service_role;
revoke all on sequence xelay_student_private.credit_events_id_seq from public,anon,authenticated,service_role;
alter table xelay_student_private.requests add column wallet_reserve_micros bigint not null default 0 check(wallet_reserve_micros>=0 and wallet_reserve_micros<=reserve_micros);

create function xelay_student_private.credit_summary(p_user_id uuid)returns jsonb language sql stable security definer set search_path=''as $$
 select jsonb_build_object('balanceCredits',greatest(0,coalesce(w.granted_micros-w.spent_micros-w.reserved_micros,0))::numeric/1000,
 'reservedCredits',coalesce(w.reserved_micros,0)::numeric/1000,'debtCredits',greatest(0,coalesce(w.spent_micros-w.granted_micros,0))::numeric/1000)
 from(select 1)s left join xelay_student_private.credit_wallets w on w.user_id=p_user_id;
$$;
-- Preserve the existing entitlement implementation, including legacy/gift logic.
do $copy$declare definition text;begin
 definition:=pg_get_functiondef('xelay_student_private.entitlement(uuid)'::regprocedure);
 if position('CREATE OR REPLACE FUNCTION xelay_student_private.entitlement('in definition)<>1 then raise exception 'MAX_CREDITS_ENTITLEMENT_DRIFT';end if;
 execute replace(definition,'CREATE OR REPLACE FUNCTION xelay_student_private.entitlement(','CREATE FUNCTION xelay_student_private.entitlement_before_credits(');
end$copy$;
create or replace function xelay_student_private.entitlement(p_user_id uuid)returns jsonb language sql stable security definer set search_path=''as $$
 select xelay_student_private.entitlement_before_credits(p_user_id)||jsonb_build_object('purchasedCredits',xelay_student_private.credit_summary(p_user_id));
$$;
create function public.xelay_max_credit_status(p_user_id uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare e jsonb;o jsonb;begin
 perform xelay_student_private.service();
 if p_user_id is null then raise exception 'MAX_CREDITS_OWNER_REQUIRED'using errcode='42501';end if;
 e:=xelay_student_private.entitlement(p_user_id);
 select coalesce(jsonb_agg(to_jsonb(r)order by r.created_at desc),'[]'::jsonb)into o from(
 select id,order_reference,package_id,amount,currency,mode,status,created_at,approved_at from xelay_student_private.credit_orders where user_id=p_user_id order by created_at desc limit 20)r;
 return jsonb_build_object('eligible',coalesce(e->>'audience'='student'and e->>'planId'='max'and(e->>'expiresAt')::timestamptz>clock_timestamp(),false),
 'wallet',xelay_student_private.credit_summary(p_user_id),'orders',o);
end$$;
create function public.xelay_create_max_credit_order(p_user_id uuid,p_mode text,p_order_reference text,p_package_id text,p_terms_version text)
returns jsonb language plpgsql security definer set search_path=''as $$
declare o xelay_student_private.credit_orders;e jsonb;price numeric;micros bigint;begin
 perform xelay_student_private.service();
 if p_user_id is null or p_mode is null or p_mode not in('live','test')or p_order_reference is null
 or p_order_reference!~'^xtop_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 or p_package_id is null or p_package_id not in('credits_1000','credits_3000','credits_10000')or p_terms_version is null or length(p_terms_version)not between 1 and 100 then raise exception 'MAX_CREDITS_ORDER_INVALID'using errcode='22023';end if;
 if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id where u.id=p_user_id and u.email_confirmed_at is not null and u.deleted_at is null and(u.banned_until is null or u.banned_until<=clock_timestamp()))then raise exception 'MAX_CREDITS_ACCOUNT_REQUIRED'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||p_user_id::text,0));
 e:=xelay_student_private.entitlement(p_user_id);
 if e->>'audience'is distinct from'student'or e->>'planId'is distinct from'max'or not coalesce((e->>'expiresAt')::timestamptz>clock_timestamp(),false)then raise exception 'MAX_CREDITS_MAX_REQUIRED'using errcode='42501';end if;
 select*into o from xelay_student_private.credit_orders where user_id=p_user_id and package_id=p_package_id and mode=p_mode and terms_version=p_terms_version and status='pending'and created_at>clock_timestamp()-interval'1 hour'order by created_at desc limit 1;
 if not found then
  if(select count(*)from xelay_student_private.credit_orders where user_id=p_user_id and created_at>clock_timestamp()-interval'1 hour')>=10 then raise exception 'CHECKOUT_RATE_LIMIT'using errcode='PT429';end if;
  price:=case p_package_id when'credits_1000'then 99 when'credits_3000'then 249 else 749 end;
  micros:=case p_package_id when'credits_1000'then 1000000 when'credits_3000'then 3000000 else 10000000 end;
  insert into xelay_student_private.credit_orders(user_id,order_reference,package_id,amount,credit_micros,mode,terms_version)
   values(p_user_id,p_order_reference,p_package_id,price,micros,p_mode,p_terms_version)returning*into o;
 end if;
 return to_jsonb(o)||jsonb_build_object('product','ai_credits','group_id',null);
end$$;
create function xelay_student_private.credit_order_snapshot()returns trigger language plpgsql set search_path=''as $$begin
 if new.id is distinct from old.id or new.user_id is distinct from old.user_id or new.order_reference is distinct from old.order_reference or new.package_id is distinct from old.package_id
 or new.amount is distinct from old.amount or new.credit_micros is distinct from old.credit_micros or new.currency is distinct from old.currency or new.mode is distinct from old.mode
 or new.terms_version is distinct from old.terms_version or new.terms_accepted_at is distinct from old.terms_accepted_at or new.created_at is distinct from old.created_at then raise exception 'MAX_CREDITS_ORDER_IMMUTABLE'using errcode='42501';end if;return new;
end$$;
create trigger max_credit_order_snapshot before update on xelay_student_private.credit_orders for each row execute function xelay_student_private.credit_order_snapshot();

create function public.xelay_apply_max_credit_event(p_reference text,p_mode text,p_fingerprint text,p_status text,p_amount numeric,p_currency text)
returns jsonb language plpgsql security definer set search_path=''as $$
declare o xelay_student_private.credit_orders;u uuid;event_id bigint;begin
 perform xelay_student_private.service();
 if p_fingerprint is null or p_fingerprint!~'^[a-f0-9]{64}$'or p_status is null or p_status not in('Approved','Declined','Expired','Refunded','Voided','Pending','InProcessing','WaitingAuthComplete')then raise exception 'MAX_CREDITS_EVENT_INVALID'using errcode='22023';end if;
 select user_id into u from xelay_student_private.credit_orders where order_reference=p_reference;
 if u is null then raise exception 'MAX_CREDITS_ORDER_REQUIRED'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||u::text,0));
 select*into o from xelay_student_private.credit_orders where order_reference=p_reference for update;
 if p_mode is null or o.mode<>p_mode or p_currency is null or o.currency<>p_currency or p_amount is null or o.amount<>p_amount then raise exception 'MAX_CREDITS_PAYMENT_MISMATCH'using errcode='42501';end if;
 if exists(select 1 from xelay_student_private.credit_events where fingerprint=p_fingerprint and order_id<>o.id)then raise exception 'MAX_CREDITS_EVENT_CONFLICT'using errcode='PT409';end if;
 insert into xelay_student_private.credit_events(order_id,fingerprint,provider_status)values(o.id,p_fingerprint,p_status)on conflict(fingerprint)do nothing returning id into event_id;
 if event_id is null then return jsonb_build_object('applied',false,'replayed',true);end if;
 if p_status='Approved'and o.status not in('refunded','voided')then
  if o.mode='live'and o.credited_at is null then
   insert into xelay_student_private.credit_wallets(user_id,granted_micros)values(o.user_id,o.credit_micros)
   on conflict(user_id)do update set granted_micros=xelay_student_private.credit_wallets.granted_micros+excluded.granted_micros;
  end if;
  update xelay_student_private.credit_orders set status='approved',approved_at=coalesce(approved_at,clock_timestamp()),credited_at=case when mode='live'then coalesce(credited_at,clock_timestamp())else null end where id=o.id;
 elsif p_status in('Refunded','Voided')then
  if o.mode='live'and o.credited_at is not null and o.revoked_at is null then
   update xelay_student_private.credit_wallets set granted_micros=granted_micros-o.credit_micros where user_id=o.user_id and granted_micros>=o.credit_micros;
   if not found then raise exception 'MAX_CREDITS_WALLET_CONFLICT'using errcode='PT409';end if;
  end if;
  update xelay_student_private.credit_orders set status=case when p_status='Refunded'then'refunded'else'voided'end,revoked_at=coalesce(revoked_at,clock_timestamp())where id=o.id;
 elsif o.status not in('approved','refunded','voided')and p_status in('Declined','Expired')then
  update xelay_student_private.credit_orders set status=lower(p_status)where id=o.id;
 end if;
 return jsonb_build_object('applied',true,'replayed',false);
end$$;
create function public.xelay_max_credit_order_owned(p_user_id uuid,p_reference text,p_mode text)returns boolean language plpgsql stable security definer set search_path=''as $$begin
 perform xelay_student_private.service();return exists(select 1 from xelay_student_private.credit_orders where user_id=p_user_id and order_reference=p_reference and mode=p_mode);end$$;
create function public.xelay_claim_max_credit_reconciliation(p_user_id uuid,p_reference text,p_mode text)returns boolean language plpgsql security definer set search_path=''as $$begin
 perform xelay_student_private.service();
 update xelay_student_private.credit_orders set last_reconciled_at=clock_timestamp()where user_id=p_user_id and order_reference=p_reference and mode=p_mode
 and(last_reconciled_at is null or last_reconciled_at<clock_timestamp()-interval'1 minute');return found;end$$;

-- Reserve one immutable allocation: use the current subscription allowance first,
-- then purchased credits. Every debit shares the existing per-owner lock.
create or replace function public.xelay_max_ai_reserve(p_user_id uuid,p_session_hash text,p_request_id text,p_fingerprint text,p_reserve_micros bigint,p_monthly_limit_micros bigint,p_request jsonb)
returns jsonb language plpgsql security definer set search_path=''as $$
declare r xelay_student_private.requests;v jsonb;lim bigint;w record;spent bigint;reserved bigint;b jsonb;base_part bigint;wallet_part bigint;available bigint;begin
 perform xelay_student_private.service();
 if not xelay_student_private.identifier(p_request_id)or p_fingerprint is null or p_fingerprint!~'^[a-f0-9]{64}$'or p_reserve_micros is null or p_reserve_micros not between 1 and 10000000 or p_monthly_limit_micros is null or p_monthly_limit_micros not between 1 and 10000000
 or not xelay_student_private.request_valid(p_request)or p_request->>'requestId'<>p_request_id then raise exception 'MAX_RESERVATION_INVALID'using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||p_user_id::text,0));
 if not xelay_student_private.session_active(p_user_id,p_session_hash)then raise exception 'MAX_SESSION_REQUIRED'using errcode='42501';end if;
 v:=xelay_student_private.entitlement(p_user_id);if v->>'planId'<>'max'or v->>'aiAllowance'<>'available'then return jsonb_build_object('state','denied');end if;
 if not xelay_student_private.sources_match(p_user_id,p_request)then raise exception 'MAX_SOURCE_CHANGED'using errcode='42501';end if;
 select*into r from xelay_student_private.requests where user_id=p_user_id and request_id=p_request_id for update;
 if found then
  if r.fingerprint<>p_fingerprint or r.request<>p_request then return jsonb_build_object('state','conflict');end if;
  if r.state='pending'then return jsonb_build_object('state','pending');end if;
  select bundle into b from xelay_student_private.runs where user_id=p_user_id and id=p_request_id;
  if b is not null then return jsonb_build_object('state','replay','bundle',b);end if;return jsonb_build_object('state','conflict');
 end if;
 if(select count(*)from xelay_student_private.requests where user_id=p_user_id and state='pending'and created_at>clock_timestamp()-interval'2 minutes')>=2 then return jsonb_build_object('state','pending');end if;
 if(select count(*)from xelay_student_private.requests where user_id=p_user_id and created_at>clock_timestamp()-interval'1 minute')>=10 then return jsonb_build_object('state','pending');end if;
 select*into w from xelay_student_private.max_budget_window(p_user_id,clock_timestamp());
 if w.grant_id is null then return jsonb_build_object('state','denied');end if;
 lim:=least(p_monthly_limit_micros,(v->'budget'->>'limitMicros')::bigint);
 insert into xelay_student_private.period_usage(user_id,grant_id,cycle)values(p_user_id,w.grant_id,w.cycle)on conflict do nothing;
 select spent_micros,reserved_micros into spent,reserved from xelay_student_private.period_usage where user_id=p_user_id and grant_id=w.grant_id and cycle=w.cycle for update;
 base_part:=least(p_reserve_micros,greatest(0,lim-spent-reserved));wallet_part:=p_reserve_micros-base_part;
 insert into xelay_student_private.credit_wallets(user_id)values(p_user_id)on conflict do nothing;
 select greatest(0,granted_micros-spent_micros-reserved_micros)into available from xelay_student_private.credit_wallets where user_id=p_user_id for update;
 if wallet_part>available or(select count(*)from xelay_student_private.requests where user_id=p_user_id and budget_grant_id=w.grant_id and budget_cycle=w.cycle)>=2000 then return jsonb_build_object('state','denied');end if;
 insert into xelay_student_private.requests(user_id,request_id,fingerprint,session_hash,period,reserve_micros,request,budget_grant_id,budget_cycle,wallet_reserve_micros)
 values(p_user_id,p_request_id,p_fingerprint,p_session_hash,date_trunc('month',clock_timestamp()at time zone'UTC')::date,p_reserve_micros,p_request,w.grant_id,w.cycle,wallet_part)returning*into r;
 update xelay_student_private.period_usage set reserved_micros=reserved_micros+base_part where user_id=p_user_id and grant_id=w.grant_id and cycle=w.cycle;
 update xelay_student_private.credit_wallets set reserved_micros=reserved_micros+wallet_part where user_id=p_user_id;
 return jsonb_build_object('state','reserved','reservationId',r.reservation_id);
end$$;
-- The trigger also settles pre-migration FINISH invocations exactly once.
create or replace function xelay_student_private.settle_paid_request_window()returns trigger language plpgsql security definer set search_path=''as $$
declare base_part bigint;base_charge bigint;wallet_charge bigint;usage_spent bigint;usage_reserved bigint;begin
 if old.state='pending'and new.state='done'and old.budget_grant_id is not null then
  if new.budget_grant_id is distinct from old.budget_grant_id or new.budget_cycle is distinct from old.budget_cycle
   or new.reserve_micros is distinct from old.reserve_micros or new.wallet_reserve_micros is distinct from old.wallet_reserve_micros or new.charge_micros is null then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  base_part:=old.reserve_micros-old.wallet_reserve_micros;
  select spent_micros,reserved_micros into usage_spent,usage_reserved from xelay_student_private.period_usage
   where user_id=old.user_id and grant_id=old.budget_grant_id and cycle=old.budget_cycle for update;
  -- Reuse allowance released by other completed requests in this same period.
  -- Other requests' holds are excluded, and a new month is never borrowed from.
  base_charge:=least(new.charge_micros,greatest(0,10000000-usage_spent-(usage_reserved-base_part)));
  -- A provider accounting overrun must never debit more purchased credits than
  -- this request actually reserved, or retroactively debit an old base-only run.
  wallet_charge:=least(old.wallet_reserve_micros,greatest(0,new.charge_micros-base_charge));base_charge:=new.charge_micros-wallet_charge;
  update xelay_student_private.period_usage set reserved_micros=reserved_micros-base_part,spent_micros=spent_micros+base_charge
   where user_id=old.user_id and grant_id=old.budget_grant_id and cycle=old.budget_cycle and reserved_micros>=base_part;
  if not found then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  insert into xelay_student_private.credit_wallets(user_id)values(old.user_id)on conflict do nothing;
  update xelay_student_private.credit_wallets set reserved_micros=reserved_micros-old.wallet_reserve_micros,spent_micros=spent_micros+wallet_charge
   where user_id=old.user_id and reserved_micros>=old.wallet_reserve_micros;
  if not found then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
 end if;return new;
end$$;
revoke all on function xelay_student_private.credit_summary(uuid),xelay_student_private.entitlement_before_credits(uuid),xelay_student_private.credit_order_snapshot()from public,anon,authenticated,service_role;
revoke all on function public.xelay_max_credit_status(uuid),public.xelay_create_max_credit_order(uuid,text,text,text,text),public.xelay_apply_max_credit_event(text,text,text,text,numeric,text),public.xelay_max_credit_order_owned(uuid,text,text),public.xelay_claim_max_credit_reconciliation(uuid,text,text)from public,anon,authenticated,service_role;
grant execute on function public.xelay_max_credit_status(uuid),public.xelay_create_max_credit_order(uuid,text,text,text,text),public.xelay_apply_max_credit_event(text,text,text,text,numeric,text),public.xelay_max_credit_order_owned(uuid,text,text),public.xelay_claim_max_credit_reconciliation(uuid,text,text)to service_role;
notify pgrst,'reload schema';
commit;
