-- Explicit student prices; preserve every legacy100UAH order and existing payment callback.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $$begin
 if to_regclass('xelay_student_private.grant_periods')is null or to_regclass('public.billing_orders')is null
 or to_regprocedure('public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)')is null
 or exists(select 1 from information_schema.columns where table_schema='public'and table_name='billing_orders'and column_name='student_plan_id')then raise exception 'STUDENT_BILLING_PREREQUISITE_OR_DRIFT';end if;
end$$;
alter table public.billing_orders add column student_plan_id text;
alter table public.billing_orders drop constraint billing_order_product_price;
alter table public.billing_orders add constraint billing_order_product_price check(
 (product='participant'and group_id is null and((student_plan_id is null and amount=100)
 or(student_plan_id='start'and amount=149)or(student_plan_id='plus'and amount=399)or(student_plan_id='max'and amount=999)))
 or(product='group'and group_id is not null and amount=750 and student_plan_id is null));
alter table xelay_student_private.grants add column order_id uuid unique references public.billing_orders(id)on delete restrict;
alter table xelay_student_private.grants add constraint student_grant_payment_order check((source='payment'and order_id is not null)or(source='admin_grant'and order_id is null));

create function xelay_student_private.plan_rank(p text)returns integer language sql immutable set search_path=''as $$select case p when'max'then 3 when'plus'then 2 when'start'then 1 else 0 end;$$;
create function public.xelay_create_student_plan_order(p_user_id uuid,p_mode text,p_order_reference text,p_plan_id text)
returns jsonb language plpgsql security definer set search_path=''as $$
declare o public.billing_orders;audience text;begin
 perform xelay_student_private.service();
 if p_user_id is null or p_mode is null or p_mode not in('live','test')or p_plan_id is null or p_plan_id not in('start','plus','max')
 or p_order_reference is null or length(p_order_reference)not between 8 and 100 then raise exception 'STUDENT_ORDER_INVALID'using errcode='22023';end if;
 if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id where u.id=p_user_id and u.email_confirmed_at is not null and u.deleted_at is null and(u.banned_until is null or u.banned_until<=clock_timestamp()))then raise exception 'STUDENT_ACCOUNT_REQUIRED'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('xelay:checkout:'||p_user_id::text,0));
 select a.audience into audience from xelay_student_private.audiences a where a.user_id=p_user_id;
 if audience='teacher'then raise exception 'STUDENT_BILLING_AUDIENCE_REQUIRED'using errcode='42501';end if;
 select*into o from public.billing_orders where user_id=p_user_id and product='participant'and group_id is null and mode=p_mode and student_plan_id=p_plan_id and status='pending'and created_at>clock_timestamp()-interval'1 hour'order by created_at desc limit 1;
 if found then return to_jsonb(o);end if;
 if(select count(*)from public.billing_orders where user_id=p_user_id and created_at>clock_timestamp()-interval'1 hour')>=10 then raise exception 'CHECKOUT_RATE_LIMIT'using errcode='PT429';end if;
 insert into public.billing_orders(user_id,product,group_id,order_reference,amount,mode,student_plan_id)
 values(p_user_id,'participant',null,p_order_reference,case p_plan_id when'start'then 149 when'plus'then 399 else 999 end,p_mode,p_plan_id)returning*into o;
 return to_jsonb(o);
end$$;
create function xelay_student_private.order_snapshot_guard()returns trigger language plpgsql set search_path=''as $$begin
 if new.user_id is distinct from old.user_id or new.product is distinct from old.product or new.group_id is distinct from old.group_id
 or new.order_reference is distinct from old.order_reference or new.amount is distinct from old.amount or new.currency is distinct from old.currency
 or new.mode is distinct from old.mode or new.student_plan_id is distinct from old.student_plan_id then raise exception 'BILLING_ORDER_SNAPSHOT_IMMUTABLE'using errcode='42501';end if;return new;end$$;
create trigger xelay_student_order_snapshot_guard before update on public.billing_orders for each row execute function xelay_student_private.order_snapshot_guard();

create function xelay_student_private.activate_paid_order(p_order_id uuid)returns void language plpgsql security definer set search_path=''as $$
declare o public.billing_orders;g xelay_student_private.grants;prior record;audience text;rank integer;v_from timestamptz;v_until timestamptz;cursor_at timestamptz;cut_at timestamptz;remaining interval;v_now timestamptz:=clock_timestamp();begin
 select*into o from public.billing_orders where id=p_order_id for update;
 if not found or o.student_plan_id is null or o.student_plan_id not in('start','plus','max')or o.product<>'participant'or o.group_id is not null or o.mode<>'live'or o.status<>'approved'
 or o.amount<>(case o.student_plan_id when'start'then 149 when'plus'then 399 else 999 end) or o.currency<>'UAH'then raise exception 'STUDENT_APPROVED_PAYMENT_REQUIRED'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||o.user_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('student-owner:'||o.user_id::text,0));
 select*into g from xelay_student_private.grants where order_id=o.id;if found then return;end if;
 select a.audience into audience from xelay_student_private.audiences a where user_id=o.user_id;
 if audience='teacher'then raise exception 'STUDENT_BILLING_AUDIENCE_REQUIRED'using errcode='42501';end if;
 -- For unprovable historic accounts, this records the explicitly purchased billing audience.
 -- It does not retroactively claim a historical registration type.
 insert into xelay_student_private.audiences(user_id,audience,source,reason)
 values(o.user_id,'student','paid_student_order','Verified paid student order '||o.order_reference)on conflict do nothing;
 rank:=xelay_student_private.plan_rank(o.student_plan_id);
 select greatest(v_now,coalesce(max(p.valid_until),v_now))into v_from from xelay_student_private.grant_periods p join xelay_student_private.grants z on z.id=p.grant_id
 where z.user_id=o.user_id and z.revoked_at is null and p.valid_until>v_now and xelay_student_private.plan_rank(z.plan_id)>=rank;
 if rank=1 then select greatest(v_from,coalesce(max(e.valid_until),v_now))into v_from from public.participant_entitlements e where e.user_id=o.user_id and e.revoked_at is null and e.valid_until>v_now and e.order_id is distinct from o.id;end if;
 v_until:=((v_from at time zone'Europe/Kyiv')+interval'1 month')at time zone'Europe/Kyiv';cursor_at:=v_until;
 -- Preserve consumed windows and every remaining lower-tier second in separate periods.
 -- Original paid grant metadata stays immutable; each deferral is privately audited.
 for prior in select p.id,p.grant_id,p.valid_from,p.valid_until from xelay_student_private.grant_periods p join xelay_student_private.grants z on z.id=p.grant_id
 where z.user_id=o.user_id and z.revoked_at is null and xelay_student_private.plan_rank(z.plan_id)<rank and p.valid_until>v_from
 order by p.valid_from,z.created_at,p.id for update of p loop
  if prior.valid_from>=cursor_at then cursor_at:=prior.valid_until;continue;end if;
  cut_at:=greatest(prior.valid_from,v_from);remaining:=prior.valid_until-cut_at;
  if prior.valid_from<cut_at then update xelay_student_private.grant_periods set valid_until=cut_at where id=prior.id;
   insert into xelay_student_private.grant_periods(grant_id,valid_from,valid_until)values(prior.grant_id,cursor_at,cursor_at+remaining);
  else update xelay_student_private.grant_periods set valid_from=cursor_at,valid_until=cursor_at+remaining where id=prior.id;end if;
  insert into xelay_student_private.schedule_audit(grant_id,original_from,original_until,new_from,new_until,reason)
   values(prior.grant_id,prior.valid_from,prior.valid_until,cursor_at,cursor_at+remaining,'upgrade_carryover:'||o.id::text);
  cursor_at:=cursor_at+remaining;
 end loop;
 insert into xelay_student_private.grants(user_id,plan_id,source,reference,valid_from,valid_until,order_id)
 values(o.user_id,o.student_plan_id,'payment','billing:'||o.id::text,v_from,v_until,o.id)returning*into g;
 insert into xelay_student_private.grant_periods(grant_id,valid_from,valid_until)values(g.id,v_from,v_until);
end$$;
create function xelay_student_private.reflow_after_refund(p_user_id uuid)returns void language plpgsql security definer set search_path=''as $$
declare p record;cursor_at timestamptz:=clock_timestamp();duration interval;begin
 select greatest(cursor_at,coalesce(max(s.valid_until),cursor_at))into cursor_at from xelay_student_private.grant_periods s join xelay_student_private.grants g on g.id=s.grant_id
 where g.user_id=p_user_id and g.revoked_at is null and s.valid_from<=clock_timestamp()and s.valid_until>clock_timestamp();
 for p in select s.*from xelay_student_private.grant_periods s join xelay_student_private.grants g on g.id=s.grant_id where g.user_id=p_user_id and g.source='payment'and g.revoked_at is null and s.valid_from>clock_timestamp()order by s.valid_from,g.created_at,s.id for update of s loop
  duration:=p.valid_until-p.valid_from;
  if p.valid_from>cursor_at then update xelay_student_private.grant_periods set valid_from=cursor_at,valid_until=cursor_at+duration where id=p.id;
   insert into xelay_student_private.schedule_audit(grant_id,original_from,original_until,new_from,new_until,reason)values(p.grant_id,p.valid_from,p.valid_until,cursor_at,cursor_at+duration,'refunded_period_reflow');
   cursor_at:=cursor_at+duration;
  else cursor_at:=greatest(cursor_at,p.valid_until);
  end if;
 end loop;
end$$;

-- Copy the existing callback implementation intact, then preserve its public OID/grants.
do $copy$declare definition text;old constant text:='CREATE OR REPLACE FUNCTION public.xelay_apply_billing_event(';begin
 definition:=pg_get_functiondef('public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)'::regprocedure);
 if position(old in definition)<>1 or position('student_plan_id'in definition)>0 then raise exception 'STUDENT_BILLING_CALLBACK_DRIFT';end if;
 execute replace(definition,old,'CREATE FUNCTION xelay_student_private.legacy_billing_event(');
end$copy$;
create or replace function public.xelay_apply_billing_event(p_reference text,p_mode text,p_fingerprint text,p_status text,p_amount numeric,p_currency text,p_fee numeric default null)
returns jsonb language plpgsql security definer set search_path=''as $$
declare result jsonb;o public.billing_orders;begin
 perform xelay_student_private.service();
 result:=xelay_student_private.legacy_billing_event(p_reference,p_mode,p_fingerprint,p_status,p_amount,p_currency,p_fee);
 select*into o from public.billing_orders where order_reference=p_reference;
 if o.student_plan_id is not null and o.mode='live'then
  if o.status='approved'then perform xelay_student_private.activate_paid_order(o.id);
  elsif o.status in('refunded','voided')then
   perform pg_advisory_xact_lock(hashtextextended('max-owner:'||o.user_id::text,0));
   update xelay_student_private.grants set revoked_at=clock_timestamp()where order_id=o.id and revoked_at is null;
   perform xelay_student_private.reflow_after_refund(o.user_id);
  end if;
 end if;return result;
end$$;
-- Calendar carryover may extend past the legacy participant queue. Count the
-- real private period directly; never call entitlement(), which calls this helper.
create function xelay_student_private.active_plan_access(p_user_id uuid,p_at timestamptz)
returns boolean language sql stable security definer set search_path=''as $$
 select exists(select 1 from xelay_student_private.grants g join xelay_student_private.grant_periods p on p.grant_id=g.id
 join xelay_student_private.audiences a on a.user_id=g.user_id and a.audience='student'
 where g.user_id=p_user_id and g.revoked_at is null and p.valid_from<=p_at and p.valid_until>p_at);
$$;
create function xelay_student_private.participant_coverage_until(p_user_id uuid,p_at timestamptz)
returns timestamptz language sql stable security definer set search_path=''as $$
 with recursive periods(valid_from,valid_until)as(
  select e.valid_from,e.valid_until from public.participant_entitlements e where e.user_id=p_user_id and e.revoked_at is null
  union all
  select p.valid_from,p.valid_until from xelay_student_private.grants g join xelay_student_private.grant_periods p on p.grant_id=g.id
  join xelay_student_private.audiences a on a.user_id=g.user_id and a.audience='student'where g.user_id=p_user_id and g.revoked_at is null
 ),coverage(until_at)as(
  select max(valid_until)from periods where valid_from<=p_at and valid_until>p_at
  union
  select p.valid_until from coverage c join periods p on p.valid_from<=c.until_at and p.valid_until>c.until_at
 )select max(until_at)from coverage;
$$;
do $copy_access$declare definition text;begin
 definition:=pg_get_functiondef('public.xelay_has_participant_access(uuid)'::regprocedure);
 if position('CREATE OR REPLACE FUNCTION public.xelay_has_participant_access('in definition)<>1
  or position('xelay_student_private'in definition)>0 then raise exception 'STUDENT_PARTICIPANT_HELPER_DRIFT';end if;
 execute replace(definition,'CREATE OR REPLACE FUNCTION public.xelay_has_participant_access(','CREATE FUNCTION xelay_student_private.legacy_has_participant_access(');
 definition:=pg_get_functiondef('public.xelay_billing_status()'::regprocedure);
 if definition is null or position('CREATE OR REPLACE FUNCTION public.xelay_billing_status('in definition)<>1
  or position('xelay_student_private'in definition)>0 then raise exception 'STUDENT_BILLING_STATUS_DRIFT';end if;
 execute replace(definition,'CREATE OR REPLACE FUNCTION public.xelay_billing_status(','CREATE FUNCTION xelay_student_private.legacy_billing_status(');
end$copy_access$;
create or replace function public.xelay_has_participant_access(p_user_id uuid)
returns boolean language sql stable security definer set search_path=''as $$
 select xelay_student_private.legacy_has_participant_access(p_user_id)
  or xelay_student_private.active_plan_access(p_user_id,clock_timestamp());
$$;
create or replace function public.xelay_billing_status()
returns jsonb language plpgsql stable security definer set search_path=''as $$
declare result jsonb;expiry timestamptz;begin
 result:=xelay_student_private.legacy_billing_status();
 -- All legacy preferences, free limits, paid flags and lifetime logic remain in
 -- the original implementation. Extend only uninterrupted paid coverage.
 if result->'is_lifetime'='true'::jsonb then expiry:=null;
 else expiry:=xelay_student_private.participant_coverage_until(auth.uid(),clock_timestamp());end if;
 return result||jsonb_build_object('expires_at',expiry);
end$$;
revoke all on all functions in schema xelay_student_private from public,anon,authenticated,service_role;
revoke all on function public.xelay_create_student_plan_order(uuid,text,text,text),public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)from public,anon,authenticated,service_role;
grant execute on function public.xelay_create_student_plan_order(uuid,text,text,text),public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)to service_role;
notify pgrst,'reload schema';
commit;
