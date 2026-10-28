-- LOCAL REVIEW ARTIFACT. Explicit installation only; intentionally outside migrations.
-- Requires platform roles/MFA tables. Bootstraps only the reviewed backend-role
-- helper when absent; no other profile/security migration is applied.
-- No provider, token, cron, or Auth changes.
begin;
do $$begin
  if pg_catalog.to_regclass('public.user_roles') is null
    or pg_catalog.to_regclass('auth.mfa_factors') is null then
    raise exception 'SECURITY_MONITOR_PREREQUISITES_REQUIRED';
  end if;
end$$;

-- Some older installations have the role/MFA model without the later profile
-- migration. Install only its exact actual-database-role helper; never infer
-- backend trust from editable JWT metadata, auth.role(), or current_user inside
-- a SECURITY DEFINER function. Existing conflicting definitions fail closed.
do $bootstrap$
begin
  if pg_catalog.to_regprocedure('public.xelay_security_is_trusted_backend()') is null then
    execute $create$
      create function public.xelay_security_is_trusted_backend()
      returns boolean language sql stable security invoker set search_path = ''
      as $helper$
        select coalesce(current_setting('role',true),'none')='service_role'
          or (coalesce(current_setting('role',true),'none') in
              ('none','postgres','supabase_admin','supabase_auth_admin')
            and session_user in ('postgres','supabase_admin','supabase_auth_admin','service_role'));
      $helper$;
    $create$;
  end if;
  if not exists(select 1 from pg_catalog.pg_proc p
    where p.oid=pg_catalog.to_regprocedure('public.xelay_security_is_trusted_backend()')
      and pg_catalog.md5(pg_catalog.regexp_replace(p.prosrc,'[[:space:]]','','g'))='a78a453665ae417aee43af80dd967531'
      and p.prokind='f' and p.prorettype='boolean'::pg_catalog.regtype and not p.proretset and p.pronargs=0
      and p.prolang=(select l.oid from pg_catalog.pg_language l where l.lanname='sql')
      and p.provolatile='s' and not p.prosecdef and p.proconfig=array['search_path=""']::text[]
      and p.proowner in(select r.oid from pg_catalog.pg_roles r where r.rolname in('postgres','supabase_admin','supabase_auth_admin'))) then
    raise exception 'SECURITY_MONITOR_TRUSTED_HELPER_CONFLICT' using errcode='42501';
  end if;
end
$bootstrap$;
revoke all on function public.xelay_security_is_trusted_backend() from public,anon,authenticated,service_role;

create schema if not exists xelay_security_monitor;
revoke all on schema xelay_security_monitor from public,anon,authenticated,service_role;
alter default privileges in schema xelay_security_monitor revoke execute on functions from public;
alter default privileges in schema xelay_security_monitor revoke all on tables from public,anon,authenticated,service_role;

create table if not exists xelay_security_monitor.state (
  singleton boolean primary key default true check(singleton),
  last_window_end timestamptz,
  next_poll_at timestamptz not null default '-infinity',
  lease_token uuid,lease_until timestamptz,window_start timestamptz,window_end timestamptz,
  coverage text not null default 'not_configured' check(coverage in('healthy','partial','unavailable','not_configured')),
  consecutive_failures integer not null default 0,
  logs_retry_at timestamptz,last_error_code text,
  telegram_retry_at timestamptz,last_admin_role_window timestamptz,ready_notice_at timestamptz
);
-- Additive upgrade for an already installed monitor. The durable marker is
-- intentionally retained beyond incident retention and never reset on rerun.
alter table xelay_security_monitor.state add column if not exists ready_notice_at timestamptz;
insert into xelay_security_monitor.state(singleton) values(true) on conflict do nothing;

create table if not exists xelay_security_monitor.policy (
  kind text primary key,source text not null,severity text not null check(severity in('info','warning','critical')),
  min_count bigint not null check(min_count>=1),min_ratio numeric not null check(min_ratio between 0 and 1),
  min_baseline_windows integer not null default 0,baseline_multiplier numeric not null default 0,
  cooldown_seconds integer not null default 1800 check(cooldown_seconds>=1800)
);
alter table xelay_security_monitor.policy drop constraint if exists policy_severity_check;
alter table xelay_security_monitor.policy add constraint policy_severity_check check(severity in('info','warning','critical'));
insert into xelay_security_monitor.policy(kind,source,severity,min_count,min_ratio,min_baseline_windows,baseline_multiplier)
values('auth_failures','auth','warning',30,0.5,0,0),
  ('api_errors','api','warning',15,0.1,0,0),
  ('access_denials','api','warning',50,0.3,0,0),
  ('storage_denials','storage','warning',20,0.4,0,0),
  ('request_volume','api','warning',3000,0,6,5),
  ('logs_unavailable','monitor','warning',3,0,0,0),
  ('rls_disabled','database','critical',1,0,0,0),
  ('admin_mfa_missing','database','critical',1,0,0,0),
  ('admin_role_changed','database','warning',1,0,0,0),
  ('monitor_ready','monitor','info',1,0,0,0)
on conflict do nothing;

-- Fixed identifiers only; neither client events nor arbitrary table names are accepted.
create table if not exists xelay_security_monitor.protected_table (
  schema_name text not null,table_name text not null,primary key(schema_name,table_name)
);
insert into xelay_security_monitor.protected_table values
  ('public','profiles'),('public','user_roles'),('public','messages'),
  ('public','notifications'),('public','teacher_verification_requests'),
  ('public','class_representative_requests'),('storage','objects') on conflict do nothing;
-- Baseline every currently protected application table, including academic
-- groups, grades, submitted work and materials. Reinstallation adds newly
-- protected tables and never removes a previously recorded invariant.
-- Approved renames/deletions require an operator to update this closed baseline.
insert into xelay_security_monitor.protected_table(schema_name,table_name)
  select n.nspname,c.relname from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in('r','p') and c.relrowsecurity
  on conflict do nothing;

create table if not exists xelay_security_monitor.windows (
  window_end timestamptz primary key,window_start timestamptz not null,
  coverage text not null check(coverage in('healthy','partial','unavailable','not_configured')),
  error_code text,created_at timestamptz not null default clock_timestamp(),
  check(window_end=window_start+interval '5 minutes')
);
create table if not exists xelay_security_monitor.observations (
  window_end timestamptz not null references xelay_security_monitor.windows(window_end) on delete cascade,
  kind text not null references xelay_security_monitor.policy(kind),
  event_count bigint not null check(event_count between 0 and 1000000000),
  total_count bigint not null check(total_count between 0 and 1000000000),
  unknown_status bigint not null default 0 check(unknown_status>=0),
  primary key(window_end,kind),check(event_count+unknown_status<=total_count)
);
create table if not exists xelay_security_monitor.incidents (
  id uuid primary key default gen_random_uuid(),kind text not null references xelay_security_monitor.policy(kind),
  source text not null,severity text not null check(severity in('info','warning','critical')),
  event_count bigint not null,total_count bigint not null,threshold jsonb not null,
  window_start timestamptz not null,window_end timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),occurrences integer not null default 1,
  status text not null default 'pending' check(status in('pending','sent','failed','skipped')),
  next_attempt_at timestamptz not null default clock_timestamp(),attempts integer not null default 0 check(attempts between 0 and 5),
  lease_token uuid,lease_until timestamptz,last_error_code text,sent_at timestamptz,
  unique(kind,window_start,window_end)
);
alter table xelay_security_monitor.incidents drop constraint if exists incidents_severity_check;
alter table xelay_security_monitor.incidents add constraint incidents_severity_check check(severity in('info','warning','critical'));
create index if not exists xelay_security_monitor_pending on xelay_security_monitor.incidents(next_attempt_at,created_at) where status='pending';
create table if not exists xelay_security_monitor.delivery_attempts (
  id uuid primary key default gen_random_uuid(),created_at timestamptz not null default clock_timestamp()
);

do $$declare t text;begin
  foreach t in array array['state','policy','protected_table','windows','observations','incidents','delivery_attempts'] loop
    execute pg_catalog.format('alter table xelay_security_monitor.%I enable row level security',t);
    execute pg_catalog.format('revoke all on table xelay_security_monitor.%I from public,anon,authenticated,service_role',t);
  end loop;
end$$;

-- One durable, aggregate incident per kind/cooldown. Preserve the first coherent
-- count/total/window snapshot. Later windows may increment only occurrences,
-- before a lease is claimed, so no numerator is labelled with another period.
create or replace function xelay_security_monitor.record_incident(p_kind text,p_count bigint,p_total bigint,p_start timestamptz,p_end timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare v_policy xelay_security_monitor.policy%rowtype;v_recent xelay_security_monitor.incidents%rowtype;v_now timestamptz:=clock_timestamp();
begin
  perform 1 from xelay_security_monitor.state where singleton for update;
  select * into strict v_policy from xelay_security_monitor.policy where kind=p_kind;
  if exists(select 1 from xelay_security_monitor.incidents where kind=p_kind and window_start=p_start and window_end=p_end) then return;end if;
  select * into v_recent from xelay_security_monitor.incidents where kind=p_kind
    and created_at>v_now-pg_catalog.make_interval(secs=>v_policy.cooldown_seconds)
    order by created_at desc limit 1 for update;
  if found then
    if v_recent.status='pending' and v_recent.lease_token is null then
      update xelay_security_monitor.incidents set occurrences=occurrences+1 where id=v_recent.id;
    end if;
    return;
  end if;
  insert into xelay_security_monitor.incidents(kind,source,severity,event_count,total_count,threshold,window_start,window_end)
    values(p_kind,v_policy.source,v_policy.severity,p_count,p_total,
      jsonb_build_object('min_count',v_policy.min_count,'min_ratio',v_policy.min_ratio,
        'min_baseline_windows',v_policy.min_baseline_windows,'baseline_multiplier',v_policy.baseline_multiplier,
        'cooldown_seconds',v_policy.cooldown_seconds),p_start,p_end);
end$$;
revoke all on function xelay_security_monitor.record_incident(text,bigint,bigint,timestamptz,timestamptz) from public,anon,authenticated,service_role;

create or replace function public.xelay_security_monitor_due()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_state xelay_security_monitor.state%rowtype;v_now timestamptz:=clock_timestamp();v_end timestamptz;v_start timestamptz;v_token uuid;v_count bigint;
begin
  if not public.xelay_security_is_trusted_backend() then raise exception 'SECURITY_MONITOR_SERVICE_REQUIRED' using errcode='42501';end if;
  select * into v_state from xelay_security_monitor.state where singleton for update;
  if v_state.next_poll_at>v_now or v_state.lease_until>v_now then return null;end if;
  -- UTC epoch windows, with one full minute allowed for logs ingestion.
  v_end:=pg_catalog.to_timestamp(floor(extract(epoch from v_now-interval '1 minute')/300)*300);
  if v_state.last_window_end>=v_end then return null;end if;
  v_start:=v_end-interval '5 minutes';v_token:=gen_random_uuid();
  update xelay_security_monitor.state set lease_token=v_token,lease_until=v_now+interval '2 minutes',
    window_start=v_start,window_end=v_end,next_poll_at=v_now+interval '5 minutes' where singleton;
  -- Include missing protected relations: coverage is never declared safe if a
  -- required relation disappeared. No actual relation/user identifier is stored.
  select count(*) into v_count from xelay_security_monitor.protected_table p
    left join pg_catalog.pg_namespace n on n.nspname=p.schema_name
    left join pg_catalog.pg_class c on c.relnamespace=n.oid and c.relname=p.table_name
    where c.oid is null or not c.relrowsecurity;
  if v_count>0 then perform xelay_security_monitor.record_incident('rls_disabled',v_count,
    (select count(*) from xelay_security_monitor.protected_table),v_start,v_end);end if;
  select count(*) into v_count from public.user_roles r where r.role='ADMIN'
    and not exists(select 1 from auth.mfa_factors f where f.user_id=r.user_id and f.status='verified');
  if v_count>0 then perform xelay_security_monitor.record_incident('admin_mfa_missing',v_count,
    (select count(*) from public.user_roles where role='ADMIN'),v_start,v_end);end if;
  -- Bounded, incremental cleanup; the fixed cadence bounds new rows.
  delete from xelay_security_monitor.windows where window_end<v_now-interval '7 days';
  delete from xelay_security_monitor.incidents where created_at<v_now-interval '30 days';
  delete from xelay_security_monitor.delivery_attempts where created_at<v_now-interval '1 hour';
  return jsonb_build_object('lease_token',v_token,'window_start',v_start,'window_end',v_end,'logs_retry_at',v_state.logs_retry_at);
end$$;

create or replace function public.xelay_security_monitor_observe(p_token uuid,p_observations jsonb,p_coverage text,p_error_code text default null,p_retry_after_seconds integer default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_state xelay_security_monitor.state%rowtype;v_now timestamptz:=clock_timestamp();v_row jsonb;v_kind text;
  v_count bigint;v_total bigint;v_unknown bigint;v_policy xelay_security_monitor.policy%rowtype;v_baseline numeric;v_baseline_n integer;
  v_failures integer;v_error text;v_retry integer;v_has_unknown boolean:=false;
begin
  if not public.xelay_security_is_trusted_backend() then raise exception 'SECURITY_MONITOR_SERVICE_REQUIRED' using errcode='42501';end if;
  select * into v_state from xelay_security_monitor.state where singleton for update;
  if p_token is null or p_token is distinct from v_state.lease_token or not(v_state.lease_until>v_now) then return false;end if;
  if p_coverage is null or p_coverage not in('healthy','partial','unavailable','not_configured')
    or p_observations is null or jsonb_typeof(p_observations)<>'array' then
    raise exception 'SECURITY_MONITOR_INVALID_OBSERVATIONS' using errcode='22023';end if;
  if jsonb_array_length(p_observations)>5 or (p_coverage in('unavailable','not_configured') and jsonb_array_length(p_observations)<>0)
    or (p_coverage in('healthy','partial') and jsonb_array_length(p_observations)<>5)
    or p_retry_after_seconds is not null and (p_retry_after_seconds<0 or p_retry_after_seconds>86400)
    or p_coverage='healthy' and (p_error_code is not null or coalesce(p_retry_after_seconds,0)>0)
    or p_coverage='partial' and (p_error_code is distinct from 'logs_partial' or coalesce(p_retry_after_seconds,0)>0) then
    raise exception 'SECURITY_MONITOR_INVALID_OBSERVATIONS' using errcode='22023';end if;
  if p_error_code is not null and p_error_code not in('logs_not_configured','logs_unauthorized','logs_forbidden','logs_payment_required',
    'logs_rate_limited','logs_unavailable','logs_timeout','logs_invalid_response','logs_partial','logs_window_mismatch') then
    raise exception 'SECURITY_MONITOR_INVALID_ERROR_CODE' using errcode='22023';end if;
  for v_row in select value from jsonb_array_elements(p_observations) loop
    if jsonb_typeof(v_row)<>'object' or exists(select 1 from jsonb_object_keys(v_row) k where k not in('kind','source','count','total','unknown_status'))
      or jsonb_typeof(v_row->'kind')<>'string' or jsonb_typeof(v_row->'count')<>'number'
      or jsonb_typeof(v_row->'total')<>'number' or coalesce(jsonb_typeof(v_row->'unknown_status'),'number')<>'number'
      or coalesce(v_row->>'count','')!~'^[0-9]{1,10}$' or coalesce(v_row->>'total','')!~'^[0-9]{1,10}$'
      or coalesce(v_row->>'unknown_status','0')!~'^[0-9]{1,10}$' then
      raise exception 'SECURITY_MONITOR_INVALID_OBSERVATIONS' using errcode='22023';end if;
    v_kind:=v_row->>'kind';
    select * into v_policy from xelay_security_monitor.policy where kind=v_kind and kind in('auth_failures','api_errors','access_denials','storage_denials','request_volume');
    if not found or v_row ? 'source' and (jsonb_typeof(v_row->'source')<>'string' or v_row->>'source' is distinct from v_policy.source)
      or (select count(*) from jsonb_array_elements(p_observations) e where e->>'kind'=v_kind)<>1 then
      raise exception 'SECURITY_MONITOR_INVALID_OBSERVATIONS' using errcode='22023';end if;
    v_count:=(v_row->>'count')::bigint;v_total:=(v_row->>'total')::bigint;v_unknown:=coalesce(v_row->>'unknown_status','0')::bigint;
    if v_count>1000000000 or v_total>1000000000 or v_count+v_unknown>v_total then
      raise exception 'SECURITY_MONITOR_INVALID_OBSERVATIONS' using errcode='22023';end if;
    v_has_unknown:=v_has_unknown or v_unknown>0;
  end loop;
  if p_coverage='healthy' and v_has_unknown or p_coverage='partial' and not v_has_unknown then
    raise exception 'SECURITY_MONITOR_INVALID_COVERAGE' using errcode='22023';end if;
  v_error:=case when p_coverage='not_configured' then 'logs_not_configured'
    when p_coverage='partial' then 'logs_partial'
    when p_coverage='unavailable' then coalesce(p_error_code,'logs_unavailable') else null end;
  insert into xelay_security_monitor.windows(window_start,window_end,coverage,error_code) values(v_state.window_start,v_state.window_end,p_coverage,v_error) on conflict do nothing;
  if p_coverage in('healthy','partial') then
    for v_row in select value from jsonb_array_elements(p_observations) loop
      v_kind:=v_row->>'kind';v_count:=(v_row->>'count')::bigint;v_total:=(v_row->>'total')::bigint;v_unknown:=coalesce(v_row->>'unknown_status','0')::bigint;
      insert into xelay_security_monitor.observations(window_end,kind,event_count,total_count,unknown_status)
        values(v_state.window_end,v_kind,v_count,v_total,v_unknown) on conflict do nothing;
      select * into v_policy from xelay_security_monitor.policy where kind=v_kind;
      if v_kind='request_volume' then
        -- Six contiguous previous complete windows avoid cold-start and stale
        -- baselines after gaps. Peaks are anomalies, never proof of an attack.
        select count(*),avg(o.event_count) into v_baseline_n,v_baseline
          from xelay_security_monitor.observations o join xelay_security_monitor.windows w using(window_end)
          where o.kind=v_kind and w.coverage in('healthy','partial') and o.unknown_status=0
            and w.window_end>=v_state.window_end-interval '30 minutes' and w.window_end<v_state.window_end;
        if v_unknown=0 and v_count>=v_policy.min_count and v_baseline_n>=v_policy.min_baseline_windows
          and v_count>v_baseline*v_policy.baseline_multiplier then
          perform xelay_security_monitor.record_incident(v_kind,v_count,v_total,v_state.window_start,v_state.window_end);end if;
      elsif v_unknown=0 and v_count>=v_policy.min_count and v_total>0 and v_count::numeric/v_total>=v_policy.min_ratio then
        perform xelay_security_monitor.record_incident(v_kind,v_count,v_total,v_state.window_start,v_state.window_end);
      end if;
    end loop;
  end if;
  v_failures:=case when p_coverage='healthy' then 0 else least(v_state.consecutive_failures+1,1000000) end;
  if v_failures>=3 then perform xelay_security_monitor.record_incident('logs_unavailable',v_failures,v_failures,v_state.window_start,v_state.window_end);end if;
  if p_coverage='healthy' and v_state.ready_notice_at is null then
    -- Truthful startup receipt: one successful complete aggregate read, not a
    -- manufactured threat. Normal private queue/delivery gates apply unchanged.
    perform xelay_security_monitor.record_incident('monitor_ready',1,1,v_state.window_start,v_state.window_end);
    update xelay_security_monitor.state set ready_notice_at=v_now where singleton;
  end if;
  v_retry:=coalesce(p_retry_after_seconds,0);
  update xelay_security_monitor.state set coverage=p_coverage,consecutive_failures=v_failures,last_error_code=v_error,
    logs_retry_at=case when v_retry>0 then v_now+pg_catalog.make_interval(secs=>v_retry) else null end,
    -- Provider backoff applies to collection, not the independent DB checks.
    -- The worker receives logs_retry_at on the next five-minute lease and
    -- records unavailable coverage without contacting the logs provider.
    last_window_end=v_state.window_end,
    lease_token=null,lease_until=null,window_start=null,window_end=null where singleton;
  return true;
end$$;

-- Role-change audit stores one aggregate change fact per five-minute window.
-- No user id, email, actor, role row, IP, or request body is copied.
create or replace function xelay_security_monitor.admin_role_changed()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_changed boolean:=false;v_end timestamptz;
begin
  if tg_op='INSERT' then v_changed:=new.role='ADMIN';
  elsif tg_op='DELETE' then v_changed:=old.role='ADMIN';
  else v_changed:=(new.role='ADMIN' or old.role='ADMIN') and
    (new.user_id is distinct from old.user_id or new.role is distinct from old.role);end if;
  if v_changed then
    v_end:=pg_catalog.to_timestamp(floor(extract(epoch from clock_timestamp())/300)*300)+interval '5 minutes';
    -- Collapse one or many role changes to a single anonymous window fact,
    -- including windows coalesced into an earlier incident during cooldown.
    perform 1 from xelay_security_monitor.state where singleton for update;
    if exists(select 1 from xelay_security_monitor.state where singleton and last_admin_role_window>=v_end) then return null;end if;
    update xelay_security_monitor.state set last_admin_role_window=v_end where singleton;
    perform xelay_security_monitor.record_incident('admin_role_changed',1,1,v_end-interval '5 minutes',v_end);
  end if;
  return null;
end$$;
revoke all on function xelay_security_monitor.admin_role_changed() from public,anon,authenticated,service_role;
drop trigger if exists xelay_security_monitor_admin_role_change on public.user_roles;
create trigger xelay_security_monitor_admin_role_change after insert or update or delete on public.user_roles
  for each row execute function xelay_security_monitor.admin_role_changed();

create or replace function xelay_security_monitor.alert_context(p_id uuid,p_token uuid)
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('lease_token',i.lease_token,'alert_id',i.id,'kind',i.kind,'severity',i.severity,
    'source',i.source,'event_count',i.event_count,'total_count',i.total_count,'threshold',i.threshold,
    'window_start',i.window_start,'window_end',i.window_end,'created_at',i.created_at,'occurrences',i.occurrences)
    from xelay_security_monitor.incidents i where i.id=p_id and i.lease_token=p_token and i.status='pending' and i.lease_until>clock_timestamp()
$$;
revoke all on function xelay_security_monitor.alert_context(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.xelay_claim_admin_security_alert()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_state xelay_security_monitor.state%rowtype;v_now timestamptz:=clock_timestamp();v_id uuid;v_token uuid:=gen_random_uuid();
begin
  if not public.xelay_security_is_trusted_backend() then raise exception 'SECURITY_MONITOR_SERVICE_REQUIRED' using errcode='42501';end if;
  select * into v_state from xelay_security_monitor.state where singleton for update;
  if v_state.telegram_retry_at>v_now
    or exists(select 1 from xelay_security_monitor.incidents where lease_until>v_now and status='pending')
    or (select count(*) from xelay_security_monitor.delivery_attempts where created_at>v_now-interval '1 hour')>=6 then return null;end if;
  update xelay_security_monitor.incidents set status='failed',lease_token=null,lease_until=null,last_error_code='delivery_attempt_limit'
    where status='pending' and attempts>=5 and (lease_until is null or lease_until<=v_now);
  select id into v_id from xelay_security_monitor.incidents where status='pending' and attempts<5 and next_attempt_at<=v_now
    and (lease_until is null or lease_until<=v_now) order by (severity='critical') desc,created_at,id limit 1 for update;
  if not found then return null;end if;
  update xelay_security_monitor.incidents set lease_token=v_token,lease_until=v_now+interval '2 minutes',attempts=attempts+1 where id=v_id;
  insert into xelay_security_monitor.delivery_attempts default values;
  return xelay_security_monitor.alert_context(v_id,v_token);
end$$;

create or replace function public.xelay_admin_security_alert_delivery_context(p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  if not public.xelay_security_is_trusted_backend() then raise exception 'SECURITY_MONITOR_SERVICE_REQUIRED' using errcode='42501';end if;
  select id into v_id from xelay_security_monitor.incidents where lease_token=p_token;
  return xelay_security_monitor.alert_context(v_id,p_token);
end$$;

create or replace function public.xelay_finish_admin_security_alert(p_token uuid,p_status text,p_error_code text default null,p_retry_after_seconds integer default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_row xelay_security_monitor.incidents%rowtype;v_now timestamptz:=clock_timestamp();v_retry integer;
begin
  if not public.xelay_security_is_trusted_backend() then raise exception 'SECURITY_MONITOR_SERVICE_REQUIRED' using errcode='42501';end if;
  perform 1 from xelay_security_monitor.state where singleton for update;
  if p_status is null or p_status not in('sent','failed','skipped') or p_error_code is not null and p_error_code not in(
    'telegram_not_configured','telegram_rate_limited','telegram_unavailable','telegram_rejected','telegram_timeout','telegram_invalid_response',
    'telegram_transport_error','telegram_delivery_failed','security_monitor_invalid_context','delivery_attempt_limit')
    or p_retry_after_seconds is not null and (p_retry_after_seconds<0 or p_retry_after_seconds>86400)
    or p_status='sent' and (p_error_code is not null or coalesce(p_retry_after_seconds,0)>0) then
    raise exception 'SECURITY_MONITOR_INVALID_DELIVERY' using errcode='22023';end if;
  select * into v_row from xelay_security_monitor.incidents where lease_token=p_token and status='pending' and lease_until>v_now for update;
  if not found then return false;end if;
  v_retry:=greatest(coalesce(p_retry_after_seconds,0),least(3600,60*(2^least(v_row.attempts,5))::integer));
  update xelay_security_monitor.incidents set
    status=case when p_status='failed' and attempts<5 then 'pending' else p_status end,
    sent_at=case when p_status='sent' then v_now else sent_at end,
    next_attempt_at=case when p_status='failed' then v_now+pg_catalog.make_interval(secs=>v_retry) else next_attempt_at end,
    last_error_code=p_error_code,lease_token=null,lease_until=null where id=v_row.id;
  if p_error_code='telegram_rate_limited' then
    update xelay_security_monitor.state set telegram_retry_at=greatest(coalesce(telegram_retry_at,v_now),v_now+pg_catalog.make_interval(secs=>v_retry)) where singleton;
  end if;
  return true;
end$$;

revoke all on function public.xelay_security_monitor_due(),
  public.xelay_security_monitor_observe(uuid,jsonb,text,text,integer),
  public.xelay_claim_admin_security_alert(),public.xelay_admin_security_alert_delivery_context(uuid),
  public.xelay_finish_admin_security_alert(uuid,text,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.xelay_security_monitor_due(),
  public.xelay_security_monitor_observe(uuid,jsonb,text,text,integer),
  public.xelay_claim_admin_security_alert(),public.xelay_admin_security_alert_delivery_context(uuid),
  public.xelay_finish_admin_security_alert(uuid,text,text,integer) to service_role;
comment on schema xelay_security_monitor is 'Closed aggregate monitor: metrics 7 days, incidents 30 days. No raw request or account identifiers. Explicit setup; no provider/cron configuration.';
notify pgrst,'reload schema';
commit;
