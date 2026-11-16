-- Private student workspace. No current account, payment, official test or grade is modified.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$begin
 if to_regclass('public.profiles') is null or to_regclass('auth.users') is null or to_regclass('auth.sessions') is null
   or to_regprocedure('public.xelay_has_participant_access(uuid)') is null
   or to_regnamespace('xelay_student_private') is not null then raise exception 'STUDENT_WORKSPACE_PREREQUISITE_OR_DRIFT';end if;
end$$;
create schema xelay_student_private;
revoke all on schema xelay_student_private from public,anon,authenticated,service_role;
create table xelay_student_private.audiences(
 user_id uuid primary key references public.profiles(id) on delete cascade,
 audience text not null check(audience in('student','teacher')),
 source text not null check(source in('registration','audited_assignment','paid_student_order')),
 reason text not null check(length(reason) between 8 and 500),assigned_at timestamptz not null default clock_timestamp()
);
create table xelay_student_private.grants(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id) on delete cascade,
 plan_id text not null check(plan_id in('start','plus','max')),source text not null check(source in('payment','admin_grant')),
 reference text not null unique check(length(reference) between 8 and 150),
 valid_from timestamptz not null,valid_until timestamptz not null,revoked_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),check(valid_until>valid_from)
);
create index student_grants_owner_period on xelay_student_private.grants(user_id,valid_until) where revoked_at is null;
create table xelay_student_private.grant_periods(
 id uuid primary key default gen_random_uuid(),grant_id uuid not null references xelay_student_private.grants(id) on delete cascade,
 valid_from timestamptz not null,valid_until timestamptz not null,check(valid_until>valid_from)
);
create index student_grant_periods_active on xelay_student_private.grant_periods(grant_id,valid_until);
create table xelay_student_private.schedule_audit(
 id uuid primary key default gen_random_uuid(),grant_id uuid not null references xelay_student_private.grants(id) on delete cascade,
 original_from timestamptz not null,original_until timestamptz not null,new_from timestamptz not null,new_until timestamptz not null,
 reason text not null,changed_at timestamptz not null default clock_timestamp()
);
create table xelay_student_private.sources(
 user_id uuid not null references public.profiles(id) on delete cascade,request_id text not null,source_id text not null,document jsonb not null,
 created_at timestamptz not null default clock_timestamp(),primary key(user_id,request_id,source_id)
);
create table xelay_student_private.usage(
 user_id uuid not null references public.profiles(id) on delete cascade,period date not null,
 spent_micros bigint not null default 0 check(spent_micros>=0),reserved_micros bigint not null default 0 check(reserved_micros>=0),
 primary key(user_id,period),check(extract(day from period)=1)
);
create table xelay_student_private.requests(
 user_id uuid not null references public.profiles(id) on delete cascade,request_id text not null,fingerprint text not null,
 session_hash text not null,reservation_id uuid not null unique default gen_random_uuid(),period date not null,
 reserve_micros bigint not null check(reserve_micros between 1 and 6000000),charge_micros bigint check(charge_micros between 0 and 1000000000),
 state text not null default 'pending' check(state in('pending','done')),request jsonb not null,
 created_at timestamptz not null default clock_timestamp(),settled_at timestamptz,primary key(user_id,request_id)
);
create table xelay_student_private.runs(
 user_id uuid not null references public.profiles(id) on delete cascade,id text not null,request jsonb not null,bundle jsonb not null,
 progress jsonb not null default '{"answers":{},"submitted":[],"cardRatings":{},"doneTasks":[]}',revision integer not null default 1,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 primary key(user_id,id),foreign key(user_id,id) references xelay_student_private.requests(user_id,request_id) on delete cascade
);
do $$declare t text;begin foreach t in array array['audiences','grants','grant_periods','schedule_audit','sources','usage','requests','runs']loop
 execute format('alter table xelay_student_private.%I enable row level security',t);
 execute format('revoke all on xelay_student_private.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

create function xelay_student_private.identifier(v text) returns boolean language sql immutable set search_path='' as $$
 select v is not null and v ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' and v not in('constructor','prototype','__proto__');$$;
create function xelay_student_private.fields(v jsonb,keys text[]) returns boolean language sql immutable set search_path='' as $$
 select case when jsonb_typeof(v)='object' then (select count(*) from jsonb_object_keys(v))=cardinality(keys)
  and not exists(select 1 from jsonb_object_keys(v) k where not(k=any(keys))) else false end;$$;
create function xelay_student_private.plain(v text,n integer) returns boolean language sql immutable set search_path='' as $$
 select v is not null and length(btrim(v)) between 1 and n and v !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' and v !~* '</?[a-z][^>]*>';$$;
create function xelay_student_private.service() returns void language plpgsql security definer set search_path='' as $$begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'STUDENT_SERVICE_REQUIRED' using errcode='42501';end if;
end$$;
create function xelay_student_private.session_active(p_user_id uuid,p_hash text) returns boolean language sql stable security definer set search_path='' as $$
 select p_hash ~ '^[a-f0-9]{64}$' and exists(select 1 from auth.users u join public.profiles p on p.id=u.id
 join auth.sessions s on s.user_id=u.id where u.id=p_user_id and u.email_confirmed_at is not null and u.deleted_at is null
 and(u.banned_until is null or u.banned_until<=clock_timestamp())
 and encode(sha256(convert_to(s.id::text,'UTF8')),'hex')=p_hash
 and(nullif(to_jsonb(s)->>'not_after','') is null or (to_jsonb(s)->>'not_after')::timestamptz>clock_timestamp()));$$;
create function xelay_student_private.caller() returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();session_text text:=auth.jwt()->>'session_id';begin
 if current_setting('role',true) is distinct from 'authenticated' or u is null or session_text is null
  or session_text !~ '^[0-9a-fA-F-]{36}$' or not xelay_student_private.session_active(u,encode(sha256(convert_to(session_text,'UTF8')),'hex')) then
  raise exception 'STUDENT_SESSION_REQUIRED' using errcode='42501';end if;return u;
end$$;
create function xelay_student_private.source_valid(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$begin
 if not xelay_student_private.fields(v,array['id','title','text','page','kind']) then return false;end if;
 return coalesce(xelay_student_private.identifier(v->>'id') and jsonb_typeof(v->'title')='string' and xelay_student_private.plain(v->>'title',200)
 and jsonb_typeof(v->'text')='string' and xelay_student_private.plain(v->>'text',20000) and octet_length(v->>'text')<=24000
 and v->>'kind' in('own_note','own_excerpt') and(v->'page'='null'::jsonb or jsonb_typeof(v->'page')='number' and(v->>'page')~'^[0-9]{1,3}$' and(v->>'page')::integer between 1 and 150),false);
end$$;
create function xelay_student_private.request_valid(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare s jsonb;seen text[]:='{}';bytes integer:=0;begin
 if not xelay_student_private.fields(v,array['requestId','mode','prompt','sources']) or not xelay_student_private.identifier(v->>'requestId')
 or jsonb_typeof(v->'mode') is distinct from 'string' or v->>'mode' not in('explain','quiz','cards','plan','math') or jsonb_typeof(v->'prompt') is distinct from 'string' or not xelay_student_private.plain(v->>'prompt',2400)
 or jsonb_typeof(v->'sources')<>'array' then return false;end if;
 if jsonb_array_length(v->'sources') not between 1 and 3 or octet_length(v::text)>96000 then return false;end if;
 for s in select value from jsonb_array_elements(v->'sources')loop
  if not xelay_student_private.source_valid(s) or(s->>'id')=any(seen) then return false;end if;
  seen:=array_append(seen,s->>'id');bytes:=bytes+octet_length(s->>'text');
 end loop;return bytes<=24000;
end$$;
create function xelay_student_private.entitlement(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a text;g xelay_student_private.grants;legacy boolean;life boolean:=false;lim bigint:=0;spent bigint:=0;reserved bigint:=0;starts timestamptz;expires timestamptz;begin
 select audience into a from xelay_student_private.audiences where user_id=p_user_id;
 select z.* into g from xelay_student_private.grants z join xelay_student_private.grant_periods p on p.grant_id=z.id
 where z.user_id=p_user_id and z.revoked_at is null and p.valid_from<=clock_timestamp() and p.valid_until>clock_timestamp()
 order by case z.plan_id when 'max' then 3 when 'plus' then 2 else 1 end desc,p.valid_until desc limit 1;
 if g.id is not null then select p.valid_from,p.valid_until into starts,expires from xelay_student_private.grant_periods p where p.grant_id=g.id and p.valid_from<=clock_timestamp() and p.valid_until>clock_timestamp() order by p.valid_until desc limit 1;end if;
 legacy:=public.xelay_has_participant_access(p_user_id);
 if to_regprocedure('public.xelay_private_participant_lifetime(uuid)') is not null then execute 'select public.xelay_private_participant_lifetime($1)' into life using p_user_id;end if;
 -- Only Max AI is approved for this release. Tier identity and dates never depend on AI allowance.
 if a='student' and g.id is not null and g.plan_id='max' then lim:=6000000;end if;
 select spent_micros,reserved_micros into spent,reserved from xelay_student_private.usage where user_id=p_user_id and period=date_trunc('month',clock_timestamp() at time zone 'UTC')::date;
 return jsonb_build_object('userId',p_user_id,'audience',coalesce(a,'unresolved'),'planId',case when a='student' and g.id is not null then g.plan_id when legacy and a='student' then 'start' else 'free' end,
 'aiAllowance',case when lim>0 and g.plan_id='max' then 'available' when a='student' and g.id is not null then 'not_included' when life or legacy then 'pending_legacy_policy' else 'not_included' end,
 'monthlyAiBudgetUsd',lim::numeric/1000000,'startsAt',case when a='student' and g.id is not null then starts else null end,'expiresAt',case when a='student' and g.id is not null then expires else null end,
 'legacyBenefits',legacy or(a='student' and g.id is not null),'isLifetime',coalesce(life,false),'ownSavedContentAccess',true,
 'budget',jsonb_build_object('limitMicros',lim,'spentMicros',coalesce(spent,0),'reservedMicros',coalesce(reserved,0)));
end$$;
create function public.xelay_student_workspace_status() returns jsonb language plpgsql stable security definer set search_path='' as $$begin
 return xelay_student_private.entitlement(xelay_student_private.caller());end$$;
create function public.xelay_student_workspace_entitlement(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$begin
 perform xelay_student_private.service();if p_user_id is null then raise exception 'STUDENT_USER_REQUIRED' using errcode='22023';end if;
 return xelay_student_private.entitlement(p_user_id);end$$;
create function public.xelay_student_audience_assign(p_user_id uuid,p_audience text,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare old text;begin perform xelay_student_private.service();
 if p_audience not in('student','teacher') or p_audience is null or not xelay_student_private.plain(p_reason,500) or length(p_reason)<8 then raise exception 'STUDENT_AUDIENCE_INVALID' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('student-owner:'||p_user_id::text,0));
 select audience into old from xelay_student_private.audiences where user_id=p_user_id;
 if old is not null and old<>p_audience then raise exception 'STUDENT_AUDIENCE_IMMUTABLE' using errcode='PT409';end if;
 insert into xelay_student_private.audiences(user_id,audience,source,reason) values(p_user_id,p_audience,'audited_assignment',p_reason) on conflict do nothing;
 return xelay_student_private.entitlement(p_user_id);end$$;
create function public.xelay_student_plan_grant(p_user_id uuid,p_plan_id text,p_valid_from timestamptz,p_valid_until timestamptz,p_reference text) returns jsonb language plpgsql security definer set search_path='' as $$
declare g xelay_student_private.grants;begin perform xelay_student_private.service();
 if p_plan_id is null or p_plan_id not in('start','plus','max') or p_valid_from is null or p_valid_until is null or p_valid_until<=p_valid_from or p_valid_until>p_valid_from+interval'1 year'
 or not xelay_student_private.plain(p_reference,150) or length(p_reference)<8 then raise exception 'STUDENT_GRANT_INVALID' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('student-owner:'||p_user_id::text,0));
 if not exists(select 1 from xelay_student_private.audiences where user_id=p_user_id and audience='student') then raise exception 'STUDENT_AUDIENCE_REQUIRED' using errcode='42501';end if;
 select * into g from xelay_student_private.grants where reference=p_reference;
 if found and(g.user_id<>p_user_id or g.plan_id<>p_plan_id or g.valid_from<>p_valid_from or g.valid_until<>p_valid_until) then raise exception 'STUDENT_GRANT_CONFLICT' using errcode='PT409';end if;
 if g.id is null then insert into xelay_student_private.grants(user_id,plan_id,source,reference,valid_from,valid_until) values(p_user_id,p_plan_id,'admin_grant',p_reference,p_valid_from,p_valid_until)returning * into g;
 insert into xelay_student_private.grant_periods(grant_id,valid_from,valid_until)values(g.id,p_valid_from,p_valid_until);end if;
 return xelay_student_private.entitlement(p_user_id);end$$;

create function public.xelay_max_sources_put(p_request_id text,p_sources jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=xelay_student_private.caller();v jsonb;seen text[]:='{}';bytes integer:=0;old jsonb;begin
 if not xelay_student_private.identifier(p_request_id) or jsonb_typeof(p_sources)<>'array' or jsonb_array_length(p_sources) not between 1 and 3 then raise exception 'MAX_SOURCES_INVALID' using errcode='22023';end if;
 if xelay_student_private.entitlement(u)->>'planId'<>'max' then raise exception 'MAX_REQUIRED' using errcode='42501';end if;
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
create function public.xelay_max_sources_get(p_request_id text,p_source_ids text[]) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u uuid:=xelay_student_private.caller();v text;s jsonb;out jsonb:='[]';begin
 if not xelay_student_private.identifier(p_request_id) or p_source_ids is null or cardinality(p_source_ids)>3 or cardinality(p_source_ids)<>(select count(distinct x) from unnest(p_source_ids)x) then raise exception 'MAX_SOURCES_INVALID' using errcode='22023';end if;
 foreach v in array p_source_ids loop
  select document into s from xelay_student_private.sources where user_id=u and request_id=p_request_id and source_id=v;
  if not found then raise exception 'MAX_SOURCE_UNAVAILABLE' using errcode='42501';end if;
  out:=out||jsonb_build_array(s||jsonb_build_object('canRead',true,'aiAllowed',true));
 end loop;return jsonb_build_object('userId',u,'sources',out);
end$$;
create function xelay_student_private.sources_match(p_user_id uuid,p_request jsonb) returns boolean language sql stable security definer set search_path='' as $$
 select xelay_student_private.request_valid(p_request) and not exists(select 1 from jsonb_array_elements(p_request->'sources') s
 where not exists(select 1 from xelay_student_private.sources p where p.user_id=p_user_id and p.request_id=p_request->>'requestId' and p.source_id=s->>'id' and p.document=s));$$;
create function public.xelay_max_ai_reserve(p_user_id uuid,p_session_hash text,p_request_id text,p_fingerprint text,p_reserve_micros bigint,p_monthly_limit_micros bigint,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r xelay_student_private.requests;v jsonb;lim bigint;period_day date:=date_trunc('month',clock_timestamp() at time zone 'UTC')::date;spent bigint;reserved bigint;b jsonb;begin
 perform xelay_student_private.service();
 if not xelay_student_private.identifier(p_request_id) or p_fingerprint is null or p_fingerprint!~'^[a-f0-9]{64}$' or p_reserve_micros is null or p_reserve_micros not between 1 and 6000000 or p_monthly_limit_micros is null or p_monthly_limit_micros not between 1 and 6000000
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
 lim:=least(p_monthly_limit_micros,(v->'budget'->>'limitMicros')::bigint);
 insert into xelay_student_private.usage(user_id,period)values(p_user_id,period_day)on conflict do nothing;
 select spent_micros,reserved_micros into spent,reserved from xelay_student_private.usage where user_id=p_user_id and period=period_day for update;
 if spent+reserved+p_reserve_micros>lim or(select count(*) from xelay_student_private.requests where user_id=p_user_id and period=period_day)>=2000 then return jsonb_build_object('state','denied');end if;
 insert into xelay_student_private.requests(user_id,request_id,fingerprint,session_hash,period,reserve_micros,request)
 values(p_user_id,p_request_id,p_fingerprint,p_session_hash,period_day,p_reserve_micros,p_request)returning * into r;
 update xelay_student_private.usage set reserved_micros=reserved_micros+p_reserve_micros where user_id=p_user_id and period=period_day;
 return jsonb_build_object('state','reserved','reservationId',r.reservation_id);
end$$;

create function xelay_student_private.bundle_valid(b jsonb,r jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare q jsonb;c jsonb;p jsonb;x jsonb;ids text[]:='{}';begin
 if not xelay_student_private.fields(b,array['version','mode','title','introduction','steps','questions','cards','plan','math','citations']) or b->'version'<>'1'::jsonb or b->>'mode'<>r->>'mode'
 or not xelay_student_private.plain(b->>'title',160) or not xelay_student_private.plain(b->>'introduction',2400) or octet_length(b::text)>512000 then return false;end if;
 foreach x in array array[b->'steps',b->'questions',b->'cards',b->'plan',b->'citations']loop if jsonb_typeof(x)<>'array' then return false;end if;end loop;
 if jsonb_array_length(b->'questions')>12 or jsonb_array_length(b->'cards')>24 or jsonb_array_length(b->'plan')>14 or jsonb_array_length(b->'steps')>12 or jsonb_array_length(b->'citations') not between 1 and 12 then return false;end if;
 for q in select value from jsonb_array_elements(b->'questions')loop
  if not xelay_student_private.fields(q,array['id','text','options','correctIndex','explanation','sourceId']) or not xelay_student_private.identifier(q->>'id') or(q->>'id')=any(ids)
  or not xelay_student_private.plain(q->>'text',1000) or not xelay_student_private.plain(q->>'explanation',1400) or jsonb_typeof(q->'options')<>'array' then return false;end if;
  if jsonb_array_length(q->'options') not between 2 and 6 or jsonb_typeof(q->'correctIndex')<>'number' or(q->>'correctIndex')!~'^[0-5]$' or(q->>'correctIndex')::integer>=jsonb_array_length(q->'options') then return false;end if;
  for x in select value from jsonb_array_elements(q->'options')loop if jsonb_typeof(x)<>'string' or not xelay_student_private.plain(x#>>'{}',500) then return false;end if;end loop;
  if not exists(select 1 from jsonb_array_elements(r->'sources')s where s->>'id'=q->>'sourceId')then return false;end if;ids:=array_append(ids,q->>'id');
 end loop;ids:='{}';
 for c in select value from jsonb_array_elements(b->'cards')loop
  if not xelay_student_private.fields(c,array['id','front','back','sourceId']) or not xelay_student_private.identifier(c->>'id') or(c->>'id')=any(ids) or not xelay_student_private.plain(c->>'front',500) or not xelay_student_private.plain(c->>'back',1200)
  or not exists(select 1 from jsonb_array_elements(r->'sources')s where s->>'id'=c->>'sourceId')then return false;end if;ids:=array_append(ids,c->>'id');
 end loop;ids:='{}';
 for p in select value from jsonb_array_elements(b->'plan')loop
  if not xelay_student_private.fields(p,array['id','label','minutes','tasks']) or not xelay_student_private.identifier(p->>'id') or(p->>'id')=any(ids) or not xelay_student_private.plain(p->>'label',120) or(p->>'minutes')!~'^[0-9]{1,3}$' or(p->>'minutes')::integer not between 5 and 240 or jsonb_typeof(p->'tasks')<>'array' then return false;end if;
  if jsonb_array_length(p->'tasks') not between 1 and 8 then return false;end if;for x in select value from jsonb_array_elements(p->'tasks')loop if jsonb_typeof(x)<>'string' or not xelay_student_private.plain(x#>>'{}',300)then return false;end if;end loop;ids:=array_append(ids,p->>'id');
 end loop;
 for c in select value from jsonb_array_elements(b->'citations')loop
  if not xelay_student_private.fields(c,array['sourceId','quote']) or not xelay_student_private.plain(c->>'quote',600) or not exists(select 1 from jsonb_array_elements(r->'sources')s where s->>'id'=c->>'sourceId' and strpos(s->>'text',c->>'quote')>0)then return false;end if;
 end loop;
 if b->>'mode'='quiz' and jsonb_array_length(b->'questions')=0 or b->>'mode'='cards' and jsonb_array_length(b->'cards')=0 or b->>'mode'='plan' and jsonb_array_length(b->'plan')=0 or b->>'mode'='explain' and jsonb_array_length(b->'steps')=0 then return false;end if;
 return true;
end$$;
create function public.xelay_max_ai_finish(p_user_id uuid,p_session_hash text,p_request_id text,p_fingerprint text,p_reservation_id uuid,p_charge_micros bigint,p_bundle jsonb default null,p_request jsonb default null)
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
 update xelay_student_private.usage set reserved_micros=reserved_micros-r.reserve_micros,spent_micros=spent_micros+p_charge_micros where user_id=p_user_id and period=r.period;
 update xelay_student_private.requests set state='done',charge_micros=p_charge_micros,settled_at=clock_timestamp() where user_id=p_user_id and request_id=p_request_id;
 if authorized then insert into xelay_student_private.runs(user_id,id,request,bundle)values(p_user_id,p_request_id,r.request,p_bundle);end if;
 return jsonb_build_object('settled',true,'replayed',false,'stored',authorized);
end$$;
create function xelay_student_private.run_document(r xelay_student_private.runs) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',r.id,'createdAt',r.created_at,'demo',false,'request',r.request,'bundle',r.bundle,'progress',r.progress,'revision',r.revision);$$;
create function public.xelay_max_runs_list(p_limit integer default 12) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u uuid:=xelay_student_private.caller();v jsonb;begin
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'MAX_HISTORY_LIMIT' using errcode='22023';end if;
 select coalesce(jsonb_agg(xelay_student_private.run_document(r) order by r.created_at desc),'[]')into v from(select * from xelay_student_private.runs where user_id=u order by created_at desc limit p_limit)r;return v;
end$$;
create function xelay_student_private.progress_valid(p jsonb,b jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare pair record;v jsonb;q jsonb;parts text[];begin
 if not xelay_student_private.fields(p,array['answers','submitted','cardRatings','doneTasks']) or jsonb_typeof(p->'answers')<>'object' or jsonb_typeof(p->'submitted')<>'array' or jsonb_typeof(p->'cardRatings')<>'object' or jsonb_typeof(p->'doneTasks')<>'array' or octet_length(p::text)>12000 then return false;end if;
 for pair in select key,value from jsonb_each(p->'answers')loop
  select value into q from jsonb_array_elements(b->'questions')where value->>'id'=pair.key;
  if q is null or jsonb_typeof(pair.value)<>'number' or(pair.value#>>'{}')!~'^[0-5]$' or(pair.value#>>'{}')::integer>=jsonb_array_length(q->'options')then return false;end if;
 end loop;
 if jsonb_array_length(p->'submitted')>12 or jsonb_array_length(p->'submitted')<>(select count(distinct value)from jsonb_array_elements(p->'submitted'))or jsonb_array_length(p->'doneTasks')>112 or jsonb_array_length(p->'doneTasks')<>(select count(distinct value)from jsonb_array_elements(p->'doneTasks'))then return false;end if;
 for v in select value from jsonb_array_elements(p->'submitted')loop if jsonb_typeof(v)<>'string' or not(p->'answers' ? (v#>>'{}'))then return false;end if;end loop;
 for pair in select key,value from jsonb_each(p->'cardRatings')loop if not exists(select 1 from jsonb_array_elements(b->'cards')c where c->>'id'=pair.key)or pair.value not in('"known"'::jsonb,'"repeat"'::jsonb)then return false;end if;end loop;
 for v in select value from jsonb_array_elements(p->'doneTasks')loop
  if jsonb_typeof(v)<>'string' or(v#>>'{}')!~'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}:[0-7]$'then return false;end if;
  parts:=string_to_array(v#>>'{}',':');select value into q from jsonb_array_elements(b->'plan')where value->>'id'=parts[1];
  if q is null or parts[2]::integer>=jsonb_array_length(q->'tasks')then return false;end if;
 end loop;return true;
end$$;
create function public.xelay_max_run_progress(p_run_id text,p_expected_version integer,p_progress jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=xelay_student_private.caller();r xelay_student_private.runs;begin
 if not xelay_student_private.identifier(p_run_id) or p_expected_version is null or p_expected_version<1 then raise exception 'MAX_PROGRESS_INVALID' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('max-owner:'||u::text,0));select * into r from xelay_student_private.runs where user_id=u and id=p_run_id for update;
 if not found then raise exception 'MAX_RUN_UNAVAILABLE' using errcode='42501';end if;
 if not xelay_student_private.progress_valid(p_progress,r.bundle)then raise exception 'MAX_PROGRESS_INVALID' using errcode='22023';end if;
 if r.progress=p_progress then return xelay_student_private.run_document(r);end if;
 if r.revision<>p_expected_version then raise exception 'MAX_PROGRESS_CONFLICT' using errcode='PT409';end if;
 -- Personal practice may deliberately repeat mistakes. This does not mutate any official assessment.
 update xelay_student_private.runs set progress=p_progress,revision=revision+1,updated_at=clock_timestamp()where user_id=u and id=p_run_id returning * into r;return xelay_student_private.run_document(r);
end$$;

create function xelay_student_private.capture_initial_audience() returns trigger language plpgsql security definer set search_path='' as $$begin
 if to_jsonb(new)->>'account_type' in('student','teacher')then insert into xelay_student_private.audiences(user_id,audience,source,reason)values(new.id,to_jsonb(new)->>'account_type','registration','Initial validated profile creation')on conflict do nothing;end if;return new;end$$;
create trigger xelay_capture_initial_billing_audience after insert on public.profiles for each row execute function xelay_student_private.capture_initial_audience();
revoke all on all functions in schema xelay_student_private from public,anon,authenticated,service_role;
revoke all on function public.xelay_student_workspace_status(),public.xelay_student_workspace_entitlement(uuid),public.xelay_student_audience_assign(uuid,text,text),public.xelay_student_plan_grant(uuid,text,timestamptz,timestamptz,text),
 public.xelay_max_sources_put(text,jsonb),public.xelay_max_sources_get(text,text[]),public.xelay_max_ai_reserve(uuid,text,text,text,bigint,bigint,jsonb),public.xelay_max_ai_finish(uuid,text,text,text,uuid,bigint,jsonb,jsonb),public.xelay_max_runs_list(integer),public.xelay_max_run_progress(text,integer,jsonb)from public,anon,authenticated,service_role;
grant execute on function public.xelay_student_workspace_status(),public.xelay_max_sources_put(text,jsonb),public.xelay_max_sources_get(text,text[]),public.xelay_max_runs_list(integer),public.xelay_max_run_progress(text,integer,jsonb)to authenticated;
grant execute on function public.xelay_student_workspace_entitlement(uuid),public.xelay_student_audience_assign(uuid,text,text),public.xelay_student_plan_grant(uuid,text,timestamptz,timestamptz,text),public.xelay_max_ai_reserve(uuid,text,text,text,bigint,bigint,jsonb),public.xelay_max_ai_finish(uuid,text,text,text,uuid,bigint,jsonb,jsonb)to service_role;
comment on schema xelay_student_private is 'Private student billing identity, explicit own-text sources, personal learning artifacts and isolated per-owner UTC-month model accounting. No official tests, grades or legacy paid time changed.';
notify pgrst,'reload schema';
commit;
