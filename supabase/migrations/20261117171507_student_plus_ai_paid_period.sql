-- Plus AI: one paid-month allowance ($3), isolated from Max ($10) and purchased credits.
-- This changes no existing grants, paid orders, official attempts, answers or grades.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $$begin
 if to_regprocedure('xelay_student_private.entitlement_before_credits(uuid)')is null
 or to_regclass('xelay_student_private.credit_wallets')is null
 or exists(select 1 from information_schema.columns where table_schema='xelay_student_private'and table_name='requests'and column_name='budget_limit_micros')then raise exception 'PLUS_AI_PREREQUISITE_OR_DRIFT';end if;
end$$;
-- Old pending reservations were all Max. Preserve their original ten-dollar cap.
alter table xelay_student_private.requests add column budget_limit_micros bigint not null default 10000000 check(budget_limit_micros between 1 and 10000000);
create function xelay_student_private.student_ai_request_allowed(p_plan text,p_request jsonb)returns boolean language plpgsql immutable set search_path=''as $$begin
 if not coalesce(xelay_student_private.request_valid(p_request),false)then return false;end if;
 if p_plan='max'then return true;end if;
 return coalesce(p_plan='plus'and p_request->>'mode'in('chat','explain','quiz','cards')and not(p_request?'studyFormat')and jsonb_array_length(p_request->'sources')<=1,false);
end$$;
create function xelay_student_private.student_ai_bundle_allowed(p_plan text,p_bundle jsonb,p_request jsonb)returns boolean language plpgsql immutable set search_path=''as $$begin
 if not coalesce(xelay_student_private.bundle_valid(p_bundle,p_request),false)then return false;end if;
 if p_plan='max'then return true;end if;
 return coalesce(p_plan='plus'and p_bundle->>'version'='1'and jsonb_array_length(p_bundle->'plan')=0 and p_bundle->'math'='null'::jsonb,false);
end$$;
create or replace function xelay_student_private.max_budget_window(p_user_id uuid,p_at timestamptz)
returns table(grant_id uuid,cycle integer,starts_at timestamptz,ends_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare selected record;i integer;anchor timestamp;boundary timestamptz;begin
 select z.id,z.source,p.valid_from,p.valid_until into selected from xelay_student_private.grants z
 join xelay_student_private.grant_periods p on p.grant_id=z.id
 join xelay_student_private.audiences a on a.user_id=z.user_id and a.audience='student'
 where z.user_id=p_user_id and z.plan_id in('plus','max') and z.revoked_at is null and p.valid_from<=p_at and p.valid_until>p_at
 order by case z.plan_id when 'max' then 2 else 1 end desc,p.valid_until desc,z.created_at desc,z.id limit 1;
 if not found then return;end if;
 -- One verified payment is exactly one allowance, even if refund reflow moves
 -- its preserved 31-day duration into a shorter calendar month or across DST.
 if selected.source='payment' then
  grant_id:=selected.id;cycle:=0;starts_at:=selected.valid_from;ends_at:=selected.valid_until;return next;return;
 end if;
 anchor:=selected.valid_from at time zone 'Europe/Kyiv';
 for i in 0..12 loop
  boundary:=(anchor+make_interval(months=>i+1))at time zone 'Europe/Kyiv';
  if p_at<boundary then
   grant_id:=selected.id;cycle:=i;starts_at:=(anchor+make_interval(months=>i))at time zone 'Europe/Kyiv';ends_at:=least(boundary,selected.valid_until);return next;return;
  end if;
 end loop;
end$$;


create or replace function xelay_student_private.entitlement_before_credits(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a text;g xelay_student_private.grants;legacy boolean;life boolean:=false;lim bigint:=0;spent bigint:=0;reserved bigint:=0;starts timestamptz;expires timestamptz;w record;begin
 select audience into a from xelay_student_private.audiences where user_id=p_user_id;
 select z.* into g from xelay_student_private.grants z join xelay_student_private.grant_periods p on p.grant_id=z.id
 where z.user_id=p_user_id and z.revoked_at is null and p.valid_from<=clock_timestamp() and p.valid_until>clock_timestamp()
 order by case z.plan_id when 'max' then 3 when 'plus' then 2 else 1 end desc,p.valid_until desc,z.created_at desc,z.id limit 1;
 if g.id is not null then select p.valid_from,p.valid_until into starts,expires from xelay_student_private.grant_periods p where p.grant_id=g.id and p.valid_from<=clock_timestamp() and p.valid_until>clock_timestamp() order by p.valid_until desc limit 1;end if;
 legacy:=public.xelay_has_participant_access(p_user_id);
 if to_regprocedure('public.xelay_private_participant_lifetime(uuid)') is not null then execute 'select public.xelay_private_participant_lifetime($1)' into life using p_user_id;end if;
 -- Paid Plus and Max allowances follow the same immutable grant windows.
 if a='student' and g.id is not null then lim:=case g.plan_id when 'max' then 10000000 when 'plus' then 3000000 else 0 end;end if;
 select * into w from xelay_student_private.max_budget_window(p_user_id,clock_timestamp());
 if w.grant_id is not null then select spent_micros,reserved_micros into spent,reserved from xelay_student_private.period_usage where user_id=p_user_id and grant_id=w.grant_id and cycle=w.cycle;end if;
 return jsonb_build_object('userId',p_user_id,'audience',coalesce(a,'unresolved'),'planId',case when a='student' and g.id is not null then g.plan_id when legacy and a='student' then 'start' else 'free' end,
 'aiAllowance',case when lim>0 and g.plan_id in('plus','max') then 'available' when a='student' and g.id is not null then 'not_included' when life or legacy then 'pending_legacy_policy' else 'not_included' end,
 'monthlyAiBudgetUsd',lim::numeric/1000000,'startsAt',case when a='student' and g.id is not null then starts else null end,'expiresAt',case when a='student' and g.id is not null then expires else null end,
 'legacyBenefits',legacy or(a='student' and g.id is not null),'isLifetime',coalesce(life,false),'ownSavedContentAccess',true,
 'budgetPeriod','subscription_month','budgetResetsAt',w.ends_at,'budget',jsonb_build_object('limitMicros',lim,'spentMicros',coalesce(spent,0),'reservedMicros',coalesce(reserved,0)));
end$$;

create or replace function public.xelay_max_sources_put(p_request_id text,p_sources jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=xelay_student_private.caller();v jsonb;seen text[]:='{}';bytes integer:=0;old jsonb;e jsonb;begin
 if not xelay_student_private.identifier(p_request_id) or jsonb_typeof(p_sources)<>'array' or jsonb_array_length(p_sources) not between 0 and 3 then raise exception 'MAX_SOURCES_INVALID' using errcode='22023';end if;
 e:=xelay_student_private.entitlement(u);
 if e->>'planId' is null or e->>'planId'not in('plus','max')then raise exception 'MAX_REQUIRED'using errcode='42501';end if;
 if e->>'planId'='plus'and jsonb_array_length(p_sources)>1 then raise exception 'PLUS_SINGLE_SOURCE_REQUIRED'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||u::text,0));
 if not exists(select 1 from xelay_student_private.sources where user_id=u and request_id=p_request_id)
  and(select count(distinct request_id)from xelay_student_private.sources where user_id=u and created_at>clock_timestamp()-interval'1 minute')>=20 then raise exception 'MAX_REQUEST_RATE_LIMIT' using errcode='PT429';end if;
 if(select count(*)from xelay_student_private.requests where user_id=u and state='pending'and created_at>clock_timestamp()-interval'2 minutes')>=2 and not exists(select 1 from xelay_student_private.requests where user_id=u and request_id=p_request_id)then raise exception 'MAX_CONCURRENCY_LIMIT' using errcode='PT429';end if;
 for v in select value from jsonb_array_elements(p_sources)loop
  if not xelay_student_private.source_valid(v) or(v->>'id')=any(seen) then raise exception 'MAX_SOURCES_INVALID' using errcode='22023';end if;
  seen:=array_append(seen,v->>'id');bytes:=bytes+octet_length(v->>'text');if bytes>24000 then raise exception 'MAX_SOURCES_TOO_LARGE' using errcode='22023';end if;
  select document into old from xelay_student_private.sources where user_id=u and request_id=p_request_id and source_id=v->>'id';
  if found and old<>v then raise exception 'MAX_SOURCE_IMMUTABLE' using errcode='PT409';end if;
 end loop;
 if exists(select 1 from xelay_student_private.sources where user_id=u and request_id=p_request_id and not(source_id=any(seen))) then raise exception 'MAX_SOURCE_SET_CHANGED' using errcode='PT409';end if;
 if not exists(select 1 from xelay_student_private.sources where user_id=u and request_id=p_request_id) and(select count(distinct request_id) from xelay_student_private.sources where user_id=u)>=2000 then raise exception 'MAX_SOURCE_LIMIT' using errcode='PT429';end if;
 for v in select value from jsonb_array_elements(p_sources)loop insert into xelay_student_private.sources(user_id,request_id,source_id,document)values(u,p_request_id,v->>'id',v)on conflict do nothing;end loop;
 return p_sources;
end$$;

create or replace function public.xelay_max_ai_reserve(p_user_id uuid,p_session_hash text,p_request_id text,p_fingerprint text,p_reserve_micros bigint,p_monthly_limit_micros bigint,p_request jsonb)
returns jsonb language plpgsql security definer set search_path=''as $$
declare r xelay_student_private.requests;v jsonb;lim bigint;w record;spent bigint;reserved bigint;b jsonb;base_part bigint;wallet_part bigint;available bigint;begin
 perform xelay_student_private.service();
 if not xelay_student_private.identifier(p_request_id)or p_fingerprint is null or p_fingerprint!~'^[a-f0-9]{64}$'or p_reserve_micros is null or p_reserve_micros not between 1 and 10000000 or p_monthly_limit_micros is null or p_monthly_limit_micros not between 1 and 10000000
 or not xelay_student_private.request_valid(p_request)or p_request->>'requestId'<>p_request_id then raise exception 'MAX_RESERVATION_INVALID'using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||p_user_id::text,0));
 if not xelay_student_private.session_active(p_user_id,p_session_hash)then raise exception 'MAX_SESSION_REQUIRED'using errcode='42501';end if;
 v:=xelay_student_private.entitlement(p_user_id);if v->>'aiAllowance'is distinct from'available'or not xelay_student_private.student_ai_request_allowed(v->>'planId',p_request)then return jsonb_build_object('state','denied');end if;
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
 if v->>'planId'='plus'and wallet_part>0 then return jsonb_build_object('state','denied');end if;
 available:=0;
 if v->>'planId'='max'then
  insert into xelay_student_private.credit_wallets(user_id)values(p_user_id)on conflict do nothing;
  select greatest(0,granted_micros-spent_micros-reserved_micros)into available from xelay_student_private.credit_wallets where user_id=p_user_id for update;
 end if;
 if wallet_part>available or(select count(*)from xelay_student_private.requests where user_id=p_user_id and budget_grant_id=w.grant_id and budget_cycle=w.cycle)>=2000 then return jsonb_build_object('state','denied');end if;
 insert into xelay_student_private.requests(user_id,request_id,fingerprint,session_hash,period,reserve_micros,request,budget_grant_id,budget_cycle,wallet_reserve_micros,budget_limit_micros)
 values(p_user_id,p_request_id,p_fingerprint,p_session_hash,date_trunc('month',clock_timestamp()at time zone'UTC')::date,p_reserve_micros,p_request,w.grant_id,w.cycle,wallet_part,lim)returning*into r;
 update xelay_student_private.period_usage set reserved_micros=reserved_micros+base_part where user_id=p_user_id and grant_id=w.grant_id and cycle=w.cycle;
 if wallet_part>0 then update xelay_student_private.credit_wallets set reserved_micros=reserved_micros+wallet_part where user_id=p_user_id;end if;
 return jsonb_build_object('state','reserved','reservationId',r.reservation_id);
end$$;


create or replace function public.xelay_max_ai_finish(p_user_id uuid,p_session_hash text,p_request_id text,p_fingerprint text,p_reservation_id uuid,p_charge_micros bigint,p_bundle jsonb default null,p_request jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r xelay_student_private.requests;authorized boolean;v jsonb;begin
 perform xelay_student_private.service();if p_charge_micros is null or p_charge_micros not between 0 and 1000000000 then raise exception 'MAX_SETTLEMENT_INVALID' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||p_user_id::text,0));
 select * into r from xelay_student_private.requests where user_id=p_user_id and request_id=p_request_id for update;
 if not found or r.fingerprint is distinct from p_fingerprint or r.reservation_id is distinct from p_reservation_id or r.session_hash is distinct from p_session_hash then raise exception 'MAX_SETTLEMENT_CONFLICT' using errcode='PT409';end if;
 if r.state='done' then
  if r.charge_micros<>p_charge_micros then raise exception 'MAX_SETTLEMENT_CONFLICT' using errcode='PT409';end if;
  return jsonb_build_object('settled',true,'replayed',true,'stored',exists(select 1 from xelay_student_private.runs where user_id=p_user_id and id=p_request_id));
 end if;
 v:=xelay_student_private.entitlement(p_user_id);
 authorized:=p_bundle is not null and p_request is not null and p_request=r.request and xelay_student_private.session_active(p_user_id,p_session_hash)
  and xelay_student_private.student_ai_request_allowed(v->>'planId',r.request) and v->>'aiAllowance'='available' and xelay_student_private.sources_match(p_user_id,r.request) and xelay_student_private.student_ai_bundle_allowed(v->>'planId',p_bundle,r.request);
 if r.budget_grant_id is null then
  update xelay_student_private.usage set reserved_micros=reserved_micros-r.reserve_micros,spent_micros=spent_micros+p_charge_micros where user_id=p_user_id and period=r.period;
 end if;
 update xelay_student_private.requests set state='done',charge_micros=p_charge_micros,settled_at=clock_timestamp() where user_id=p_user_id and request_id=p_request_id;
 if authorized then insert into xelay_student_private.runs(user_id,id,request,bundle)values(p_user_id,p_request_id,r.request,p_bundle);end if;
 return jsonb_build_object('settled',true,'replayed',false,'stored',authorized);
end$$;

create or replace function xelay_student_private.settle_paid_request_window()returns trigger language plpgsql security definer set search_path=''as $$
declare base_part bigint;base_charge bigint;wallet_charge bigint;usage_spent bigint;usage_reserved bigint;begin
 if old.state='pending'and new.state='done'and old.budget_grant_id is not null then
  if new.budget_grant_id is distinct from old.budget_grant_id or new.budget_cycle is distinct from old.budget_cycle
   or new.budget_limit_micros is distinct from old.budget_limit_micros or new.reserve_micros is distinct from old.reserve_micros or new.wallet_reserve_micros is distinct from old.wallet_reserve_micros or new.charge_micros is null then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  base_part:=old.reserve_micros-old.wallet_reserve_micros;
  select spent_micros,reserved_micros into usage_spent,usage_reserved from xelay_student_private.period_usage
   where user_id=old.user_id and grant_id=old.budget_grant_id and cycle=old.budget_cycle for update;
  -- Reuse allowance released by other completed requests in this same period.
  -- Other requests' holds are excluded, and a new month is never borrowed from.
  base_charge:=least(new.charge_micros,greatest(0,old.budget_limit_micros-usage_spent-(usage_reserved-base_part)));
  -- A provider accounting overrun must never debit more purchased credits than
  -- this request actually reserved, or retroactively debit an old base-only run.
  wallet_charge:=least(old.wallet_reserve_micros,greatest(0,new.charge_micros-base_charge));base_charge:=new.charge_micros-wallet_charge;
  update xelay_student_private.period_usage set reserved_micros=reserved_micros-base_part,spent_micros=spent_micros+base_charge
   where user_id=old.user_id and grant_id=old.budget_grant_id and cycle=old.budget_cycle and reserved_micros>=base_part;
  if not found then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  if old.wallet_reserve_micros>0 then
  insert into xelay_student_private.credit_wallets(user_id)values(old.user_id)on conflict do nothing;
  update xelay_student_private.credit_wallets set reserved_micros=reserved_micros-old.wallet_reserve_micros,spent_micros=spent_micros+wallet_charge
   where user_id=old.user_id and reserved_micros>=old.wallet_reserve_micros;
  if not found then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  end if;
 end if;return new;
end$$;

revoke all on function xelay_student_private.student_ai_request_allowed(text,jsonb)from public,anon,authenticated,service_role;
revoke all on function xelay_student_private.student_ai_bundle_allowed(text,jsonb,jsonb)from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
