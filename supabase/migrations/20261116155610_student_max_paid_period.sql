-- Allowance follows each paid month, never the first day of a calendar month.
-- Existing UTC ledgers remain archived; requests, personal runs and old grants are retained.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $$begin if to_regclass('xelay_student_private.requests') is null or to_regclass('xelay_student_private.period_usage') is not null then raise exception 'MAX_PAID_PERIOD_PREREQUISITE_OR_DRIFT';end if;end$$;
create table xelay_student_private.period_usage(
 user_id uuid not null references public.profiles(id) on delete cascade,
 grant_id uuid not null references xelay_student_private.grants(id) on delete restrict,
 cycle integer not null check(cycle between 0 and 12),
 spent_micros bigint not null default 0 check(spent_micros>=0),reserved_micros bigint not null default 0 check(reserved_micros>=0),
 primary key(user_id,grant_id,cycle)
);
alter table xelay_student_private.period_usage enable row level security;
revoke all on xelay_student_private.period_usage from public,anon,authenticated,service_role;
alter table xelay_student_private.requests add column budget_grant_id uuid,add column budget_cycle integer;
alter table xelay_student_private.requests add constraint max_request_paid_period foreign key(user_id,budget_grant_id,budget_cycle) references xelay_student_private.period_usage(user_id,grant_id,cycle);
alter table xelay_student_private.requests add constraint max_request_paid_period_pair check((budget_grant_id is null)=(budget_cycle is null));
create index max_requests_paid_period on xelay_student_private.requests(user_id,budget_grant_id,budget_cycle);
alter table xelay_student_private.requests drop constraint requests_reserve_micros_check;
alter table xelay_student_private.requests add constraint requests_reserve_micros_check check(reserve_micros between 1 and 10000000);
create function xelay_student_private.max_budget_window(p_user_id uuid,p_at timestamptz)
returns table(grant_id uuid,cycle integer,starts_at timestamptz,ends_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare selected record;i integer;anchor timestamp;boundary timestamptz;begin
 select z.id,z.source,p.valid_from,p.valid_until into selected from xelay_student_private.grants z
 join xelay_student_private.grant_periods p on p.grant_id=z.id
 join xelay_student_private.audiences a on a.user_id=z.user_id and a.audience='student'
 where z.user_id=p_user_id and z.plan_id='max' and z.revoked_at is null and p.valid_from<=p_at and p.valid_until>p_at
 order by p.valid_until desc,z.created_at desc,z.id limit 1;
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
-- Map actual historical requests to the original grant window, carrying both settled
-- spending and in-flight reservations forward. Migration itself issues no fresh allowance.
create temporary table max_period_backfill on commit drop as
 select r.user_id,r.request_id,w.grant_id,w.cycle,r.state,r.charge_micros,r.reserve_micros
 from xelay_student_private.requests r cross join lateral xelay_student_private.max_budget_window(r.user_id,r.created_at) w;
insert into xelay_student_private.period_usage(user_id,grant_id,cycle,spent_micros,reserved_micros)
 select user_id,grant_id,cycle,coalesce(sum(charge_micros)filter(where state='done'),0),coalesce(sum(reserve_micros)filter(where state='pending'),0)
 from max_period_backfill group by user_id,grant_id,cycle;
update xelay_student_private.requests r set budget_grant_id=b.grant_id,budget_cycle=b.cycle from max_period_backfill b where r.user_id=b.user_id and r.request_id=b.request_id;
-- An old function invocation already in progress may resume after migration.
-- It must retry before model dispatch, never insert a fresh unmetered UTC row.
create function xelay_student_private.require_paid_request_window()returns trigger language plpgsql set search_path=''as $$begin
 if new.budget_grant_id is null or new.budget_cycle is null then raise exception 'MAX_ACCOUNTING_CHANGED_RETRY'using errcode='PT409';end if;return new;
end$$;
create trigger max_require_paid_request_window before insert on xelay_student_private.requests for each row execute function xelay_student_private.require_paid_request_window();
-- Settlement belongs to the row transition, so even a pre-migration FINISH
-- invocation debits the mapped period exactly once after it resumes.
create function xelay_student_private.settle_paid_request_window()returns trigger language plpgsql security definer set search_path=''as $$begin
 if old.state='pending'and new.state='done'and old.budget_grant_id is not null then
  if new.budget_grant_id is distinct from old.budget_grant_id or new.budget_cycle is distinct from old.budget_cycle
   or new.reserve_micros is distinct from old.reserve_micros or new.charge_micros is null then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
  update xelay_student_private.period_usage set reserved_micros=reserved_micros-old.reserve_micros,spent_micros=spent_micros+new.charge_micros
   where user_id=old.user_id and grant_id=old.budget_grant_id and cycle=old.budget_cycle and reserved_micros>=old.reserve_micros;
  if not found then raise exception 'MAX_SETTLEMENT_CONFLICT'using errcode='PT409';end if;
 end if;return new;
end$$;
create trigger max_settle_paid_request_window after update of state on xelay_student_private.requests for each row execute function xelay_student_private.settle_paid_request_window();
create or replace function xelay_student_private.entitlement(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a text;g xelay_student_private.grants;legacy boolean;life boolean:=false;lim bigint:=0;spent bigint:=0;reserved bigint:=0;starts timestamptz;expires timestamptz;w record;begin
 select audience into a from xelay_student_private.audiences where user_id=p_user_id;
 select z.* into g from xelay_student_private.grants z join xelay_student_private.grant_periods p on p.grant_id=z.id
 where z.user_id=p_user_id and z.revoked_at is null and p.valid_from<=clock_timestamp() and p.valid_until>clock_timestamp()
 order by case z.plan_id when 'max' then 3 when 'plus' then 2 else 1 end desc,p.valid_until desc,z.created_at desc,z.id limit 1;
 if g.id is not null then select p.valid_from,p.valid_until into starts,expires from xelay_student_private.grant_periods p where p.grant_id=g.id and p.valid_from<=clock_timestamp() and p.valid_until>clock_timestamp() order by p.valid_until desc limit 1;end if;
 legacy:=public.xelay_has_participant_access(p_user_id);
 if to_regprocedure('public.xelay_private_participant_lifetime(uuid)') is not null then execute 'select public.xelay_private_participant_lifetime($1)' into life using p_user_id;end if;
 -- Only Max AI is approved for this release. Tier identity and dates never depend on AI allowance.
 if a='student' and g.id is not null and g.plan_id='max' then lim:=10000000;end if;
 select * into w from xelay_student_private.max_budget_window(p_user_id,clock_timestamp());
 if w.grant_id is not null then select spent_micros,reserved_micros into spent,reserved from xelay_student_private.period_usage where user_id=p_user_id and grant_id=w.grant_id and cycle=w.cycle;end if;
 return jsonb_build_object('userId',p_user_id,'audience',coalesce(a,'unresolved'),'planId',case when a='student' and g.id is not null then g.plan_id when legacy and a='student' then 'start' else 'free' end,
 'aiAllowance',case when lim>0 and g.plan_id='max' then 'available' when a='student' and g.id is not null then 'not_included' when life or legacy then 'pending_legacy_policy' else 'not_included' end,
 'monthlyAiBudgetUsd',lim::numeric/1000000,'startsAt',case when a='student' and g.id is not null then starts else null end,'expiresAt',case when a='student' and g.id is not null then expires else null end,
 'legacyBenefits',legacy or(a='student' and g.id is not null),'isLifetime',coalesce(life,false),'ownSavedContentAccess',true,
 'budgetPeriod','subscription_month','budgetResetsAt',w.ends_at,'budget',jsonb_build_object('limitMicros',lim,'spentMicros',coalesce(spent,0),'reservedMicros',coalesce(reserved,0)));
end$$;
create or replace function public.xelay_max_ai_reserve(p_user_id uuid,p_session_hash text,p_request_id text,p_fingerprint text,p_reserve_micros bigint,p_monthly_limit_micros bigint,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r xelay_student_private.requests;v jsonb;lim bigint;w record;spent bigint;reserved bigint;b jsonb;begin
 perform xelay_student_private.service();
 if not xelay_student_private.identifier(p_request_id) or p_fingerprint is null or p_fingerprint!~'^[a-f0-9]{64}$' or p_reserve_micros is null or p_reserve_micros not between 1 and 10000000 or p_monthly_limit_micros is null or p_monthly_limit_micros not between 1 and 10000000
 or not xelay_student_private.request_valid(p_request) or p_request->>'requestId'<>p_request_id then raise exception 'MAX_RESERVATION_INVALID' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||p_user_id::text,0));
 if not xelay_student_private.session_active(p_user_id,p_session_hash) then raise exception 'MAX_SESSION_REQUIRED' using errcode='42501';end if;
 v:=xelay_student_private.entitlement(p_user_id);if v->>'planId'<>'max' or v->>'aiAllowance'<>'available' then return jsonb_build_object('state','denied');end if;
 if not xelay_student_private.sources_match(p_user_id,p_request) then raise exception 'MAX_SOURCE_CHANGED' using errcode='42501';end if;
 select * into r from xelay_student_private.requests where user_id=p_user_id and request_id=p_request_id for update;
 if found then
  if r.fingerprint<>p_fingerprint or r.request<>p_request then return jsonb_build_object('state','conflict');end if;
  if r.state='pending' then return jsonb_build_object('state','pending');end if;
  select bundle into b from xelay_student_private.runs where user_id=p_user_id and id=p_request_id;
  if b is not null then return jsonb_build_object('state','replay','bundle',b);end if;return jsonb_build_object('state','conflict');
 end if;
 if(select count(*)from xelay_student_private.requests where user_id=p_user_id and state='pending'and created_at>clock_timestamp()-interval'2 minutes')>=2 then return jsonb_build_object('state','pending');end if;
 if(select count(*)from xelay_student_private.requests where user_id=p_user_id and created_at>clock_timestamp()-interval'1 minute')>=10 then return jsonb_build_object('state','pending');end if;
 select * into w from xelay_student_private.max_budget_window(p_user_id,clock_timestamp());
 if w.grant_id is null then return jsonb_build_object('state','denied');end if;
 lim:=least(p_monthly_limit_micros,(v->'budget'->>'limitMicros')::bigint);
 insert into xelay_student_private.period_usage(user_id,grant_id,cycle)values(p_user_id,w.grant_id,w.cycle)on conflict do nothing;
 select spent_micros,reserved_micros into spent,reserved from xelay_student_private.period_usage where user_id=p_user_id and grant_id=w.grant_id and cycle=w.cycle for update;
 if spent+reserved+p_reserve_micros>lim or(select count(*) from xelay_student_private.requests where user_id=p_user_id and budget_grant_id=w.grant_id and budget_cycle=w.cycle)>=2000 then return jsonb_build_object('state','denied');end if;
 insert into xelay_student_private.requests(user_id,request_id,fingerprint,session_hash,period,reserve_micros,request,budget_grant_id,budget_cycle)
 values(p_user_id,p_request_id,p_fingerprint,p_session_hash,date_trunc('month',clock_timestamp() at time zone 'UTC')::date,p_reserve_micros,p_request,w.grant_id,w.cycle)returning * into r;
 update xelay_student_private.period_usage set reserved_micros=reserved_micros+p_reserve_micros where user_id=p_user_id and grant_id=w.grant_id and cycle=w.cycle;
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
  and v->>'planId'='max' and v->>'aiAllowance'='available' and xelay_student_private.sources_match(p_user_id,r.request) and xelay_student_private.bundle_valid(p_bundle,r.request);
 if r.budget_grant_id is null then
  update xelay_student_private.usage set reserved_micros=reserved_micros-r.reserve_micros,spent_micros=spent_micros+p_charge_micros where user_id=p_user_id and period=r.period;
 end if;
 update xelay_student_private.requests set state='done',charge_micros=p_charge_micros,settled_at=clock_timestamp() where user_id=p_user_id and request_id=p_request_id;
 if authorized then insert into xelay_student_private.runs(user_id,id,request,bundle)values(p_user_id,p_request_id,r.request,p_bundle);end if;
 return jsonb_build_object('settled',true,'replayed',false,'stored',authorized);
end$$;
revoke all on function xelay_student_private.max_budget_window(uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function xelay_student_private.require_paid_request_window() from public,anon,authenticated,service_role;
revoke all on function xelay_student_private.settle_paid_request_window() from public,anon,authenticated,service_role;
-- CREATE OR REPLACE retains the existing narrow public RPC ACLs.
comment on schema xelay_student_private is 'Private student workspace; Max allowance follows a paid/granted month. Archived UTC usage retained. No official test or grade changes.';
notify pgrst,'reload schema';
commit;
