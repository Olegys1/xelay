-- Enrich the existing scoped, read-only calendar. No queue, notification,
-- student submission, grade or timetable content is changed by this view.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
alter function public.xelay_teaching_calendar(date,date) rename to xelay_private_calendar_before_homework_20261104;
revoke all on function public.xelay_private_calendar_before_homework_20261104(date,date) from public,anon,authenticated,service_role;

create function public.xelay_teaching_calendar(p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_calendar jsonb;v_result jsonb;
begin
  -- The installed calendar retains current verification, semester, scoped
  -- group access, recurrence, excluded dates, limits and personal markers.
  v_calendar:=public.xelay_private_calendar_before_homework_20261104(p_from,p_to);
  select coalesce(jsonb_agg(l.value||jsonb_build_object('homework',h.items,'homework_count',h.total) order by l.ordinality),'[]'::jsonb)
    into v_result from jsonb_array_elements(v_calendar->'lessons') with ordinality l(value,ordinality)
    cross join lateral (
      select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'body',left(x.body,2000),
        'due_at',x.due_at,'source',x.source,'audience_label',x.audience_label,'body_truncated',length(x.body)>2000)
        order by x.sort_order,x.created_at desc,x.id) filter(where x.position<=10),'[]'::jsonb) items,
        count(*) total from (
        select q.*,row_number() over(order by q.sort_order,q.created_at desc,q.id) position from (
          select i.id,i.title,i.body,t.due_at,'teacher'::text source,
            case t.audience_mode when 'subgroups' then 'Для підгрупи' when 'teams' then 'Для команди' else 'Для всієї групи' end audience_label,
            0 sort_order,i.created_at
            from public.teaching_items i join public.teaching_item_targets t on t.item_id=i.id
            where i.course_id=(l.value->>'course_id')::uuid and t.group_id=(l.value->>'group_id')::uuid
              and i.kind='assignment' and i.status='published' and i.withdrawn_at is null
              and t.lesson_date=(l.value->>'lesson_date')::date and t.placement_mode='lesson'
              and (t.schedule_item_id=(l.value->>'id')::uuid or(t.schedule_item_id is null and not exists(
                select 1 from public.study_group_schedule duplicate where duplicate.group_id=t.group_id
                  and duplicate.id<>(l.value->>'id')::uuid
                  and public.xelay_academic_subject_key(duplicate.subject)=public.xelay_academic_subject_key(l.value->>'subject_name')
                  and public.xelay_schedule_occurs_on_date(duplicate.weekday,duplicate.valid_from,duplicate.valid_until,
                    duplicate.week_pattern,duplicate.week_anchor_date,t.lesson_date) and not(t.lesson_date=any(duplicate.excluded_dates)))))
              and public.xelay_teaching_can_read_item(i.id,v_uid)
          union all
          select hw.id,'ДЗ групи',hw.body,null::timestamptz,'group','Для всієї групи',1,hw.created_at
            from public.study_group_homework hw where hw.group_id=(l.value->>'group_id')::uuid
              and hw.schedule_item_id=(l.value->>'id')::uuid and hw.lesson_date=(l.value->>'lesson_date')::date
              and public.xelay_teaching_group_permissions((l.value->>'course_id')::uuid,hw.group_id,v_uid)&&array['assignments','grades']::text[]
        ) q
      ) x
    ) h;
  return v_calendar||jsonb_build_object('lessons',v_result);
end $$;
revoke all on function public.xelay_teaching_calendar(date,date) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_calendar(date,date) to authenticated;
notify pgrst,'reload schema';
commit;
