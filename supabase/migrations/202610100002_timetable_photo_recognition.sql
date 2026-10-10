-- Service-only, atomic daily cost limits for photo timetable recognition.
-- No image, extracted text, provider key or token is stored in this table.
-- Existing schedule/homework data and client permissions are unchanged.
begin;

do $timetable_recognition_preflight$
begin
  if to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_group_deputy_requests') is null
    or to_regprocedure('public.xelay_study_group_permissions(uuid)') is null then
    raise exception 'TIMETABLE_RECOGNITION_PREREQUISITES_MISSING'
      using hint='Apply study-group academic and deputy permissions before timetable recognition. No changes were made.';
  end if;
end;
$timetable_recognition_preflight$;

create table if not exists public.timetable_recognition_usage(
  day date not null check(isfinite(day)),
  scope text not null check(scope in('actor','group','global')),
  scope_id uuid not null,
  attempts integer not null default 0 check(attempts between 0 and 200),
  primary key(day,scope,scope_id),
  constraint timetable_recognition_global_scope check(
    (scope='global')=(scope_id='00000000-0000-0000-0000-000000000000'::uuid))
);
alter table public.timetable_recognition_usage enable row level security;
revoke all on table public.timetable_recognition_usage from public,anon,authenticated,service_role;
-- The server can check migration availability without returning usage records.
-- All counter mutation is possible only through the function below.
grant select on table public.timetable_recognition_usage to service_role;

create or replace function public.xelay_reserve_timetable_recognition(p_user_id uuid,p_group_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare
  v_day date := (clock_timestamp() at time zone 'Europe/Kyiv')::date;
  v_actor integer;
  v_group integer;
  v_global integer;
  v_global_id constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'TIMETABLE_RECOGNITION_SERVICE_REQUIRED' using errcode='42501';
  end if;
  if p_user_id is null or p_group_id is null or p_user_id=v_global_id or p_group_id=v_global_id then
    raise exception 'TIMETABLE_RECOGNITION_PERMISSION_REQUIRED' using errcode='42501';
  end if;
  -- Same advisory group lock as deputy/role/content changes. A platform admin
  -- role never substitutes for an actual representative/deputy appointment.
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || p_group_id::text,0));
  if not exists(select 1 from public.study_groups g where g.id=p_group_id and (
    g.representative_id=p_user_id or exists(select 1 from public.study_group_deputy_requests d
      join public.study_group_members m on m.group_id=d.group_id and m.user_id=d.user_id and m.status='accepted'
      where d.group_id=g.id and d.user_id=p_user_id and d.status='approved' and 'schedule'=any(d.permissions)))) then
    raise exception 'TIMETABLE_RECOGNITION_PERMISSION_REQUIRED' using errcode='42501';
  end if;
  -- One global transaction lock prevents concurrent server instances from
  -- overspending actor, group or global quota. Nothing is reserved partially.
  perform pg_advisory_xact_lock(hashtextextended('xelay:timetable-recognition:quota',0));
  insert into public.timetable_recognition_usage(day,scope,scope_id) values
    (v_day,'actor',p_user_id),(v_day,'group',p_group_id),(v_day,'global',v_global_id)
    on conflict(day,scope,scope_id) do nothing;
  select attempts into v_actor from public.timetable_recognition_usage where day=v_day and scope='actor' and scope_id=p_user_id;
  select attempts into v_group from public.timetable_recognition_usage where day=v_day and scope='group' and scope_id=p_group_id;
  select attempts into v_global from public.timetable_recognition_usage where day=v_day and scope='global' and scope_id=v_global_id;
  if v_actor>=10 then raise exception 'TIMETABLE_RECOGNITION_ACTOR_LIMIT' using errcode='54000'; end if;
  if v_group>=20 then raise exception 'TIMETABLE_RECOGNITION_GROUP_LIMIT' using errcode='54000'; end if;
  if v_global>=200 then raise exception 'TIMETABLE_RECOGNITION_GLOBAL_LIMIT' using errcode='54000'; end if;
  update public.timetable_recognition_usage set attempts=attempts+1 where day=v_day and (
    (scope='actor' and scope_id=p_user_id) or (scope='group' and scope_id=p_group_id)
    or (scope='global' and scope_id=v_global_id));
  -- Keep only recent usage counters/IDs; no personal schedule content.
  delete from public.timetable_recognition_usage where day<=v_day-90;
  return true;
end;
$$;

revoke all on function public.xelay_reserve_timetable_recognition(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_reserve_timetable_recognition(uuid,uuid) to service_role;
comment on table public.timetable_recognition_usage is
  'Server-only recognition attempt counters: per Europe/Kyiv calendar day actor 10, group 20, global 200. Records contain no image or timetable text and are retained up to 90 days. No client access.';
comment on function public.xelay_reserve_timetable_recognition(uuid,uuid) is
  'Service-only cost reservation. Server verifies actor bearer; function independently enforces actual representative or accepted approved schedule deputy under group lock and reserves all daily counters atomically. Failed provider attempts remain counted.';
notify pgrst,'reload schema';
commit;
