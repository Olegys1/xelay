-- Extend the existing private administrator Telegram outbox to pending teacher
-- applications. No applicant content, new client RPC or audience is exposed.
begin;

do $$
begin
  if to_regclass('public.teacher_verification_requests') is null
    or to_regclass('public.admin_representative_alert_delivery') is null
    or to_regprocedure('public.xelay_private_queue_representative_alert()') is null
    or to_regprocedure('public.xelay_claim_admin_representative_alert()') is null
    or to_regprocedure('public.xelay_admin_representative_alert_delivery_context(uuid)') is null
    or to_regprocedure('public.xelay_finish_admin_representative_alert(uuid,text,text,integer)') is null then
    raise exception 'ADMIN_TEACHER_ALERT_PREREQUISITES_REQUIRED';
  end if;
  if not exists(select 1 from pg_class c where c.oid='public.teacher_verification_requests'::regclass and c.relrowsecurity) then
    raise exception 'ADMIN_TEACHER_ALERT_RLS_REQUIRED';
  end if;
end $$;

-- Owner-only projection, used under the existing service-only delivery RPCs.
-- Keep the representative-only administrator popup/summary contract unchanged.
-- A reapplication uses the teacher row's updated_at as its new queue arrival.
create or replace function public.xelay_private_admin_request_pending_summary()
returns jsonb language sql stable set search_path='' as $$
  with pending as (
    select 'representative'::text kind,case when isfinite(r.created_at)
      and r.created_at>=timestamptz '1970-01-01 00:00:00+00'
      then least(r.created_at,statement_timestamp()) else statement_timestamp() end arrived_at
      from public.class_representative_requests r where r.status='pending'
    union all
    select 'teacher'::text kind,case when isfinite(r.updated_at)
      and r.updated_at>=timestamptz '1970-01-01 00:00:00+00'
      then least(r.updated_at,statement_timestamp()) else statement_timestamp() end arrived_at
      from public.teacher_verification_requests r where r.status='pending'
  )
  select jsonb_build_object(
    'pending_count',count(*),
    'representative_pending_count',count(*) filter(where kind='representative'),
    'teacher_pending_count',count(*) filter(where kind='teacher'),
    'oldest_pending_at',min(arrived_at),'latest_pending_at',max(arrived_at),
    'oldest_representative_pending_at',min(arrived_at) filter(where kind='representative'),
    'oldest_teacher_pending_at',min(arrived_at) filter(where kind='teacher'))
  from pending;
$$;
revoke all on function public.xelay_private_admin_request_pending_summary() from public,anon,authenticated,service_role;

-- Preserve the installed lease/backoff functions and their ACLs. Abort atomically
-- on managed-function drift rather than replacing unrelated authorization logic.
do $$
declare v_body text;v_signature text;v_old text;v_new text;
begin
  foreach v_signature in array array[
    'public.xelay_claim_admin_representative_alert()',
    'public.xelay_admin_representative_alert_delivery_context(uuid)'] loop
    select replace(pg_get_functiondef(v_signature::regprocedure),chr(13),'') into v_body;
    v_old:='v_summary := public.xelay_private_representative_pending_summary();';
    v_new:='v_summary := public.xelay_private_admin_request_pending_summary();';
    if cardinality(string_to_array(v_body,v_old))=2 and position(v_new in v_body)=0 then
      execute replace(v_body,v_old,v_new);
    elsif cardinality(string_to_array(v_body,v_new))<>2 or position(v_old in v_body)>0 then
      raise exception 'ADMIN_TEACHER_ALERT_SUMMARY_DRIFT: %',v_signature;
    end if;
  end loop;
  select replace(pg_get_functiondef('public.xelay_finish_admin_representative_alert(uuid,text,text,integer)'::regprocedure),chr(13),'') into v_body;
  v_old:='select exists (select 1 from public.class_representative_requests r where r.status = ''pending'') into v_pending;';
  v_new:='select exists (select 1 from public.class_representative_requests r where r.status = ''pending'') or exists (select 1 from public.teacher_verification_requests r where r.status = ''pending'') into v_pending;';
  if cardinality(string_to_array(v_body,v_old))=2 and position(v_new in v_body)=0 then
    execute replace(v_body,v_old,v_new);
  elsif cardinality(string_to_array(v_body,v_new))<>2 or position(v_old in v_body)>0 then
    raise exception 'ADMIN_TEACHER_ALERT_FINISH_DRIFT';
  end if;
end $$;

-- The new trigger is also the atomic installation marker: bootstrap an existing
-- pending teacher backlog once, without resetting an active lease or Telegram's
-- provider Retry-After. Rolling back installation rolls back the marker too.
do $$
begin
  if not exists(select 1 from pg_trigger where tgrelid='public.teacher_verification_requests'::regclass
    and tgname='xelay_queue_teacher_admin_alert' and not tgisinternal) then
    create trigger xelay_queue_teacher_admin_alert
      after insert or update of status or delete on public.teacher_verification_requests
      for each row execute function public.xelay_private_queue_representative_alert();
    update public.admin_representative_alert_delivery s set
      generation=s.generation+1,
      attempts=case when s.lease_until>clock_timestamp() then s.attempts else 0 end,
      next_attempt_at=clock_timestamp(),last_queue_changed_at=clock_timestamp()
      where s.singleton and exists(select 1 from public.teacher_verification_requests r where r.status='pending');
  elsif not exists(select 1 from pg_trigger t where t.tgrelid='public.teacher_verification_requests'::regclass
    and t.tgname='xelay_queue_teacher_admin_alert' and t.tgfoid='public.xelay_private_queue_representative_alert()'::regprocedure
    and not t.tgisinternal and t.tgenabled='O' and t.tgtype=29) then
    raise exception 'ADMIN_TEACHER_ALERT_TRIGGER_DRIFT';
  end if;
end $$;

comment on function public.xelay_private_admin_request_pending_summary() is
  'Owner-only aggregate pending representative/teacher counts and sanitized arrival times for the existing private Telegram outbox; no names, contacts, request IDs or application content.';
comment on table public.admin_representative_alert_delivery is
  'Private singleton Telegram outbox for live pending representative and teacher queues. New arrivals coalesce, failures retain retry/backoff, backlog repeats hourly until reviewed. No applicant content or secrets. External delivery is at-least-once.';
notify pgrst,'reload schema';
commit;
