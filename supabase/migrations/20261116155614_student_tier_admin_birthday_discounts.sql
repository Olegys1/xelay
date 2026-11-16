-- Future birthday offers are discounts; every previously offered month is retained.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $$begin
 if to_regclass('public.birthday_gifts')is null or to_regclass('xelay_student_private.grant_periods')is null
 or to_regprocedure('xelay_student_private.activate_paid_order(uuid)')is null then raise exception 'BIRTHDAY_DISCOUNT_PREREQUISITE';end if;
end$$;
alter table public.birthday_gifts add column gift_kind text not null default 'legacy_month' check(gift_kind in('legacy_month','discount_coupon'));
alter table public.birthday_gifts add column coupon_expires_at timestamptz;
alter table public.birthday_gifts add column coupon_order_id uuid unique references public.billing_orders(id)on delete restrict;
alter table public.birthday_gifts add column coupon_redeemed_at timestamptz;
alter table public.birthday_gifts add constraint birthday_coupon_shape check(coalesce(
 (gift_kind='legacy_month'and coupon_expires_at is null and coupon_order_id is null and coupon_redeemed_at is null)
 or(gift_kind='discount_coupon'and coupon_expires_at=offered_at+interval'7 days'and claimed_at is null and entitlement_id is null
 and(coupon_redeemed_at is null or coupon_order_id is not null)),false));
alter table public.billing_orders add column birthday_gift_id uuid unique references public.birthday_gifts(id)on delete restrict;
alter table public.billing_orders add column list_amount numeric(12,2);
alter table public.billing_orders add column discount_percent smallint;
alter table public.billing_orders add column discount_expires_at timestamptz;
alter table public.billing_orders drop constraint billing_order_product_price;
alter table public.billing_orders add constraint billing_order_product_price check(coalesce(
 (birthday_gift_id is null and list_amount is null and discount_percent is null and discount_expires_at is null and(
  (product='participant'and group_id is null and((student_plan_id is null and amount=100)
   or(student_plan_id='start'and amount=149)or(student_plan_id='plus'and amount=399)or(student_plan_id='max'and amount=999)))
  or(product='group'and group_id is not null and amount=750 and student_plan_id is null)))
 or(birthday_gift_id is not null and list_amount is not null and discount_percent is not null and discount_expires_at is not null and product='participant'and group_id is null
  and((student_plan_id='start'and list_amount=149 and discount_percent=50)
   or(student_plan_id='plus'and list_amount=399 and discount_percent=30)
   or(student_plan_id='max'and list_amount=999 and discount_percent=20))
  and amount=round(list_amount*(100-discount_percent)/100,2)),false));

create function xelay_student_private.order_price_valid(o jsonb)returns boolean language sql immutable set search_path=''as $$
 select coalesce(case when o->>'birthday_gift_id'is null then
  (o->>'amount')::numeric=case o->>'student_plan_id'when'start'then 149 when'plus'then 399 when'max'then 999 else 100 end
  and o->>'list_amount'is null and o->>'discount_percent'is null and o->>'discount_expires_at'is null
 else o->>'student_plan_id'in('start','plus','max')and(o->>'list_amount')::numeric=case o->>'student_plan_id'when'start'then 149 when'plus'then 399 else 999 end
  and(o->>'discount_percent')::integer=case o->>'student_plan_id'when'start'then 50 when'plus'then 30 else 20 end
  and(o->>'amount')::numeric=round((o->>'list_amount')::numeric*(100-(o->>'discount_percent')::integer)/100,2)
  and o->>'discount_expires_at'is not null end,false);
$$;
create or replace function xelay_student_private.order_snapshot_guard()returns trigger language plpgsql set search_path=''as $$begin
 if new.user_id is distinct from old.user_id or new.product is distinct from old.product or new.group_id is distinct from old.group_id
 or new.order_reference is distinct from old.order_reference or new.amount is distinct from old.amount or new.currency is distinct from old.currency
 or new.mode is distinct from old.mode or new.student_plan_id is distinct from old.student_plan_id
 or new.birthday_gift_id is distinct from old.birthday_gift_id or new.list_amount is distinct from old.list_amount
 or new.discount_percent is distinct from old.discount_percent or new.discount_expires_at is distinct from old.discount_expires_at
 or new.created_at is distinct from old.created_at then raise exception 'BILLING_ORDER_SNAPSHOT_IMMUTABLE'using errcode='42501';end if;return new;end$$;
-- Change only the canonical-price predicate; preserve paid scheduling/refunds exactly.
do $$declare definition text;old text:='o.amount<>(case o.student_plan_id when''start''then 149 when''plus''then 399 else 999 end)';begin
 definition:=pg_get_functiondef('xelay_student_private.activate_paid_order(uuid)'::regprocedure);
 if(length(definition)-length(replace(definition,old,'')))/length(old)<>1 then raise exception 'BIRTHDAY_ACTIVATION_DRIFT';end if;
 execute replace(definition,old,'not xelay_student_private.order_price_valid(to_jsonb(o))');
end$$;
create or replace function public.xelay_private_birthday_gift_json(p_gift_id uuid,p_newly_claimed boolean)
returns jsonb language sql stable security definer set search_path=''as $$
 select jsonb_build_object('id',g.id,'notification_id',g.notification_id,'recipient_name',g.greeting_name,'gift_year',g.gift_year,
 'offered_at',g.offered_at,'claimed_at',g.claimed_at,'valid_from',e.valid_from,'valid_until',e.valid_until,'newly_claimed',p_newly_claimed,
 'gift_kind',g.gift_kind,'coupon_expires_at',g.coupon_expires_at,'coupon_redeemed_at',g.coupon_redeemed_at,
 'coupon_plan_id',o.student_plan_id)
 from public.birthday_gifts g left join public.participant_entitlements e on e.id=g.entitlement_id
 left join public.billing_orders o on o.id=g.coupon_order_id where g.id=p_gift_id;
$$;
create function xelay_student_private.offer_birthday_coupon(p_user uuid,p_actor uuid,p_name text)returns jsonb
language plpgsql security definer set search_path=''as $$
declare v_now timestamptz:=public.xelay_private_birthday_gift_clock();v_year integer;v_id uuid;v_notification uuid;begin
 if p_user is null or not exists(select 1 from public.profiles p join auth.users u on u.id=p.id where p.id=p_user
 and u.email_confirmed_at is not null and u.deleted_at is null and(u.banned_until is null or u.banned_until<=v_now))then
 raise exception 'BIRTHDAY_ACCOUNT_UNAVAILABLE'using errcode='42501';end if;
 v_year:=extract(year from v_now at time zone'Europe/Kyiv')::integer;
 perform pg_advisory_xact_lock(hashtextextended('xelay:birthday-gift:'||p_user::text||':'||v_year::text,0));
 select id into v_id from public.birthday_gifts where recipient_id=p_user and gift_year=v_year;
 if v_id is not null then return public.xelay_private_birthday_gift_json(v_id,false);end if;
 insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,created_at)
 values(p_user,coalesce(p_actor,p_user),'Xelay','birthday_gift','З днем народження! Для вас святкова знижка: Старт −50%, Плюс −30%, Макс −20%. Оберіть один тариф протягом 7 днів. Без автопродовження.',false,v_now)returning id into v_notification;
 insert into public.birthday_gifts(recipient_id,greeting_name,gift_year,notification_id,offered_by,offered_at,gift_kind,coupon_expires_at)
 values(p_user,p_name,v_year,v_notification,p_actor,v_now,'discount_coupon',v_now+interval'7 days')returning id into v_id;
 insert into public.billing_audit_log(actor_id,action,target_user_id,detail)values(p_actor,'birthday_discount_offer',p_user,
 jsonb_build_object('gift_id',v_id,'gift_year',v_year,'expires_at',v_now+interval'7 days'));
 return public.xelay_private_birthday_gift_json(v_id,false);
end$$;
create or replace function public.xelay_admin_offer_birthday_gift(p_user_id uuid,p_greeting_name text default'')returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare actor uuid:=xelay_student_private.caller();v_name text:=btrim(coalesce(p_greeting_name,''));begin
 if not public.xelay_is_platform_admin()or coalesce(auth.jwt()->>'aal','')<>'aal2'
 or not exists(select 1 from auth.mfa_factors f where f.user_id=actor and f.status='verified')then raise exception 'BIRTHDAY_ADMIN_MFA_REQUIRED'using errcode='42501';end if;
 if length(v_name)>80 or v_name~'[[:cntrl:]]'then raise exception 'BIRTHDAY_GIFT_GREETING_NAME_INVALID'using errcode='22023';end if;
 return xelay_student_private.offer_birthday_coupon(p_user_id,actor,v_name);
end$$;
create or replace function public.xelay_private_ensure_profile_birthday_gift(p_user uuid)returns boolean
language plpgsql volatile security definer set search_path=''as $$
declare v_now timestamptz:=public.xelay_private_birthday_gift_clock();v_today date;v_year integer;b public.profile_birthdays;begin
 v_today:=(v_now at time zone'Europe/Kyiv')::date;v_year:=extract(year from v_today)::integer;
 select*into b from public.profile_birthdays where user_id=p_user;
 if not found or b.month is null or public.xelay_private_birthday_observed_date(b.day,b.month,v_year)<>v_today then return false;end if;
 perform pg_advisory_xact_lock(hashtextextended('xelay:birthday-gift:'||p_user::text||':'||v_year::text,0));
 if exists(select 1 from public.birthday_gifts where recipient_id=p_user and gift_year=v_year)then return false;end if;
 if not exists(select 1 from auth.users u where u.id=p_user and u.email_confirmed_at is not null and u.deleted_at is null
 and(u.banned_until is null or u.banned_until<=v_now))then return false;end if;
 perform xelay_student_private.offer_birthday_coupon(p_user,null,'');return true;
end$$;
-- A coupon never enters the old free-month claim path; old unclaimed offers remain claimable.
do $$declare definition text;needle text:='if v_gift.claimed_at is not null then';begin
 definition:=pg_get_functiondef('public.xelay_claim_birthday_gift(uuid)'::regprocedure);
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'BIRTHDAY_CLAIM_DRIFT';end if;
 execute replace(definition,needle,'if v_gift.gift_kind=''discount_coupon''then raise exception ''BIRTHDAY_COUPON_CHECKOUT_REQUIRED''using errcode=''22023'';end if;'||chr(10)||needle);
end$$;
create function public.xelay_my_birthday_discount()returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();v_id uuid;begin
 perform public.xelay_private_ensure_profile_birthday_gift(u);
 select id into v_id from public.birthday_gifts where recipient_id=u and gift_kind='discount_coupon'
 and coupon_expires_at>clock_timestamp()and coupon_redeemed_at is null order by offered_at desc limit 1;
 return case when v_id is null then null else public.xelay_private_birthday_gift_json(v_id,false)end;
end$$;
create function public.xelay_create_discounted_student_plan_order(p_user_id uuid,p_mode text,p_order_reference text,p_plan_id text,p_gift_id uuid)
returns jsonb language plpgsql security definer set search_path=''as $$
declare g public.birthday_gifts;o public.billing_orders;price numeric;percent integer;begin
 perform xelay_student_private.service();
 if p_mode is null or p_mode not in('live','test')or p_plan_id is null or p_plan_id not in('start','plus','max')
 or p_order_reference is null or p_order_reference!~'^xelay_[a-f0-9-]{36}$'then raise exception 'STUDENT_ORDER_INVALID'using errcode='22023';end if;
 if p_user_id is null or not exists(select 1 from auth.users u join public.profiles p on p.id=u.id where u.id=p_user_id
 and u.email_confirmed_at is not null and u.deleted_at is null and(u.banned_until is null or u.banned_until<=clock_timestamp()))then
 raise exception 'STUDENT_ACCOUNT_REQUIRED'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('xelay:checkout:'||p_user_id::text,0));
 if exists(select 1 from xelay_student_private.audiences where user_id=p_user_id and audience='teacher')then raise exception 'STUDENT_BILLING_AUDIENCE_REQUIRED'using errcode='42501';end if;
 -- Existing-order callbacks lock order then coupon. Follow that order here
 -- as well, while the owner checkout lock serializes new reservations.
 select*into g from public.birthday_gifts where id=p_gift_id and recipient_id=p_user_id and gift_kind='discount_coupon';
 if found and g.coupon_order_id is not null then perform 1 from public.billing_orders where id=g.coupon_order_id for update;end if;
 select*into g from public.birthday_gifts where id=p_gift_id and recipient_id=p_user_id and gift_kind='discount_coupon'for update;
 if not found or g.coupon_expires_at<=clock_timestamp()or g.coupon_redeemed_at is not null then raise exception 'BIRTHDAY_DISCOUNT_UNAVAILABLE'using errcode='42501';end if;
 if g.coupon_order_id is not null then
  select*into o from public.billing_orders where id=g.coupon_order_id for update;
  if o.mode<>p_mode or o.student_plan_id<>p_plan_id then raise exception 'BIRTHDAY_DISCOUNT_PLAN_LOCKED'using errcode='PT409';end if;
  if o.status not in('pending','declined')then raise exception 'BIRTHDAY_DISCOUNT_UNAVAILABLE'using errcode='PT409';end if;
  if o.status='declined'then update public.billing_orders set status='pending'where id=o.id returning*into o;end if;
  return to_jsonb(o);
 end if;
 if(select count(*)from public.billing_orders where user_id=p_user_id and created_at>clock_timestamp()-interval'1 hour')>=10 then raise exception 'CHECKOUT_RATE_LIMIT'using errcode='PT429';end if;
 price:=case p_plan_id when'start'then 149 when'plus'then 399 else 999 end;percent:=case p_plan_id when'start'then 50 when'plus'then 30 else 20 end;
 insert into public.billing_orders(user_id,product,group_id,order_reference,amount,mode,student_plan_id,birthday_gift_id,list_amount,discount_percent,discount_expires_at)
 values(p_user_id,'participant',null,p_order_reference,round(price*(100-percent)/100,2),p_mode,p_plan_id,g.id,price,percent,g.coupon_expires_at)returning*into o;
 update public.birthday_gifts set coupon_order_id=o.id where id=g.id;
 return to_jsonb(o);
end$$;
-- Same provider reference for every retry. Redeem only after an authenticated,
-- exact-amount Approved callback; duplicate callbacks cannot grant another term.
create function xelay_student_private.redeem_birthday_discount()returns trigger language plpgsql security definer set search_path=''as $$
declare g public.birthday_gifts;begin
 if new.birthday_gift_id is null or new.status<>'approved'or old.status='approved'then return new;end if;
 select*into g from public.birthday_gifts where id=new.birthday_gift_id for update;
 if not found or g.recipient_id<>new.user_id or g.coupon_order_id<>new.id or g.gift_kind<>'discount_coupon'
 or not xelay_student_private.order_price_valid(to_jsonb(new))then raise exception 'BIRTHDAY_DISCOUNT_ORDER_MISMATCH'using errcode='42501';end if;
 if new.mode='live'and g.coupon_redeemed_at is null then
  update public.birthday_gifts set coupon_redeemed_at=clock_timestamp()where id=g.id;
  insert into public.billing_audit_log(action,target_user_id,detail)values('birthday_discount_redeemed',new.user_id,jsonb_build_object('gift_id',g.id,'order_id',new.id,'plan_id',new.student_plan_id));
 end if;return new;
end$$;
create trigger xelay_birthday_discount_redemption after update of status on public.billing_orders for each row execute function xelay_student_private.redeem_birthday_discount();

create function public.xelay_admin_grant_student_plan(p_user_id uuid,p_plan_id text,p_days integer,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=''as $$
declare actor uuid:=xelay_student_private.caller();g xelay_student_private.grants;v_now timestamptz:=clock_timestamp();v_from timestamptz;v_until timestamptz;prior record;cursor_at timestamptz;cut_at timestamptz;remaining interval;rank integer;v_reference text;begin
 if not public.xelay_is_platform_admin()or coalesce(auth.jwt()->>'aal','')<>'aal2'
 or not exists(select 1 from auth.mfa_factors f where f.user_id=actor and f.status='verified')then raise exception 'STUDENT_GRANT_ADMIN_MFA_REQUIRED'using errcode='42501';end if;
 if p_plan_id is null or p_plan_id not in('start','plus','max')or p_days is null or p_days not between 1 and 366 or p_request_id is null
 or not xelay_student_private.plain(p_reason,500)or length(btrim(p_reason))<5 then raise exception 'STUDENT_GRANT_INVALID'using errcode='22023';end if;
 if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id where u.id=p_user_id and u.email_confirmed_at is not null and u.deleted_at is null
 and(u.banned_until is null or u.banned_until<=v_now))then raise exception 'STUDENT_ACCOUNT_REQUIRED'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||p_user_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('student-owner:'||p_user_id::text,0));
 if not exists(select 1 from xelay_student_private.audiences where user_id=p_user_id and audience='student')then
  -- The explicitly selected student-tier gift is an audited MFA-admin choice,
  -- never an inference from user-editable profile or JWT metadata.
  if exists(select 1 from xelay_student_private.audiences where user_id=p_user_id)then raise exception 'STUDENT_AUDIENCE_REQUIRED'using errcode='42501';end if;
  insert into xelay_student_private.audiences(user_id,audience,source,reason)
  values(p_user_id,'student','audited_assignment','MFA administrator '||actor::text||' approved student-tier gift: '||left(btrim(p_reason),400));
  insert into public.billing_audit_log(actor_id,action,target_user_id,detail)
  values(actor,'student_audience_assignment',p_user_id,jsonb_build_object('audience','student','reason',btrim(p_reason),'source','admin_student_plan_grant'));
 end if;
 v_reference:='admin-plan:'||actor::text||':'||p_request_id::text;
 select*into g from xelay_student_private.grants where grants.reference=v_reference;
 if found then
  if g.user_id<>p_user_id or g.plan_id<>p_plan_id or g.valid_until-g.valid_from<>make_interval(days=>p_days)
  or not exists(select 1 from public.billing_audit_log a where a.action='grant_student_plan'and a.actor_id=actor and a.detail->>'grant_id'=g.id::text and a.detail->>'reason'=btrim(p_reason))then
  raise exception 'STUDENT_GRANT_CONFLICT'using errcode='PT409';end if;
  return jsonb_build_object('granted',false,'already_granted',true,'plan_id',g.plan_id,'valid_from',g.valid_from,'valid_until',g.valid_until);
 end if;
 rank:=xelay_student_private.plan_rank(p_plan_id);
 select greatest(v_now,coalesce(max(p.valid_until),v_now))into v_from from xelay_student_private.grant_periods p join xelay_student_private.grants z on z.id=p.grant_id
 where z.user_id=p_user_id and z.revoked_at is null and p.valid_until>v_now and xelay_student_private.plan_rank(z.plan_id)>=rank;
 if rank=1 then select greatest(v_from,coalesce(max(e.valid_until),v_now))into v_from from public.participant_entitlements e where e.user_id=p_user_id and e.revoked_at is null and e.valid_until>v_now;end if;
 v_until:=v_from+make_interval(days=>p_days);cursor_at:=v_until;
 for prior in select p.*from xelay_student_private.grant_periods p join xelay_student_private.grants z on z.id=p.grant_id where z.user_id=p_user_id and z.revoked_at is null
 and xelay_student_private.plan_rank(z.plan_id)<rank and p.valid_until>v_from order by p.valid_from,z.created_at,p.id for update of p loop
  if prior.valid_from>=cursor_at then cursor_at:=prior.valid_until;continue;end if;
  cut_at:=greatest(prior.valid_from,v_from);remaining:=prior.valid_until-cut_at;
  if prior.valid_from<cut_at then update xelay_student_private.grant_periods set valid_until=cut_at where id=prior.id;
   insert into xelay_student_private.grant_periods(grant_id,valid_from,valid_until)values(prior.grant_id,cursor_at,cursor_at+remaining);
  else update xelay_student_private.grant_periods set valid_from=cursor_at,valid_until=cursor_at+remaining where id=prior.id;end if;
  insert into xelay_student_private.schedule_audit(grant_id,original_from,original_until,new_from,new_until,reason)values(prior.grant_id,prior.valid_from,prior.valid_until,cursor_at,cursor_at+remaining,'admin_upgrade_carryover:'||v_reference);
  cursor_at:=cursor_at+remaining;
 end loop;
 insert into xelay_student_private.grants(user_id,plan_id,source,reference,valid_from,valid_until)values(p_user_id,p_plan_id,'admin_grant',v_reference,v_from,v_until)returning*into g;
 insert into xelay_student_private.grant_periods(grant_id,valid_from,valid_until)values(g.id,v_from,v_until);
 insert into public.billing_audit_log(actor_id,action,target_user_id,detail)values(actor,'grant_student_plan',p_user_id,jsonb_build_object('grant_id',g.id,'plan_id',p_plan_id,'days',p_days,'reason',btrim(p_reason),'valid_from',v_from,'valid_until',v_until));
 return jsonb_build_object('granted',true,'already_granted',false,'plan_id',p_plan_id,'valid_from',v_from,'valid_until',v_until);
end$$;
revoke all on function xelay_student_private.order_price_valid(jsonb),xelay_student_private.offer_birthday_coupon(uuid,uuid,text),xelay_student_private.redeem_birthday_discount()from public,anon,authenticated,service_role;
revoke all on function public.xelay_my_birthday_discount(),public.xelay_create_discounted_student_plan_order(uuid,text,text,text,uuid),public.xelay_admin_grant_student_plan(uuid,text,integer,text,uuid)from public,anon,authenticated,service_role;
grant execute on function public.xelay_my_birthday_discount(),public.xelay_admin_grant_student_plan(uuid,text,integer,text,uuid)to authenticated;
grant execute on function public.xelay_create_discounted_student_plan_order(uuid,text,text,text,uuid)to service_role;
notify pgrst,'reload schema';
commit;
