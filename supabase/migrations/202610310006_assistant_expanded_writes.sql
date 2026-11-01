-- LOCAL PREPARATION ONLY. Extends the existing private draft validator and adds
-- caller/RLS operations; no assistant runtime or model is enabled here.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

alter table public.study_group_homework add column if not exists due_at timestamptz
  constraint study_group_homework_due_at_finite check(due_at is null or isfinite(due_at));
comment on column public.study_group_homework.due_at is 'Optional explicitly chosen group homework deadline; null means no deadline. No inferred student grade or automatic submission closure.';

create or replace function public.xelay_assistant_draft_document_valid(p_document jsonb)
returns boolean language sql immutable security definer set search_path='' as $$
 select p_document is not null and jsonb_typeof(p_document)='object'
   and octet_length(p_document::text)<=180000
   and p_document->>'action' in('schedule.create','schedule.update','schedule.copy','schedule.move','homework.upsert','organizer.task.create',
     'seminar.book','seminar.team.join','seminar.reopen','seminar.prepare','seminar.subject.upsert','seminar.schedule.upsert',
     'teaching.assignment.upsert','teaching.publication.schedule','teaching.grades.save','teaching.grading.save',
     'teaching.material.upsert','teaching.material.visibility','teaching.material.collaborators','teaching.material.ai')
   and jsonb_typeof(p_document->'scope')='object' and jsonb_typeof(p_document->'payload')='object'
   and not(p_document ?| array['id','userId','revision','status','createdAt','expiresAt','receipt','confirmationToken','claimToken'])
   and p_document::text !~* '"(authorization|access_token|refresh_token|password|apiKey|serviceRoleKey|cookie|confirmationToken|claimToken)"[[:space:]]*:'
$$;
revoke all on function public.xelay_assistant_draft_document_valid(jsonb) from public,anon,authenticated,service_role;

-- Keep timetable identity guards and all resource/notification triggers intact.
-- Date changes retain the original cancelled occurrence and its history. A new
-- one-off and a copy of its dated homework are created in the same transaction.
create function public.xelay_assistant_move_schedule(
  p_group_id uuid,p_schedule_id uuid,p_source_date date,p_target_date date,
  p_starts_at text,p_ends_at text,p_expected_updated_at timestamptz,p_new_id uuid
)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='3s' as $$
declare v_uid uuid:=auth.uid();v_old public.study_group_schedule%rowtype;v_new uuid;v_result jsonb;v_homework public.study_group_homework%rowtype;
begin
  if v_uid is null or not coalesce(public.xelay_has_study_group_permission(p_group_id,'schedule'),false) then
    raise exception 'ASSISTANT_SCHEDULE_PERMISSION_REQUIRED' using errcode='42501';end if;
  if p_schedule_id is null or p_new_id is null or p_expected_updated_at is null
    or p_source_date is null or p_target_date is null or not isfinite(p_source_date) or not isfinite(p_target_date)
    or p_target_date not between date'2000-01-01' and date'2099-12-31'
    or p_starts_at is null or p_ends_at is null or p_starts_at !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
    or p_ends_at !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$' or p_starts_at>=p_ends_at then
    raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||p_group_id::text,0));
  if not coalesce(public.xelay_has_study_group_permission(p_group_id,'schedule'),false) then
    raise exception 'ASSISTANT_SCHEDULE_PERMISSION_REQUIRED' using errcode='42501';end if;
  select * into v_old from public.study_group_schedule where id=p_schedule_id and group_id=p_group_id for update;
  if not found or v_old.updated_at is distinct from p_expected_updated_at
    or not public.xelay_schedule_occurs_on_date(v_old.weekday,v_old.valid_from,v_old.valid_until,v_old.week_pattern,v_old.week_anchor_date,p_source_date)
    or p_source_date=any(v_old.excluded_dates) then raise exception 'ASSISTANT_SCHEDULE_SOURCE_CHANGED' using errcode='PT409';end if;
  if exists(select 1 from public.study_group_schedule s where s.group_id=p_group_id
    and not(s.id=p_schedule_id and p_target_date=p_source_date)
    and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,p_target_date)
    and not(p_target_date=any(s.excluded_dates)) and s.starts_at<p_ends_at::time and s.ends_at>p_starts_at::time) then
    raise exception 'ASSISTANT_SCHEDULE_OVERLAP' using errcode='PT409';end if;
  if p_source_date=p_target_date and v_old.valid_from=v_old.valid_until then
    if p_new_id<>p_schedule_id then raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
    update public.study_group_schedule set starts_at=p_starts_at::time,ends_at=p_ends_at::time
      where id=p_schedule_id and group_id=p_group_id and updated_at=p_expected_updated_at;
    if not found then raise exception 'ASSISTANT_SCHEDULE_SOURCE_CHANGED' using errcode='PT409';end if;
    return jsonb_build_object('id',p_schedule_id);
  end if;
  if p_new_id=p_schedule_id then raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  select * into v_homework from public.study_group_homework where group_id=p_group_id and schedule_item_id=p_schedule_id and lesson_date=p_source_date for update;
  if found and not coalesce(public.xelay_has_study_group_permission(p_group_id,'homework'),false) then
    raise exception 'ASSISTANT_HOMEWORK_PERMISSION_REQUIRED' using errcode='42501';end if;
  -- Cancel before insertion when replacing an occurrence on the same day;
  -- rollback restores the original if any later resource/overlap check fails.
  update public.study_group_schedule set excluded_dates=array(select distinct d from unnest(excluded_dates||array[p_source_date]) d order by d)
    where id=p_schedule_id and group_id=p_group_id and updated_at=p_expected_updated_at;
  if not found then raise exception 'ASSISTANT_SCHEDULE_SOURCE_CHANGED' using errcode='PT409';end if;
  v_result:=public.xelay_assistant_create_schedule(jsonb_build_object(
    'id',p_new_id,'group_id',p_group_id,'weekday',extract(isodow from p_target_date)::integer,
    'starts_at',p_starts_at,'ends_at',p_ends_at,'subject',v_old.subject,'teacher_name',coalesce(v_old.teacher_name,''),
    'lesson_type',v_old.lesson_type,'location',coalesce(v_old.location,''),'online_url',v_old.online_url,'online_url_secondary',v_old.online_url_secondary,
    'online_url_label',null,'online_url_secondary_label',null,'online_links_extra',v_old.online_links_extra,
    'conference_id',v_old.conference_id,'conference_access_code',v_old.conference_access_code,
    'valid_from',p_target_date,'valid_until',p_target_date,'week_pattern','every','week_anchor_date',null,'created_by',v_uid));
  if v_homework.id is not null then
    insert into public.study_group_homework(group_id,schedule_item_id,lesson_date,lesson_topic,body,url,resource_links,resource_link_labels,attachments,due_at,created_by)
      values(p_group_id,p_new_id,p_target_date,v_homework.lesson_topic,v_homework.body,v_homework.url,v_homework.resource_links,v_homework.resource_link_labels,v_homework.attachments,v_homework.due_at,v_uid);
  end if;
  update public.study_group_schedule set online_url_label=v_old.online_url_label,online_url_secondary_label=v_old.online_url_secondary_label,
    copied_from_schedule_id=v_old.id,inherit_source_links=true where id=p_new_id and group_id=p_group_id;
  return jsonb_build_object('id',p_new_id);
end $$;
revoke all on function public.xelay_assistant_move_schedule(uuid,uuid,date,date,text,text,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_assistant_move_schedule(uuid,uuid,date,date,text,text,timestamptz,uuid) to authenticated;

-- Reuse the exact fixed-shape/URL/author validation of the existing one-day
-- insert. Expansion happens under the same lock and transaction, before any
-- other caller can observe or race the intermediate one-day row.
create function public.xelay_assistant_create_recurring_schedule(p_values jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='3s' as $$
declare v public.study_group_schedule%rowtype;v_first date;v_result jsonb;v_days integer;
begin
  if p_values is null or jsonb_typeof(p_values)<>'object' then raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  select * into v from jsonb_populate_record(null::public.study_group_schedule,p_values);
  if auth.uid() is null or not coalesce(public.xelay_has_study_group_permission(v.group_id,'schedule'),false) then raise exception 'ASSISTANT_SCHEDULE_PERMISSION_REQUIRED' using errcode='42501';end if;
  if v.valid_from is null or v.valid_until is null or not isfinite(v.valid_from) or not isfinite(v.valid_until)
    or v.valid_from not between date'2000-01-01' and date'2099-12-31' or v.valid_until not between v.valid_from and least(v.valid_from+366,date'2099-12-31')
    or v.weekday is null or v.weekday not between 1 and 7 or v.week_pattern is null or v.week_pattern not in('every','upper','lower')
    or v.week_pattern<>'every' and(v.week_anchor_date is null or not isfinite(v.week_anchor_date)) then raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||v.group_id::text,0));
  select min(d::date) into v_first from generate_series(v.valid_from::timestamp,v.valid_until::timestamp,interval'1 day') d
    where public.xelay_schedule_occurs_on_date(v.weekday,v.valid_from,v.valid_until,v.week_pattern,v.week_anchor_date,d::date);
  if v_first is null then raise exception 'ASSISTANT_SCHEDULE_NO_OCCURRENCES' using errcode='22023';end if;
  if exists(select 1 from public.study_group_schedule s cross join generate_series(v.valid_from::timestamp,v.valid_until::timestamp,interval'1 day') d
    where s.group_id=v.group_id and s.id<>v.id
      and public.xelay_schedule_occurs_on_date(v.weekday,v.valid_from,v.valid_until,v.week_pattern,v.week_anchor_date,d::date)
      and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,d::date)
      and not(d::date=any(s.excluded_dates)) and s.starts_at<v.ends_at and s.ends_at>v.starts_at) then raise exception 'ASSISTANT_SCHEDULE_OVERLAP' using errcode='PT409';end if;
  if exists(select 1 from public.study_group_schedule where id=v.id) then raise exception 'ASSISTANT_SCHEDULE_ID_CONFLICT' using errcode='PT409';end if;
  v_result:=public.xelay_assistant_create_schedule(p_values||jsonb_build_object('valid_from',v_first,'valid_until',v_first,'week_pattern','every','week_anchor_date',null));
  update public.study_group_schedule set valid_from=v.valid_from,valid_until=v.valid_until,week_pattern=v.week_pattern,
    week_anchor_date=case when v.week_pattern='every' then null else v.week_anchor_date end where id=v.id and group_id=v.group_id;
  if not found then raise exception 'ASSISTANT_SCHEDULE_SOURCE_CHANGED' using errcode='PT409';end if;
  return v_result;
end $$;
revoke all on function public.xelay_assistant_create_recurring_schedule(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_assistant_create_recurring_schedule(jsonb) to authenticated;

create function public.xelay_assistant_update_schedule(p_id uuid,p_group_id uuid,p_expected_updated_at timestamptz,p_values jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='3s' as $$
declare v_old public.study_group_schedule%rowtype;v public.study_group_schedule%rowtype;
begin
  if auth.uid() is null or not coalesce(public.xelay_has_study_group_permission(p_group_id,'schedule'),false) then
    raise exception 'ASSISTANT_SCHEDULE_PERMISSION_REQUIRED' using errcode='42501';end if;
  if p_values is null or jsonb_typeof(p_values)<>'object' or octet_length(p_values::text)>70000
    or exists(select 1 from jsonb_object_keys(p_values) k where k not in('group_id','weekday','starts_at','ends_at','subject','teacher_name','lesson_type','location',
      'online_url','online_url_secondary','online_url_label','online_url_secondary_label','online_links_extra','conference_id','conference_access_code',
      'valid_from','valid_until','week_pattern','week_anchor_date','created_by')) then raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||p_group_id::text,0));
  select * into v_old from public.study_group_schedule where id=p_id and group_id=p_group_id for update;
  if not found or v_old.updated_at is distinct from p_expected_updated_at then raise exception 'ASSISTANT_SCHEDULE_SOURCE_CHANGED' using errcode='PT409';end if;
  select * into v from jsonb_populate_record(v_old,p_values);
  if v.group_id<>p_group_id or v.created_by<>v_old.created_by
    or v.valid_from is null or v.valid_until is null or not isfinite(v.valid_from) or not isfinite(v.valid_until)
    or v.valid_from not between date'2000-01-01' and date'2099-12-31' or v.valid_until not between v.valid_from and least(v.valid_from+366,date'2099-12-31')
    or v.weekday is null or v.weekday not between 1 and 7 or v.week_pattern is null or v.week_pattern not in('every','upper','lower')
    or v.week_pattern<>'every' and(v.week_anchor_date is null or not isfinite(v.week_anchor_date))
    or v.starts_at is null or v.ends_at is null or v.starts_at>=v.ends_at or char_length(btrim(v.subject)) not between 1 and 120
    or char_length(v.teacher_name)>180 or char_length(v.location)>160 then raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  if exists(select 1 from public.study_group_schedule s cross join generate_series(v.valid_from::timestamp,v.valid_until::timestamp,interval'1 day') d
    where s.group_id=p_group_id and s.id<>p_id
      and public.xelay_schedule_occurs_on_date(v.weekday,v.valid_from,v.valid_until,v.week_pattern,v.week_anchor_date,d::date) and not(d::date=any(v_old.excluded_dates))
      and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,d::date)
      and not(d::date=any(s.excluded_dates)) and s.starts_at<v.ends_at and s.ends_at>v.starts_at) then raise exception 'ASSISTANT_SCHEDULE_OVERLAP' using errcode='PT409';end if;
  update public.study_group_schedule set starts_at=v.starts_at,ends_at=v.ends_at,subject=v.subject,teacher_name=v.teacher_name,lesson_type=v.lesson_type,location=v.location,
    online_url=v.online_url,online_url_secondary=v.online_url_secondary,online_url_label=v.online_url_label,online_url_secondary_label=v.online_url_secondary_label,
    online_links_extra=v.online_links_extra,conference_id=v.conference_id,conference_access_code=v.conference_access_code,
    weekday=v.weekday,valid_from=v.valid_from,valid_until=v.valid_until,week_pattern=v.week_pattern,week_anchor_date=case when v.week_pattern='every' then null else v.week_anchor_date end
    where id=p_id and group_id=p_group_id and updated_at=p_expected_updated_at;
  if not found then raise exception 'ASSISTANT_SCHEDULE_SOURCE_CHANGED' using errcode='PT409';end if;
  return jsonb_build_object('id',p_id);
end $$;
revoke all on function public.xelay_assistant_update_schedule(uuid,uuid,timestamptz,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_assistant_update_schedule(uuid,uuid,timestamptz,jsonb) to authenticated;

-- Existing seminar commands own all booking/capacity/streak/resource rules.
-- This wrapper only adds a version check while holding their existing group
-- lock, so a confirmed old form cannot overwrite a concurrent editor.
create function public.xelay_assistant_save_seminar(p_action text,p_expected_updated_at timestamptz,p_values jsonb)
returns uuid language plpgsql security invoker set search_path='' set lock_timeout='3s' as $$
declare v_group uuid;v_id uuid;v_stamp timestamptz;v_found boolean;
begin
  if p_values is null or jsonb_typeof(p_values)<>'object' or octet_length(p_values::text)>150000
    or p_action is null or p_action not in('subject','schedule','seminar') then raise exception 'ASSISTANT_SEMINAR_VALUES_INVALID' using errcode='22023';end if;
  v_group:=(p_values->>'p_group_id')::uuid;
  if auth.uid() is null or not coalesce(public.xelay_has_study_group_permission(v_group,'seminars'),false) then raise exception 'ASSISTANT_SEMINAR_PERMISSION_REQUIRED' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||v_group::text,0));
  if p_action='subject' then
    if exists(select 1 from jsonb_object_keys(p_values) k where k not in('p_group_id','p_subject_id','p_name')) then raise exception 'ASSISTANT_SEMINAR_VALUES_INVALID' using errcode='22023';end if;
    v_id:=(p_values->>'p_subject_id')::uuid;
    if v_id is not null then select updated_at into v_stamp from public.study_group_seminar_subjects where id=v_id and group_id=v_group for update;v_found:=found;end if;
  elsif p_action='schedule' then
    if exists(select 1 from jsonb_object_keys(p_values) k where k not in('p_group_id','p_schedule_id','p_subject_id','p_weekday','p_starts_at','p_ends_at','p_valid_from','p_valid_until')) then raise exception 'ASSISTANT_SEMINAR_VALUES_INVALID' using errcode='22023';end if;
    v_id:=(p_values->>'p_schedule_id')::uuid;
    if v_id is not null then select updated_at into v_stamp from public.study_group_seminar_schedule where id=v_id and group_id=v_group for update;v_found:=found;end if;
  else
    if exists(select 1 from jsonb_object_keys(p_values) k where k not in('p_group_id','p_seminar_id','p_schedule_id','p_lesson_date','p_title','p_instructions','p_format','p_questions','p_teams','p_resource_links','p_resource_attachments')) then raise exception 'ASSISTANT_SEMINAR_VALUES_INVALID' using errcode='22023';end if;
    v_id:=(p_values->>'p_seminar_id')::uuid;
    if v_id is not null then select updated_at into v_stamp from public.study_group_seminars where id=v_id and group_id=v_group for update;v_found:=found;end if;
  end if;
  if (v_id is null and p_expected_updated_at is not null) or(v_id is not null and(not coalesce(v_found,false) or p_expected_updated_at is null or p_expected_updated_at is distinct from v_stamp)) then
    raise exception 'ASSISTANT_SEMINAR_CHANGED' using errcode='PT409';end if;
  if p_action='subject' then return public.xelay_save_seminar_subject(v_group,v_id,p_values->>'p_name');end if;
  if p_action='schedule' then return public.xelay_save_seminar_schedule(v_group,v_id,(p_values->>'p_subject_id')::uuid,(p_values->>'p_weekday')::integer,
    (p_values->>'p_starts_at')::time,(p_values->>'p_ends_at')::time,(p_values->>'p_valid_from')::date,(p_values->>'p_valid_until')::date);end if;
  return public.xelay_save_seminar_with_resources(v_group,v_id,(p_values->>'p_schedule_id')::uuid,(p_values->>'p_lesson_date')::date,p_values->>'p_title',p_values->>'p_instructions',p_values->>'p_format',
    p_values->'p_questions',p_values->'p_teams',p_values->'p_resource_links',p_values->'p_resource_attachments');
end $$;
revoke all on function public.xelay_assistant_save_seminar(text,timestamptz,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_assistant_save_seminar(text,timestamptz,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
