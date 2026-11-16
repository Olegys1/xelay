-- Teacher writes stay on the canonical group timetable. Personal lesson marks
-- are only an additional filter; they never replace current scoped authority.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.teaching_schedule_change_requests (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  schedule_id uuid not null references public.study_group_schedule(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  lesson_date date not null,
  change_kind text not null check(change_kind in('move','cancel')),
  proposed_date date,
  proposed_start time,
  proposed_end time,
  reason text not null check(char_length(reason) between 1 and 1000),
  before_snapshot jsonb not null,
  status text not null default 'pending' check(status in('pending','approved','rejected','stale')),
  created_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete restrict,
  replacement_id uuid references public.study_group_schedule(id) on delete set null,
  check(change_kind='cancel' or(proposed_date is not null and proposed_start is not null and proposed_end>proposed_start))
);
create unique index teaching_schedule_change_one_pending on public.teaching_schedule_change_requests(schedule_id,lesson_date) where status='pending';
create index teaching_schedule_change_group_status on public.teaching_schedule_change_requests(group_id,status,created_at desc);
alter table public.teaching_schedule_change_requests enable row level security;
revoke all on public.teaching_schedule_change_requests from public,anon,authenticated,service_role;

create table public.teaching_schedule_link_audit (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.study_group_schedule(id) on delete cascade,
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  changed_by uuid not null references public.profiles(id) on delete restrict,
  before_links jsonb not null, after_links jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.teaching_schedule_link_audit enable row level security;
revoke all on public.teaching_schedule_link_audit from public,anon,authenticated,service_role;

create function public.xelay_private_teacher_owns_schedule(p_user_id uuid,p_course_id uuid,p_group_id uuid,p_schedule_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_teaching_has_current_access(p_user_id)
    and public.xelay_study_group_is_listed(p_group_id)
    and public.xelay_teaching_group_permissions(p_course_id,p_group_id,p_user_id)&&array['assignments','grades']::text[]
    and exists(select 1 from public.teaching_courses c
      join public.teaching_course_groups l on l.course_id=c.id and l.group_id=p_group_id and l.status='accepted'
      join public.study_group_schedule s on s.id=p_schedule_id and s.group_id=l.group_id
      left join public.study_group_seminar_subjects sub on sub.id=l.subject_id and sub.group_id=l.group_id
      left join public.teaching_calendar_assignments a on a.user_id=p_user_id and a.course_id=c.id and a.group_id=l.group_id and a.schedule_id=s.id and a.source='timetable'
      left join public.teaching_lesson_roles r on r.user_id=p_user_id and r.course_id=c.id and r.group_id=l.group_id
      where c.id=p_course_id and c.archived_at is null
        and c.ends_on>=(clock_timestamp() at time zone 'Europe/Kyiv')::date and s.valid_until>=(clock_timestamp() at time zone 'Europe/Kyiv')::date
        and c.starts_on<=s.valid_until and c.ends_on>=s.valid_from
        and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(coalesce(sub.name,c.title))
        and coalesce(a.assigned,s.lesson_type=any(r.lesson_types),false));
$$;
revoke all on function public.xelay_private_teacher_owns_schedule(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.xelay_private_teacher_schedule_lock(p_course_id uuid,p_group_id uuid,p_schedule_id uuid,p_expected_user_id uuid)
returns public.study_group_schedule language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user(); v_row public.study_group_schedule%rowtype;
begin
  if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||p_group_id::text,0));
  perform 1 from public.teaching_courses where id=p_course_id for update;
  perform public.xelay_private_assert_teacher_current_access(v_uid);
  if not public.xelay_private_teacher_owns_schedule(v_uid,p_course_id,p_group_id,p_schedule_id) then
    raise exception 'TEACHING_SCHEDULE_FORBIDDEN' using errcode='42501'; end if;
  select * into v_row from public.study_group_schedule where id=p_schedule_id and group_id=p_group_id for update;
  if not found then raise exception 'TEACHING_SCHEDULE_FORBIDDEN' using errcode='42501'; end if;
  if not exists(select 1 from public.billing_settings b where b.singleton and(not b.enforce_group_payment or public.xelay_group_has_access(p_group_id))) then
    raise exception 'GROUP_LICENSE_REQUIRED' using errcode='42501'; end if;
  return v_row;
end $$;
revoke all on function public.xelay_private_teacher_schedule_lock(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- A private transaction-bound capability lets the established row triggers
-- distinguish this exact link-only operation from ordinary group edits.
-- Neither a client GUC nor a self-selected lesson mark can create a capability.
create table public.teaching_schedule_link_write_context (
  backend_pid integer not null, transaction_id bigint not null, user_id uuid not null,
  course_id uuid not null, group_id uuid not null, schedule_id uuid not null,
  before_snapshot jsonb not null, after_links jsonb not null,
  primary key(backend_pid,transaction_id,user_id)
);
alter table public.teaching_schedule_link_write_context enable row level security;
revoke all on public.teaching_schedule_link_write_context from public,anon,authenticated,service_role;

create function public.xelay_private_teacher_link_write_allowed(p_old jsonb,p_new jsonb)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_context public.teaching_schedule_link_write_context%rowtype;v_keys constant text[]:=array['online_url','online_url_secondary','online_url_label','online_url_secondary_label','online_links_extra','conference_id','conference_access_code'];v_actual jsonb;
begin
  select * into v_context from public.teaching_schedule_link_write_context
    where backend_pid=pg_backend_pid() and transaction_id=txid_current() and user_id=auth.uid();
  if not found or p_old->>'group_id' is distinct from v_context.group_id::text
    or (p_new-(v_keys||array['inherit_source_links','updated_at'])) is distinct from (p_old-(v_keys||array['inherit_source_links','updated_at'])) then return false;end if;
  select jsonb_object_agg(k,p_new->k) into v_actual from unnest(v_keys)k;
  if p_old->>'id'=v_context.schedule_id::text then
    return p_old=v_context.before_snapshot and v_actual=v_context.after_links and p_new->'inherit_source_links'='false'::jsonb;
  end if;
  -- Only nested propagation into an existing descendant is authorized. Source
  -- lookup, cycle checks and exact teacher/type/subject matching still run in
  -- the installed inheritance trigger. No child identity or schedule changes.
  if pg_trigger_depth()<=1 or p_old->'inherit_source_links' is distinct from 'true'::jsonb then return false;end if;
  if not exists(with recursive ancestors as (
    select s.id,s.copied_from_schedule_id,1 depth from public.study_group_schedule s where s.id=(p_old->>'id')::uuid and s.group_id=v_context.group_id
    union all select s.id,s.copied_from_schedule_id,a.depth+1 from ancestors a join public.study_group_schedule s on s.id=a.copied_from_schedule_id and s.group_id=v_context.group_id where a.depth<32
  ) select 1 from ancestors where copied_from_schedule_id=v_context.schedule_id) then return false;end if;
  return (p_new->'inherit_source_links'=p_old->'inherit_source_links' and v_actual=v_context.after_links)
    or (p_new->'inherit_source_links'='false'::jsonb and v_actual=(select jsonb_object_agg(k,p_old->k) from unnest(v_keys)k));
end $$;
revoke all on function public.xelay_private_teacher_link_write_allowed(jsonb,jsonb) from public,anon,authenticated,service_role;

-- Preserve all existing trigger safeguards. Only their group-role check gains
-- an additional path for the unforgeable private link capability above.
do $guard_patch$
declare v_sig text;v_body text;v_old text;v_new text;
begin
  foreach v_sig in array array['public.xelay_private_schedule_copy_link_guard()','public.xelay_validate_study_group_delegated_content()'] loop
    select replace(pg_get_functiondef(to_regprocedure(v_sig)),chr(13),'') into v_body;
    if v_sig='public.xelay_private_schedule_copy_link_guard()' then
      v_old:='  perform public.xelay_lock_study_group_permission(v_group,''schedule'',tg_op<>''DELETE'');';
      v_new:='  if not(tg_op=''UPDATE'' and public.xelay_private_teacher_link_write_allowed(to_jsonb(old),to_jsonb(new))) then perform public.xelay_lock_study_group_permission(v_group,''schedule'',tg_op<>''DELETE'');end if;';
    else
      v_old:='  perform public.xelay_lock_study_group_permission(v_group_id,v_permission,tg_op<>''DELETE'');';
      v_new:='  if not(tg_table_name=''study_group_schedule'' and tg_op=''UPDATE'' and public.xelay_private_teacher_link_write_allowed(to_jsonb(old),to_jsonb(new))) then perform public.xelay_lock_study_group_permission(v_group_id,v_permission,tg_op<>''DELETE'');end if;';
    end if;
    if v_body is null or (length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then raise exception 'TEACHING_SCHEDULE_GUARD_SOURCE_DRIFT: %',v_sig;end if;
    execute replace(v_body,v_old,v_new);
  end loop;
end $guard_patch$;

create function public.xelay_teaching_schedule_links_save(p_course_id uuid,p_group_id uuid,p_schedule_id uuid,p_expected_updated_at timestamptz,p_links jsonb,p_expected_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_old public.study_group_schedule%rowtype; v_new public.study_group_schedule%rowtype; v_key text;
  v_keys constant text[]:=array['online_url','online_url_secondary','online_url_label','online_url_secondary_label','online_links_extra','conference_id','conference_access_code'];
begin
  v_old:=public.xelay_private_teacher_schedule_lock(p_course_id,p_group_id,p_schedule_id,p_expected_user_id);
  if p_expected_updated_at is null or v_old.updated_at is distinct from p_expected_updated_at then
    raise exception 'TEACHING_SCHEDULE_CONFLICT' using errcode='PT409'; end if;
  if p_links is null or jsonb_typeof(p_links)<>'object' or octet_length(p_links::text)>50000
    or exists(select 1 from jsonb_object_keys(p_links) k where not(k=any(v_keys))) then
    raise exception 'TEACHING_SCHEDULE_LINKS_INVALID' using errcode='22023'; end if;
  foreach v_key in array v_keys loop
    if v_key<>'online_links_extra' and p_links ? v_key and jsonb_typeof(p_links->v_key) not in('string','null') then
      raise exception 'TEACHING_SCHEDULE_LINKS_INVALID' using errcode='22023'; end if;
  end loop;
  select * into v_new from jsonb_populate_record(v_old,p_links);
  if exists(select 1 from unnest(array[v_new.online_url,v_new.online_url_secondary]) u
    where u is not null and (char_length(u)>2000 or u!~* '^https?://[^[:space:]/?#@:]+(:[0-9]+)?([/?#][^[:space:]]*)?$' or u~'[[:cntrl:]]' or u~U&'[\0080-\009F\202A-\202E\2066-\2069]')) then
    raise exception 'TEACHING_SCHEDULE_LINKS_INVALID' using errcode='22023'; end if;
  if exists(select 1 from unnest(array[v_new.online_url_label,v_new.online_url_secondary_label]) label where char_length(label)>80 or label~'[[:cntrl:]]' or label~U&'[\0080-\009F\202A-\202E\2066-\2069]')
    or exists(select 1 from unnest(array[v_new.conference_id,v_new.conference_access_code]) field where char_length(field)>120 or field~'[[:cntrl:]]' or field~U&'[\0080-\009F\202A-\202E\2066-\2069]') then
    raise exception 'TEACHING_SCHEDULE_LINKS_INVALID' using errcode='22023'; end if;
  v_new.online_url:=nullif(btrim(v_new.online_url),'');v_new.online_url_secondary:=nullif(btrim(v_new.online_url_secondary),'');
  v_new.online_url_label:=nullif(btrim(v_new.online_url_label),'');v_new.online_url_secondary_label:=nullif(btrim(v_new.online_url_secondary_label),'');
  v_new.conference_id:=nullif(btrim(v_new.conference_id),'');v_new.conference_access_code:=nullif(btrim(v_new.conference_access_code),'');
  v_new.online_links_extra:=public.xelay_normalize_schedule_extra_links(v_new.online_links_extra);
  insert into public.teaching_schedule_link_write_context(backend_pid,transaction_id,user_id,course_id,group_id,schedule_id,before_snapshot,after_links)
    select pg_backend_pid(),txid_current(),p_expected_user_id,p_course_id,p_group_id,p_schedule_id,to_jsonb(v_old),(select jsonb_object_agg(k,to_jsonb(v_new)->k) from unnest(v_keys)k);
  update public.study_group_schedule set online_url=nullif(btrim(v_new.online_url),''),online_url_secondary=nullif(btrim(v_new.online_url_secondary),''),
    online_url_label=v_new.online_url_label,online_url_secondary_label=v_new.online_url_secondary_label,online_links_extra=v_new.online_links_extra,
    conference_id=v_new.conference_id,conference_access_code=v_new.conference_access_code,inherit_source_links=false,updated_at=clock_timestamp()
    where id=p_schedule_id and group_id=p_group_id returning * into v_new;
  delete from public.teaching_schedule_link_write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and user_id=p_expected_user_id;
  insert into public.teaching_schedule_link_audit(schedule_id,course_id,group_id,changed_by,before_links,after_links)
    select p_schedule_id,p_course_id,p_group_id,p_expected_user_id,
      (select jsonb_object_agg(k,to_jsonb(v_old)->k) from unnest(v_keys)k),
      (select jsonb_object_agg(k,to_jsonb(v_new)->k) from unnest(v_keys)k);
  return jsonb_build_object('saved',true,'updated_at',v_new.updated_at);
end $$;
revoke all on function public.xelay_teaching_schedule_links_save(uuid,uuid,uuid,timestamptz,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_schedule_links_save(uuid,uuid,uuid,timestamptz,jsonb,uuid) to authenticated;

create function public.xelay_teaching_schedule_change_request(p_course_id uuid,p_group_id uuid,p_schedule_id uuid,p_lesson_date date,p_expected_updated_at timestamptz,p_change jsonb,p_expected_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_old public.study_group_schedule%rowtype;v_id uuid;v_kind text;v_date date;v_start time;v_end time;v_reason text;
begin
  v_old:=public.xelay_private_teacher_schedule_lock(p_course_id,p_group_id,p_schedule_id,p_expected_user_id);
  if p_expected_updated_at is null or v_old.updated_at is distinct from p_expected_updated_at then raise exception 'TEACHING_SCHEDULE_CONFLICT' using errcode='PT409'; end if;
  if p_change is null or jsonb_typeof(p_change)<>'object' or octet_length(p_change::text)>6000
    or exists(select 1 from jsonb_object_keys(p_change) k where k not in('kind','date','starts_at','ends_at','reason')) then
    raise exception 'TEACHING_SCHEDULE_CHANGE_INVALID' using errcode='22023'; end if;
  v_kind:=p_change->>'kind';v_reason:=btrim(p_change->>'reason');
  if p_lesson_date is null or not isfinite(p_lesson_date) or p_lesson_date<(clock_timestamp() at time zone 'Europe/Kyiv')::date
    or not public.xelay_schedule_occurs_on_date(v_old.weekday,v_old.valid_from,v_old.valid_until,v_old.week_pattern,v_old.week_anchor_date,p_lesson_date)
    or not exists(select 1 from public.teaching_courses c where c.id=p_course_id and p_lesson_date between c.starts_on and c.ends_on)
    or p_lesson_date=any(v_old.excluded_dates) or v_kind is null or v_kind not in('move','cancel') or v_reason is null or char_length(v_reason) not between 1 and 1000 then
    raise exception 'TEACHING_SCHEDULE_CHANGE_INVALID' using errcode='22023'; end if;
  if v_kind='move' then
    v_date:=(p_change->>'date')::date;v_start:=(p_change->>'starts_at')::time;v_end:=(p_change->>'ends_at')::time;
    if v_date is null or not isfinite(v_date) or v_date not between greatest(v_old.valid_from,(clock_timestamp() at time zone 'Europe/Kyiv')::date) and v_old.valid_until
      or not exists(select 1 from public.teaching_courses c where c.id=p_course_id and v_date between c.starts_on and c.ends_on)
      or v_start is null or v_end is null or v_end<=v_start or v_start>=time'24:00' or v_end>=time'24:00'
      or(v_date=p_lesson_date and v_start=v_old.starts_at and v_end=v_old.ends_at) then
      raise exception 'TEACHING_SCHEDULE_CHANGE_INVALID' using errcode='22023'; end if;
  end if;
  insert into public.teaching_schedule_change_requests(course_id,group_id,schedule_id,requested_by,lesson_date,change_kind,proposed_date,proposed_start,proposed_end,reason,before_snapshot)
    values(p_course_id,p_group_id,p_schedule_id,p_expected_user_id,p_lesson_date,v_kind,v_date,v_start,v_end,v_reason,to_jsonb(v_old)) returning id into v_id;
  return jsonb_build_object('id',v_id,'status','pending');
exception when unique_violation then raise exception 'TEACHING_SCHEDULE_REQUEST_EXISTS' using errcode='PT409';
end $$;
revoke all on function public.xelay_teaching_schedule_change_request(uuid,uuid,uuid,date,timestamptz,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_schedule_change_request(uuid,uuid,uuid,date,timestamptz,jsonb,uuid) to authenticated;

create function public.xelay_private_schedule_reviewer(p_group_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and (exists(select 1 from public.study_groups where id=p_group_id and representative_id=auth.uid())
    or exists(select 1 from public.study_group_deputy_requests d join public.study_group_members m on m.group_id=d.group_id and m.user_id=d.user_id and m.status='accepted'
      where d.group_id=p_group_id and d.user_id=auth.uid() and d.status='approved' and 'schedule'=any(d.permissions)));
$$;
revoke all on function public.xelay_private_schedule_reviewer(uuid) from public,anon,authenticated,service_role;

create function public.xelay_teaching_schedule_requests(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform public.xelay_teaching_assert_user();
  if not public.xelay_private_schedule_reviewer(p_group_id) then raise exception 'STUDY_GROUP_PERMISSION_REQUIRED' using errcode='42501'; end if;
  return jsonb_build_object('requests',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at) from(
    select q.id,q.schedule_id,q.course_id,c.title course_title,p.full_name teacher_name,q.lesson_date,q.change_kind,q.proposed_date,
      q.proposed_start,q.proposed_end,q.reason,q.status,q.created_at,q.before_snapshot->>'subject' subject,
      q.before_snapshot->>'starts_at' original_start,q.before_snapshot->>'ends_at' original_end
      from public.teaching_schedule_change_requests q join public.teaching_courses c on c.id=q.course_id join public.profiles p on p.id=q.requested_by
      where q.group_id=p_group_id and q.status='pending' order by q.created_at limit 100)r),'[]'::jsonb));
end $$;
revoke all on function public.xelay_teaching_schedule_requests(uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_schedule_requests(uuid) to authenticated;

create function public.xelay_teaching_schedule_change_review(p_request_id uuid,p_approve boolean,p_expected_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();q public.teaching_schedule_change_requests%rowtype;v_old public.study_group_schedule%rowtype;v_new public.study_group_schedule%rowtype;v_group uuid;
begin
  if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501'; end if;
  select group_id into v_group from public.teaching_schedule_change_requests where id=p_request_id;
  if v_group is null or not public.xelay_private_schedule_reviewer(v_group) then raise exception 'STUDY_GROUP_PERMISSION_REQUIRED' using errcode='42501'; end if;
  perform public.xelay_lock_study_group_permission(v_group,'schedule',true);
  select * into q from public.teaching_schedule_change_requests where id=p_request_id for update;
  if q.status<>'pending' or p_approve is null then raise exception 'TEACHING_SCHEDULE_CONFLICT' using errcode='PT409'; end if;
  if p_approve then
    perform 1 from public.teaching_courses where id=q.course_id for update;
    select * into v_old from public.study_group_schedule where id=q.schedule_id and group_id=q.group_id for update;
    if not found or to_jsonb(v_old) is distinct from q.before_snapshot
      or q.lesson_date<(clock_timestamp() at time zone 'Europe/Kyiv')::date
      or not public.xelay_private_teacher_owns_schedule(q.requested_by,q.course_id,q.group_id,q.schedule_id) then
      update public.teaching_schedule_change_requests set status='stale',reviewed_at=clock_timestamp(),reviewed_by=v_uid where id=q.id;
      return jsonb_build_object('id',q.id,'status','stale');
    end if;
    if q.change_kind='move' then
      if q.proposed_date<(clock_timestamp() at time zone 'Europe/Kyiv')::date then raise exception 'TEACHING_SCHEDULE_CHANGE_INVALID' using errcode='22023'; end if;
      if exists(select 1 from public.study_group_schedule s where s.group_id=q.group_id
        and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,q.proposed_date)
        and not(q.proposed_date=any(s.excluded_dates)) and s.starts_at<q.proposed_end and s.ends_at>q.proposed_start
        and not(s.id=q.schedule_id and q.proposed_date=q.lesson_date)) then
        raise exception 'TEACHING_SCHEDULE_OVERLAP' using errcode='PT409'; end if;
      -- A single-occurrence replacement preserves the original series, all old
      -- homework, submissions, journal columns and published grades unchanged.
      v_new:=v_old;v_new.id:=gen_random_uuid();v_new.weekday:=extract(isodow from q.proposed_date);
      v_new.starts_at:=q.proposed_start;v_new.ends_at:=q.proposed_end;v_new.valid_from:=q.proposed_date;v_new.valid_until:=q.proposed_date;
      v_new.week_pattern:='every';v_new.week_anchor_date:=null;v_new.excluded_dates:='{}';v_new.created_by:=v_uid;
      v_new.created_at:=clock_timestamp();v_new.updated_at:=clock_timestamp();v_new.copied_from_schedule_id:=null;v_new.inherit_source_links:=false;
      insert into public.study_group_schedule select (v_new).*;
    end if;
    perform public.xelay_cancel_study_group_schedule_occurrence(q.group_id,q.schedule_id,q.lesson_date);
  end if;
  update public.teaching_schedule_change_requests set status=case when p_approve then 'approved' else 'rejected' end,
    reviewed_at=clock_timestamp(),reviewed_by=v_uid,replacement_id=case when q.change_kind='move' and p_approve then v_new.id else null end where id=q.id;
  return jsonb_build_object('id',q.id,'status',case when p_approve then 'approved' else 'rejected' end,'replacement_id',case when p_approve then v_new.id else null end);
end $$;
revoke all on function public.xelay_teaching_schedule_change_review(uuid,boolean,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_schedule_change_review(uuid,boolean,uuid) to authenticated;

alter function public.xelay_teaching_calendar(date,date) rename to xelay_private_calendar_before_schedule_edits_20261116;
revoke all on function public.xelay_private_calendar_before_schedule_edits_20261116(date,date) from public,anon,authenticated,service_role;
create function public.xelay_teaching_calendar(p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_calendar jsonb;v_lessons jsonb;
begin
  v_calendar:=public.xelay_private_calendar_before_schedule_edits_20261116(p_from,p_to);
  select coalesce(jsonb_agg(l.value||jsonb_build_object('schedule_updated_at',s.updated_at,
    'online_url_label',s.online_url_label,'online_url_secondary_label',s.online_url_secondary_label,
    'can_edit_schedule',public.xelay_private_teacher_owns_schedule(v_uid,(l.value->>'course_id')::uuid,(l.value->>'group_id')::uuid,s.id),
    'schedule_change_status',(select q.status from public.teaching_schedule_change_requests q where q.schedule_id=s.id and q.lesson_date=(l.value->>'lesson_date')::date and q.requested_by=v_uid order by q.created_at desc limit 1)) order by l.ordinality),'[]'::jsonb)
    into v_lessons from jsonb_array_elements(v_calendar->'lessons') with ordinality l(value,ordinality)
    left join public.study_group_schedule s on s.id=(l.value->>'id')::uuid and s.group_id=(l.value->>'group_id')::uuid and l.value->>'source'='timetable';
  return v_calendar||jsonb_build_object('lessons',v_lessons);
end $$;
revoke all on function public.xelay_teaching_calendar(date,date) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_calendar(date,date) to authenticated;
notify pgrst,'reload schema';
commit;
