-- A topic belongs to one dated lesson, alongside its optional homework.
begin;

do $$
begin
  if to_regclass('public.study_group_homework') is null
    or to_regprocedure('public.xelay_notify_study_group_homework()') is null then
    raise exception 'Apply the study-group schedule migration before lesson topics';
  end if;
end;
$$;

alter table public.study_group_homework
  add column if not exists lesson_topic text;

-- The inline body CHECK in 202609290001_study_groups_schedule.sql receives
-- this PostgreSQL-generated name. Replace only that known constraint.
alter table public.study_group_homework
  drop constraint if exists study_group_homework_body_check,
  drop constraint if exists study_group_homework_lesson_topic_check,
  drop constraint if exists study_group_homework_content_check;

alter table public.study_group_homework
  add constraint study_group_homework_body_check
    check (length(btrim(body)) between 0 and 10000),
  add constraint study_group_homework_lesson_topic_check
    check (lesson_topic is null or length(btrim(lesson_topic)) <= 240),
  add constraint study_group_homework_content_check
    check (
      length(btrim(body)) > 0
      or coalesce(length(btrim(lesson_topic)), 0) > 0
      or nullif(btrim(url), '') is not null
    );

comment on column public.study_group_homework.lesson_topic is
  'Optional topic or notice for schedule_item_id on lesson_date only; does not repeat weekly.';

create or replace function public.xelay_notify_study_group_homework()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_subject text;
  v_actor_name text;
  v_message text;
  v_member record;
begin
  if tg_op = 'UPDATE'
    and old.body is not distinct from new.body
    and old.url is not distinct from new.url
    and old.lesson_topic is not distinct from new.lesson_topic then
    return new;
  end if;
  select subject into v_subject from public.study_group_schedule where id = new.schedule_item_id;
  select full_name into v_actor_name from public.profiles where id = new.created_by;
  v_message := case when tg_op = 'INSERT'
      then 'додав(-ла) інформацію про заняття: '
      else 'оновив(-ла) інформацію про заняття: '
    end
    || coalesce(v_subject, 'Заняття')
    || ' (' || to_char(new.lesson_date, 'DD.MM.YYYY') || ')'
    || case when nullif(btrim(new.lesson_topic), '') is not null
      then ' — ' || btrim(new.lesson_topic)
      else ''
    end;
  for v_member in
    select user_id from public.study_group_members
    where group_id = new.group_id and status = 'accepted' and user_id <> new.created_by
  loop
    insert into public.notifications (
      recipient_id, actor_id, actor_name, type, message, is_read, study_group_id
    ) values (
      v_member.user_id, new.created_by, coalesce(nullif(v_actor_name, ''), 'Староста'),
      'group_homework', v_message, false, new.group_id
    );
  end loop;
  return new;
end;
$$;

notify pgrst, 'reload schema';

commit;
