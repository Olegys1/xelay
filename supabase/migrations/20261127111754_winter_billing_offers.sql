-- Winter coupons reserve a single immutable payable order. Existing payment paths delegate unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema xelay_winter_payment_private;
revoke all on schema xelay_winter_payment_private from public,anon,authenticated,service_role;

create function xelay_winter_payment_private.service_user(p_user_id uuid) returns void language plpgsql security definer set search_path='' as $$begin
 perform xelay_student_private.service();
 if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id where u.id=p_user_id and u.email_confirmed_at is not null and u.deleted_at is null and(u.banned_until is null or u.banned_until<=clock_timestamp()))then raise exception 'WINTER_ACTIVE_ACCOUNT_REQUIRED' using errcode='42501';end if;
end$$;
-- One paid order may contain twelve independent monthly allowance grants.
alter table xelay_student_private.grants add column order_cycle integer not null default 0 check(order_cycle between 0 and 11);
alter table xelay_teacher_private.grants add column order_cycle integer not null default 0 check(order_cycle between 0 and 11);
do $$declare sch text;c record;begin foreach sch in array array['xelay_student_private','xelay_teacher_private']loop
 for c in select conname from pg_constraint where conrelid=format('%I.grants',sch)::regclass and contype='u' and conkey=array[(select attnum from pg_attribute where attrelid=format('%I.grants',sch)::regclass and attname='order_id')]::smallint[]loop
 execute format('alter table %I.grants drop constraint %I',sch,c.conname);end loop;
 execute format('alter table %I.grants add constraint winter_paid_order_cycle unique(order_id,order_cycle)',sch);
end loop;end$$;

create function xelay_winter_payment_private.activate(p_order_id uuid)returns void language plpgsql security definer set search_path=''as $$
declare o public.billing_orders;aud text;fixed text;sch text;period_table text;rank_function text;plan text;r integer;
 start_at timestamptz;end_at timestamptz;cursor_at timestamptz;v_now timestamptz:=xelay_winter_private.clock();prior record;cut_at timestamptz;remaining interval;g uuid;i integer;month_from timestamptz;month_until timestamptz;exists_grant boolean;
begin
 select*into o from public.billing_orders where id=p_order_id for update;
 if not found or o.status<>'approved'or o.mode<>'live'or not xelay_winter_payment_private.price_valid(to_jsonb(o))
 or not exists(select 1 from xelay_winter_payment_private.redemptions where user_id=o.user_id and order_id=o.id)then raise exception 'WINTER_APPROVED_ORDER_REQUIRED';end if;
 aud:=case when o.teacher_plan_id is null then'student'else'teacher'end;plan:=coalesce(o.student_plan_id,o.teacher_plan_id);
 -- Same owner-lock order as ordinary student / teacher billing and allowance settlement.
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||o.user_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('student-owner:'||o.user_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('teacher-owner:'||o.user_id::text,0));
 select audience into fixed from xelay_student_private.audiences where user_id=o.user_id;
 if fixed is not null and fixed<>aud then raise exception 'WINTER_AUDIENCE';end if;
 insert into xelay_student_private.audiences(user_id,audience,source,reason)values(o.user_id,aud,case when aud='student'then'paid_student_order'else'paid_teacher_order'end,'Verified winter subscription '||o.order_reference)on conflict do nothing;
 sch:=case when aud='student'then'xelay_student_private'else'xelay_teacher_private'end;
 period_table:=case when aud='student'then'grant_periods'else'periods'end;
 rank_function:=case when aud='student'then'plan_rank'else'rank'end;
 execute format('select exists(select 1 from %I.grants where order_id=$1)',sch)into exists_grant using o.id;if exists_grant then return;end if;
 execute format('select %I.%I($1)',sch,rank_function)into r using plan;
 start_at:=greatest(v_now,coalesce(xelay_winter_private.pause_until(o.user_id,aud),v_now));
 execute format('select greatest($1,coalesce(max(p.valid_until),$1)) from %I.%I p join %I.grants z on z.id=p.grant_id where z.user_id=$2 and z.revoked_at is null and p.valid_until>$1 and %I.%I(z.plan_id)>=$3',sch,period_table,sch,sch,rank_function)into start_at using start_at,o.user_id,r;
 if aud='student'and r=1 then select greatest(start_at,coalesce(max(valid_until),start_at))into start_at from public.participant_entitlements where user_id=o.user_id and revoked_at is null and valid_until>v_now;end if;
 end_at:=((start_at at time zone'Europe/Kyiv')+make_interval(months=>o.winter_term_months))at time zone'Europe/Kyiv';cursor_at:=end_at;
 -- Carry over lower-tier paid AND gifted remaining time; never reset its allowance identity.
 for prior in execute format('select p.* from %I.%I p join %I.grants z on z.id=p.grant_id where z.user_id=$1 and z.revoked_at is null and p.valid_until>$2 and %I.%I(z.plan_id)<$3 order by p.valid_from,z.created_at,p.id for update of p',sch,period_table,sch,sch,rank_function)using o.user_id,start_at,r loop
  if prior.valid_from>=cursor_at then cursor_at:=prior.valid_until;continue;end if;
  cut_at:=greatest(prior.valid_from,start_at);remaining:=prior.valid_until-cut_at;
  if prior.valid_from<cut_at then
   execute format('update %I.%I set valid_until=$1 where id=$2',sch,period_table)using cut_at,prior.id;
   execute format('insert into %I.%I(grant_id,valid_from,valid_until)values($1,$2,$3)',sch,period_table)using prior.grant_id,cursor_at,cursor_at+remaining;
  else execute format('update %I.%I set valid_from=$1,valid_until=$2 where id=$3',sch,period_table)using cursor_at,cursor_at+remaining,prior.id;end if;
  execute format('insert into %I.schedule_audit(grant_id,original_from,original_until,new_from,new_until,reason)values($1,$2,$3,$4,$5,$6)',sch)using prior.grant_id,prior.valid_from,prior.valid_until,cursor_at,cursor_at+remaining,'winter_upgrade:'||o.id::text;
  cursor_at:=cursor_at+remaining;
 end loop;
 for i in 0..o.winter_term_months-1 loop
  -- Both boundaries use the original anchor (Jan31 -> Feb28 -> Mar31), not repeated clamping.
  month_from:=((start_at at time zone'Europe/Kyiv')+make_interval(months=>i))at time zone'Europe/Kyiv';
  month_until:=((start_at at time zone'Europe/Kyiv')+make_interval(months=>i+1))at time zone'Europe/Kyiv';
  if aud='student'then
   insert into xelay_student_private.grants(user_id,plan_id,source,reference,valid_from,valid_until,order_id,order_cycle)values(o.user_id,plan,'payment','winter:'||o.id::text||':'||i,month_from,month_until,o.id,i)returning id into g;
  else insert into xelay_teacher_private.grants(user_id,plan_id,order_id,valid_from,valid_until,order_cycle)values(o.user_id,plan,o.id,month_from,month_until,i)returning id into g;end if;
  execute format('insert into %I.%I(grant_id,valid_from,valid_until)values($1,$2,$3)',sch,period_table)using g,month_from,month_until;
 end loop;
end$$;
create function xelay_winter_payment_private.expires() returns timestamptz language sql immutable set search_path='' as $$select '2027-03-01 00:00:00 Europe/Kyiv'::timestamptz$$;
create function xelay_winter_payment_private.available() returns boolean language sql volatile set search_path='' as $$select xelay_winter_private.clock()>='2026-12-01 00:00:00 Europe/Kyiv'::timestamptz and xelay_winter_private.clock()<xelay_winter_payment_private.expires()$$;
create function xelay_winter_payment_private.percent(p_user_id uuid,p_kind text,p_tier text default null) returns integer language sql stable set search_path='' as $$
 select coalesce(max(v.percent),0) from(values
 (3,'monthly','start',10),(6,'monthly','plus',10),(8,'monthly','max',5),
 (12,'monthly','start',20),(14,'monthly','plus',15),(17,'monthly','max',10),
 (22,'monthly','start',25),(24,'monthly','plus',20),(27,'monthly','max',15),
 (10,'annual',null,10),(20,'annual',null,15),(29,'annual',null,20),
 (5,'friend',null,10),(18,'friend',null,15),(28,'friend',null,20),(11,'credits',null,5),(21,'credits',null,10)
 )v(day,kind,tier,percent) where v.kind=p_kind and v.tier is not distinct from p_tier and xelay_winter_private.earned(p_user_id,v.day)
$$;
create table xelay_winter_payment_private.friends(
 owner_id uuid primary key references public.profiles(id) on delete cascade,
 token text not null unique check(token~'^[a-f0-9]{64}$'),percent integer not null check(percent in(10,15,20)),
 recipient_id uuid unique references public.profiles(id) on delete restrict,accepted_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),check(recipient_id is distinct from owner_id),check((recipient_id is null)=(accepted_at is null))
);
create table xelay_winter_payment_private.redemptions(
 user_id uuid primary key references public.profiles(id) on delete restrict,order_id uuid not null unique references public.billing_orders(id) on delete restrict,
 source text not null check(source in('own','friend')),friend_owner uuid references xelay_winter_payment_private.friends(owner_id) on delete restrict,
 redeemed_at timestamptz,created_at timestamptz not null default clock_timestamp(),check((source='friend')=(friend_owner is not null))
);
create table xelay_winter_payment_private.retired_orders(
 order_id uuid primary key references public.billing_orders(id)on delete restrict,user_id uuid not null references public.profiles(id)on delete restrict,
 retired_at timestamptz not null default clock_timestamp()
);
create table xelay_winter_payment_private.credit_bonuses(
 user_id uuid primary key references public.profiles(id) on delete restrict,
 order_id uuid not null unique references xelay_student_private.credit_orders(id) on delete restrict,
 percent integer not null check(percent in(5,10)),micros bigint not null check(micros between 1 and 300000),
 awarded_at timestamptz,revoked_at timestamptz,created_at timestamptz not null default clock_timestamp()
);
do $$declare t text;begin foreach t in array array['friends','redemptions','credit_bonuses','retired_orders']loop
 execute format('alter table xelay_winter_payment_private.%I enable row level security',t);
 execute format('revoke all on xelay_winter_payment_private.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

alter table public.billing_orders add column winter_campaign text,add column winter_term_months integer,
 add column winter_source text,add column winter_discount_percent integer,add column winter_list_amount numeric,add column winter_coupon_expiry timestamptz;
create function xelay_winter_payment_private.price_valid(o jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(o->>'winter_campaign'='winter-2026' and o->>'product'='participant' and o->>'group_id' is null and o->>'currency'='UAH'
 and o->>'birthday_gift_id' is null and o->>'list_amount' is null and o->>'discount_percent' is null and o->>'discount_expires_at' is null
 and ((o->>'student_plan_id' in('start','plus','max') and o->>'teacher_plan_id' is null) or(o->>'teacher_plan_id' in('teacher_start','teacher_plus','teacher_max') and o->>'student_plan_id' is null))
 and (o->>'winter_term_months')::integer in(1,12) and o->>'winter_source' in('own','friend')
 and (o->>'winter_coupon_expiry')::timestamptz=xelay_winter_payment_private.expires()
 and (o->>'winter_list_amount')::numeric=(o->>'winter_term_months')::integer*(case coalesce(o->>'student_plan_id',o->>'teacher_plan_id')when'start'then 149 when'plus'then 399 when'max'then 999 when'teacher_start'then 199 when'teacher_plus'then 499 when'teacher_max'then 999 end)
 and (case when o->>'winter_source'='friend' then (o->>'winter_term_months')::integer=1 and (o->>'winter_discount_percent')::integer in(10,15,20)
 when(o->>'winter_term_months')::integer=12 then(o->>'winter_discount_percent')::integer in(10,15,20)
 when coalesce(o->>'student_plan_id',replace(o->>'teacher_plan_id','teacher_',''))='start' then(o->>'winter_discount_percent')::integer in(10,20,25)
 when coalesce(o->>'student_plan_id',replace(o->>'teacher_plan_id','teacher_',''))='plus' then(o->>'winter_discount_percent')::integer in(10,15,20)
 else(o->>'winter_discount_percent')::integer in(5,10,15)end)
 and(o->>'amount')::numeric=round((o->>'winter_list_amount')::numeric*(100-(o->>'winter_discount_percent')::integer)/100,2),false)
$$;
-- Preserve the exact deployed old price check for every non-winter order.
do $$declare original text;begin
 select pg_get_expr(conbin,conrelid) into original from pg_constraint where conrelid='public.billing_orders'::regclass and conname='billing_order_product_price';
 if original is null then raise exception 'WINTER_PRICE_CONSTRAINT_DRIFT';end if;
 alter table public.billing_orders drop constraint billing_order_product_price;
 execute 'alter table public.billing_orders add constraint billing_order_product_price check ((winter_campaign is null and winter_term_months is null and winter_source is null and winter_discount_percent is null and winter_list_amount is null and winter_coupon_expiry is null and ('||original||')) or xelay_winter_payment_private.price_valid(to_jsonb(billing_orders.*)))';
end$$;
create function xelay_winter_payment_private.snapshot_guard()returns trigger language plpgsql set search_path=''as $$begin
 if row(new.winter_campaign,new.winter_term_months,new.winter_source,new.winter_discount_percent,new.winter_list_amount,new.winter_coupon_expiry)
 is distinct from row(old.winter_campaign,old.winter_term_months,old.winter_source,old.winter_discount_percent,old.winter_list_amount,old.winter_coupon_expiry)then raise exception 'WINTER_ORDER_IMMUTABLE'using errcode='42501';end if;return new;
end$$;
create trigger winter_order_snapshot before update on public.billing_orders for each row execute function xelay_winter_payment_private.snapshot_guard();

create function public.xelay_winter_billing_offers(p_user_id uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare live boolean;f xelay_winter_payment_private.friends;accepted integer;bonus integer;o public.billing_orders;pending jsonb;begin
 perform xelay_winter_payment_private.service_user(p_user_id);live:=xelay_winter_payment_private.available();
 select*into f from xelay_winter_payment_private.friends where owner_id=p_user_id;
 select percent into accepted from xelay_winter_payment_private.friends where recipient_id=p_user_id;
 bonus:=case when live then xelay_winter_payment_private.percent(p_user_id,'credits')else 0 end;
 select b.*into o from xelay_winter_payment_private.redemptions r join public.billing_orders b on b.id=r.order_id where r.user_id=p_user_id;
 if found and(o.status in('pending','declined')or(o.status='expired'and o.provider_status is distinct from'Expired'))then pending:=jsonb_build_object('audience',case when o.teacher_plan_id is null then'student'else'teacher'end,'planId',coalesce(o.student_plan_id,o.teacher_plan_id),'termMonths',o.winter_term_months,'source',o.winter_source,'orderReference',o.order_reference,'status',o.status,'expiresAt',least(o.created_at+interval'7 days',o.winter_coupon_expiry),'amount',o.amount,'listAmount',o.winter_list_amount,'discountPercent',o.winter_discount_percent,'currency',o.currency);end if;
 return jsonb_build_object('campaign','winter-2026','expiresAt',xelay_winter_payment_private.expires(),
 'subscriptionUsed',coalesce(o.status in('approved','refunded','voided'),false),'pendingOrder',pending,
 'paused',jsonb_build_object('student',xelay_winter_private.is_paused(p_user_id,'student',xelay_winter_private.clock()),'teacher',xelay_winter_private.is_paused(p_user_id,'teacher',xelay_winter_private.clock())),
 'monthly',jsonb_build_object('start',case when live then xelay_winter_payment_private.percent(p_user_id,'monthly','start')else 0 end,'plus',case when live then xelay_winter_payment_private.percent(p_user_id,'monthly','plus')else 0 end,'max',case when live then xelay_winter_payment_private.percent(p_user_id,'monthly','max')else 0 end),
 'annualPercent',case when live then xelay_winter_payment_private.percent(p_user_id,'annual')else 0 end,
 'friend',jsonb_strip_nulls(jsonb_build_object('issuedToken',f.token,'percent',case when live then coalesce(f.percent,xelay_winter_payment_private.percent(p_user_id,'friend'))else 0 end,'acceptedPercent',case when live then coalesce(accepted,0)else 0 end)),
 'creditBonus',jsonb_build_object('percent',bonus,'capCredits',case when bonus=10 then 300 when bonus=5 then 100 else 0 end,'used',exists(select 1 from xelay_winter_payment_private.credit_bonuses where user_id=p_user_id)));
end$$;
create function public.xelay_winter_friend_issue(p_user_id uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare f xelay_winter_payment_private.friends;p integer;begin
 perform xelay_winter_payment_private.service_user(p_user_id);
 perform pg_advisory_xact_lock(hashtextextended('winter-billing:'||p_user_id::text,0));
 p:=xelay_winter_payment_private.percent(p_user_id,'friend');
 if not xelay_winter_payment_private.available()or p=0 then raise exception 'WINTER_COUPON_UNAVAILABLE';end if;
 insert into xelay_winter_payment_private.friends(owner_id,token,percent)values(p_user_id,replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),p)
 on conflict(owner_id)do nothing;
 -- The single code and its best earned discount are fixed at first creation.
 -- Later claims or retries cannot silently change a previously shared offer.
 select*into f from xelay_winter_payment_private.friends where owner_id=p_user_id;
 return jsonb_build_object('token',f.token,'percent',f.percent,'expiresAt',xelay_winter_payment_private.expires());
end$$;
create function public.xelay_winter_friend_accept(p_user_id uuid,p_token text)returns jsonb language plpgsql security definer set search_path=''as $$
declare f xelay_winter_payment_private.friends;begin
 perform xelay_winter_payment_private.service_user(p_user_id);
 perform pg_advisory_xact_lock(hashtextextended('winter-billing:'||p_user_id::text,0));
 if not xelay_winter_payment_private.available()or p_token is null or p_token!~'^[a-f0-9]{64}$' then raise exception 'WINTER_COUPON_UNAVAILABLE';end if;
 select*into f from xelay_winter_payment_private.friends where token=p_token for update;
 if not found or f.owner_id=p_user_id or(f.recipient_id is not null and f.recipient_id<>p_user_id)
 or exists(select 1 from xelay_winter_payment_private.redemptions where user_id=p_user_id)
 or exists(select 1 from xelay_winter_payment_private.friends where recipient_id=p_user_id and owner_id<>f.owner_id)then raise exception 'WINTER_COUPON_UNAVAILABLE';end if;
 update xelay_winter_payment_private.friends set recipient_id=p_user_id,accepted_at=coalesce(accepted_at,xelay_winter_private.clock())where owner_id=f.owner_id;
 return jsonb_build_object('percent',f.percent,'expiresAt',xelay_winter_payment_private.expires());
end$$;
create function public.xelay_winter_subscription_quote(p_user_id uuid,p_audience text,p_plan text,p_months integer,p_source text)returns jsonb language plpgsql security definer set search_path=''as $$
declare tier text;price numeric;p integer;reason text;fixed_audience text;r xelay_winter_payment_private.redemptions;old public.billing_orders;begin
 perform xelay_winter_payment_private.service_user(p_user_id);
 if p_audience is null or p_audience not in('student','teacher')or p_months is null or p_months not in(1,12)or p_source is null or p_source not in('own','friend')
 or(p_audience='student'and(p_plan is null or p_plan not in('start','plus','max')))or(p_audience='teacher'and(p_plan is null or p_plan not in('teacher_start','teacher_plus','teacher_max')))or(p_source='friend'and p_months<>1)then raise exception 'WINTER_SELECTION_INVALID';end if;
 tier:=replace(p_plan,'teacher_','');price:=case p_plan when'start'then 149 when'plus'then 399 when'max'then 999 when'teacher_start'then 199 when'teacher_plus'then 499 else 999 end;
 select audience into fixed_audience from xelay_student_private.audiences where user_id=p_user_id;
 if fixed_audience is not null and fixed_audience<>p_audience then reason:='WINTER_AUDIENCE';
 elsif not xelay_winter_payment_private.available()then reason:='WINTER_EXPIRED';
 elsif xelay_winter_private.is_paused(p_user_id,p_audience,xelay_winter_private.clock())then reason:='WINTER_PAUSED';end if;
 if p_source='friend'then select percent into p from xelay_winter_payment_private.friends where recipient_id=p_user_id;
 else p:=xelay_winter_payment_private.percent(p_user_id,case when p_months=12 then'annual'else'monthly'end,case when p_months=1 then tier else null end);end if;
 if coalesce(p,0)=0 then reason:=coalesce(reason,'WINTER_NOT_EARNED');end if;
 select*into r from xelay_winter_payment_private.redemptions where user_id=p_user_id;
 if found then
  select*into old from public.billing_orders where id=r.order_id;
  if old.status='expired'and old.provider_status='Expired'and old.approved_at is null then null;
  elsif old.status in('pending','declined')and coalesce(old.student_plan_id,old.teacher_plan_id)=p_plan and old.winter_term_months=p_months and old.winter_source=p_source then p:=old.winter_discount_percent;
  else reason:=coalesce(reason,'WINTER_CHECKOUT_RESERVED');end if;
 end if;
 return jsonb_build_object('audience',p_audience,'planId',p_plan,'termMonths',p_months,'source',p_source,'listAmount',price*p_months,'discountPercent',coalesce(p,0),'amount',round(price*p_months*(100-coalesce(p,0))/100,2),'currency','UAH','expiresAt',xelay_winter_payment_private.expires(),'available',reason is null,'reason',reason);
end$$;
create function public.xelay_winter_subscription_order(p_user_id uuid,p_audience text,p_plan text,p_months integer,p_source text,p_mode text,p_reference text,p_terms text)returns jsonb language plpgsql security definer set search_path=''as $$
declare q jsonb;o public.billing_orders;friend_owner uuid;begin
 perform xelay_winter_payment_private.service_user(p_user_id);
 perform pg_advisory_xact_lock(hashtextextended('winter-billing:'||p_user_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('xelay:checkout:'||p_user_id::text,0));
 if p_mode is null or p_mode not in('live','test')or p_reference is null or p_reference!~'^xelay_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'or p_terms is distinct from '2026-11-27.1'then raise exception 'WINTER_ORDER_INVALID';end if;
 q:=public.xelay_winter_subscription_quote(p_user_id,p_audience,p_plan,p_months,p_source);
 if not(q->>'available')::boolean then raise exception '%',q->>'reason';end if;
 select b.*into o from xelay_winter_payment_private.redemptions r join public.billing_orders b on b.id=r.order_id where r.user_id=p_user_id;
 if found then
  if o.mode<>p_mode then raise exception 'WINTER_CHECKOUT_RESERVED';end if;
  if o.status='expired'and o.provider_status='Expired'and o.approved_at is null then
   insert into xelay_winter_payment_private.retired_orders(order_id,user_id)values(o.id,p_user_id);
   delete from xelay_winter_payment_private.redemptions where order_id=o.id;
  else return to_jsonb(o);end if;
 end if;
 if p_source='friend'then select owner_id into friend_owner from xelay_winter_payment_private.friends where recipient_id=p_user_id for update;end if;
 insert into public.billing_orders(user_id,product,group_id,order_reference,amount,currency,mode,student_plan_id,teacher_plan_id,winter_campaign,winter_term_months,winter_source,winter_discount_percent,winter_list_amount,winter_coupon_expiry,terms_version,terms_accepted_at)
 values(p_user_id,'participant',null,p_reference,(q->>'amount')::numeric,'UAH',p_mode,case when p_audience='student'then p_plan end,case when p_audience='teacher'then p_plan end,'winter-2026',p_months,p_source,(q->>'discountPercent')::integer,(q->>'listAmount')::numeric,xelay_winter_payment_private.expires(),p_terms,xelay_winter_private.clock())returning*into o;
 insert into xelay_winter_payment_private.redemptions(user_id,order_id,source,friend_owner)values(p_user_id,o.id,p_source,friend_owner);
 return to_jsonb(o);
end$$;

do $$declare definition text;begin
 definition:=pg_get_functiondef('public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)'::regprocedure);
 if position('CREATE OR REPLACE FUNCTION public.xelay_apply_billing_event('in definition)<>1 then raise exception 'WINTER_CALLBACK_DRIFT';end if;
 execute replace(definition,'CREATE OR REPLACE FUNCTION public.xelay_apply_billing_event(','CREATE FUNCTION xelay_winter_payment_private.previous_billing_event(');
end$$;
create or replace function public.xelay_apply_billing_event(p_reference text,p_mode text,p_fingerprint text,p_status text,p_amount numeric,p_currency text,p_fee numeric default null)returns jsonb language plpgsql security definer set search_path=''as $$
declare o public.billing_orders;n integer;bound uuid;result jsonb;begin
 perform xelay_student_private.service();
 select*into o from public.billing_orders where order_reference=p_reference for update;
 if not found or o.winter_campaign is null then return xelay_winter_payment_private.previous_billing_event(p_reference,p_mode,p_fingerprint,p_status,p_amount,p_currency,p_fee);end if;
 if p_mode is distinct from o.mode or p_amount is distinct from o.amount or p_currency is distinct from o.currency or p_fingerprint is null or p_fingerprint!~'^[a-f0-9]{64}$'
 or p_status is null or p_status not in('Approved','Declined','Expired','Refunded','Voided','Pending','InProcessing','WaitingAuthComplete')or not xelay_winter_payment_private.price_valid(to_jsonb(o))then raise exception 'WINTER_PAYMENT_MISMATCH';end if;
 -- Locked checkout reservation is the proof this exact owner earned this exact offer.
 if not exists(select 1 from xelay_winter_payment_private.redemptions where user_id=o.user_id and order_id=o.id)
 and not(p_status in('Refunded','Voided','Expired')and exists(select 1 from xelay_winter_payment_private.retired_orders where order_id=o.id and user_id=o.user_id))then raise exception 'WINTER_PAYMENT_RESERVATION_REQUIRED';end if;
 select order_id into bound from public.billing_payment_events where fingerprint=p_fingerprint;
 if found and bound<>o.id then raise exception 'WINTER_FINGERPRINT_CONFLICT';end if;
 insert into public.billing_payment_events(order_id,fingerprint,provider_status,amount,mode)values(o.id,p_fingerprint,p_status,p_amount,p_mode)on conflict(fingerprint)do nothing;get diagnostics n=row_count;
 if n=0 then return jsonb_build_object('replayed',true,'status',o.status);end if;
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||o.user_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('student-owner:'||o.user_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('teacher-owner:'||o.user_id::text,0));
 if p_status='Approved'and o.status not in('approved','refunded','voided')then
  update public.billing_orders set status='approved',provider_status=p_status,approved_at=coalesce(approved_at,clock_timestamp()),updated_at=clock_timestamp()where id=o.id;
  if p_mode='live'then perform xelay_winter_payment_private.activate(o.id);update xelay_winter_payment_private.redemptions set redeemed_at=coalesce(redeemed_at,clock_timestamp())where order_id=o.id;end if;
 elsif p_status in('Refunded','Voided')then
  update public.billing_orders set status=case when p_status='Refunded'or o.status='refunded'then'refunded'else'voided'end,provider_status=case when o.status='refunded'then'Refunded'else p_status end,updated_at=clock_timestamp()where id=o.id;
  if p_mode='live'then
  update xelay_student_private.grants set revoked_at=coalesce(revoked_at,clock_timestamp())where order_id=o.id;
  update xelay_teacher_private.grants set revoked_at=coalesce(revoked_at,clock_timestamp())where order_id=o.id;
  -- A paused queue must retain its pause boundary. Reflow only when running.
  if o.teacher_plan_id is null then
   if not xelay_winter_private.is_paused(o.user_id,'student',xelay_winter_private.clock())then perform xelay_student_private.reflow_after_refund(o.user_id);end if;
  elsif not xelay_winter_private.is_paused(o.user_id,'teacher',xelay_winter_private.clock())then perform xelay_teacher_private.refund_reflow(o.user_id);end if;
  end if;
 elsif p_status in('Declined','Expired')and o.status not in('approved','refunded','voided')then
  update public.billing_orders set status=lower(p_status),provider_status=p_status,updated_at=clock_timestamp()where id=o.id;
 end if;
 return jsonb_build_object('replayed',false,'status',(select status from public.billing_orders where id=o.id));
end$$;

-- Credit bonuses use the same signed price, permanent paid credits and verified old callback.
-- Only the bonus record is new; original purchased-credit accounting remains unchanged.
do $$declare d text;begin
 d:=pg_get_functiondef('public.xelay_create_max_credit_order(uuid,text,text,text,text)'::regprocedure);
 execute replace(d,'CREATE OR REPLACE FUNCTION public.xelay_create_max_credit_order(','CREATE FUNCTION xelay_winter_payment_private.previous_credit_order(');
 d:=pg_get_functiondef('public.xelay_apply_max_credit_event(text,text,text,text,numeric,text)'::regprocedure);
 execute replace(d,'CREATE OR REPLACE FUNCTION public.xelay_apply_max_credit_event(','CREATE FUNCTION xelay_winter_payment_private.previous_credit_event(');
end$$;
create or replace function public.xelay_create_max_credit_order(p_user_id uuid,p_mode text,p_order_reference text,p_package_id text,p_terms_version text)returns jsonb language plpgsql security definer set search_path=''as $$
declare o jsonb;p integer;bonus bigint;begin
 perform xelay_winter_payment_private.service_user(p_user_id);
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||p_user_id::text,0));
 if xelay_winter_private.is_paused(p_user_id,'student',xelay_winter_private.clock())then raise exception 'WINTER_PAUSED';end if;
 if xelay_winter_private.student_entitlement_before(p_user_id)->>'planId' is distinct from'max'then raise exception 'MAX_CREDITS_MAX_REQUIRED'using errcode='42501';end if;
 o:=xelay_winter_payment_private.previous_credit_order(p_user_id,p_mode,p_order_reference,p_package_id,p_terms_version);
 if xelay_winter_payment_private.available()then
  p:=xelay_winter_payment_private.percent(p_user_id,'credits');
  if p>0 then
   bonus:=least(case when p=10 then 300000 else 100000 end,(o->>'credit_micros')::bigint*p/100);
   insert into xelay_winter_payment_private.credit_bonuses(user_id,order_id,percent,micros)values(p_user_id,(o->>'id')::uuid,p,bonus)on conflict(user_id)do nothing;
  end if;
 end if;
 return o;
end$$;
create or replace function public.xelay_apply_max_credit_event(p_reference text,p_mode text,p_fingerprint text,p_status text,p_amount numeric,p_currency text)returns jsonb language plpgsql security definer set search_path=''as $$
declare result jsonb;o xelay_student_private.credit_orders;b xelay_winter_payment_private.credit_bonuses;begin
 perform xelay_student_private.service();
 result:=xelay_winter_payment_private.previous_credit_event(p_reference,p_mode,p_fingerprint,p_status,p_amount,p_currency);
 select*into o from xelay_student_private.credit_orders where order_reference=p_reference;
 select*into b from xelay_winter_payment_private.credit_bonuses where order_id=o.id for update;
 if found and o.mode='live'then
  if o.status='approved'and b.awarded_at is null and b.revoked_at is null then
   perform xelay_winter_private.award_purchase_bonus(o.user_id,'winter-order:'||o.id::text,b.micros);
   update xelay_winter_payment_private.credit_bonuses set awarded_at=clock_timestamp()where order_id=o.id;
  elsif o.status in('refunded','voided')and b.revoked_at is null then
   if b.awarded_at is not null then perform xelay_winter_private.revoke_purchase_bonus(o.user_id,'winter-order:'||o.id::text);end if;
   update xelay_winter_payment_private.credit_bonuses set revoked_at=clock_timestamp()where order_id=o.id;
  elsif o.status='expired'and p_status='Expired'and b.awarded_at is null and b.revoked_at is null then
   -- A provider-confirmed unused expiry releases only the bonus reservation.
   -- Later contradictory approval still receives all purchased credits through
   -- the original callback, but cannot steal a newer order's one-off bonus.
   delete from xelay_winter_payment_private.credit_bonuses where order_id=o.id;
  end if;
 end if;
 return result;
end$$;

-- Every browser-facing read/mutation rechecks the verified user's live session in
-- the same transaction, rather than trusting a still-unexpired JWT after logout.
create function public.xelay_winter_billing_request(p_user_id uuid,p_session_id uuid,p_action text,p_payload jsonb default '{}'::jsonb)returns jsonb language plpgsql security definer set search_path=''as $$begin
 perform xelay_winter_payment_private.service_user(p_user_id);
 if p_session_id is null or not exists(select 1 from auth.sessions s where s.id=p_session_id and s.user_id=p_user_id and(s.not_after is null or s.not_after>clock_timestamp()))then raise exception 'WINTER_SESSION_REQUIRED'using errcode='42501';end if;
 if jsonb_typeof(p_payload)is distinct from'object'or octet_length(p_payload::text)>4096 then raise exception 'WINTER_REQUEST_INVALID';end if;
 case p_action
 when'xelay_winter_billing_offers'then return public.xelay_winter_billing_offers(p_user_id);
 when'xelay_winter_friend_issue'then return public.xelay_winter_friend_issue(p_user_id);
 when'xelay_winter_friend_accept'then return public.xelay_winter_friend_accept(p_user_id,p_payload->>'p_token');
 when'xelay_winter_subscription_quote'then return public.xelay_winter_subscription_quote(p_user_id,p_payload->>'p_audience',p_payload->>'p_plan',(p_payload->>'p_months')::integer,p_payload->>'p_source');
 when'xelay_winter_subscription_order'then return public.xelay_winter_subscription_order(p_user_id,p_payload->>'p_audience',p_payload->>'p_plan',(p_payload->>'p_months')::integer,p_payload->>'p_source',p_payload->>'p_mode',p_payload->>'p_reference',p_payload->>'p_terms');
 else raise exception 'WINTER_REQUEST_INVALID';end case;
end$$;

revoke all on all functions in schema xelay_winter_payment_private from public,anon,authenticated,service_role;
do $$declare f regprocedure;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname in('xelay_winter_billing_request','xelay_winter_billing_offers','xelay_winter_friend_issue','xelay_winter_friend_accept','xelay_winter_subscription_quote','xelay_winter_subscription_order')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
 end loop;
end$$;
notify pgrst,'reload schema';
commit;
