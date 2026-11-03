-- Reuse the existing group events and their transaction-level deduplication.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create function public.xelay_private_notify_group_event(
  p_group uuid,p_event text,p_message text,p_tab text,p_actor uuid,p_type text,p_priority text
)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_actor is null or p_group is null or p_type not in('study_group_update','group_homework')
    or p_tab not in('schedule','seminars','timetable','materials')
    or p_priority is null or p_priority not in('normal','urgent') then return; end if;
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,
    study_group_id,academic_event_key,academic_tab,delivery_priority)
  select audience.user_id,p_actor,coalesce(nullif(p.full_name,''),'Xelay'),p_type,left(p_message,1000),false,
    p_group,p_event,p_tab,p_priority
  from(
    select g.representative_id as user_id from public.study_groups g where g.id=p_group
    union
    select m.user_id from public.study_group_members m join public.study_groups g on g.id=m.group_id
      where m.group_id=p_group and m.status='accepted'
  ) audience
  join auth.users u on u.id=audience.user_id and u.deleted_at is null
    and coalesce(u.banned_until,'-infinity'::timestamptz)<=now()
  left join public.profiles p on p.id=p_actor
  where audience.user_id<>p_actor
  order by audience.user_id
  on conflict(recipient_id,academic_event_key) where academic_event_key is not null do nothing;
end $$;
revoke all on function public.xelay_private_notify_group_event(uuid,text,text,text,uuid,text,text)
  from public,anon,authenticated,service_role;

create or replace function public.xelay_private_notify_group_event(
  p_group uuid,p_event text,p_message text,p_tab text,p_actor uuid,p_type text default 'study_group_update'
)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.xelay_private_notify_group_event(p_group,p_event,p_message,p_tab,p_actor,p_type,'normal');
end $$;

create or replace function public.xelay_notify_study_group_homework()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_subject text;
  v_actor uuid:=auth.uid();
  v_message text;
  v_homework public.study_group_homework%rowtype;
  v_urgent boolean:=false;
begin
  if v_actor is null then return null; end if;
  if tg_op='UPDATE' then
    if (to_jsonb(new)-array['updated_at','created_at','created_by'])
      is not distinct from(to_jsonb(old)-array['updated_at','created_at','created_by']) then return null; end if;
    v_urgent:=new.due_at is distinct from old.due_at
      and coalesce(greatest(new.due_at,old.due_at)>statement_timestamp(),false);
  end if;
  if v_urgent is distinct from(tg_argv[0]='urgent') then return null; end if;
  if tg_op='DELETE' then v_homework:=old; else v_homework:=new; end if;
  select subject into v_subject from public.study_group_schedule where id=v_homework.schedule_item_id;
  -- Parent removals already have a timetable event.
  if tg_op='DELETE' and not found then return null; end if;
  v_message:=case when v_urgent and v_homework.due_at is null then 'прибрав(-ла) дедлайн домашнього завдання: '
    when v_urgent then 'змінив(-ла) дедлайн домашнього завдання: '
    else (case when tg_op='INSERT' then 'додав(-ла)' when tg_op='DELETE' then 'видалив(-ла)' else 'оновив(-ла)' end)
      ||' інформацію про заняття: ' end
    ||coalesce(v_subject,'Заняття')||' ('||to_char(v_homework.lesson_date,'DD.MM.YYYY')||')';
  perform public.xelay_private_notify_group_event(v_homework.group_id,
    'academic:homework:'||v_homework.id::text||':'||txid_current()::text,v_message,'schedule',v_actor,'group_homework',
    case when v_urgent then 'urgent' else 'normal' end);
  return null;
end $$;

-- Find the next actual lesson, including alternating weeks and cancellations.
-- A finite search of at most one occurrence per cancelled date plus one more
-- suffices because any row can have at most one occurrence in a 14-day cycle.
create function public.xelay_private_timetable_has_future_occurrence(
  p_item public.study_group_schedule,p_local_now timestamp
)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from (select greatest(p_item.valid_from,p_local_now::date+
      case when p_item.ends_at<=p_local_now::time then 1 else 0 end) as first_date) f
    cross join lateral (select 13+14*cardinality(p_item.excluded_dates) as max_offset) span
    cross join lateral generate_series(0,case
      when not isfinite(f.first_date) or f.first_date>p_item.valid_until then -1
      when isfinite(p_item.valid_until) then least(span.max_offset,p_item.valid_until-f.first_date)
      else span.max_offset end) days(offset_days)
    where public.xelay_schedule_occurs_on_date(p_item.weekday,p_item.valid_from,p_item.valid_until,
      p_item.week_pattern,p_item.week_anchor_date,f.first_date+days.offset_days)
      and not(f.first_date+days.offset_days=any(p_item.excluded_dates))
  )
$$;
revoke all on function public.xelay_private_timetable_has_future_occurrence(public.study_group_schedule,timestamp)
  from public,anon,authenticated,service_role;

create or replace function public.xelay_notify_academic_timetable()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid();
  v_group uuid;
  v_urgent boolean:=false;
  v_local_now timestamp:=statement_timestamp() at time zone 'Europe/Kyiv';
begin
  if v_actor is null then return null; end if;
  if tg_op='UPDATE' and(to_jsonb(new)-array['updated_at','created_at','created_by','updated_by','teaching_version'])
    is not distinct from(to_jsonb(old)-array['updated_at','created_at','created_by','updated_by','teaching_version']) then return null; end if;
  if tg_table_name='study_group_schedule' then
    if tg_op='DELETE' then
      v_urgent:=public.xelay_private_timetable_has_future_occurrence(old,v_local_now);
    elsif tg_op='UPDATE' then
      v_urgent:=exists(
        select 1 from unnest(new.excluded_dates) excluded(lesson_date)
        where not(excluded.lesson_date=any(old.excluded_dates))
          and (excluded.lesson_date>v_local_now::date
            or (excluded.lesson_date=v_local_now::date and old.ends_at>v_local_now::time))
          and public.xelay_schedule_occurs_on_date(old.weekday,old.valid_from,old.valid_until,
            old.week_pattern,old.week_anchor_date,excluded.lesson_date)
      ) or (
        (new.weekday,new.starts_at,new.ends_at,new.valid_from,new.valid_until,new.week_pattern,new.week_anchor_date)
          is distinct from(old.weekday,old.starts_at,old.ends_at,old.valid_from,old.valid_until,old.week_pattern,old.week_anchor_date)
        and (public.xelay_private_timetable_has_future_occurrence(old,v_local_now)
          or public.xelay_private_timetable_has_future_occurrence(new,v_local_now))
      );
    end if;
  end if;
  if v_urgent is distinct from(tg_argv[0]='urgent') then return null; end if;
  v_group:=case when tg_op='DELETE' then old.group_id else new.group_id end;
  perform public.xelay_private_notify_group_event(v_group,
    'academic:timetable:'||v_group::text||':'||txid_current()::text,
    case when v_urgent then 'змінив(-ла) час чи дату заняття або скасував(-ла) його. Перевірте актуальний розклад.'
      else 'оновив(-ла) розклад навчальної групи. Перевірте час, місце та посилання на заняття.' end,
    'timetable',v_actor,'study_group_update',case when v_urgent then 'urgent' else 'normal' end);
  return null;
end $$;

-- Ordinary events are committed after urgent row edits. A mixed import/edit
-- therefore keeps the existing single event key and captures urgent priority.
drop trigger study_group_homework_notification on public.study_group_homework;
create constraint trigger study_group_homework_notification after insert or update or delete on public.study_group_homework
  deferrable initially deferred for each row execute function public.xelay_notify_study_group_homework('normal');
create trigger study_group_homework_urgent_notification after update on public.study_group_homework
  for each row execute function public.xelay_notify_study_group_homework('urgent');

drop trigger study_group_schedule_notification on public.study_group_schedule;
create constraint trigger study_group_schedule_notification after insert or update or delete on public.study_group_schedule
  deferrable initially deferred for each row execute function public.xelay_notify_academic_timetable('normal');
create trigger study_group_schedule_urgent_notification after update or delete on public.study_group_schedule
  for each row execute function public.xelay_notify_academic_timetable('urgent');
drop trigger study_group_seminar_schedule_notification on public.study_group_seminar_schedule;
create constraint trigger study_group_seminar_schedule_notification after insert or update or delete on public.study_group_seminar_schedule
  deferrable initially deferred for each row execute function public.xelay_notify_academic_timetable('normal');
drop trigger study_group_timetable_photo_notification on public.study_group_timetable_photos;
create constraint trigger study_group_timetable_photo_notification after insert or update or delete on public.study_group_timetable_photos
  deferrable initially deferred for each row execute function public.xelay_notify_academic_timetable('normal');

commit;
