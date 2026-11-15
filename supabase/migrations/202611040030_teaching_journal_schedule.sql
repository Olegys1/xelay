-- Local preparation only. Schedule occurrences add durable journal columns;
-- moving/removing a lesson never deletes or moves an existing grade.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.teaching_activities
  add column schedule_item_id uuid,
  add column schedule_lesson_date date,
  add column schedule_starts_at time,
  add column schedule_ends_at time,
  add column schedule_lesson_type text,
  add column schedule_missing boolean not null default false,
  add column schedule_default_max_points boolean not null default false,
  add constraint teaching_activity_schedule_metadata_valid check(
    (schedule_item_id is null and schedule_lesson_date is null and schedule_starts_at is null
      and schedule_ends_at is null and schedule_lesson_type is null)
    or(schedule_item_id is not null and schedule_lesson_date is not null and isfinite(schedule_lesson_date)
      and schedule_starts_at is not null and schedule_ends_at is not null and schedule_ends_at>schedule_starts_at
      and schedule_lesson_type is not null and length(schedule_lesson_type)<=50));
-- There is intentionally no FK to the timetable: historical grades survive a
-- timetable row being removed or replaced with a new ID.
create unique index teaching_activity_schedule_occurrence_unique
  on public.teaching_activities(course_id,group_id,schedule_item_id,schedule_lesson_date)
  where schedule_item_id is not null;

create function public.xelay_teaching_sync_journal_schedule(
  p_course_id uuid,p_group_id uuid,p_from date,p_to date,p_expected_user_id uuid
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_uid uuid:=public.xelay_teaching_assert_user();v_course public.teaching_courses%rowtype;
  v_subject text;v_from date;v_to date;v_lesson record;v_existing public.teaching_activities%rowtype;
  v_rules jsonb;v_preset jsonb;v_work_type text;v_category text;v_max numeric;
  v_matches uuid[];v_seen uuid[]:='{}';v_count integer:=0;
  v_created integer:=0;v_linked integer:=0;v_updated integer:=0;v_retained integer:=0;
  v_represented integer:=0;v_defaulted integer:=0;
begin
  if p_expected_user_id is distinct from v_uid then
    raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_to<p_from or p_to-p_from>366 then
    raise exception 'TEACHING_JOURNAL_RANGE_INVALID' using errcode='22023';end if;
  perform public.xelay_private_assert_teaching_group(p_course_id,p_group_id,'grades');
  select * into v_course from public.teaching_courses where id=p_course_id;
  select coalesce(s.name,v_course.title) into v_subject from public.teaching_course_groups g
    left join public.study_group_seminar_subjects s on s.id=g.subject_id and s.group_id=g.group_id
    where g.course_id=p_course_id and g.group_id=p_group_id and g.status='accepted' for update of g;
  if not found then raise exception 'TEACHING_GROUP_FORBIDDEN' using errcode='42501';end if;
  v_from:=greatest(p_from,v_course.starts_on);v_to:=least(p_to,v_course.ends_on);
  if v_to<v_from then return jsonb_build_object('created',0,'linked',0,'updated',0,'retained',0,'represented',0,'defaulted',0,'default_max_points',5);end if;
  v_rules:=public.xelay_private_teaching_group_rules(p_course_id,p_group_id);
  -- Same current timetable projection as the teacher calendar: this does not
  -- manufacture lessons from independent student seminar planning.
  for v_lesson in
    select s.id,s.lesson_type,s.starts_at,s.ends_at,d.lesson_date
      from public.study_group_schedule s cross join lateral(
        select v_from+n lesson_date from generate_series(0,v_to-v_from) n) d
      where s.group_id=p_group_id
        and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(v_subject)
        and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,d.lesson_date)
        and not(d.lesson_date=any(s.excluded_dates))
      order by d.lesson_date,s.starts_at,s.id limit 1001
  loop
    v_count:=v_count+1;
    if v_count>1000 then raise exception 'TEACHING_CALENDAR_TOO_LARGE' using errcode='22023';end if;
    select * into v_existing from public.teaching_activities a
      where a.course_id=p_course_id and a.group_id=p_group_id
        and a.schedule_item_id=v_lesson.id and a.schedule_lesson_date=v_lesson.lesson_date for update;
    if not found then
      -- An assessed assignment explicitly bound to this exact occurrence
      -- already supplies a grade column. Do not add a duplicate or guess a
      -- match from a manual title/date. Several bound assignments stay separate.
      select array_agg(a.id order by a.id) into v_matches from public.teaching_activities a
        join public.teaching_item_targets t on t.item_id=a.item_id and t.group_id=a.group_id
        where a.course_id=p_course_id and a.group_id=p_group_id and t.schedule_item_id=v_lesson.id
          and t.lesson_date=v_lesson.lesson_date and t.placement_mode='lesson';
      if cardinality(v_matches)>0 then
        if cardinality(v_matches)=1 then
          select * into v_existing from public.teaching_activities where id=v_matches[1] for update;
          if v_existing.schedule_item_id is null then
            update public.teaching_activities set schedule_item_id=v_lesson.id,schedule_lesson_date=v_lesson.lesson_date,
              schedule_starts_at=v_lesson.starts_at,schedule_ends_at=v_lesson.ends_at,schedule_lesson_type=v_lesson.lesson_type,
              schedule_missing=false,version=version+1 where id=v_existing.id returning * into v_existing;
            v_linked:=v_linked+1;v_represented:=v_represented+1;
          else
            -- The assignment has moved, but its old graded occurrence must
            -- not move with it. Give the new lesson a separate empty column.
            v_existing:=null;
          end if;
        elsif exists(select 1 from public.teaching_activities a where a.id=any(v_matches) and a.schedule_item_id is null) then
          v_represented:=v_represented+1;continue;
        else
          -- All matching works belong to historical occurrences already.
          v_existing:=null;
        end if;
      end if;
      if v_existing.id is null then
        v_work_type:=case v_lesson.lesson_type when 'lecture' then 'Лекція' when 'seminar' then 'Семінар'
          when 'practical' then 'Практичне заняття' when 'lab' then 'Лабораторна робота'
          when 'makeup' then 'Відпрацювання' when 'replacement' then 'Заміна' when 'module' then 'МКР'
          when 'final_assessment' then 'Підсумкова робота' when 'test' then 'Контрольна робота' else 'Заняття' end;
        select value into v_preset from jsonb_array_elements(coalesce(v_rules->'presets','[]'::jsonb))
          where public.xelay_academic_subject_key(value->>'work_type')=public.xelay_academic_subject_key(v_work_type)
          order by value->>'id' limit 1;
        v_max:=coalesce((v_preset->>'max_points')::numeric,5);v_category:=coalesce(v_preset->>'category','');
        if v_preset is null then v_defaulted:=v_defaulted+1;end if;
        insert into public.teaching_activities(course_id,group_id,title,category,work_type,activity_date,max_points,
          schedule_item_id,schedule_lesson_date,schedule_starts_at,schedule_ends_at,schedule_lesson_type,schedule_default_max_points)
          values(p_course_id,p_group_id,left(v_work_type||' · '||v_subject,180),v_category,v_work_type,v_lesson.lesson_date,v_max,
            v_lesson.id,v_lesson.lesson_date,v_lesson.starts_at,v_lesson.ends_at,v_lesson.lesson_type,v_preset is null)
          returning * into v_existing;
        v_created:=v_created+1;
      end if;
    elsif v_existing.schedule_starts_at is distinct from v_lesson.starts_at
      or v_existing.schedule_ends_at is distinct from v_lesson.ends_at
      or v_existing.schedule_lesson_type is distinct from v_lesson.lesson_type or v_existing.schedule_missing then
      -- Only source metadata follows the timetable. A teacher's title, date,
      -- maximum, category, work type and all grades remain exactly as saved.
      update public.teaching_activities set schedule_starts_at=v_lesson.starts_at,schedule_ends_at=v_lesson.ends_at,
        schedule_lesson_type=v_lesson.lesson_type,schedule_missing=false,version=version+1
        where id=v_existing.id returning * into v_existing;
      v_updated:=v_updated+1;
    end if;
    v_seen:=array_append(v_seen,v_existing.id);
  end loop;
  update public.teaching_activities set schedule_missing=true,version=version+1
    where course_id=p_course_id and group_id=p_group_id and schedule_item_id is not null
      and schedule_lesson_date between v_from and v_to and not(id=any(v_seen)) and not schedule_missing;
  get diagnostics v_retained=row_count;
  return jsonb_build_object('created',v_created,'linked',v_linked,'updated',v_updated,'retained',v_retained,
    'represented',v_represented,'defaulted',v_defaulted,'default_max_points',5);
end $$;
revoke all on function public.xelay_teaching_sync_journal_schedule(uuid,uuid,date,date,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_sync_journal_schedule(uuid,uuid,date,date,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
