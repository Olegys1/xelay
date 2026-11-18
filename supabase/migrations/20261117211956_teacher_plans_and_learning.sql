-- Local preparation. Teacher paid tools are separate from every existing free
-- classroom feature, student grant, lifetime gift and official grade.
begin;
set local lock_timeout='5s';set local statement_timeout='90s';
do $$begin
 if to_regnamespace('xelay_teacher_private')is not null
 or to_regprocedure('xelay_student_private.caller()')is null
 or to_regprocedure('public.xelay_teaching_has_current_access(uuid)')is null
 or to_regprocedure('public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)')is null
 or to_regclass('public.teaching_test_attempts')is null then raise exception 'TEACHER_PLANS_PREREQUISITE_OR_DRIFT';end if;
end$$;
create schema xelay_teacher_private;
revoke all on schema xelay_teacher_private from public,anon,authenticated,service_role;
alter table xelay_student_private.audiences drop constraint audiences_source_check;
alter table xelay_student_private.audiences add constraint audiences_source_check check(source in('registration','audited_assignment','paid_student_order','paid_teacher_order'));
alter table public.billing_orders add column teacher_plan_id text;
-- Retain the exact deployed legacy/student/coupon price predicate.
do $$declare prior text;begin
 select pg_get_expr(conbin,conrelid)into prior from pg_constraint where conrelid='public.billing_orders'::regclass and conname='billing_order_product_price';
 if prior is null or position('teacher_plan_id'in prior)>0 then raise exception 'TEACHER_ORDER_PRICE_DRIFT';end if;
 alter table public.billing_orders drop constraint billing_order_product_price;
 execute 'alter table public.billing_orders add constraint billing_order_product_price check(coalesce((teacher_plan_id is null and ('||prior||')) or (teacher_plan_id in(''teacher_start'',''teacher_plus'',''teacher_max'') and product=''participant'' and group_id is null and student_plan_id is null and birthday_gift_id is null and list_amount is null and discount_percent is null and discount_expires_at is null and amount=case teacher_plan_id when''teacher_start''then 199 when''teacher_plus''then 499 else 999 end),false))';
end$$;
create function xelay_teacher_private.order_guard()returns trigger language plpgsql set search_path=''as $$begin
 if new.teacher_plan_id is distinct from old.teacher_plan_id then raise exception 'BILLING_ORDER_SNAPSHOT_IMMUTABLE'using errcode='42501';end if;return new;
end$$;
create trigger xelay_teacher_order_guard before update on public.billing_orders for each row execute function xelay_teacher_private.order_guard();
create table xelay_teacher_private.grants(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id)on delete cascade,
 plan_id text not null check(plan_id in('teacher_start','teacher_plus','teacher_max')),
 order_id uuid not null unique references public.billing_orders(id)on delete restrict,
 valid_from timestamptz not null,valid_until timestamptz not null,revoked_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),check(valid_until>valid_from)
);
create table xelay_teacher_private.periods(
 id uuid primary key default gen_random_uuid(),grant_id uuid not null references xelay_teacher_private.grants(id)on delete cascade,
 valid_from timestamptz not null,valid_until timestamptz not null,check(valid_until>valid_from)
);
create index teacher_grants_owner on xelay_teacher_private.grants(user_id,valid_until)where revoked_at is null;
create index teacher_periods_grant on xelay_teacher_private.periods(grant_id,valid_until);
create table xelay_teacher_private.usage(
 user_id uuid not null references public.profiles(id)on delete cascade,grant_id uuid not null references xelay_teacher_private.grants(id)on delete restrict,
 spent_micros bigint not null default 0 check(spent_micros>=0),reserved_micros bigint not null default 0 check(reserved_micros>=0),
 primary key(user_id,grant_id)
);
create table xelay_teacher_private.requests(
 user_id uuid not null references public.profiles(id)on delete cascade,id uuid not null,
 session_hash text not null,fingerprint text not null,grant_id uuid not null,
 reservation_id uuid not null unique default gen_random_uuid(),reserve_micros bigint not null check(reserve_micros between 1 and 50000),
 charge_micros bigint check(charge_micros between 0 and 1000000000),request jsonb not null,context_hash text not null,
 state text not null default'pending'check(state in('pending','done')),bundle jsonb,
 created_at timestamptz not null default clock_timestamp(),settled_at timestamptz,
 primary key(user_id,id),foreign key(user_id,grant_id)references xelay_teacher_private.usage(user_id,grant_id)
);
create table xelay_teacher_private.drafts(
 user_id uuid not null,id uuid not null,request jsonb not null,bundle jsonb not null,
 status text not null default'draft'check(status in('draft','accepted')),teacher_notes text not null default''check(length(teacher_notes)<=5000),
 revision integer not null default 1 check(revision>0),created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 primary key(user_id,id),foreign key(user_id,id)references xelay_teacher_private.requests(user_id,id)on delete cascade
);
create table xelay_teacher_private.schedule_audit(
 id uuid primary key default gen_random_uuid(),grant_id uuid not null references xelay_teacher_private.grants(id),
 original_from timestamptz not null,original_until timestamptz not null,new_from timestamptz not null,new_until timestamptz not null,reason text not null
);
do $$declare name text;begin foreach name in array array['grants','periods','usage','requests','drafts','schedule_audit']loop
 execute format('alter table xelay_teacher_private.%I enable row level security',name);
 execute format('revoke all on xelay_teacher_private.%I from public,anon,authenticated,service_role',name);
end loop;end$$;
create function xelay_teacher_private.rank(p text)returns integer language sql immutable set search_path=''as $$select case p when'teacher_max'then 3 when'teacher_plus'then 2 when'teacher_start'then 1 else 0 end;$$;
create function xelay_teacher_private.modes(p text)returns text[]language sql immutable set search_path=''as $$select case
 when p='teacher_max'then array['questions','variants','tasks','rubric_review','quality','error_practice']
 when p='teacher_plus'then array['questions','variants','tasks','rubric_review']
 when p='teacher_start'then array['questions','variants','tasks']else '{}'::text[]end;$$;
create function xelay_teacher_private.entitlement(p_user_id uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare a text;chosen record;lim bigint:=0;spent bigint:=0;reserved bigint:=0;access boolean;begin
 select audience into a from xelay_student_private.audiences where user_id=p_user_id;
 access:=coalesce(public.xelay_teaching_has_current_access(p_user_id),false);
 if a='teacher'and access then
  select g.id,g.plan_id,p.valid_from,p.valid_until into chosen from xelay_teacher_private.grants g join xelay_teacher_private.periods p on p.grant_id=g.id
  where g.user_id=p_user_id and g.revoked_at is null and p.valid_from<=clock_timestamp()and p.valid_until>clock_timestamp()
  order by xelay_teacher_private.rank(g.plan_id)desc,p.valid_until desc,g.created_at desc,g.id limit 1;
  if found then lim:=case chosen.plan_id when'teacher_start'then 1000000 when'teacher_plus'then 4000000 else 8000000 end;
   select spent_micros,reserved_micros into spent,reserved from xelay_teacher_private.usage where user_id=p_user_id and grant_id=chosen.id;
  end if;
 end if;
 return jsonb_build_object('userId',p_user_id,'audience',coalesce(a,'unresolved'),'planId',case when lim>0 then chosen.plan_id else'free'end,
 'canGenerate',lim-coalesce(spent,0)-coalesce(reserved,0)>=50000,'canEdit',access and coalesce(a='teacher',false)and lim>0,
 'startsAt',case when lim>0 then chosen.valid_from else null end,'expiresAt',case when lim>0 then chosen.valid_until else null end,
 'budgetPeriod','subscription_month','budget',jsonb_build_object('limitMicros',lim,'spentMicros',coalesce(spent,0),'reservedMicros',coalesce(reserved,0)),
 'allowedModes',to_jsonb(xelay_teacher_private.modes(case when lim>0 then chosen.plan_id else null end)));
end$$;
create function public.xelay_teacher_workspace_status()returns jsonb language plpgsql stable security definer set search_path=''as $$begin
 return xelay_teacher_private.entitlement(xelay_student_private.caller());end$$;
create function public.xelay_teacher_plan_state()returns jsonb language sql stable security definer set search_path=''as $$select public.xelay_teacher_workspace_status();$$;
create function public.xelay_create_teacher_plan_order(p_user_id uuid,p_mode text,p_order_reference text,p_plan_id text)
returns jsonb language plpgsql security definer set search_path=''as $$
declare o public.billing_orders;a text;begin
 perform xelay_student_private.service();
 if p_user_id is null or p_mode is null or p_mode not in('live','test')or xelay_teacher_private.rank(p_plan_id)=0
 or p_order_reference is null or p_order_reference!~'^xelay_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'then raise exception 'TEACHER_ORDER_INVALID'using errcode='22023';end if;
 if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id where u.id=p_user_id and u.email_confirmed_at is not null and u.deleted_at is null and(u.banned_until is null or u.banned_until<=clock_timestamp()))
 or not public.xelay_teaching_has_current_access(p_user_id)then raise exception 'TEACHER_VERIFIED_ACCOUNT_REQUIRED'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('xelay:checkout:'||p_user_id::text,0));
 select audience into a from xelay_student_private.audiences where user_id=p_user_id;
 if a='student'or(a is null and not exists(select 1 from public.profiles where id=p_user_id and account_type='teacher'))then raise exception 'TEACHER_BILLING_AUDIENCE_REQUIRED'using errcode='42501';end if;
 select*into o from public.billing_orders where user_id=p_user_id and teacher_plan_id=p_plan_id and mode=p_mode and status='pending'and created_at>clock_timestamp()-interval'1 hour'order by created_at desc limit 1;
 if found then return to_jsonb(o);end if;
 if(select count(*)from public.billing_orders where user_id=p_user_id and created_at>clock_timestamp()-interval'1 hour')>=10 then raise exception 'CHECKOUT_RATE_LIMIT'using errcode='PT429';end if;
 insert into public.billing_orders(user_id,product,order_reference,amount,mode,teacher_plan_id)
 values(p_user_id,'participant',p_order_reference,case p_plan_id when'teacher_start'then 199 when'teacher_plus'then 499 else 999 end,p_mode,p_plan_id)returning*into o;
 return to_jsonb(o);
end$$;
create function xelay_teacher_private.activate(p_order_id uuid)returns void language plpgsql security definer set search_path=''as $$
declare o public.billing_orders;old record;a text;v_now timestamptz:=clock_timestamp();v_from timestamptz;v_until timestamptz;cursor_at timestamptz;cut_at timestamptz;remaining interval;g uuid;begin
 select*into o from public.billing_orders where id=p_order_id for update;
 if not found or xelay_teacher_private.rank(o.teacher_plan_id)=0 or o.status<>'approved'or o.mode<>'live'or o.currency<>'UAH'
 or o.student_plan_id is not null or o.amount<>(case o.teacher_plan_id when'teacher_start'then 199 when'teacher_plus'then 499 else 999 end)then raise exception 'TEACHER_APPROVED_PAYMENT_REQUIRED'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('student-owner:'||o.user_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('teacher-owner:'||o.user_id::text,0));
 if exists(select 1 from xelay_teacher_private.grants where order_id=o.id)then return;end if;
 select audience into a from xelay_student_private.audiences where user_id=o.user_id;
 if a='student'then raise exception 'TEACHER_BILLING_AUDIENCE_REQUIRED'using errcode='42501';end if;
 insert into xelay_student_private.audiences(user_id,audience,source,reason)values(o.user_id,'teacher','paid_teacher_order','Verified paid teacher order '||o.order_reference)on conflict do nothing;
 select greatest(v_now,coalesce(max(p.valid_until),v_now))into v_from from xelay_teacher_private.periods p join xelay_teacher_private.grants z on z.id=p.grant_id
 where z.user_id=o.user_id and z.revoked_at is null and p.valid_until>v_now and xelay_teacher_private.rank(z.plan_id)>=xelay_teacher_private.rank(o.teacher_plan_id);
 v_until:=((v_from at time zone'Europe/Kyiv')+interval'1 month')at time zone'Europe/Kyiv';cursor_at:=v_until;
 for old in select p.*from xelay_teacher_private.periods p join xelay_teacher_private.grants z on z.id=p.grant_id
 where z.user_id=o.user_id and z.revoked_at is null and p.valid_until>v_from and xelay_teacher_private.rank(z.plan_id)<xelay_teacher_private.rank(o.teacher_plan_id)
 order by p.valid_from,z.created_at,p.id for update of p loop
  if old.valid_from>=cursor_at then cursor_at:=old.valid_until;continue;end if;
  cut_at:=greatest(old.valid_from,v_from);remaining:=old.valid_until-cut_at;
  if old.valid_from<cut_at then update xelay_teacher_private.periods set valid_until=cut_at where id=old.id;
   insert into xelay_teacher_private.periods(grant_id,valid_from,valid_until)values(old.grant_id,cursor_at,cursor_at+remaining);
  else update xelay_teacher_private.periods set valid_from=cursor_at,valid_until=cursor_at+remaining where id=old.id;end if;
  insert into xelay_teacher_private.schedule_audit(grant_id,original_from,original_until,new_from,new_until,reason)values(old.grant_id,old.valid_from,old.valid_until,cursor_at,cursor_at+remaining,'upgrade:'||o.id::text);
  cursor_at:=cursor_at+remaining;
 end loop;
 insert into xelay_teacher_private.grants(user_id,plan_id,order_id,valid_from,valid_until)values(o.user_id,o.teacher_plan_id,o.id,v_from,v_until)returning id into g;
 insert into xelay_teacher_private.periods(grant_id,valid_from,valid_until)values(g,v_from,v_until);
end$$;
create function xelay_teacher_private.refund_reflow(p_user_id uuid)returns void language plpgsql security definer set search_path=''as $$
declare p record;cursor_at timestamptz:=clock_timestamp();duration interval;begin
 select greatest(cursor_at,coalesce(max(s.valid_until),cursor_at))into cursor_at from xelay_teacher_private.periods s join xelay_teacher_private.grants g on g.id=s.grant_id
 where g.user_id=p_user_id and g.revoked_at is null and s.valid_from<=clock_timestamp()and s.valid_until>clock_timestamp();
 for p in select s.*from xelay_teacher_private.periods s join xelay_teacher_private.grants g on g.id=s.grant_id where g.user_id=p_user_id and g.revoked_at is null and s.valid_from>clock_timestamp()order by s.valid_from,g.created_at,s.id for update of s loop
  duration:=p.valid_until-p.valid_from;
  if p.valid_from>cursor_at then update xelay_teacher_private.periods set valid_from=cursor_at,valid_until=cursor_at+duration where id=p.id;
   insert into xelay_teacher_private.schedule_audit(grant_id,original_from,original_until,new_from,new_until,reason)values(p.grant_id,p.valid_from,p.valid_until,cursor_at,cursor_at+duration,'refund_reflow');
   cursor_at:=cursor_at+duration;
  else cursor_at:=greatest(cursor_at,p.valid_until);end if;
 end loop;
end$$;
do $$declare definition text;begin
 definition:=pg_get_functiondef('public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)'::regprocedure);
 if position('CREATE OR REPLACE FUNCTION public.xelay_apply_billing_event('in definition)<>1 or position('teacher_plan_id'in definition)>0 then raise exception 'TEACHER_CALLBACK_DRIFT';end if;
 execute replace(definition,'CREATE OR REPLACE FUNCTION public.xelay_apply_billing_event(','CREATE FUNCTION xelay_teacher_private.previous_billing_event(');
end$$;
create or replace function public.xelay_apply_billing_event(p_reference text,p_mode text,p_fingerprint text,p_status text,p_amount numeric,p_currency text,p_fee numeric default null)
returns jsonb language plpgsql security definer set search_path=''as $$
declare o public.billing_orders;n integer;begin
 perform xelay_student_private.service();select*into o from public.billing_orders where order_reference=p_reference for update;
 if not found or o.teacher_plan_id is null then return xelay_teacher_private.previous_billing_event(p_reference,p_mode,p_fingerprint,p_status,p_amount,p_currency,p_fee);end if;
 if o.mode is distinct from p_mode or o.amount is distinct from p_amount or p_currency is distinct from'UAH'or p_status is null or p_fingerprint is null or p_fingerprint!~'^[a-f0-9]{64}$'then raise exception 'TEACHER_PAYMENT_MISMATCH'using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('teacher-owner:'||o.user_id::text,0));
 if exists(select 1 from public.billing_payment_events where fingerprint=p_fingerprint and order_id<>o.id)then raise exception 'TEACHER_EVENT_CONFLICT'using errcode='PT409';end if;
 insert into public.billing_payment_events(order_id,fingerprint,provider_status,amount,mode)values(o.id,p_fingerprint,p_status,p_amount,p_mode)on conflict(fingerprint)do nothing;get diagnostics n=row_count;
 if n=0 then return jsonb_build_object('duplicate',true,'status',o.status,'mode',p_mode);end if;
 if p_status='Approved'and o.status not in('approved','refunded','voided')then
  update public.billing_orders set status='approved',provider_status=p_status,provider_fee=p_fee,approved_at=clock_timestamp(),updated_at=clock_timestamp()where id=o.id;
  if p_mode='live'then perform xelay_teacher_private.activate(o.id);end if;
 elsif p_status in('Refunded','Voided')then
  update public.billing_orders set status=case when p_status='Refunded'or o.status='refunded'then'refunded'else'voided'end,provider_status=case when o.status='refunded'then'Refunded'else p_status end,updated_at=clock_timestamp()where id=o.id;
  update xelay_teacher_private.grants set revoked_at=clock_timestamp()where order_id=o.id and revoked_at is null;
  if p_mode='live'then perform xelay_teacher_private.refund_reflow(o.user_id);end if;
 elsif p_status in('Declined','Expired')and o.status not in('approved','refunded','voided')then
  update public.billing_orders set status=case when p_status='Expired'then'expired'else'declined'end,provider_status=p_status,updated_at=clock_timestamp()where id=o.id;
 else update public.billing_orders set provider_status=p_status,updated_at=clock_timestamp()where id=o.id;end if;
 return jsonb_build_object('duplicate',false,'mode',p_mode,'teacher',true);
end$$;

create function xelay_teacher_private.request_valid(r jsonb)returns boolean language plpgsql immutable set search_path=''as $$begin
 return coalesce(jsonb_typeof(r)='object'and octet_length(r::text)<=64000 and(r->>'requestId')~'^[a-f0-9-]{36}$'
 and r->>'kind'in('questions','variants','tasks','rubric_review','quality','error_practice')and r->'consent'='true'::jsonb
 and(r->>'courseId')~'^[a-f0-9-]{36}$'and xelay_student_private.plain(r->>'prompt',2400)
 and jsonb_typeof(r->'groupIds')='array'and jsonb_array_length(r->'groupIds')between 1 and 10
 and not exists(select 1 from jsonb_array_elements_text(r->'groupIds')g where g!~'^[a-f0-9-]{36}$')
 and coalesce(length(r->>'sourceText'),0)<=12000 and coalesce(length(r->>'rubricText'),0)<=4000
 and not exists(select 1 from jsonb_object_keys(r)k where not k=any(array['requestId','kind','courseId','groupIds','prompt','consent','sourceText','rubricText','submissionId','testId','questionCount','variantCount'])),false);
exception when others then return false;end$$;
-- Authenticated direct-RPC edits must satisfy the same persisted structure as
-- the API. A malformed own draft must not poison the whole history on reload.
create function xelay_teacher_private.text_valid(v jsonb,n integer,p_empty boolean default false)returns boolean language sql immutable set search_path=''as $$
 select coalesce(jsonb_typeof(v)='string'and length(v#>>'{}')<=n and(p_empty or length(btrim(v#>>'{}'))>0)
 and(v#>>'{}')!~'[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'and(v#>>'{}')!~*'</?[a-z][^>]*>',false);
$$;
create function xelay_teacher_private.bundle_valid(v jsonb,r jsonb)returns boolean language plpgsql immutable set search_path=''as $$
declare q jsonb;t jsonb;c jsonb;review jsonb;seen text[]:='{}';kind text:=r->>'kind';n integer:=coalesce((r->>'questionCount')::integer,5);variants integer:=case when r->>'kind'='variants'then coalesce((r->>'variantCount')::integer,2)else 1 end;i integer;total numeric:=0;maximum numeric:=0;begin
 if not xelay_student_private.fields(v,array['version','kind','title','summary','questions','tasks','review','quality','warnings'])
 or v->'version' is distinct from'1'::jsonb or v->>'kind'is distinct from kind
 or not(xelay_teacher_private.text_valid(v->'title',180)and xelay_teacher_private.text_valid(v->'summary',2400))
 or jsonb_typeof(v->'questions')is distinct from'array'or jsonb_array_length(v->'questions')>20
 or jsonb_typeof(v->'tasks')is distinct from'array'or jsonb_array_length(v->'tasks')>10
 or jsonb_typeof(v->'quality')is distinct from'array'or jsonb_array_length(v->'quality')>30
 or jsonb_typeof(v->'warnings')is distinct from'array'or jsonb_array_length(v->'warnings')>10
 or octet_length(v::text)>100000 then return false;end if;
 for q in select value from jsonb_array_elements(v->'questions')loop
  if not xelay_student_private.fields(q,array['id','type','text','choices','correctIndex','explanation','points','topic','variant'])
  or not coalesce(jsonb_typeof(q->'id')='string'and q->>'id'~'^[A-Za-z0-9_-]{1,64}$'and not(q->>'id')=any(seen)and q->>'type'='single'
   and xelay_teacher_private.text_valid(q->'text',2000)and xelay_teacher_private.text_valid(q->'explanation',1000)and xelay_teacher_private.text_valid(q->'topic',200),false)
  or jsonb_typeof(q->'choices')is distinct from'array'or jsonb_array_length(q->'choices')<>4
  or jsonb_typeof(q->'correctIndex')is distinct from'number'or(q->>'correctIndex')!~'^[0-3]$'
  or jsonb_typeof(q->'variant')is distinct from'number'or(q->>'variant')!~'^[1-3]$'
  or jsonb_typeof(q->'points')is distinct from'number'or(q->>'points')::numeric not between 0.01 and 100
  or round((q->>'points')::numeric,2)<>(q->>'points')::numeric then return false;end if;
  if exists(select 1 from jsonb_array_elements(q->'choices')x where jsonb_typeof(x)is distinct from'string'or not coalesce(xelay_student_private.plain(x#>>'{}',500),false))
   or(select count(distinct x)from jsonb_array_elements(q->'choices')x)<>4 then return false;end if;
  seen:=array_append(seen,q->>'id');
 end loop;
 for t in select value from jsonb_array_elements(v->'tasks')loop
  if not xelay_student_private.fields(t,array['title','instructions','criteria'])
  or not(xelay_teacher_private.text_valid(t->'title',180)and xelay_teacher_private.text_valid(t->'instructions',3000))
  or jsonb_typeof(t->'criteria')is distinct from'array'or jsonb_array_length(t->'criteria')not between 1 and 10
  or exists(select 1 from jsonb_array_elements(t->'criteria')x where jsonb_typeof(x)is distinct from'string'or not coalesce(xelay_student_private.plain(x#>>'{}',500),false))then return false;end if;
 end loop;
 for q in select value from jsonb_array_elements(v->'quality')loop
  if not xelay_student_private.fields(q,array['questionId','issue','suggestion'])or not(xelay_teacher_private.text_valid(q->'questionId',64)and xelay_teacher_private.text_valid(q->'issue',1000)and xelay_teacher_private.text_valid(q->'suggestion',1500))then return false;end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(v->'warnings')x where jsonb_typeof(x)is distinct from'string'or not coalesce(xelay_student_private.plain(x#>>'{}',500),false))then return false;end if;
 review:=v->'review';
 if review<>'null'::jsonb then
  if not xelay_student_private.fields(review,array['criteria','feedback','suggestedScore','maxScore'])or not xelay_teacher_private.text_valid(review->'feedback',3000)
  or jsonb_typeof(review->'criteria')is distinct from'array'or jsonb_array_length(review->'criteria')not between 1 and 20
  or jsonb_typeof(review->'maxScore')is distinct from'number'or(review->>'maxScore')::numeric not between 0.01 and 10000
  or jsonb_typeof(review->'suggestedScore')is distinct from'number'or(review->>'suggestedScore')::numeric not between 0 and(review->>'maxScore')::numeric
  or round((review->>'maxScore')::numeric,2)<>(review->>'maxScore')::numeric or round((review->>'suggestedScore')::numeric,2)<>(review->>'suggestedScore')::numeric then return false;end if;
  for c in select value from jsonb_array_elements(review->'criteria')loop
   if not xelay_student_private.fields(c,array['title','points','maxPoints','comment','evidence'])or not(xelay_teacher_private.text_valid(c->'title',200)and xelay_teacher_private.text_valid(c->'comment',1000))
   or jsonb_typeof(c->'maxPoints')is distinct from'number'or(c->>'maxPoints')::numeric not between 0 and 10000
   or jsonb_typeof(c->'points')is distinct from'number'or(c->>'points')::numeric not between 0 and(c->>'maxPoints')::numeric
   or round((c->>'maxPoints')::numeric,2)<>(c->>'maxPoints')::numeric or round((c->>'points')::numeric,2)<>(c->>'points')::numeric
   or jsonb_typeof(c->'evidence')is distinct from'array'or jsonb_array_length(c->'evidence')>4
   or exists(select 1 from jsonb_array_elements(c->'evidence')x where jsonb_typeof(x)is distinct from'string'or not coalesce(xelay_student_private.plain(x#>>'{}',180),false))then return false;end if;
   total:=total+(c->>'points')::numeric;maximum:=maximum+(c->>'maxPoints')::numeric;
  end loop;
  if abs(total-(review->>'suggestedScore')::numeric)>0.011 or abs(maximum-(review->>'maxScore')::numeric)>0.011 then return false;end if;
 end if;
 if kind in('questions','variants','error_practice')then
  if jsonb_array_length(v->'questions')<>n*variants or jsonb_array_length(v->'tasks')<>0 or review<>'null'::jsonb or jsonb_array_length(v->'quality')<>0 then return false;end if;
  for i in 1..variants loop if(select count(*)from jsonb_array_elements(v->'questions')as question(entry)where(question.entry->>'variant')::integer=i)<>n then return false;end if;end loop;
  if kind='variants'then
   for i in 2..variants loop
    if exists(select 1 from(select item,row_number()over(order by position)rn from jsonb_array_elements(v->'questions')with ordinality items(item,position)where item->>'variant'='1')a
     join(select item,row_number()over(order by position)rn from jsonb_array_elements(v->'questions')with ordinality items(item,position)where(item->>'variant')::integer=i)b using(rn)
     where a.item->>'topic'is distinct from b.item->>'topic'or a.item->'points'is distinct from b.item->'points'or a.item->>'text'=b.item->>'text')then return false;end if;
   end loop;
  end if;
 elsif jsonb_array_length(v->'questions')<>0 then return false;end if;
 if(kind='tasks'and(jsonb_array_length(v->'tasks')=0 or review<>'null'::jsonb or jsonb_array_length(v->'quality')<>0))or(kind<>'tasks'and jsonb_array_length(v->'tasks')<>0)
 or(kind='rubric_review'and review='null'::jsonb)or(kind<>'rubric_review'and review<>'null'::jsonb)or(kind<>'quality'and jsonb_array_length(v->'quality')<>0)then return false;end if;
 return true;
exception when others then return false;end$$;
-- Context is caller-only and re-authorized before generation and settlement.
-- No names, contacts, live student drafts or journal rows go to the provider.
create function xelay_teacher_private.context(p_user_id uuid,r jsonb)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare c public.teaching_courses;g uuid;groups jsonb:='[]';permission text;sub record;test public.teaching_tests;payload jsonb;errors jsonb;begin
 if not xelay_teacher_private.request_valid(r)then raise exception 'TEACHER_AI_INVALID'using errcode='22023';end if;
 if not public.xelay_teaching_has_current_access(p_user_id)then raise exception 'TEACHER_VERIFIED_ACCESS_REQUIRED'using errcode='42501';end if;
 select*into c from public.teaching_courses where id=(r->>'courseId')::uuid and archived_at is null;
 if not found then raise exception 'TEACHER_COURSE_FORBIDDEN'using errcode='42501';end if;
 permission:=case when r->>'kind'in('rubric_review','error_practice')then'grades'else'assignments'end;
 if not permission=any(public.xelay_teaching_permissions(c.id,p_user_id))then raise exception 'TEACHER_COURSE_FORBIDDEN'using errcode='42501';end if;
 for g in select value::uuid from jsonb_array_elements_text(r->'groupIds')loop
  if not permission=any(public.xelay_teaching_group_permissions(c.id,g,p_user_id))or not exists(select 1 from public.teaching_course_groups where course_id=c.id and group_id=g and status='accepted')then raise exception 'TEACHER_GROUP_FORBIDDEN'using errcode='42501';end if;
  groups:=groups||jsonb_build_array(jsonb_build_object('id',g,'name',(select group_name from public.study_groups where id=g)));
 end loop;
 if jsonb_array_length(groups)<>(select count(distinct x)from jsonb_array_elements_text(r->'groupIds')x)then raise exception 'TEACHER_DUPLICATE_GROUP'using errcode='22023';end if;
 payload:=jsonb_build_object('course',jsonb_build_object('id',c.id,'title',c.title,'version',c.version),'groups',groups);
 if r->>'kind'='rubric_review'then
  select s.id,s.version,s.body,s.item_id,i.title,i.body assignment_body,i.max_points,b.rubric,b.version rubric_version into sub
   from public.teaching_submissions s join public.teaching_items i on i.id=s.item_id join public.teaching_assignment_rubrics b on b.item_id=i.id
   where s.id=(r->>'submissionId')::uuid and s.course_id=c.id and s.group_id=any(array(select value::uuid from jsonb_array_elements_text(r->'groupIds')))
   and s.status in('submitted','reviewed')and i.kind='assignment'and i.max_points is not null;
  if not found or length(btrim(sub.body))=0 or length(sub.body)>12000 then raise exception 'TEACHER_REVIEW_TEXT_AND_RUBRIC_REQUIRED'using errcode='22023';end if;
  payload:=payload||jsonb_build_object('submission',jsonb_build_object('id',sub.id,'version',sub.version,'body',sub.body,'assignmentTitle',sub.title,'assignmentBody',left(sub.assignment_body,4000),'maximum',sub.max_points,'rubric',sub.rubric,'rubricVersion',sub.rubric_version));
 elsif r->>'kind'in('quality','error_practice')then
  select*into test from public.teaching_tests where id=(r->>'testId')::uuid and course_id=c.id;
  if not found or not public.xelay_private_test_staff(test,p_user_id,permission,false)then raise exception 'TEACHER_TEST_FORBIDDEN'using errcode='42501';end if;
  if jsonb_array_length(test.questions)>30 or octet_length(test.questions::text)>30000 then raise exception 'TEACHER_TEST_TOO_LARGE'using errcode='22023';end if;
  payload:=payload||jsonb_build_object('test',jsonb_build_object('id',test.id,'title',test.title,'version',test.version,'questions',test.questions));
  if r->>'kind'='error_practice'then
   if test.closes_at>clock_timestamp()or exists(select 1 from public.teaching_test_attempts a where a.test_id=test.id and a.group_id=any(array(select value::uuid from jsonb_array_elements_text(r->'groupIds')))and a.status='in_progress')then raise exception 'TEACHER_TEST_NOT_FINISHED'using errcode='PT409';end if;
   select coalesce(jsonb_agg(jsonb_build_object('question',z.question,'responses',z.responses,'errors',z.errors)order by z.errors desc),'[]')into errors from(
    select jsonb_build_object('id',q->>'id','kind',q->>'kind','text',q->>'text','options',q->'options','points',q->'points')question,
     count(*)::integer responses,count(*)filter(where public.xelay_private_test_question_points(q,a.answers->(q->>'id'))<(q->>'points')::numeric)::integer errors
    from public.teaching_test_attempts a cross join lateral jsonb_array_elements(a.questions)q
    where a.test_id=test.id and a.group_id=any(array(select value::uuid from jsonb_array_elements_text(r->'groupIds')))and a.status='submitted'and q->>'kind'<>'essay'
    group by jsonb_build_object('id',q->>'id','kind',q->>'kind','text',q->>'text','options',q->'options','points',q->'points')
    having count(*)filter(where public.xelay_private_test_question_points(q,a.answers->(q->>'id'))<(q->>'points')::numeric)>0
    order by errors desc limit 12)z;
   if jsonb_array_length(errors)=0 then raise exception 'TEACHER_NO_CONFIRMED_ERRORS'using errcode='22023';end if;
   payload:=payload||jsonb_build_object('actualErrors',errors);
  end if;
 end if;
 if octet_length(payload::text)>50000 then raise exception 'TEACHER_CONTEXT_TOO_LARGE'using errcode='22023';end if;
 return payload;
end$$;
create function public.xelay_teacher_ai_context(p_request jsonb)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();e jsonb;ctx jsonb;begin
 e:=xelay_teacher_private.entitlement(u);
 if not(p_request->>'kind')=any(array(select jsonb_array_elements_text(e->'allowedModes')))
 or(jsonb_array_length(p_request->'groupIds')>1 and e->>'planId'<>'teacher_max')then raise exception 'TEACHER_PLAN_REQUIRED'using errcode='42501';end if;
 ctx:=xelay_teacher_private.context(u,p_request);
 return jsonb_build_object('context',ctx,'contextHash',encode(sha256(convert_to(ctx::text,'UTF8')),'hex'));
end$$;
create function public.xelay_teacher_ai_catalog()returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();begin
 if not public.xelay_teaching_has_current_access(u)then return '[]'::jsonb;end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'permissions',public.xelay_teaching_permissions(c.id,u),'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.group_name,'permissions',public.xelay_teaching_group_permissions(c.id,g.id,u))order by g.group_name)from public.teaching_course_groups l join public.study_groups g on g.id=l.group_id where l.course_id=c.id and l.status='accepted'and public.xelay_teaching_group_permissions(c.id,g.id,u)&&array['assignments','grades']::text[]),'[]'))order by c.title)
 from(select*from public.teaching_courses cc where cc.archived_at is null and public.xelay_teaching_permissions(cc.id,u)&&array['assignments','grades']::text[]order by cc.title limit 100)c),'[]');
end$$;
create function public.xelay_teacher_ai_candidates(p_course_id uuid,p_group_ids uuid[])returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();g uuid;rights text[];can_grade boolean:=true;can_assign boolean:=true;begin
 if not public.xelay_teaching_has_current_access(u)or p_group_ids is null or cardinality(p_group_ids)not between 1 and 10 or array_position(p_group_ids,null)is not null
 or cardinality(p_group_ids)<>(select count(distinct x)from unnest(p_group_ids)x)then raise exception 'TEACHER_CANDIDATES_FORBIDDEN'using errcode='42501';end if;
 if not exists(select 1 from public.teaching_courses where id=p_course_id and archived_at is null)then raise exception 'TEACHER_COURSE_FORBIDDEN'using errcode='42501';end if;
 foreach g in array p_group_ids loop
  rights:=public.xelay_teaching_group_permissions(p_course_id,g,u);
  if not rights&&array['assignments','grades']::text[]or not exists(select 1 from public.teaching_course_groups where course_id=p_course_id and group_id=g and status='accepted')then raise exception 'TEACHER_GROUP_FORBIDDEN'using errcode='42501';end if;
  can_grade:=can_grade and'grades'=any(rights);can_assign:=can_assign and'assignments'=any(rights);
 end loop;
 return jsonb_build_object('submissions',case when can_grade then coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'label',s.title||' · робота '||s.number))from(
  select s.id,i.title,row_number()over(order by s.submitted_at desc,s.id)number from public.teaching_submissions s join public.teaching_items i on i.id=s.item_id
  join public.teaching_assignment_rubrics r on r.item_id=i.id where s.course_id=p_course_id and s.group_id=any(p_group_ids)and s.status in('submitted','reviewed')and btrim(s.body)<>''and length(s.body)<=12000 order by s.submitted_at desc,s.id limit 50)s),'[]')else'[]'::jsonb end,
 'tests',case when can_assign or can_grade then coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.title))from(
  select t.id,t.title from public.teaching_tests t where t.course_id=p_course_id and exists(select 1 from jsonb_array_elements(t.targets)target where(target->>'group_id')::uuid=any(p_group_ids))order by t.created_at desc limit 50)t),'[]')else'[]'::jsonb end);
end$$;
create function public.xelay_teacher_ai_reserve(p_user_id uuid,p_session_hash text,p_request jsonb,p_fingerprint text,p_context_hash text,p_reserve_micros bigint)
returns jsonb language plpgsql security definer set search_path=''as $$
declare old xelay_teacher_private.requests;stale xelay_teacher_private.requests;e jsonb;g uuid;used xelay_teacher_private.usage;lim bigint;ctx jsonb;begin
 perform xelay_student_private.service();
 if not xelay_student_private.session_active(p_user_id,p_session_hash)then raise exception 'TEACHER_SESSION_REQUIRED'using errcode='42501';end if;
 if not xelay_teacher_private.request_valid(p_request)or p_fingerprint is null or p_fingerprint!~'^[a-f0-9]{64}$'or p_context_hash is null or p_context_hash!~'^[a-f0-9]{64}$'
 or p_reserve_micros is distinct from 50000::bigint then raise exception 'TEACHER_RESERVATION_INVALID'using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('teacher-owner:'||p_user_id::text,0));
 for stale in select*from xelay_teacher_private.requests where user_id=p_user_id and state='pending'and created_at<clock_timestamp()-interval'2 minutes'for update loop
  update xelay_teacher_private.usage set reserved_micros=reserved_micros-stale.reserve_micros,spent_micros=spent_micros+stale.reserve_micros where user_id=p_user_id and grant_id=stale.grant_id and reserved_micros>=stale.reserve_micros;
  if not found then raise exception 'TEACHER_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  update xelay_teacher_private.requests set state='done',charge_micros=stale.reserve_micros,settled_at=clock_timestamp()where user_id=p_user_id and id=stale.id;
 end loop;
 select*into old from xelay_teacher_private.requests where user_id=p_user_id and id=(p_request->>'requestId')::uuid;
 if found then
  if old.fingerprint<>p_fingerprint or old.request<>p_request then return jsonb_build_object('state','conflict');end if;
  if old.state='pending'then return jsonb_build_object('state','pending');end if;
  if old.bundle is null then return jsonb_build_object('state','failed');end if;
  -- Replays never grant content from a revoked course or a different account.
  perform xelay_teacher_private.context(p_user_id,p_request);
  return jsonb_build_object('state','replay','bundle',old.bundle);
 end if;
 e:=xelay_teacher_private.entitlement(p_user_id);lim:=(e->'budget'->>'limitMicros')::bigint;
 if not(p_request->>'kind')=any(array(select jsonb_array_elements_text(e->'allowedModes')))or(jsonb_array_length(p_request->'groupIds')>1 and e->>'planId'<>'teacher_max')then raise exception 'TEACHER_PLAN_REQUIRED'using errcode='42501';end if;
 ctx:=xelay_teacher_private.context(p_user_id,p_request);
 if encode(sha256(convert_to(ctx::text,'UTF8')),'hex')<>p_context_hash then raise exception 'TEACHER_CONTEXT_CHANGED'using errcode='PT409';end if;
 if exists(select 1 from xelay_teacher_private.requests where user_id=p_user_id and state='pending')then return jsonb_build_object('state','pending');end if;
 if(select count(*)from xelay_teacher_private.requests where user_id=p_user_id and created_at>clock_timestamp()-interval'1 minute')>=10 then raise exception 'TEACHER_AI_RATE_LIMIT'using errcode='PT429';end if;
 select z.id into g from xelay_teacher_private.grants z join xelay_teacher_private.periods p on p.grant_id=z.id where z.user_id=p_user_id and z.revoked_at is null and p.valid_from<=clock_timestamp()and p.valid_until>clock_timestamp()
 order by xelay_teacher_private.rank(z.plan_id)desc,p.valid_until desc,z.created_at desc,z.id limit 1;
 if g is null then return jsonb_build_object('state','denied');end if;
 insert into xelay_teacher_private.usage(user_id,grant_id)values(p_user_id,g)on conflict do nothing;
 select*into used from xelay_teacher_private.usage where user_id=p_user_id and grant_id=g for update;
 if used.spent_micros+used.reserved_micros+p_reserve_micros>lim then return jsonb_build_object('state','denied');end if;
 update xelay_teacher_private.usage set reserved_micros=reserved_micros+p_reserve_micros where user_id=p_user_id and grant_id=g;
 insert into xelay_teacher_private.requests(user_id,id,session_hash,fingerprint,grant_id,reserve_micros,request,context_hash)
 values(p_user_id,(p_request->>'requestId')::uuid,p_session_hash,p_fingerprint,g,p_reserve_micros,p_request,p_context_hash)returning*into old;
 return jsonb_build_object('state','reserved','reservationId',old.reservation_id);
end$$;
create function public.xelay_teacher_ai_finish(p_user_id uuid,p_session_hash text,p_request_id uuid,p_fingerprint text,p_reservation_id uuid,p_charge_micros bigint,p_bundle jsonb)
returns jsonb language plpgsql security definer set search_path=''as $$
declare old xelay_teacher_private.requests;ctx jsonb;keep boolean:=false;charge bigint;begin
 perform xelay_student_private.service();perform pg_advisory_xact_lock(hashtextextended('teacher-owner:'||p_user_id::text,0));
 select*into old from xelay_teacher_private.requests where user_id=p_user_id and id=p_request_id for update;
 if not found or old.session_hash is distinct from p_session_hash or old.fingerprint is distinct from p_fingerprint or old.reservation_id is distinct from p_reservation_id then raise exception 'TEACHER_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
 if old.state='done'then return jsonb_build_object('saved',old.bundle is not null,'replayed',true);end if;
 if p_charge_micros is null or p_charge_micros not between 0 and 1000000000 then raise exception 'TEACHER_USAGE_INVALID'using errcode='22023';end if;
 charge:=p_charge_micros;
 -- Always settle incurred provider costs, even when a session/access/record changes.
 -- Failed/unknown completion is conservatively charged at the prior reservation.
 if p_bundle is not null and xelay_teacher_private.bundle_valid(p_bundle,old.request)and xelay_student_private.session_active(p_user_id,p_session_hash)
 and xelay_teacher_private.entitlement(p_user_id)->>'planId'<>'free'then
  begin ctx:=xelay_teacher_private.context(p_user_id,old.request);keep:=encode(sha256(convert_to(ctx::text,'UTF8')),'hex')=old.context_hash;exception when others then keep:=false;end;
 end if;
 update xelay_teacher_private.usage set reserved_micros=reserved_micros-old.reserve_micros,spent_micros=spent_micros+charge where user_id=p_user_id and grant_id=old.grant_id and reserved_micros>=old.reserve_micros;
 if not found then raise exception 'TEACHER_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
 update xelay_teacher_private.requests set state='done',charge_micros=charge,bundle=case when keep then p_bundle else null end,settled_at=clock_timestamp()where user_id=p_user_id and id=p_request_id;
 if keep then insert into xelay_teacher_private.drafts(user_id,id,request,bundle)values(p_user_id,p_request_id,old.request,p_bundle);end if;
 return jsonb_build_object('saved',keep,'replayed',false);
end$$;
create function xelay_teacher_private.draft_json(d xelay_teacher_private.drafts)returns jsonb language sql stable set search_path=''as $$select jsonb_build_object('id',d.id,'request',d.request,'bundle',d.bundle,'revision',d.revision,'status',d.status,'teacherNotes',d.teacher_notes,'createdAt',d.created_at,'updatedAt',d.updated_at);$$;
create function public.xelay_teacher_ai_history()returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();d xelay_teacher_private.drafts;result jsonb:='[]';entry jsonb;used integer:=2;cost integer;begin
 for d in select*from xelay_teacher_private.drafts where user_id=u order by created_at desc limit 50 loop
  begin
   perform xelay_teacher_private.context(u,d.request);
   if not xelay_teacher_private.bundle_valid(d.bundle,d.request)or not xelay_teacher_private.text_valid(to_jsonb(d.teacher_notes),5000,true)then continue;end if;
   entry:=xelay_teacher_private.draft_json(d);cost:=octet_length(entry::text)+1;
   if used+cost>2097152 then exit;end if;
   result:=result||jsonb_build_array(entry);used:=used+cost;
  exception when others then null;end;
 end loop;return result;
end$$;
create function public.xelay_teacher_ai_draft(p_id uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();d xelay_teacher_private.drafts;begin
 select*into d from xelay_teacher_private.drafts where user_id=u and id=p_id;
 if not found then raise exception 'TEACHER_DRAFT_FORBIDDEN'using errcode='42501';end if;
 perform xelay_teacher_private.context(u,d.request);return xelay_teacher_private.draft_json(d);
end$$;
create function public.xelay_teacher_ai_draft_save(p_id uuid,p_expected_revision integer,p_bundle jsonb,p_teacher_notes text,p_status text)
returns jsonb language plpgsql security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();d xelay_teacher_private.drafts;ctx jsonb;original_hash text;begin
 if p_expected_revision is null or p_expected_revision<1 or p_teacher_notes is null or length(p_teacher_notes)>5000
 or not xelay_teacher_private.text_valid(to_jsonb(p_teacher_notes),5000,true)or p_status is null or p_status not in('draft','accepted')then raise exception 'TEACHER_DRAFT_INVALID'using errcode='22023';end if;
 select*into d from xelay_teacher_private.drafts where user_id=u and id=p_id for update;
 if not found then raise exception 'TEACHER_DRAFT_FORBIDDEN'using errcode='42501';end if;
 if d.revision<>p_expected_revision then raise exception 'TEACHER_DRAFT_CONFLICT'using errcode='PT409';end if;
 if xelay_teacher_private.entitlement(u)->>'canEdit'<>'true'then raise exception 'TEACHER_PLAN_REQUIRED'using errcode='42501';end if;
 ctx:=xelay_teacher_private.context(u,d.request);
 if p_status='accepted'and d.request->>'kind'='rubric_review'then
  select context_hash into original_hash from xelay_teacher_private.requests where user_id=u and id=d.id;
  if original_hash is distinct from encode(sha256(convert_to(ctx::text,'UTF8')),'hex')then raise exception 'TEACHER_CONTEXT_CHANGED'using errcode='PT409';end if;
 end if;
 if not xelay_teacher_private.bundle_valid(p_bundle,d.request)then raise exception 'TEACHER_DRAFT_INVALID'using errcode='22023';end if;
 update xelay_teacher_private.drafts set bundle=p_bundle,status=p_status,teacher_notes=p_teacher_notes,revision=revision+1,updated_at=clock_timestamp()where user_id=u and id=p_id returning*into d;
 return xelay_teacher_private.draft_json(d);
end$$;
revoke all on all functions in schema xelay_teacher_private from public,anon,authenticated,service_role;
revoke all on function public.xelay_teacher_workspace_status(),public.xelay_teacher_plan_state(),public.xelay_teacher_ai_context(jsonb),public.xelay_teacher_ai_catalog(),public.xelay_teacher_ai_candidates(uuid,uuid[]),public.xelay_teacher_ai_history(),public.xelay_teacher_ai_draft(uuid),public.xelay_teacher_ai_draft_save(uuid,integer,jsonb,text,text),public.xelay_create_teacher_plan_order(uuid,text,text,text),public.xelay_teacher_ai_reserve(uuid,text,jsonb,text,text,bigint),public.xelay_teacher_ai_finish(uuid,text,uuid,text,uuid,bigint,jsonb),public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)from public,anon,authenticated,service_role;
grant execute on function public.xelay_teacher_workspace_status(),public.xelay_teacher_plan_state(),public.xelay_teacher_ai_context(jsonb),public.xelay_teacher_ai_catalog(),public.xelay_teacher_ai_candidates(uuid,uuid[]),public.xelay_teacher_ai_history(),public.xelay_teacher_ai_draft(uuid),public.xelay_teacher_ai_draft_save(uuid,integer,jsonb,text,text)to authenticated;
grant execute on function public.xelay_create_teacher_plan_order(uuid,text,text,text),public.xelay_teacher_ai_reserve(uuid,text,jsonb,text,text,bigint),public.xelay_teacher_ai_finish(uuid,text,uuid,text,uuid,bigint,jsonb),public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)to service_role;
notify pgrst,'reload schema';
commit;
