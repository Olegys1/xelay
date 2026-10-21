-- Bind teacher homework to an explicit occurrence of the group's timetable.
-- Preserve the canonical teaching item, student submissions and grade pipeline.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if to_regclass('public.teaching_item_targets') is null
    or to_regclass('public.study_group_schedule') is null
    or to_regprocedure('public.xelay_classroom_assignment_mutate(text,jsonb)') is null
    or to_regprocedure('public.xelay_teaching_mutate(text,jsonb)') is null
    or to_regprocedure('public.xelay_group_teacher_materials(uuid)') is null
    or to_regprocedure('public.xelay_academic_subject_key(text)') is null
    or to_regprocedure('public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date)') is null
    or not exists(select 1 from pg_attribute where attrelid='public.teaching_items'::regclass
      and attname='withdrawn_at' and not attisdropped)
    or not exists(select 1 from pg_attribute where attrelid='public.study_group_schedule'::regclass
      and attname='excluded_dates' and not attisdropped) then
    raise exception 'Apply classroom, timetable occurrence and teacher material migrations through 202610210001 first';
  end if;
end $$;

alter table public.teaching_item_targets
  add column if not exists lesson_date date,
  add column if not exists schedule_item_id uuid,
  add column if not exists placement_mode text;
create unique index if not exists study_group_schedule_id_group_uidx
  on public.study_group_schedule(id,group_id);
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.teaching_item_targets'::regclass
    and conname='teaching_target_lesson_date_valid') then
    alter table public.teaching_item_targets add constraint teaching_target_lesson_date_valid
      check(lesson_date is null or(isfinite(lesson_date) and lesson_date between date '1900-01-01' and date '2200-12-31'));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.teaching_item_targets'::regclass
    and conname='teaching_target_slot_has_date') then
    alter table public.teaching_item_targets add constraint teaching_target_slot_has_date
      check(schedule_item_id is null or lesson_date is not null);
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.teaching_item_targets'::regclass
    and conname='teaching_target_placement_mode_valid') then
    alter table public.teaching_item_targets add constraint teaching_target_placement_mode_valid
      check(placement_mode is null or placement_mode in('lesson','unplaced'));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.teaching_item_targets'::regclass
    and conname='teaching_target_unplaced_has_no_slot') then
    alter table public.teaching_item_targets add constraint teaching_target_unplaced_has_no_slot
      check(placement_mode is distinct from 'unplaced' or schedule_item_id is null);
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.teaching_item_targets'::regclass
    and conname='teaching_target_timetable_slot_group_fkey') then
    alter table public.teaching_item_targets add constraint teaching_target_timetable_slot_group_fkey
      foreign key(schedule_item_id,group_id) references public.study_group_schedule(id,group_id)
      on delete set null(schedule_item_id);
  end if;
end $$;
create index if not exists teaching_item_targets_group_lesson_idx
  on public.teaching_item_targets(group_id,lesson_date,schedule_item_id,item_id);

-- A timetable edit can invalidate placement, but cannot remove a teacher source,
-- a target's calendar date, a student's submitted work or any assessment data.
-- Legacy targets stay NULL/NULL; no date is inferred from deadline or title.
create or replace function public.xelay_private_assert_teaching_assignment_lesson(
  p_course_id uuid,p_group_id uuid,p_lesson_date date,p_schedule_item_id uuid,p_placement_mode text,p_due_at timestamptz
)
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_subject text;v_starts date;v_ends date;
begin
  if p_placement_mode is null or p_placement_mode not in('lesson','unplaced') then
    raise exception 'TEACHING_ASSIGNMENT_PLACEMENT_REQUIRED' using errcode='22023'; end if;
  if p_lesson_date is not null and(not isfinite(p_lesson_date)
    or p_lesson_date not between date '1900-01-01' and date '2200-12-31') then
    raise exception 'TEACHING_ASSIGNMENT_LESSON_INVALID' using errcode='22023'; end if;
  -- Callers already hold the course lock. Serialize timetable/subject checks
  -- with the existing group schedule writers before touching target rows.
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||p_group_id::text,0));
  select s.name,c.starts_on,c.ends_on into v_subject,v_starts,v_ends
    from public.teaching_course_groups l join public.teaching_courses c on c.id=l.course_id
    left join public.study_group_seminar_subjects s on s.id=l.subject_id and s.group_id=l.group_id
    where l.course_id=p_course_id and l.group_id=p_group_id and l.status='accepted';
  if not found then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  if p_placement_mode='unplaced' then
    if p_schedule_item_id is not null or(p_lesson_date is null and p_due_at is null)
      or(p_lesson_date is not null and p_lesson_date not between v_starts and v_ends)
      or(p_due_at is not null and not isfinite(p_due_at)) then
      raise exception 'TEACHING_ASSIGNMENT_LESSON_INVALID' using errcode='22023'; end if;
    return;
  end if;
  if p_lesson_date is null or p_schedule_item_id is null then
    raise exception 'TEACHING_ASSIGNMENT_LESSON_REQUIRED' using errcode='22023'; end if;
  if v_subject is null then raise exception 'TEACHING_ASSIGNMENT_SUBJECT_REQUIRED' using errcode='22023'; end if;
  if p_lesson_date not between v_starts and v_ends or not exists(
    select 1 from public.study_group_schedule s where s.id=p_schedule_item_id and s.group_id=p_group_id
      and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(v_subject)
      and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,
        s.week_pattern,s.week_anchor_date,p_lesson_date)
      and not(p_lesson_date=any(s.excluded_dates))
  ) then raise exception 'TEACHING_ASSIGNMENT_LESSON_INVALID' using errcode='22023'; end if;
end $$;
revoke all on function public.xelay_private_assert_teaching_assignment_lesson(uuid,uuid,date,uuid,text,timestamptz)
  from public,anon,authenticated,service_role;

-- Teacher picker: only timetable occurrences for this accepted course/group's
-- explicitly selected subject. Multiple slots are returned for an explicit pick.
create or replace function public.xelay_teaching_assignment_lessons(
  p_course_id uuid,p_group_id uuid,p_lesson_date date
)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_subject text;v_starts date;v_ends date;
begin
  if not 'assignments'=any(public.xelay_teaching_permissions(p_course_id,v_uid)) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  select s.name,c.starts_on,c.ends_on into v_subject,v_starts,v_ends
    from public.teaching_course_groups l join public.teaching_courses c on c.id=l.course_id
    left join public.study_group_seminar_subjects s on s.id=l.subject_id and s.group_id=l.group_id
    where l.course_id=p_course_id and l.group_id=p_group_id and l.status='accepted';
  if not found then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  if v_subject is null then raise exception 'TEACHING_ASSIGNMENT_SUBJECT_REQUIRED' using errcode='22023'; end if;
  if p_lesson_date is null or not isfinite(p_lesson_date)
    or p_lesson_date not between v_starts and v_ends then
    raise exception 'TEACHING_ASSIGNMENT_LESSON_INVALID' using errcode='22023'; end if;
  return jsonb_build_object('subject_name',v_subject,'lessons',coalesce((
    select jsonb_agg(to_jsonb(s) order by s.starts_at,s.ends_at,s.id)
    from public.study_group_schedule s where s.group_id=p_group_id
      and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(v_subject)
      and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,
        s.week_pattern,s.week_anchor_date,p_lesson_date)
      and not(p_lesson_date=any(s.excluded_dates))
  ),'[]'::jsonb));
end $$;

create or replace function public.xelay_group_teacher_assignments(p_group_id uuid,p_lesson_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();
begin
  if not public.xelay_teaching_is_member(p_group_id,v_uid) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  if p_lesson_date is null or not isfinite(p_lesson_date)
    or p_lesson_date not between date '1900-01-01' and date '2200-12-31' then
    raise exception 'TEACHING_ASSIGNMENT_LESSON_INVALID' using errcode='22023'; end if;
  return jsonb_build_object('assignments',coalesce((select jsonb_agg(
    public.xelay_teaching_item_json(i,p_group_id)||jsonb_build_object(
      'source','teacher','source_item_id',i.id,'read_only',true,'group_id',p_group_id,
      'subject_id',l.subject_id,'subject_name',coalesce(s.name,c.title),'course_title',c.title,
      'course_archived_at',c.archived_at,'lesson_date',t.lesson_date,'schedule_item_id',t.schedule_item_id,
      'placement_mode',t.placement_mode,
      'author_verified',public.xelay_teaching_is_verified(i.created_by))
    order by t.lesson_date nulls last,i.created_at desc,i.id)
    from public.teaching_items i join public.teaching_item_targets t on t.item_id=i.id and t.group_id=p_group_id
    join public.teaching_course_groups l on l.course_id=i.course_id and l.group_id=p_group_id and l.status='accepted'
    join public.teaching_courses c on c.id=i.course_id
    left join public.study_group_seminar_subjects s on s.id=l.subject_id and s.group_id=p_group_id
    where i.kind='assignment' and i.status='published' and i.withdrawn_at is null
      and(t.lesson_date=p_lesson_date or(t.lesson_date is null and(
        t.placement_mode is null or t.due_at is null or(t.due_at at time zone 'Europe/Kyiv')::date=p_lesson_date)))
  ),'[]'::jsonb));
end $$;
revoke all on function public.xelay_teaching_assignment_lessons(uuid,uuid,date),public.xelay_group_teacher_assignments(uuid,date)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_assignment_lessons(uuid,uuid,date),public.xelay_group_teacher_assignments(uuid,date)
  to authenticated;

-- Extend audience metadata in every teaching view, retaining material receipt
-- redaction and the exact existing audience visibility rules from 202610210001.
create or replace function public.xelay_teaching_item_json(p_item public.teaching_items,p_group uuid default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select(to_jsonb(p_item)-case when p_item.created_by is distinct from auth.uid()
      then array['rights_accepted_by','rights_accepted_at','rights_terms_version']::text[] else '{}'::text[] end)
    ||jsonb_build_object('author_name',(select full_name from public.profiles where id=p_item.created_by),
      'course_title',(select title from public.teaching_courses where id=p_item.course_id),
      'targets',coalesce((select jsonb_agg(jsonb_build_object('group_id',t.group_id,'due_at',t.due_at,
        'lesson_date',t.lesson_date,'schedule_item_id',t.schedule_item_id,'placement_mode',t.placement_mode) order by t.group_id)
        from public.teaching_item_targets t where t.item_id=p_item.id and(p_group is null or t.group_id=p_group)
          and(cardinality(public.xelay_teaching_permissions(p_item.course_id,auth.uid()))>0
            or public.xelay_teaching_is_member(t.group_id,auth.uid()))),'[]'::jsonb));
$$;

do $assignment_lesson_contract$
declare v_body text;v_old text;v_new text;v_old_count integer;v_new_count integer;v_patch record;
begin
  select pg_get_functiondef('public.xelay_teaching_mutate(text,jsonb)'::regprocedure) into v_body;
  for v_patch in select * from(values
    ($old$for v_target in select value from jsonb_array_elements(p_payload->'targets') loop$old$,
     $new$for v_target in select value from jsonb_array_elements(p_payload->'targets') order by value->>'group_id' loop$new$),
    ($old$and l.group_id=(v_target->>'group_id')::uuid and l.status='accepted') then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;$old$,
     $new$and l.group_id=(v_target->>'group_id')::uuid and l.status='accepted') then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
      -- teacher_assignment_explicit_lesson_contract
      if v_kind='assignment' and(v_status='published' or nullif(v_target->>'schedule_item_id','') is not null) then
        perform public.xelay_private_assert_teaching_assignment_lesson(v_course_id,(v_target->>'group_id')::uuid,
          nullif(v_target->>'lesson_date','')::date,nullif(v_target->>'schedule_item_id','')::uuid,
          nullif(v_target->>'placement_mode',''),nullif(v_target->>'due_at','')::timestamptz);
      end if;$new$),
    ($old$insert into public.teaching_item_targets(item_id,group_id,due_at)
      select v_record.id,(value->>'group_id')::uuid,nullif(value->>'due_at','')::timestamptz from jsonb_array_elements(p_payload->'targets');$old$,
     $new$insert into public.teaching_item_targets(item_id,group_id,due_at,lesson_date,schedule_item_id,placement_mode)
      select v_record.id,(value->>'group_id')::uuid,nullif(value->>'due_at','')::timestamptz,
        case when v_kind='assignment' then nullif(value->>'lesson_date','')::date end,
        case when v_kind='assignment' then nullif(value->>'schedule_item_id','')::uuid end,
        case when v_kind='assignment' then nullif(value->>'placement_mode','') end
      from jsonb_array_elements(p_payload->'targets');$new$)
  ) as patches(old_body,new_body) loop
    v_old:=v_patch.old_body;v_new:=v_patch.new_body;
    v_old_count:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
    v_new_count:=(length(v_body)-length(replace(v_body,v_new,'')))/length(v_new);
    if v_new_count=1 and v_old_count=(length(v_new)-length(replace(v_new,v_old,'')))/length(v_old) then continue; end if;
    if v_old_count<>1 or v_new_count<>0 then raise exception 'TEACHER_ASSIGNMENT_MUTATION_PREREQUISITE'; end if;
    v_body:=replace(v_body,v_old,v_new);
  end loop;
  execute v_body;

  select pg_get_functiondef('public.xelay_classroom_assignment_mutate(text,jsonb)'::regprocedure) into v_body;
  for v_patch in select * from(values
    ($old$perform public.xelay_classroom_lock_group(v_course_id,v_group,'assignments');
    v_payload:=p_payload-'source_item_id'-'source_version';$old$,
     $new$-- Lock course -> group timetable -> course/group link -> item/targets.
    -- A selected-subject deletion may also update the course/group link FK;
    -- never hold that link while waiting for the timetable writer's group lock.
    perform public.xelay_teaching_lock_course(v_course_id,'assignments');
    perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||v_group::text,0));
    perform public.xelay_classroom_lock_group(v_course_id,v_group,'assignments');
    v_payload:=p_payload-'source_item_id'-'source_version';$new$),
    ($old$insert into public.teaching_item_targets(item_id,group_id,due_at)
        select v_id,group_id,due_at from public.teaching_item_targets where item_id=v_source.id and group_id=v_group;$old$,
     $new$insert into public.teaching_item_targets(item_id,group_id,due_at,lesson_date,schedule_item_id,placement_mode)
        select v_id,group_id,due_at,lesson_date,schedule_item_id,placement_mode from public.teaching_item_targets
        where item_id=v_source.id and group_id=v_group;$new$)
  ) as patches(old_body,new_body) loop
    v_old:=v_patch.old_body;v_new:=v_patch.new_body;
    v_old_count:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
    v_new_count:=(length(v_body)-length(replace(v_body,v_new,'')))/length(v_new);
    if v_new_count=1 and v_old_count=(length(v_new)-length(replace(v_new,v_old,'')))/length(v_old) then continue; end if;
    if v_old_count<>1 or v_new_count<>0 then raise exception 'TEACHER_ASSIGNMENT_CLASSROOM_PREREQUISITE'; end if;
    v_body:=replace(v_body,v_old,v_new);
  end loop;
  execute v_body;
end $assignment_lesson_contract$;

comment on column public.teaching_item_targets.lesson_date is
  'Explicit timetable occurrence date chosen for this group. Independent of due_at. Legacy rows remain unbound; the date survives timetable slot deletion.';
comment on column public.teaching_item_targets.schedule_item_id is
  'Selected ordinary study_group_schedule slot in the same group, validated against course subject and occurrence on assignment publication. Deletion clears only this FK, preserving the source and student work.';
comment on column public.teaching_item_targets.placement_mode is
  'Publisher explicitly chooses lesson (strict timetable binding) or unplaced (standalone date/deadline); NULL identifies legacy/unconfigured targets. No timetable binding is inferred from a deadline.';
comment on function public.xelay_group_teacher_assignments(uuid,date) is
  'Accepted-member-only source projection for a selected day, plus unbound legacy publications. Invalidated timetable placement is returned rather than silently discarded; no ordinary homework or seminar rows are written.';

notify pgrst, 'reload schema';
commit;
