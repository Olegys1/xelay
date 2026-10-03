-- Private organizer subjects, date-only deadlines, source snapshots and in-app
-- reminders. Existing tasks remain intact; no email, push or scheduled worker.
begin;

do $$
begin
  if to_regclass('public.organizer_tasks') is null
    or to_regclass('public.notifications') is null
    or to_regclass('public.notification_preferences') is null
    or to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_group_homework') is null
    or to_regclass('public.study_group_schedule') is null
    or to_regclass('public.study_group_seminars') is null
    or to_regclass('public.study_group_seminar_subjects') is null
    or to_regclass('public.study_group_seminar_questions') is null
    or to_regprocedure('public.xelay_has_participant_access(uuid)') is null then
    raise exception 'Apply participant billing, private study assignments and notification preferences before the organizer upgrade';
  end if;
end;
$$;

alter table public.organizer_tasks
  add column if not exists subject text not null default '',
  add column if not exists due_date date,
  add column if not exists due_sort_at timestamptz,
  add column if not exists reminder_at timestamptz,
  add column if not exists reminder_sent_at timestamptz,
  add column if not exists source_kind text,
  add column if not exists source_id uuid,
  add column if not exists source_group_id uuid,
  add column if not exists source_question_id uuid,
  add column if not exists source_date date;

alter table public.organizer_tasks
  drop constraint if exists organizer_task_subject_check,
  drop constraint if exists organizer_task_due_date_check,
  drop constraint if exists organizer_task_one_due_check,
  drop constraint if exists organizer_task_reminder_check,
  drop constraint if exists organizer_task_source_check;
alter table public.organizer_tasks
  add constraint organizer_task_subject_check check(length(subject)<=120),
  add constraint organizer_task_due_date_check check(due_date is null or isfinite(due_date)),
  add constraint organizer_task_one_due_check check(due_date is null or due_at is null),
  add constraint organizer_task_reminder_check check(
    reminder_at is null or (isfinite(reminder_at) and (due_date is not null or due_at is not null))),
  add constraint organizer_task_source_check check (
    (source_kind is null and source_id is null and source_group_id is null
      and source_question_id is null and source_date is null)
    or (source_kind is not null and source_kind in ('homework','seminar') and source_id is not null
      and source_group_id is not null and source_date is not null and isfinite(source_date)
      and (source_kind='seminar' or source_question_id is null))
  );

-- No FK to assignments/group: personal snapshots survive source removal and
-- never grant access to the group. Link navigation still obeys group RLS.
create unique index if not exists organizer_tasks_source_unique_idx
  on public.organizer_tasks(user_id,source_kind,source_id,(source_question_id is null),
    coalesce(source_question_id,'00000000-0000-0000-0000-000000000000'::uuid))
  where source_kind is not null;
create index if not exists organizer_tasks_user_due_sort_idx
  on public.organizer_tasks(user_id,completed,due_sort_at,id);
create index if not exists organizer_tasks_pending_reminder_idx
  on public.organizer_tasks(user_id,reminder_at,id)
  where not completed and reminder_at is not null and reminder_sent_at is null;

create or replace function public.xelay_prepare_organizer_task()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  if auth.uid() is not null and (new.user_id is distinct from auth.uid()
    or not public.xelay_has_participant_access(auth.uid())) then
    raise exception 'ORGANIZER_PARTICIPANT_REQUIRED' using errcode='42501';
  end if;
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.user_id is distinct from old.user_id
      or new.created_at is distinct from old.created_at then
      raise exception 'ORGANIZER_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    if new.source_kind is distinct from old.source_kind or new.source_id is distinct from old.source_id
      or new.source_group_id is distinct from old.source_group_id
      or new.source_question_id is distinct from old.source_question_id
      or new.source_date is distinct from old.source_date then
      raise exception 'ORGANIZER_SOURCE_IMMUTABLE' using errcode='42501';
    end if;
  end if;
  new.subject := btrim(new.subject);
  if new.due_date is not null and (not isfinite(new.due_date) or new.due_at is not null) then
    raise exception 'ORGANIZER_INVALID_DEADLINE' using errcode='22023';
  end if;
  -- Old records are preserved. A newly supplied timestamp must be finite.
  if new.due_at is not null and (tg_op='INSERT' or new.due_at is distinct from old.due_at)
    and not isfinite(new.due_at) then
    raise exception 'ORGANIZER_INVALID_DEADLINE' using errcode='22023';
  end if;
  if new.reminder_at is not null then
    if not isfinite(new.reminder_at) or (new.due_date is null and new.due_at is null) then
      raise exception 'ORGANIZER_INVALID_REMINDER' using errcode='22023';
    end if;
    -- Already due, unsent reminders remain pending while preferences/subscription
    -- disable delivery. Ordinary note/completion edits do not discard them.
    if (tg_op='INSERT' or new.reminder_at is distinct from old.reminder_at)
      and new.reminder_at<=clock_timestamp() then
      raise exception 'ORGANIZER_REMINDER_IN_PAST' using errcode='22023';
    end if;
  end if;
  new.due_sort_at := coalesce(new.due_at,
    (new.due_date+time '23:59:59') at time zone 'Europe/Kyiv');
  if tg_op='INSERT' then
    new.created_at := clock_timestamp();
    new.reminder_sent_at := null;
  elsif new.reminder_at is distinct from old.reminder_at
    or new.due_date is distinct from old.due_date or new.due_at is distinct from old.due_at
    or new.completed is distinct from old.completed then
    new.reminder_sent_at := null;
  end if;
  -- Delivery changes only a server marker. Preserve the content version so
  -- an open personal edit is not rejected merely because its reminder ran.
  if tg_op='INSERT' or new.title is distinct from old.title or new.notes is distinct from old.notes
    or new.subject is distinct from old.subject or new.due_at is distinct from old.due_at
    or new.due_date is distinct from old.due_date or new.reminder_at is distinct from old.reminder_at
    or new.completed is distinct from old.completed then
    new.updated_at := clock_timestamp();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;
drop trigger if exists organizer_task_prepare on public.organizer_tasks;
create trigger organizer_task_prepare before insert or update on public.organizer_tasks
  for each row execute function public.xelay_prepare_organizer_task();

-- Fill only the new sorting column; old deadlines, notes and timestamps stay
-- unchanged. Temporarily omit this migration's guard for trusted backfill.
alter table public.organizer_tasks disable trigger organizer_task_prepare;
update public.organizer_tasks set due_sort_at=coalesce(due_at,
  (due_date+time '23:59:59') at time zone 'Europe/Kyiv')
  where due_sort_at is distinct from coalesce(due_at,
    (due_date+time '23:59:59') at time zone 'Europe/Kyiv');
alter table public.organizer_tasks enable trigger organizer_task_prepare;

alter table public.organizer_tasks enable row level security;
drop policy if exists "Owner reads organizer" on public.organizer_tasks;
drop policy if exists "Participant creates organizer" on public.organizer_tasks;
drop policy if exists "Participant updates organizer" on public.organizer_tasks;
drop policy if exists "Owner deletes organizer" on public.organizer_tasks;
create policy "Owner reads organizer" on public.organizer_tasks
  for select to authenticated using(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
create policy "Participant creates organizer" on public.organizer_tasks
  for insert to authenticated with check(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
create policy "Participant updates organizer" on public.organizer_tasks
  for update to authenticated using(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()))
  with check(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
create policy "Owner deletes organizer" on public.organizer_tasks
  for delete to authenticated using(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
-- Restrictive policies constrain any older permissive policies as well.
drop policy if exists "Organizer owner read guard" on public.organizer_tasks;
drop policy if exists "Organizer participant insert guard" on public.organizer_tasks;
drop policy if exists "Organizer participant update guard" on public.organizer_tasks;
drop policy if exists "Organizer owner delete guard" on public.organizer_tasks;
create policy "Organizer owner read guard" on public.organizer_tasks as restrictive
  for select to authenticated using(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
create policy "Organizer participant insert guard" on public.organizer_tasks as restrictive
  for insert to authenticated with check(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
create policy "Organizer participant update guard" on public.organizer_tasks as restrictive
  for update to authenticated using(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()))
  with check(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
create policy "Organizer owner delete guard" on public.organizer_tasks as restrictive
  for delete to authenticated using(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));

revoke all on public.organizer_tasks from public,anon,authenticated;
-- Table REVOKE does not revoke old column privileges. Reset these explicitly.
do $$
declare v_columns text;
begin
  select string_agg(quote_ident(attname),',') into v_columns from pg_attribute
    where attrelid='public.organizer_tasks'::regclass and attnum>0 and not attisdropped;
  execute format('revoke select (%s),insert (%s),update (%s) on public.organizer_tasks from public,anon,authenticated',v_columns,v_columns,v_columns);
end;
$$;
grant select,delete on public.organizer_tasks to authenticated;
-- Legacy updated_at payloads remain accepted, then overwritten by the trigger.
-- Source identity, sort keys and reminder delivery markers are server-only.
grant insert(user_id,title,notes,due_at,completed,subject,due_date,reminder_at,updated_at),
  update(title,notes,due_at,completed,subject,due_date,reminder_at,updated_at)
  on public.organizer_tasks to authenticated;

alter table public.notifications
  add column if not exists organizer_task_id uuid references public.organizer_tasks(id) on delete cascade;
create index if not exists notifications_organizer_task_idx
  on public.notifications(organizer_task_id) where organizer_task_id is not null;
alter table public.notifications drop constraint if exists notification_organizer_task_check;
alter table public.notifications add constraint notification_organizer_task_check check (
  (type='organizer_reminder' and organizer_task_id is not null)
  or (type is distinct from 'organizer_reminder' and organizer_task_id is null)
);

-- Some legacy deployments may retain broad notification column privileges.
-- Protect only the newly introduced organizer identity, without changing old
-- event behavior. INVOKER is intentional: a DEFINER would hide the caller role.
create or replace function public.xelay_guard_organizer_notification()
returns trigger language plpgsql security invoker set search_path=public,pg_temp
as $$
begin
  if current_user in ('authenticated','anon') then
    if tg_op='INSERT' then
      if new.organizer_task_id is not null or new.type='organizer_reminder' then
        raise exception 'ORGANIZER_NOTIFICATION_FORBIDDEN' using errcode='42501';
      end if;
    else
      if new.organizer_task_id is distinct from old.organizer_task_id
        or (new.type is distinct from old.type
          and (new.type='organizer_reminder' or old.type='organizer_reminder')) then
        raise exception 'ORGANIZER_NOTIFICATION_FORBIDDEN' using errcode='42501';
      end if;
      if old.type='organizer_reminder'
        and (to_jsonb(new)-'is_read') is distinct from (to_jsonb(old)-'is_read') then
        raise exception 'ORGANIZER_NOTIFICATION_FORBIDDEN' using errcode='42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists organizer_notification_guard on public.notifications;
create trigger organizer_notification_guard before insert or update on public.notifications
  for each row execute function public.xelay_guard_organizer_notification();

create or replace function public.xelay_add_organizer_assignment(
  p_kind text,p_assignment_id uuid,p_question_id uuid default null
)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp
as $$
declare v_user_id uuid := auth.uid(); v_group_id uuid; v_subject text; v_title text; v_notes text;
  v_date date; v_question text; v_task public.organizer_tasks%rowtype;
begin
  if v_user_id is null then raise exception 'ORGANIZER_AUTH_REQUIRED' using errcode='42501'; end if;
  if not public.xelay_has_participant_access(v_user_id) then
    raise exception 'ORGANIZER_PARTICIPANT_REQUIRED' using errcode='42501';
  end if;
  if p_kind is null or p_kind not in ('homework','seminar') or p_assignment_id is null
    or (p_kind='homework' and p_question_id is not null) then
    raise exception 'ORGANIZER_INVALID_ASSIGNMENT' using errcode='22023';
  end if;
  if p_kind='homework' then
    select group_id into v_group_id from public.study_group_homework where id=p_assignment_id;
  else
    select group_id into v_group_id from public.study_group_seminars where id=p_assignment_id;
  end if;
  if v_group_id is null then raise exception 'ORGANIZER_ASSIGNMENT_UNAVAILABLE' using errcode='42501'; end if;
  -- Serialize with group member removal and academic edits, but never require
  -- editing permission or mutate a shared assignment/reservation/material.
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  if not exists(select 1 from public.study_groups g where g.id=v_group_id
    and (g.representative_id=v_user_id or exists(select 1 from public.study_group_members m
      where m.group_id=g.id and m.user_id=v_user_id and m.status='accepted'))) then
    raise exception 'ORGANIZER_ASSIGNMENT_UNAVAILABLE' using errcode='42501';
  end if;
  if p_kind='homework' then
    select s.subject,'ДЗ · ' || s.subject,h.body,h.lesson_date
      into v_subject,v_title,v_notes,v_date
      from public.study_group_homework h join public.study_group_schedule s
        on s.id=h.schedule_item_id and s.group_id=h.group_id
      where h.id=p_assignment_id and h.group_id=v_group_id;
  else
    select subject.name,'Семінар · ' || seminar.title,seminar.instructions,seminar.lesson_date
      into v_subject,v_title,v_notes,v_date
      from public.study_group_seminars seminar join public.study_group_seminar_subjects subject
        on subject.id=seminar.subject_id and subject.group_id=seminar.group_id
      where seminar.id=p_assignment_id and seminar.group_id=v_group_id;
  end if;
  if not found or v_date is null or not isfinite(v_date) then
    raise exception 'ORGANIZER_ASSIGNMENT_UNAVAILABLE' using errcode='42501';
  end if;
  if p_question_id is not null then
    select body into v_question from public.study_group_seminar_questions
      where id=p_question_id and seminar_id=p_assignment_id;
    if not found then raise exception 'ORGANIZER_ASSIGNMENT_UNAVAILABLE' using errcode='42501'; end if;
    v_title := 'Семінар · ' || left(v_question,180);
    v_notes := left(v_question || case when nullif(v_notes,'') is not null
      then E'\n\n' || v_notes else '' end,10000);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:organizer-source:' || v_user_id::text
    || ':' || p_kind || ':' || p_assignment_id::text || ':' || coalesce(p_question_id::text,''),0));
  select * into v_task from public.organizer_tasks where user_id=v_user_id
    and source_kind=p_kind and source_id=p_assignment_id and source_question_id is not distinct from p_question_id;
  if found then return to_jsonb(v_task); end if;
  insert into public.organizer_tasks(user_id,title,notes,subject,due_date,
    source_kind,source_id,source_group_id,source_question_id,source_date)
    values(v_user_id,left(v_title,200),left(coalesce(v_notes,''),10000),left(coalesce(v_subject,''),120),v_date,
      p_kind,p_assignment_id,v_group_id,p_question_id,v_date)
    returning * into v_task;
  return to_jsonb(v_task);
end;
$$;

create or replace function public.xelay_deliver_organizer_reminders()
returns integer language plpgsql volatile security definer set search_path=public,pg_temp
as $$
declare v_user_id uuid := auth.uid(); v_task public.organizer_tasks%rowtype;
  v_enabled boolean; v_delivered integer := 0; v_now timestamptz := clock_timestamp();
begin
  if v_user_id is null then raise exception 'ORGANIZER_AUTH_REQUIRED' using errcode='42501'; end if;
  if not public.xelay_has_participant_access(v_user_id) then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:organizer-reminders:' || v_user_id::text,0));
  select notifications_enabled into v_enabled from public.notification_preferences
    where user_id=v_user_id for share;
  if not coalesce(v_enabled,true) then return 0; end if;
  for v_task in select * from public.organizer_tasks where user_id=v_user_id and not completed
    and reminder_at is not null and reminder_at<=v_now and reminder_sent_at is null
    order by reminder_at,id limit 100 for update
  loop
    -- Self-actor and the existing email type whitelist both exclude this event
    -- from mail delivery. Only the owner receives the in-app notification.
    insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,organizer_task_id)
      values(v_user_id,v_user_id,'Органайзер','organizer_reminder',
        'Нагадування: ' || v_task.title,false,v_task.id);
    update public.organizer_tasks set reminder_sent_at=v_now where id=v_task.id and user_id=v_user_id;
    v_delivered := v_delivered+1;
  end loop;
  return v_delivered;
end;
$$;

create or replace function public.xelay_organizer_subjects()
returns text[] language plpgsql stable security definer set search_path=public,pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'ORGANIZER_AUTH_REQUIRED' using errcode='42501'; end if;
  if not public.xelay_has_participant_access(auth.uid()) then
    raise exception 'ORGANIZER_PARTICIPANT_REQUIRED' using errcode='42501';
  end if;
  return array(select distinct subject from public.organizer_tasks
    where user_id=auth.uid() and nullif(btrim(subject),'') is not null order by subject);
end;
$$;

revoke all on function public.xelay_prepare_organizer_task(),public.xelay_guard_organizer_notification(),
  public.xelay_add_organizer_assignment(text,uuid,uuid),public.xelay_deliver_organizer_reminders(),
  public.xelay_organizer_subjects() from public,anon,authenticated,service_role;
grant execute on function public.xelay_add_organizer_assignment(text,uuid,uuid),
  public.xelay_deliver_organizer_reminders(),public.xelay_organizer_subjects() to authenticated;

comment on column public.organizer_tasks.due_date is
  'Optional calendar day without an invented lesson time; mutually exclusive with due_at.';
comment on column public.organizer_tasks.due_sort_at is
  'Server-controlled pagination key: timed deadline, or 23:59:59 Europe/Kyiv on a date-only deadline.';
comment on column public.organizer_tasks.source_date is
  'Immutable source lesson date for navigation, even when the private task deadline is rescheduled.';
comment on function public.xelay_deliver_organizer_reminders() is
  'At most 100 due reminders for the current authenticated active participant per call; respects in-app notification preferences, atomically marks delivery, leaves disabled/expired reminders pending, sends no email or push.';

commit;
