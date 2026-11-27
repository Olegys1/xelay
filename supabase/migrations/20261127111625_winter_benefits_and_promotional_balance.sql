-- Winter rewards are recorded separately from payments and existing allowance usage.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create schema xelay_winter_private;
revoke all on schema xelay_winter_private from public, anon, authenticated, service_role;

create function xelay_winter_private.clock() returns timestamptz language sql volatile set search_path='' as $$select public.xelay_private_winter_clock()$$;
create function xelay_winter_private.earned(p_user_id uuid,p_day integer) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.winter_advent_claims where user_id=p_user_id and campaign_id='winter-2026' and day=p_day)
$$;
create table xelay_winter_private.benefits(
 user_id uuid not null references public.profiles(id) on delete cascade,
 day smallint not null check(day in(2,4,7,9,13,16,19,23,25,26,30)),
 redeemed_at timestamptz,audience text check(audience in('student','teacher')),
 active_from timestamptz,active_until timestamptz,converted boolean not null default false,
 grant_id uuid,primary key(user_id,day),
 check((redeemed_at is null)=(audience is null)),check(active_until is null or active_until>=active_from)
);
create table xelay_winter_private.wallets(
 user_id uuid primary key references public.profiles(id) on delete cascade,
 activated_at timestamptz,activation_order_id uuid references public.billing_orders(id) on delete restrict,
 spent_micros bigint not null default 0 check(spent_micros between 0 and 450000),
 reserved_micros bigint not null default 0 check(reserved_micros between 0 and 450000)
);
create table xelay_winter_private.purchase_bonuses(
 user_id uuid primary key references public.profiles(id) on delete cascade,
 source_ref text not null unique check(source_ref~'^winter-order:[a-f0-9-]{36}$'),
 micros bigint not null check(micros between 1 and 300000),
 revoked_at timestamptz,created_at timestamptz not null default clock_timestamp()
);
create table xelay_winter_private.pauses(
 user_id uuid not null references public.profiles(id) on delete cascade,audience text not null check(audience in('student','teacher')),
 day smallint not null,starts_at timestamptz not null,ends_at timestamptz not null,resumed_at timestamptz,
 plan_id text not null,grant_id uuid not null,primary key(user_id,day),
 foreign key(user_id,day) references xelay_winter_private.benefits(user_id,day) on delete cascade,
 check(ends_at>starts_at and ends_at<=starts_at+interval'3 days')
);
create index winter_pauses_owner on xelay_winter_private.pauses(user_id,audience,ends_at);
create table xelay_winter_private.audit(
 id bigint generated always as identity primary key,user_id uuid not null references public.profiles(id) on delete cascade,
 day smallint,audience text,action text not null,created_at timestamptz not null default clock_timestamp(),detail jsonb not null default '{}'
);
do $$declare t text;begin foreach t in array array['benefits','wallets','purchase_bonuses','pauses','audit']loop
 execute format('alter table xelay_winter_private.%I enable row level security',t);
 execute format('revoke all on xelay_winter_private.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

create function xelay_winter_private.catalog(p_day integer) returns table(kind text,days integer) language sql immutable set search_path=''as $$
 select kind,days from(values(2,'extension',1),(4,'upgrade',1),(7,'pause',2),(9,'extension',1),(13,'upgrade',1),(16,'pause',2),(19,'extension',2),(23,'upgrade',1),(25,'extension',2),(26,'pause',3),(30,'extension',1))v(day,kind,days) where day=p_day
$$;
-- The public helper deliberately has no client-controlled clock argument.
create function xelay_winter_private.is_paused(p_user_id uuid,p_audience text,p_at timestamptz) returns boolean language sql stable set search_path=''as $$
 select exists(select 1 from xelay_winter_private.pauses where user_id=p_user_id and audience=p_audience and resumed_at is null and starts_at<=p_at and ends_at>p_at)
$$;
create function xelay_winter_private.pause_until(p_user_id uuid,p_audience text) returns timestamptz language sql volatile set search_path=''as $$
 select max(ends_at) from xelay_winter_private.pauses where user_id=p_user_id and audience=p_audience and resumed_at is null and starts_at<=xelay_winter_private.clock() and ends_at>xelay_winter_private.clock()
$$;
create function xelay_winter_private.paid_plan(p_user_id uuid,p_audience text,p_at timestamptz)
returns table(grant_id uuid,period_id uuid,plan_id text,starts_at timestamptz,ends_at timestamptz,order_id uuid)
language sql stable set search_path=''as $$
 select z.* from(
 select g.id,p.id,g.plan_id,p.valid_from,p.valid_until,g.order_id from xelay_student_private.grants g
 join xelay_student_private.grant_periods p on p.grant_id=g.id join public.billing_orders o on o.id=g.order_id
 where p_audience='student' and g.user_id=p_user_id and g.source='payment' and g.revoked_at is null and o.status='approved' and o.mode='live'
 and p.valid_from<=p_at and p.valid_until>p_at
 union all
 select g.id,p.id,g.plan_id,p.valid_from,p.valid_until,g.order_id from xelay_teacher_private.grants g
 join xelay_teacher_private.periods p on p.grant_id=g.id join public.billing_orders o on o.id=g.order_id
 where p_audience='teacher' and g.user_id=p_user_id and g.source='payment' and g.revoked_at is null and o.status='approved' and o.mode='live'
 and p.valid_from<=p_at and p.valid_until>p_at
 )z where not xelay_winter_private.is_paused(p_user_id,p_audience,p_at)
 order by case z.plan_id when'max'then 3 when'teacher_max'then 3 when'plus'then 2 when'teacher_plus'then 2 else 1 end desc,z.valid_until desc limit 1
$$;
create function xelay_winter_private.ai_paid(p_user_id uuid,p_audience text) returns boolean language sql volatile set search_path=''as $$
 select exists(select 1 from xelay_winter_private.paid_plan(p_user_id,p_audience,xelay_winter_private.clock()) p where p.plan_id in('plus','max','teacher_start','teacher_plus','teacher_max'))
$$;
create function xelay_winter_private.upgrade_until(p_user_id uuid,p_audience text) returns timestamptz language sql volatile set search_path=''as $$
 select max(b.active_until) from xelay_winter_private.benefits b cross join lateral xelay_winter_private.catalog(b.day)c
 where b.user_id=p_user_id and b.audience=p_audience and c.kind='upgrade' and not b.converted
 and b.active_from<=xelay_winter_private.clock() and b.active_until>xelay_winter_private.clock()
 and xelay_winter_private.ai_paid(p_user_id,p_audience)
$$;
create function xelay_winter_private.collected_micros(p_user_id uuid) returns bigint language sql stable set search_path=''as $$
 select count(*)*50000 from public.winter_advent_claims where user_id=p_user_id and campaign_id='winter-2026' and day in(1,15,31)
$$;
create function xelay_winter_private.granted_micros(p_user_id uuid) returns bigint language sql stable set search_path=''as $$
 select case when exists(select 1 from xelay_winter_private.wallets where user_id=p_user_id and activated_at is not null)then xelay_winter_private.collected_micros(p_user_id)else 0 end
 +coalesce((select micros from xelay_winter_private.purchase_bonuses where user_id=p_user_id and revoked_at is null),0)
$$;
create function xelay_winter_private.activate(p_user_id uuid) returns void language plpgsql set search_path=''as $$
declare paid record;begin
 insert into xelay_winter_private.wallets(user_id)values(p_user_id)on conflict do nothing;
 if exists(select 1 from xelay_winter_private.wallets where user_id=p_user_id and activated_at is not null)then return;end if;
 if xelay_winter_private.clock()>='2027-02-01 00:00:00 Europe/Kyiv'::timestamptz then raise exception 'WINTER_ACTIVATION_ENDED'using errcode='PT409';end if;
 select * into paid from xelay_winter_private.paid_plan(p_user_id,'student',xelay_winter_private.clock()) where plan_id in('plus','max');
 if not found then select * into paid from xelay_winter_private.paid_plan(p_user_id,'teacher',xelay_winter_private.clock());end if;
 if not found then raise exception 'WINTER_PAID_PLAN_REQUIRED'using errcode='PT409';end if;
 update xelay_winter_private.wallets set activated_at=xelay_winter_private.clock(),activation_order_id=paid.order_id where user_id=p_user_id and activated_at is null;
end$$;
-- PROMO_ACCOUNTING_INTEGRATION
alter table xelay_student_private.requests add column winter_reserve_micros bigint not null default 0 check(winter_reserve_micros>=0 and winter_reserve_micros+wallet_reserve_micros<=reserve_micros);
alter table xelay_teacher_private.requests add column winter_reserve_micros bigint not null default 0 check(winter_reserve_micros between 0 and reserve_micros);
create function xelay_winter_private.patch(p_function regprocedure,p_old text,p_new text)returns void language plpgsql set search_path=''as $$
declare definition text;begin
 definition:=pg_get_functiondef(p_function);
 if cardinality(string_to_array(definition,p_old))<>2 then raise exception 'WINTER_FUNCTION_DRIFT: %',p_function;end if;
 execute replace(definition,p_old,p_new);
end$$;

select xelay_winter_private.patch('public.xelay_max_ai_reserve(uuid,text,text,text,bigint,bigint,jsonb)'::regprocedure,
 'available bigint;begin','available bigint;winter_part bigint;begin');
select xelay_winter_private.patch('public.xelay_max_ai_reserve(uuid,text,text,text,bigint,bigint,jsonb)'::regprocedure,
 'base_part:=least(p_reserve_micros,greatest(0,lim-spent-reserved));wallet_part:=p_reserve_micros-base_part;',
 $patch$base_part:=least(p_reserve_micros,greatest(0,lim-spent-reserved));
 insert into xelay_winter_private.wallets(user_id)values(p_user_id)on conflict do nothing;
 perform 1 from xelay_winter_private.wallets where user_id=p_user_id for update;
 winter_part:=least(p_reserve_micros-base_part,xelay_winter_private.promo_available(p_user_id,'student'));
 wallet_part:=p_reserve_micros-base_part-winter_part;$patch$);
select xelay_winter_private.patch('public.xelay_max_ai_reserve(uuid,text,text,text,bigint,bigint,jsonb)'::regprocedure,
 '(v->>''planId''<>''max'' and wallet_part>0)',
 '(xelay_winter_private.student_entitlement_before(p_user_id)->>''planId''<>''max'' and wallet_part>0)');
select xelay_winter_private.patch('public.xelay_max_ai_reserve(uuid,text,text,text,bigint,bigint,jsonb)'::regprocedure,
 'budget_cycle,wallet_reserve_micros)','budget_cycle,wallet_reserve_micros,winter_reserve_micros)');
select xelay_winter_private.patch('public.xelay_max_ai_reserve(uuid,text,text,text,bigint,bigint,jsonb)'::regprocedure,
 'w.grant_id,w.cycle,wallet_part)returning','w.grant_id,w.cycle,wallet_part,winter_part)returning');
select xelay_winter_private.patch('public.xelay_max_ai_reserve(uuid,text,text,text,bigint,bigint,jsonb)'::regprocedure,
 'update xelay_student_private.credit_wallets set reserved_micros=reserved_micros+wallet_part where user_id=p_user_id;',
 $patch$update xelay_student_private.credit_wallets set reserved_micros=reserved_micros+wallet_part where user_id=p_user_id;
 update xelay_winter_private.wallets set reserved_micros=reserved_micros+winter_part where user_id=p_user_id;$patch$);

create or replace function xelay_student_private.settle_paid_request_window()returns trigger language plpgsql security definer set search_path=''as $$
declare base_part bigint;base_charge bigint;wallet_charge bigint;winter_charge bigint;usage_spent bigint;usage_reserved bigint;period_limit bigint;begin
 if old.state='pending'and new.state='done'and old.budget_grant_id is not null then
  if new.budget_grant_id is distinct from old.budget_grant_id or new.budget_cycle is distinct from old.budget_cycle
   or new.reserve_micros is distinct from old.reserve_micros or new.wallet_reserve_micros is distinct from old.wallet_reserve_micros
   or new.winter_reserve_micros is distinct from old.winter_reserve_micros or new.charge_micros is null then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  base_part:=old.reserve_micros-old.wallet_reserve_micros-old.winter_reserve_micros;
  select spent_micros,reserved_micros into usage_spent,usage_reserved from xelay_student_private.period_usage
   where user_id=old.user_id and grant_id=old.budget_grant_id and cycle=old.budget_cycle for update;
  select case plan_id when'plus'then 3000000 when'max'then 10000000 else 0 end into period_limit from xelay_student_private.grants where id=old.budget_grant_id and user_id=old.user_id;
  if coalesce(period_limit,0)=0 then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  base_charge:=least(new.charge_micros,greatest(0,period_limit-usage_spent-(usage_reserved-base_part)));
  winter_charge:=least(old.winter_reserve_micros,greatest(0,new.charge_micros-base_charge));
  wallet_charge:=least(old.wallet_reserve_micros,greatest(0,new.charge_micros-base_charge-winter_charge));
  base_charge:=new.charge_micros-wallet_charge-winter_charge;
  update xelay_student_private.period_usage set reserved_micros=reserved_micros-base_part,spent_micros=spent_micros+base_charge
   where user_id=old.user_id and grant_id=old.budget_grant_id and cycle=old.budget_cycle and reserved_micros>=base_part;
  if not found then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  insert into xelay_student_private.credit_wallets(user_id)values(old.user_id)on conflict do nothing;
  update xelay_student_private.credit_wallets set reserved_micros=reserved_micros-old.wallet_reserve_micros,spent_micros=spent_micros+wallet_charge where user_id=old.user_id and reserved_micros>=old.wallet_reserve_micros;
  if not found then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  if old.winter_reserve_micros>0 then
   update xelay_winter_private.wallets set reserved_micros=reserved_micros-old.winter_reserve_micros,spent_micros=spent_micros+winter_charge where user_id=old.user_id and reserved_micros>=old.winter_reserve_micros;
   if not found then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  end if;
 end if;return new;
end$$;

select xelay_winter_private.patch('public.xelay_teacher_ai_reserve(uuid,text,jsonb,text,text,bigint)'::regprocedure,
 'lim bigint;ctx jsonb;begin','lim bigint;ctx jsonb;base_part bigint;winter_part bigint;begin');
select xelay_winter_private.patch('public.xelay_teacher_ai_reserve(uuid,text,jsonb,text,text,bigint)'::regprocedure,
 'if used.spent_micros+used.reserved_micros+p_reserve_micros>lim then return jsonb_build_object(''state'',''denied'');end if;',
 $patch$base_part:=least(p_reserve_micros,greatest(0,lim-used.spent_micros-used.reserved_micros));
 insert into xelay_winter_private.wallets(user_id)values(p_user_id)on conflict do nothing;
 perform 1 from xelay_winter_private.wallets where user_id=p_user_id for update;
 winter_part:=p_reserve_micros-base_part;
 if winter_part>xelay_winter_private.promo_available(p_user_id,'teacher')then return jsonb_build_object('state','denied');end if;$patch$);
select xelay_winter_private.patch('public.xelay_teacher_ai_reserve(uuid,text,jsonb,text,text,bigint)'::regprocedure,
 'update xelay_teacher_private.usage set reserved_micros=reserved_micros+p_reserve_micros where user_id=p_user_id and grant_id=g;',
 $patch$update xelay_teacher_private.usage set reserved_micros=reserved_micros+base_part where user_id=p_user_id and grant_id=g;
 update xelay_winter_private.wallets set reserved_micros=reserved_micros+winter_part where user_id=p_user_id;$patch$);
select xelay_winter_private.patch('public.xelay_teacher_ai_reserve(uuid,text,jsonb,text,text,bigint)'::regprocedure,
 'reserve_micros,request,context_hash)','reserve_micros,request,context_hash,winter_reserve_micros)');
select xelay_winter_private.patch('public.xelay_teacher_ai_reserve(uuid,text,jsonb,text,text,bigint)'::regprocedure,
 'g,p_reserve_micros,p_request,p_context_hash)returning','g,p_reserve_micros,p_request,p_context_hash,winter_part)returning');
-- Use one transition trigger for both normal settlement and conservative stale
-- settlement. Otherwise stale requests could debit the subscription a second time.
create function xelay_winter_private.settle_teacher_request()returns trigger language plpgsql security definer set search_path=''as $$
declare base_part bigint;base_charge bigint;winter_charge bigint;lim bigint;used xelay_teacher_private.usage;begin
 if old.state='pending'and new.state='done'then
  if new.grant_id is distinct from old.grant_id or new.reserve_micros<>old.reserve_micros or new.winter_reserve_micros<>old.winter_reserve_micros or new.charge_micros is null then raise exception 'TEACHER_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  base_part:=old.reserve_micros-old.winter_reserve_micros;
  select * into used from xelay_teacher_private.usage where user_id=old.user_id and grant_id=old.grant_id for update;
  select case plan_id when'teacher_start'then 1000000 when'teacher_plus'then 4000000 else 8000000 end into lim from xelay_teacher_private.grants where id=old.grant_id and user_id=old.user_id;
  base_charge:=least(new.charge_micros,greatest(0,lim-used.spent_micros-(used.reserved_micros-base_part)));
  winter_charge:=least(old.winter_reserve_micros,greatest(0,new.charge_micros-base_charge));base_charge:=new.charge_micros-winter_charge;
  update xelay_teacher_private.usage set reserved_micros=reserved_micros-base_part,spent_micros=spent_micros+base_charge where user_id=old.user_id and grant_id=old.grant_id and reserved_micros>=base_part;
  if not found then raise exception 'TEACHER_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  if old.winter_reserve_micros>0 then
   update xelay_winter_private.wallets set reserved_micros=reserved_micros-old.winter_reserve_micros,spent_micros=spent_micros+winter_charge where user_id=old.user_id and reserved_micros>=old.winter_reserve_micros;
   if not found then raise exception 'TEACHER_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  end if;
 end if;return new;
end$$;
create trigger winter_teacher_request_settle after update of state on xelay_teacher_private.requests for each row execute function xelay_winter_private.settle_teacher_request();
select xelay_winter_private.patch('public.xelay_teacher_ai_reserve(uuid,text,jsonb,text,text,bigint)'::regprocedure,
 $patch$update xelay_teacher_private.usage set reserved_micros=reserved_micros-stale.reserve_micros,spent_micros=spent_micros+stale.reserve_micros where user_id=p_user_id and grant_id=stale.grant_id and reserved_micros>=stale.reserve_micros;
  if not found then raise exception 'TEACHER_SETTLEMENT_CONFLICT'using errcode='PT409';end if;$patch$,
 '-- Settlement is performed exactly once by the request transition trigger.');
select xelay_winter_private.patch('public.xelay_teacher_ai_finish(uuid,text,uuid,text,uuid,bigint,jsonb)'::regprocedure,
 $patch$update xelay_teacher_private.usage set reserved_micros=reserved_micros-old.reserve_micros,spent_micros=spent_micros+charge where user_id=p_user_id and grant_id=old.grant_id and reserved_micros>=old.reserve_micros;
 if not found then raise exception 'TEACHER_SETTLEMENT_CONFLICT'using errcode='PT409';end if;$patch$,
 '-- Settlement is performed exactly once by the request transition trigger.');
drop function xelay_winter_private.patch(regprocedure,text,text);
create function xelay_winter_private.promo_available(p_user_id uuid,p_audience text) returns bigint language plpgsql volatile set search_path=''as $$
declare w xelay_winter_private.wallets;begin
 if not xelay_winter_private.ai_paid(p_user_id,p_audience)then return 0;end if;
 select * into w from xelay_winter_private.wallets where user_id=p_user_id;
 if w.user_id is null then return 0;end if;
 return greatest(0,xelay_winter_private.granted_micros(p_user_id)-w.spent_micros-w.reserved_micros);
end$$;
create function xelay_winter_private.award_purchase_bonus(p_user_id uuid,p_source_ref text,p_micros bigint) returns void language plpgsql set search_path=''as $$
declare old xelay_winter_private.purchase_bonuses;begin
 if p_source_ref is null or p_source_ref!~'^winter-order:[a-f0-9-]{36}$' or p_micros is null or p_micros not in(50000,100000,300000)then raise exception 'WINTER_BONUS_INVALID'using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('xelay-winter-2026:'||p_user_id::text,0));
 if not xelay_winter_private.earned(p_user_id,21) and(not xelay_winter_private.earned(p_user_id,11)or p_micros>100000)then raise exception 'WINTER_BONUS_NOT_EARNED'using errcode='42501';end if;
 select * into old from xelay_winter_private.purchase_bonuses where user_id=p_user_id for update;
 if found then if old.source_ref<>p_source_ref or old.micros<>p_micros then raise exception 'WINTER_BONUS_ALREADY_USED'using errcode='PT409';end if;return;end if;
 insert into xelay_winter_private.purchase_bonuses(user_id,source_ref,micros)values(p_user_id,p_source_ref,p_micros);
 insert into xelay_winter_private.wallets(user_id)values(p_user_id)on conflict do nothing;
 if xelay_winter_private.clock()<'2027-02-01 00:00:00 Europe/Kyiv'::timestamptz and xelay_winter_private.collected_micros(p_user_id)>0
 and(xelay_winter_private.ai_paid(p_user_id,'student')or xelay_winter_private.ai_paid(p_user_id,'teacher'))then perform xelay_winter_private.activate(p_user_id);end if;
end$$;
create function xelay_winter_private.revoke_purchase_bonus(p_user_id uuid,p_source_ref text) returns void language plpgsql volatile set search_path=''as $$begin
 -- Student and teacher reservations use different owner locks but the same
 -- wallet. Serialize revocation with both so no new hold can use refunded credit.
 perform 1 from xelay_winter_private.wallets where user_id=p_user_id for update;
 update xelay_winter_private.purchase_bonuses set revoked_at=coalesce(revoked_at,xelay_winter_private.clock())where user_id=p_user_id and source_ref=p_source_ref;
end$$;

-- Keep the exact pre-winter entitlement implementations, including legacy gifts.
do $copy$declare spec text[];definition text;oldname text;newname text;begin
 foreach spec slice 1 in array array[
 ['xelay_student_private.entitlement(uuid)','xelay_student_private.entitlement','xelay_winter_private.student_entitlement_before'],
 ['xelay_teacher_private.entitlement(uuid)','xelay_teacher_private.entitlement','xelay_winter_private.teacher_entitlement_before'],
 ['public.xelay_has_participant_access(uuid)','public.xelay_has_participant_access','xelay_winter_private.participant_access_before']
 ]loop
 definition:=pg_get_functiondef(spec[1]::regprocedure);oldname:='CREATE OR REPLACE FUNCTION '||spec[2]||'(';newname:='CREATE FUNCTION '||spec[3]||'(';
 if position(oldname in definition)<>1 or position('xelay_winter_private' in definition)>0 then raise exception 'WINTER_PREREQUISITE_DRIFT';end if;
 execute replace(definition,oldname,newname);
 end loop;
end$copy$;
create or replace function xelay_student_private.entitlement(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=''as $$
declare e jsonb;until_at timestamptz;begin
 e:=xelay_winter_private.student_entitlement_before(p_user_id);
 if xelay_winter_private.is_paused(p_user_id,'student',xelay_winter_private.clock())then
  return e||jsonb_build_object('planId','free','aiAllowance','not_included','monthlyAiBudgetUsd',0,'budget',jsonb_build_object('limitMicros',0,'spentMicros',0,'reservedMicros',0),'legacyBenefits',false,'winterPausedUntil',xelay_winter_private.pause_until(p_user_id,'student'));
 end if;
 until_at:=xelay_winter_private.upgrade_until(p_user_id,'student');
 if until_at is not null and e->>'planId'='plus' then e:=e||jsonb_build_object('planId','max','winterUpgradeUntil',until_at);end if;
 return e||jsonb_build_object('winterPromoCredits',xelay_winter_private.promo_available(p_user_id,'student')::numeric/1000);
end$$;
create or replace function xelay_teacher_private.entitlement(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=''as $$
declare e jsonb;until_at timestamptz;available bigint;begin
 e:=xelay_winter_private.teacher_entitlement_before(p_user_id);
 if xelay_winter_private.is_paused(p_user_id,'teacher',xelay_winter_private.clock())then
  return e||jsonb_build_object('planId','free','canGenerate',false,'canEdit',false,'budget',jsonb_build_object('limitMicros',0,'spentMicros',0,'reservedMicros',0),'allowedModes','[]'::jsonb,'winterPausedUntil',xelay_winter_private.pause_until(p_user_id,'teacher'));
 end if;
 until_at:=xelay_winter_private.upgrade_until(p_user_id,'teacher');
 if until_at is not null and e->>'planId' in('teacher_start','teacher_plus')then e:=e||jsonb_build_object('winterBasePlanId',e->>'planId','planId','teacher_max','allowedModes',to_jsonb(xelay_teacher_private.modes('teacher_max')),'winterUpgradeUntil',until_at);end if;
 available:=xelay_winter_private.promo_available(p_user_id,'teacher');
 return e||jsonb_build_object('winterPromoCredits',available::numeric/1000,'canGenerate',e->>'planId'<>'free' and coalesce((e->'budget'->>'limitMicros')::bigint-(e->'budget'->>'spentMicros')::bigint-(e->'budget'->>'reservedMicros')::bigint,0)+available>=50000);
end$$;
create or replace function public.xelay_has_participant_access(p_user_id uuid) returns boolean language sql stable security definer set search_path=''as $$
 select not xelay_winter_private.is_paused(p_user_id,'student',xelay_winter_private.clock()) and xelay_winter_private.participant_access_before(p_user_id)
$$;

create function xelay_winter_private.no_pending(p_user_id uuid,p_audience text) returns void language plpgsql set search_path=''as $$begin
 if p_audience='student' and exists(select 1 from xelay_student_private.requests where user_id=p_user_id and state='pending')
 or p_audience='teacher' and exists(select 1 from xelay_teacher_private.requests where user_id=p_user_id and state='pending')then
 raise exception 'WINTER_PENDING_REQUEST'using errcode='PT409';end if;
end$$;
create function xelay_winter_private.extend_period(p_user_id uuid,p_audience text,p_period_id uuid,p_days integer) returns timestamptz
language plpgsql set search_path=''as $$
declare schema_name text;table_name text;until_at timestamptz;delta interval:=make_interval(days=>p_days);begin
 if p_audience not in('student','teacher')or p_days not between 1 and 2 then raise exception 'WINTER_EXTENSION_INVALID'using errcode='22023';end if;
 schema_name:=case p_audience when'student'then'xelay_student_private'else'xelay_teacher_private'end;
 table_name:=case p_audience when'student'then'grant_periods'else'periods'end;
 execute format('select p.valid_until from %I.%I p join %I.grants g on g.id=p.grant_id where p.id=$1 and g.user_id=$2 and g.source=''payment'' and g.revoked_at is null for update of p',schema_name,table_name,schema_name)into until_at using p_period_id,p_user_id;
 if until_at is null then raise exception 'WINTER_PAID_PLAN_REQUIRED'using errcode='PT409';end if;
 -- Preserve every future period, including already queued gifts. Existing usage
 -- remains keyed to the same grant; extension never creates another allowance.
 execute format('update %I.%I p set valid_from=p.valid_from+$1,valid_until=p.valid_until+$1 from %I.grants g where p.grant_id=g.id and g.user_id=$2 and g.revoked_at is null and p.valid_from>=$3 and p.id<>$4',schema_name,table_name,schema_name)using delta,p_user_id,until_at,p_period_id;
 execute format('update %I.%I set valid_until=valid_until+$1 where id=$2',schema_name,table_name)using delta,p_period_id;
 if p_audience='student'then
  update public.participant_entitlements set valid_from=valid_from+delta,valid_until=valid_until+delta where user_id=p_user_id and revoked_at is null and valid_from>=until_at;
 end if;
 return until_at+delta;
end$$;
create function xelay_winter_private.shift_paid_time(p_user_id uuid,p_audience text,p_from timestamptz,p_delta interval,p_split boolean)
returns void language plpgsql set search_path=''as $$
declare schema_name text;table_name text;r record;begin
 if p_audience not in('student','teacher')or p_delta=interval'0'then raise exception 'WINTER_PAUSE_INVALID'using errcode='22023';end if;
 schema_name:=case p_audience when'student'then'xelay_student_private'else'xelay_teacher_private'end;
 table_name:=case p_audience when'student'then'grant_periods'else'periods'end;
 for r in execute format('select p.* from %I.%I p join %I.grants g on g.id=p.grant_id where g.user_id=$1 and (g.source=''payment''or p.valid_from>=$2) and g.revoked_at is null and p.valid_until>$2 order by p.valid_from,p.id for update of p',schema_name,table_name,schema_name)using p_user_id,p_from loop
  if p_split and r.valid_from<p_from then
   execute format('update %I.%I set valid_until=$1 where id=$2',schema_name,table_name)using p_from,r.id;
   execute format('insert into %I.%I(grant_id,valid_from,valid_until)values($1,$2,$3)',schema_name,table_name)using r.grant_id,p_from+p_delta,r.valid_until+p_delta;
  else
   execute format('update %I.%I set valid_from=valid_from+$1,valid_until=valid_until+$1 where id=$2',schema_name,table_name)using p_delta,r.id;
  end if;
 end loop;
 if p_audience='student'then
  update public.participant_entitlements set valid_from=valid_from+p_delta,valid_until=valid_until+p_delta where user_id=p_user_id and revoked_at is null and valid_from>=p_from;
 end if;
end$$;
create function xelay_winter_private.subscription_json(p_user_id uuid,p_audience text) returns jsonb language plpgsql volatile set search_path=''as $$
declare p record;pause xelay_winter_private.pauses;upgrade timestamptz;begin
 select * into p from xelay_winter_private.paid_plan(p_user_id,p_audience,xelay_winter_private.clock());
 select * into pause from xelay_winter_private.pauses where user_id=p_user_id and audience=p_audience and resumed_at is null and starts_at<=xelay_winter_private.clock() and ends_at>xelay_winter_private.clock()order by ends_at desc limit 1;
 upgrade:=xelay_winter_private.upgrade_until(p_user_id,p_audience);
 return jsonb_build_object('planId',coalesce(p.plan_id,pause.plan_id),'effectivePlanId',case when upgrade is not null then case p_audience when'student'then'max'else'teacher_max'end else p.plan_id end,
 'expiresAt',p.ends_at,'pausedUntil',pause.ends_at,'upgradeUntil',upgrade);
end$$;
create function xelay_winter_private.state(p_user_id uuid) returns jsonb language plpgsql volatile set search_path=''as $$
declare w xelay_winter_private.wallets;items jsonb;v_now timestamptz:=xelay_winter_private.clock();available bigint;begin
 select * into w from xelay_winter_private.wallets where user_id=p_user_id;
 available:=greatest(xelay_winter_private.promo_available(p_user_id,'student'),xelay_winter_private.promo_available(p_user_id,'teacher'));
 select coalesce(jsonb_agg(jsonb_build_object('day',claim.day,'kind',c.kind,'amountDays',c.days,'status',
  case when b.redeemed_at is null then case when v_now>='2027-03-01 00:00:00 Europe/Kyiv'::timestamptz then'expired'else'available'end
   when b.active_from<=v_now and b.active_until>v_now then'active'else'used'end,
  'audience',b.audience,'activeUntil',b.active_until,'convertedToExtension',coalesce(b.converted,false))order by claim.day),'[]'::jsonb)into items
 from public.winter_advent_claims claim cross join lateral xelay_winter_private.catalog(claim.day)c
 left join xelay_winter_private.benefits b on b.user_id=claim.user_id and b.day=claim.day
 where claim.user_id=p_user_id and claim.campaign_id='winter-2026';
 return jsonb_build_object('campaignId','winter-2026','serverNow',v_now,'eligible',true,'activationEndsAt','2027-02-28T22:00:00.000Z',
 'promo',jsonb_build_object('collectedCredits',xelay_winter_private.collected_micros(p_user_id)::numeric/1000,
  'purchaseBonusCredits',coalesce((select micros from xelay_winter_private.purchase_bonuses where user_id=p_user_id and revoked_at is null),0)::numeric/1000,
  'availableCredits',available::numeric/1000,'reservedCredits',coalesce(w.reserved_micros,0)::numeric/1000,'spentCredits',coalesce(w.spent_micros,0)::numeric/1000,
  'activatedAt',w.activated_at,'activationEndsAt','2027-01-31T22:00:00.000Z','usable',available>0),
 'subscriptions',jsonb_build_object('student',xelay_winter_private.subscription_json(p_user_id,'student'),'teacher',xelay_winter_private.subscription_json(p_user_id,'teacher')),'benefits',items);
end$$;
create function public.xelay_winter_benefits(p_user_id uuid,p_session_id uuid,p_action jsonb default null) returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare v_now timestamptz:=xelay_winter_private.clock();aud text;day_no integer;c record;p record;b xelay_winter_private.benefits;pause xelay_winter_private.pauses;
 until_at timestamptz;delta interval;v_hits integer;v_started timestamptz;begin
 if coalesce(current_setting('request.jwt.claims',true),'')=''or coalesce(current_setting('request.jwt.claims',true)::jsonb->>'role','')<>'service_role'
 or p_user_id is null or p_session_id is null or not exists(select 1 from auth.users u join auth.sessions s on s.user_id=u.id and s.id=p_session_id join public.profiles profile_row on profile_row.id=u.id
 where u.id=p_user_id and u.email_confirmed_at is not null and u.deleted_at is null and not coalesce(u.is_anonymous,false)and(u.banned_until is null or u.banned_until<=v_now)and(s.not_after is null or s.not_after>v_now))then raise exception 'WINTER_ACCOUNT_REQUIRED'using errcode='42501';end if;
 if p_action is null then return xelay_winter_private.state(p_user_id);end if;
 if jsonb_typeof(p_action)<>'object'or not(p_action->>'action')=any(array['activate_credits','redeem','resume'])then raise exception 'WINTER_ACTION_INVALID'using errcode='22023';end if;
 aud:=p_action->>'audience';
 -- Match the established payment/AI lock order before the campaign lock.
 if aud='student'then
  perform pg_advisory_xact_lock(hashtextextended('max-owner:'||p_user_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('student-owner:'||p_user_id::text,0));
 elsif aud='teacher'then
  perform pg_advisory_xact_lock(hashtextextended('student-owner:'||p_user_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('teacher-owner:'||p_user_id::text,0));
 end if;
 perform pg_advisory_xact_lock(hashtextextended('xelay-winter-2026:'||p_user_id::text,0));
 select window_started_at,hits into v_started,v_hits from public.winter_advent_claim_rate where user_id=p_user_id for update;
 if v_started>v_now-interval'1 minute'and v_hits>=60 then raise exception 'WINTER_RATE_LIMIT'using errcode='PT429';end if;
 insert into public.winter_advent_claim_rate(user_id,window_started_at,hits)values(p_user_id,v_now,1)on conflict(user_id)do update set window_started_at=case when v_started<=v_now-interval'1 minute'then v_now else v_started end,hits=case when v_started<=v_now-interval'1 minute'then 1 else v_hits+1 end;
 if p_action->>'action'='activate_credits'then
  if p_action<>jsonb_build_object('action','activate_credits')or xelay_winter_private.collected_micros(p_user_id)=0 then raise exception 'WINTER_NOT_EARNED'using errcode='PT409';end if;
  perform xelay_winter_private.activate(p_user_id);return xelay_winter_private.state(p_user_id);
 end if;
 aud:=p_action->>'audience';if aud is null or aud not in('student','teacher')then raise exception 'WINTER_ACTION_INVALID'using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(case aud when'student'then'max-owner:'else'teacher-owner:'end||p_user_id::text,0));
 if p_action->>'action'='resume'then
  if p_action<>jsonb_build_object('action','resume','audience',aud)then raise exception 'WINTER_ACTION_INVALID'using errcode='22023';end if;
  select * into pause from xelay_winter_private.pauses where user_id=p_user_id and audience=aud and resumed_at is null and starts_at<=v_now and ends_at>v_now for update;
  if found then
   perform xelay_winter_private.no_pending(p_user_id,aud);delta:=v_now-pause.ends_at;
   perform xelay_winter_private.shift_paid_time(p_user_id,aud,pause.ends_at,delta,false);
   update xelay_winter_private.pauses set resumed_at=v_now where user_id=p_user_id and day=pause.day;
   update xelay_winter_private.benefits set active_until=v_now where user_id=p_user_id and day=pause.day;
   insert into xelay_winter_private.audit(user_id,day,audience,action,detail)values(p_user_id,pause.day,aud,'resume',jsonb_build_object('seconds',extract(epoch from(v_now-pause.starts_at))));
  end if;
  return xelay_winter_private.state(p_user_id);
 end if;
 if jsonb_typeof(p_action->'day')<>'number'or(p_action->>'day')!~'^[0-9]{1,2}$'then raise exception 'WINTER_ACTION_INVALID'using errcode='22023';end if;
 day_no:=(p_action->>'day')::integer;
 if p_action<>jsonb_build_object('action','redeem','day',day_no,'audience',aud)then raise exception 'WINTER_ACTION_INVALID'using errcode='22023';end if;
 select * into c from xelay_winter_private.catalog(day_no);
 if not found or not xelay_winter_private.earned(p_user_id,day_no)then raise exception 'WINTER_NOT_EARNED'using errcode='PT409';end if;
 insert into xelay_winter_private.benefits(user_id,day)values(p_user_id,day_no)on conflict do nothing;
 select * into b from xelay_winter_private.benefits where user_id=p_user_id and day=day_no for update;
 if b.redeemed_at is not null then
  if b.audience<>aud then raise exception 'WINTER_ALREADY_REDEEMED'using errcode='PT409';end if;return xelay_winter_private.state(p_user_id);
 end if;
 if v_now>='2027-03-01 00:00:00 Europe/Kyiv'::timestamptz then raise exception 'WINTER_ACTIVATION_ENDED'using errcode='PT409';end if;
 if xelay_winter_private.is_paused(p_user_id,aud,v_now)then raise exception 'WINTER_SUBSCRIPTION_PAUSED'using errcode='PT409';end if;
 select * into p from xelay_winter_private.paid_plan(p_user_id,aud,v_now);
 if not found then raise exception 'WINTER_PAID_PLAN_REQUIRED'using errcode='PT409';end if;
 if c.kind='upgrade'and p.plan_id='start'then raise exception 'WINTER_PAID_PLAN_REQUIRED'using errcode='PT409';end if;
 if c.kind='upgrade'and p.plan_id not in('max','teacher_max')and(
  aud='student'and exists(select 1 from xelay_student_private.grants g join xelay_student_private.grant_periods s on s.grant_id=g.id where g.user_id=p_user_id and g.source<>'payment'and g.plan_id='max'and g.revoked_at is null and s.valid_from<=v_now and s.valid_until>v_now)
  or aud='teacher'and exists(select 1 from xelay_teacher_private.grants g join xelay_teacher_private.periods s on s.grant_id=g.id where g.user_id=p_user_id and g.source<>'payment'and g.plan_id='teacher_max'and g.revoked_at is null and s.valid_from<=v_now and s.valid_until>v_now)
 )then raise exception 'WINTER_UPGRADE_GIFT_ACTIVE'using errcode='PT409';end if;
 if c.kind='extension'or c.kind='upgrade'and p.plan_id in('max','teacher_max')then
  until_at:=xelay_winter_private.extend_period(p_user_id,aud,p.period_id,c.days);
  update xelay_winter_private.benefits set redeemed_at=v_now,audience=aud,grant_id=p.grant_id,converted=c.kind='upgrade' where user_id=p_user_id and day=day_no;
 elsif c.kind='upgrade'then
  until_at:=least(p.ends_at,greatest(v_now,coalesce(xelay_winter_private.upgrade_until(p_user_id,aud),v_now))+make_interval(days=>c.days));
  if until_at<v_now+make_interval(days=>c.days)then raise exception 'WINTER_PAID_PLAN_REQUIRED'using errcode='PT409';end if;
  update xelay_winter_private.benefits set redeemed_at=v_now,audience=aud,grant_id=p.grant_id,active_from=v_now,active_until=until_at where user_id=p_user_id and day=day_no;
 else
  perform xelay_winter_private.no_pending(p_user_id,aud);
  if xelay_winter_private.upgrade_until(p_user_id,aud)is not null then raise exception 'WINTER_UPGRADE_ACTIVE'using errcode='PT409';end if;
  -- An active independent gift is not a paid term. Pausing it would either
  -- consume its time or reset its calendar-based allowance after a split.
  if aud='student'and(exists(select 1 from xelay_student_private.grants g join xelay_student_private.grant_periods s on s.grant_id=g.id where g.user_id=p_user_id and g.source<>'payment'and g.revoked_at is null and s.valid_from<=v_now and s.valid_until>v_now)
   or exists(select 1 from public.participant_entitlements e where e.user_id=p_user_id and e.revoked_at is null and e.valid_from<=v_now and e.valid_until>v_now))
   or aud='teacher'and exists(select 1 from xelay_teacher_private.grants g join xelay_teacher_private.periods s on s.grant_id=g.id where g.user_id=p_user_id and g.source<>'payment'and g.revoked_at is null and s.valid_from<=v_now and s.valid_until>v_now)
  then raise exception 'WINTER_GIFT_ACTIVE'using errcode='PT409';end if;
  until_at:=v_now+make_interval(days=>c.days);
  perform xelay_winter_private.shift_paid_time(p_user_id,aud,v_now,make_interval(days=>c.days),true);
  update xelay_winter_private.benefits set redeemed_at=v_now,audience=aud,grant_id=p.grant_id,active_from=v_now,active_until=until_at where user_id=p_user_id and day=day_no;
  insert into xelay_winter_private.pauses(user_id,audience,day,starts_at,ends_at,plan_id,grant_id)values(p_user_id,aud,day_no,v_now,until_at,p.plan_id,p.grant_id);
 end if;
 insert into xelay_winter_private.audit(user_id,day,audience,action,detail)values(p_user_id,day_no,aud,c.kind,jsonb_build_object('grant_id',p.grant_id,'until',until_at,'days',c.days));
 return xelay_winter_private.state(p_user_id);
end$$;

-- A checkout begun before pausing may still finish. Start its access after the
-- pause inside the original allocator, which already preserves queued periods.
do $pause_payments$declare signature text;definition text;needle text;replacement text;aud text;begin
 foreach signature in array array['xelay_student_private.reflow_after_refund(uuid)','xelay_teacher_private.refund_reflow(uuid)']loop
  aud:=case when signature like'xelay_student%'then'student'else'teacher'end;
  definition:=pg_get_functiondef(signature::regprocedure);needle:='cursor_at timestamptz:=clock_timestamp();';
  if cardinality(string_to_array(definition,needle))<>2 then raise exception 'WINTER_REFUND_PAUSE_DRIFT: %',signature;end if;
  execute replace(definition,needle,'cursor_at timestamptz:=greatest(clock_timestamp(),coalesce(xelay_winter_private.pause_until(p_user_id,'''||aud||'''),clock_timestamp()));');
 end loop;
 foreach signature in array array['xelay_student_private.activate_paid_order(uuid)','xelay_teacher_private.activate(uuid)']loop
  aud:=case when signature like'xelay_student%'then'student'else'teacher'end;
  definition:=pg_get_functiondef(signature::regprocedure);
  needle:=case aud when'student'then'rank:=xelay_student_private.plan_rank(o.student_plan_id);'else'select greatest(v_now,coalesce(max(p.valid_until),v_now))into v_from'end;
  replacement:='v_now:=greatest(v_now,coalesce(xelay_winter_private.pause_until(o.user_id,'''||aud||'''),v_now));'||chr(10)||needle;
  if cardinality(string_to_array(definition,needle))<>2 then raise exception 'WINTER_PAYMENT_PAUSE_DRIFT: %',signature;end if;
  execute replace(definition,needle,replacement);
 end loop;
 foreach signature in array array['public.xelay_create_student_plan_order(uuid,text,text,text)','public.xelay_create_teacher_plan_order(uuid,text,text,text)','public.xelay_create_discounted_student_plan_order(uuid,text,text,text,uuid)']loop
  aud:=case when signature like'%teacher%'then'teacher'else'student'end;
  definition:=pg_get_functiondef(signature::regprocedure);needle:='perform xelay_student_private.service();';
  if cardinality(string_to_array(definition,needle))<>2 then raise exception 'WINTER_CHECKOUT_PAUSE_DRIFT: %',signature;end if;
  execute replace(definition,needle,needle||chr(10)||'if xelay_winter_private.is_paused(p_user_id,'''||aud||''',xelay_winter_private.clock())then raise exception ''WINTER_SUBSCRIPTION_PAUSED''using errcode=''PT409'';end if;');
 end loop;
end$pause_payments$;
do $legacy_checkout$declare definition text;begin
 definition:=pg_get_functiondef('public.xelay_create_billing_order(uuid,text,text,text,uuid)'::regprocedure);
 if position('CREATE OR REPLACE FUNCTION public.xelay_create_billing_order('in definition)<>1 then raise exception 'WINTER_LEGACY_CHECKOUT_DRIFT';end if;
 execute replace(definition,'CREATE OR REPLACE FUNCTION public.xelay_create_billing_order(','CREATE FUNCTION xelay_winter_private.legacy_checkout_before(');
end$legacy_checkout$;
create or replace function public.xelay_create_billing_order(p_user_id uuid,p_product text,p_mode text,p_order_reference text,p_group_id uuid default null)
returns jsonb language plpgsql security definer set search_path=''as $$begin
 perform xelay_student_private.service();
 if p_product='participant'and(xelay_winter_private.is_paused(p_user_id,'student',xelay_winter_private.clock())or xelay_winter_private.is_paused(p_user_id,'teacher',xelay_winter_private.clock()))then raise exception 'WINTER_SUBSCRIPTION_PAUSED'using errcode='PT409';end if;
 return xelay_winter_private.legacy_checkout_before(p_user_id,p_product,p_mode,p_order_reference,p_group_id);
end$$;
-- No browser or service credential may invoke individual helpers or edit the
-- ledger. The service-only entrypoint validates the verified owner/session.
revoke all on all functions in schema xelay_winter_private from public,anon,authenticated,service_role;
revoke all on function public.xelay_winter_benefits(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_winter_benefits(uuid,uuid,jsonb) to service_role;
comment on schema xelay_winter_private is 'Private campaign ledger; paid periods retain their original usage identities.';
commit;
