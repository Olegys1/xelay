begin;
set local lock_timeout='5s';set local statement_timeout='60s';
-- Only aggregate evidence, tied to the existing leased five-minute window.
create table xelay_security_monitor.diagnostics (
 window_end timestamptz primary key, evidence jsonb not null,
 database_started_at timestamptz not null, created_at timestamptz not null default clock_timestamp()
);
alter table xelay_security_monitor.diagnostics enable row level security;
revoke all on xelay_security_monitor.diagnostics from public,anon,authenticated,service_role;
create function public.xelay_security_monitor_record_diagnostics(p_token uuid,p_evidence jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare s xelay_security_monitor.state;v jsonb;v_key text;
begin
 if not public.xelay_security_is_trusted_backend() then raise exception 'SECURITY_MONITOR_SERVICE_REQUIRED' using errcode='42501';end if;
 select * into s from xelay_security_monitor.state where singleton for update;
 if p_token is null or p_token is distinct from s.lease_token or not(s.lease_until>clock_timestamp()) then return false;end if;
 if p_evidence is null or jsonb_typeof(p_evidence)<>'object'
 or (select count(*) from jsonb_object_keys(p_evidence))<>5
 or exists(select 1 from jsonb_object_keys(p_evidence) k where k not in('api_total','api_errors','unauthenticated_denials','database_shutdowns','database_starting')) then
  raise exception 'SECURITY_MONITOR_INVALID_EVIDENCE' using errcode='22023';end if;
 for v_key,v in select key,value from jsonb_each(p_evidence) loop
  if jsonb_typeof(v)<>'number' or v::text!~'^[0-9]{1,10}$' or v::text::bigint>1000000000 then
   raise exception 'SECURITY_MONITOR_INVALID_EVIDENCE' using errcode='22023';end if;
 end loop;
 if (p_evidence->>'api_errors')::bigint+(p_evidence->>'unauthenticated_denials')::bigint>(p_evidence->>'api_total')::bigint then
  raise exception 'SECURITY_MONITOR_INVALID_EVIDENCE' using errcode='22023';end if;
 insert into xelay_security_monitor.diagnostics(window_end,evidence,database_started_at)
 values(s.window_end,p_evidence,pg_postmaster_start_time()) on conflict do nothing;
 delete from xelay_security_monitor.diagnostics where window_end<clock_timestamp()-interval '7 days';
 return true;
end$$;
revoke all on function public.xelay_security_monitor_record_diagnostics(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_security_monitor_record_diagnostics(uuid,jsonb) to service_role;

-- Existing delivery, leases, severity, thresholds and access checks remain intact.
create or replace function xelay_security_monitor.alert_context(p_id uuid,p_token uuid)
returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('lease_token',i.lease_token,'alert_id',i.id,'kind',i.kind,'severity',i.severity,
  'source',i.source,'event_count',i.event_count,'total_count',i.total_count,'threshold',i.threshold,
  'window_start',i.window_start,'window_end',i.window_end,'created_at',i.created_at,'occurrences',i.occurrences,
  'diagnostics',case when d.window_end is not null then d.evidence||jsonb_build_object('window_end',d.window_end,'database_started_at',d.database_started_at) else null end)
 from xelay_security_monitor.incidents i left join xelay_security_monitor.diagnostics d on d.window_end=i.window_end
 where i.id=p_id and i.lease_token=p_token and i.status='pending' and i.lease_until>clock_timestamp();
$$;
revoke all on function xelay_security_monitor.alert_context(uuid,uuid) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
