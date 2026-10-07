-- Participant organizer: Kyiv calendar recurrence and deduplicated reminders.
-- Apply after 202610040001. Existing sources, tasks and sent reminders survive.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$
begin
  if to_regclass('public.organizer_tasks') is null
    or to_regclass('public.notifications') is null
    or to_regclass('public.notification_preferences') is null
    or to_regprocedure('public.xelay_prepare_organizer_task()') is null
    or to_regprocedure('public.xelay_has_participant_access(uuid)') is null
    or not exists(select 1 from pg_attribute where attrelid='public.organizer_tasks'::regclass
      and attname='source_date' and not attisdropped) then
    raise exception 'Apply organizer upgrade 202610040001 before participant organizer features';
  end if;
end;
$$;

alter table public.organizer_tasks
  add column if not exists recurrence_rule text not null default 'none',
  add column if not exists recurrence_until date,
  add column if not exists reminder_offsets_minutes integer[] not null default '{}',
  add column if not exists recurrence_anchor_at timestamptz,
  add column if not exists recurrence_anchor_date date,
  add column if not exists recurrence_series_id uuid,
  add column if not exists recurrence_index integer not null default 0,
  add column if not exists recurrence_parent_id uuid,
  add column if not exists recurrence_next_id uuid;
alter table public.organizer_tasks
  drop constraint if exists organizer_task_recurrence_check,
  drop constraint if exists organizer_task_offsets_check;
alter table public.organizer_tasks
  add constraint organizer_task_recurrence_check check (
    recurrence_rule in ('none','daily','weekly','monthly') and recurrence_index>=0
    and (recurrence_until is null or isfinite(recurrence_until))
    and (recurrence_rule='none' or ((due_at is not null or due_date is not null) and source_kind is null))),
  add constraint organizer_task_offsets_check check (
    cardinality(reminder_offsets_minutes)<=5 and array_position(reminder_offsets_minutes,null) is null
    and reminder_offsets_minutes <@ array[15,60,180,1440,10080]
    and (cardinality(reminder_offsets_minutes)=0 or due_at is not null or due_date is not null));
create unique index if not exists organizer_task_recurrence_parent_unique_idx
  on public.organizer_tasks(recurrence_parent_id) where recurrence_parent_id is not null;
grant insert(recurrence_rule,recurrence_until,reminder_offsets_minutes),
  update(recurrence_rule,recurrence_until,reminder_offsets_minutes)
  on public.organizer_tasks to authenticated;

create table if not exists public.organizer_task_reminders (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.organizer_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reminder_at timestamptz not null check(isfinite(reminder_at)),
  sent_at timestamptz,
  notification_id uuid,
  unique(task_id,reminder_at)
);
alter table public.organizer_task_reminders enable row level security;
revoke all on public.organizer_task_reminders from public,anon,authenticated;
grant select on public.organizer_task_reminders to authenticated;
drop policy if exists "Participant reads own task reminders" on public.organizer_task_reminders;
create policy "Participant reads own task reminders" on public.organizer_task_reminders
  for select to authenticated using(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
drop policy if exists "Task reminder owner read guard" on public.organizer_task_reminders;
create policy "Task reminder owner read guard" on public.organizer_task_reminders as restrictive
  for select to authenticated using(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
create index if not exists organizer_task_reminders_pending_idx
  on public.organizer_task_reminders(reminder_at,task_id) where sent_at is null;

create or replace function public.xelay_prepare_organizer_task()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_base timestamptz; v_offset integer; v_changed boolean; v_generated boolean;
begin
  if auth.uid() is not null and (new.user_id is distinct from auth.uid()
    or not public.xelay_has_participant_access(auth.uid())) then
    raise exception 'ORGANIZER_PARTICIPANT_REQUIRED' using errcode='42501';
  end if;
  v_generated := tg_op='INSERT' and new.recurrence_parent_id is not null;
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
    if old.completed and old.recurrence_next_id is not null and not new.completed then
      raise exception 'ORGANIZER_OCCURRENCE_FINISHED' using errcode='22023';
    end if;
  end if;
  new.subject := btrim(new.subject);
  if new.due_date is not null and (not isfinite(new.due_date) or new.due_at is not null)
    or (new.due_at is not null and not isfinite(new.due_at)) then
    raise exception 'ORGANIZER_INVALID_DEADLINE' using errcode='22023';
  end if;
  if new.recurrence_rule not in ('none','daily','weekly','monthly')
    or (new.recurrence_rule<>'none' and (new.source_kind is not null or (new.due_at is null and new.due_date is null)))
    or (new.recurrence_until is not null and (not isfinite(new.recurrence_until)
      or new.recurrence_until<coalesce(new.due_date,(new.due_at at time zone 'Europe/Kyiv')::date))) then
    raise exception 'ORGANIZER_INVALID_RECURRENCE' using errcode='22023';
  end if;
  new.reminder_offsets_minutes := array(select distinct value from unnest(new.reminder_offsets_minutes) value order by value);
  if cardinality(new.reminder_offsets_minutes)>5 or array_position(new.reminder_offsets_minutes,null) is not null
    or not new.reminder_offsets_minutes <@ array[15,60,180,1440,10080]
    or (cardinality(new.reminder_offsets_minutes)>0 and new.due_at is null and new.due_date is null) then
    raise exception 'ORGANIZER_INVALID_REMINDER' using errcode='22023';
  end if;
  v_base := coalesce(new.due_at,(new.due_date+time '18:00') at time zone 'Europe/Kyiv');
  v_changed := tg_op='INSERT';
  if tg_op='UPDATE' then
    v_changed := new.due_at is distinct from old.due_at or new.due_date is distinct from old.due_date
      or new.reminder_offsets_minutes is distinct from old.reminder_offsets_minutes;
  end if;
  if v_changed and not v_generated then
    foreach v_offset in array new.reminder_offsets_minutes loop
      if v_base-make_interval(mins=>v_offset)<=clock_timestamp() then
        raise exception 'ORGANIZER_REMINDER_IN_PAST' using errcode='22023';
      end if;
    end loop;
  end if;
  if new.reminder_at is not null then
    if not isfinite(new.reminder_at) or v_base is null then
      raise exception 'ORGANIZER_INVALID_REMINDER' using errcode='22023';
    end if;
    if (tg_op='INSERT' or new.reminder_at is distinct from old.reminder_at) and not v_generated
      and new.reminder_at<=clock_timestamp() then
      raise exception 'ORGANIZER_REMINDER_IN_PAST' using errcode='22023';
    end if;
  end if;
  -- A changed pending occurrence starts a new anchor. Future months always use
  -- that anchor (31 January -> 28 February -> 31 March, without accumulated drift).
  if tg_op='INSERT' and not v_generated then
    new.recurrence_anchor_at := new.due_at; new.recurrence_anchor_date := new.due_date;
    new.recurrence_series_id := new.id; new.recurrence_index := 0;
  elsif tg_op='UPDATE' and (new.due_at is distinct from old.due_at
    or new.due_date is distinct from old.due_date or new.recurrence_rule is distinct from old.recurrence_rule) then
    new.recurrence_anchor_at := new.due_at; new.recurrence_anchor_date := new.due_date;
    new.recurrence_series_id := new.id; new.recurrence_index := 0;
  end if;
  new.due_sort_at := coalesce(new.due_at,(new.due_date+time '23:59:59') at time zone 'Europe/Kyiv');
  if tg_op='INSERT' then
    new.created_at := clock_timestamp(); new.reminder_sent_at := null;
  elsif new.reminder_at is distinct from old.reminder_at or v_changed or new.completed is distinct from old.completed then
    new.reminder_sent_at := null;
  end if;
  if tg_op='INSERT' or new.title is distinct from old.title or new.notes is distinct from old.notes
    or new.subject is distinct from old.subject or new.due_at is distinct from old.due_at
    or new.due_date is distinct from old.due_date or new.reminder_at is distinct from old.reminder_at
    or new.completed is distinct from old.completed or new.recurrence_rule is distinct from old.recurrence_rule
    or new.recurrence_until is distinct from old.recurrence_until
    or new.reminder_offsets_minutes is distinct from old.reminder_offsets_minutes then
    new.updated_at := clock_timestamp();
  else new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

create or replace function public.xelay_private_organizer_after_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_base timestamptz; v_desired timestamptz[]; v_next_at timestamptz; v_next_date date;
  v_anchor timestamp; v_next_base timestamptz; v_index integer; v_next_id uuid; v_reminder timestamptz;
begin
  v_base := coalesce(new.due_at,(new.due_date+time '18:00') at time zone 'Europe/Kyiv');
  v_desired := array(select distinct value from (
    select new.reminder_at value where new.reminder_at is not null
    union select v_base-make_interval(mins=>value) from unnest(new.reminder_offsets_minutes) value
  ) reminders where value is not null);
  if new.completed then
    delete from public.organizer_task_reminders where task_id=new.id and sent_at is null;
  else
    delete from public.organizer_task_reminders where task_id=new.id and sent_at is null
      and not reminder_at=any(v_desired);
    foreach v_reminder in array v_desired loop
      -- Existing overdue queue entries remain above when still desired. Never
      -- recreate an elapsed offset omitted from an automatically generated
      -- occurrence just because its notes or delivery receipt changed later.
      if v_reminder>clock_timestamp() then
        insert into public.organizer_task_reminders(task_id,user_id,reminder_at)
          values(new.id,new.user_id,v_reminder) on conflict(task_id,reminder_at) do nothing;
      end if;
    end loop;
  end if;
  if tg_op<>'UPDATE' or not new.completed or old.completed or new.recurrence_rule='none'
    or new.recurrence_next_id is not null then return null; end if;
  v_anchor := coalesce(new.recurrence_anchor_at at time zone 'Europe/Kyiv',new.recurrence_anchor_date+time '18:00');
  v_index := new.recurrence_index+1;
  if new.recurrence_rule in ('daily','weekly') then
    v_index := greatest(v_index, floor(((clock_timestamp() at time zone 'Europe/Kyiv')::date-v_anchor::date)::numeric
      /case new.recurrence_rule when 'weekly' then 7 else 1 end)::integer);
  else
    v_index := greatest(v_index, (extract(year from clock_timestamp() at time zone 'Europe/Kyiv')::integer
      -extract(year from v_anchor)::integer)*12+extract(month from clock_timestamp() at time zone 'Europe/Kyiv')::integer
      -extract(month from v_anchor)::integer);
  end if;
  loop
    if new.recurrence_rule='monthly' then
      v_next_base := (v_anchor+make_interval(months=>v_index)) at time zone 'Europe/Kyiv';
    else
      v_next_base := (v_anchor+make_interval(days=>v_index*case new.recurrence_rule when 'weekly' then 7 else 1 end)) at time zone 'Europe/Kyiv';
    end if;
    exit when v_next_base>clock_timestamp();
    v_index := v_index+1;
  end loop;
  v_next_date := (v_next_base at time zone 'Europe/Kyiv')::date;
  if new.recurrence_until is not null and v_next_date>new.recurrence_until then return null; end if;
  v_next_at := case when new.due_at is not null then v_next_base else null end;
  v_reminder := case when new.reminder_at is not null then v_next_base-(v_base-new.reminder_at) else null end;
  -- Sent custom reminders remain relative to the deadline; if the next reminder
  -- has already passed, omit it rather than generating a retrospective push.
  if v_reminder<=clock_timestamp() then v_reminder := null; end if;
  insert into public.organizer_tasks(user_id,title,notes,subject,due_at,due_date,reminder_at,
    recurrence_rule,recurrence_until,reminder_offsets_minutes,recurrence_anchor_at,recurrence_anchor_date,
    recurrence_series_id,recurrence_index,recurrence_parent_id)
    values(new.user_id,new.title,new.notes,new.subject,v_next_at,
      case when v_next_at is null then v_next_date else null end,v_reminder,
      new.recurrence_rule,new.recurrence_until,new.reminder_offsets_minutes,new.recurrence_anchor_at,new.recurrence_anchor_date,
      new.recurrence_series_id,v_index,new.id)
    on conflict(recurrence_parent_id) where recurrence_parent_id is not null do nothing returning id into v_next_id;
  if v_next_id is null then select id into v_next_id from public.organizer_tasks where recurrence_parent_id=new.id; end if;
  update public.organizer_tasks set recurrence_next_id=v_next_id where id=new.id;
  return null;
end;
$$;
drop trigger if exists organizer_task_feature_after_change on public.organizer_tasks;
create trigger organizer_task_feature_after_change after insert or update on public.organizer_tasks
  for each row execute function public.xelay_private_organizer_after_change();

-- Retain delivery markers from the old single-reminder implementation.
insert into public.organizer_task_reminders(task_id,user_id,reminder_at,sent_at)
  select id,user_id,reminder_at,reminder_sent_at from public.organizer_tasks
  where reminder_at is not null and (not completed or reminder_sent_at is not null)
  on conflict(task_id,reminder_at) do nothing;

create or replace function public.xelay_private_dispatch_organizer_reminders(p_user_id uuid,p_limit integer)
returns integer language plpgsql volatile security definer set search_path=public,pg_temp
as $$
declare v_task public.organizer_tasks%rowtype; v_reminder public.organizer_task_reminders%rowtype;
  v_count integer := 0; v_notification uuid; v_enabled boolean;
begin
  -- All paths lock the task before its reminder rows. This also serializes with
  -- task edits/completion, and SKIP LOCKED allows parallel foreground/cron jobs.
  for v_task in select t.* from public.organizer_tasks t
    where not t.completed and (p_user_id is null or t.user_id=p_user_id)
      and exists(select 1 from public.organizer_task_reminders r where r.task_id=t.id and r.sent_at is null and r.reminder_at<=clock_timestamp())
      and public.xelay_has_participant_access(t.user_id)
      and not exists(select 1 from public.notification_preferences pref
        where pref.user_id=t.user_id and pref.notifications_enabled is false)
    order by t.id limit p_limit for update of t skip locked
  loop
    select notifications_enabled into v_enabled from public.notification_preferences where user_id=v_task.user_id;
    if not coalesce(v_enabled,true) then continue; end if;
    for v_reminder in select * from public.organizer_task_reminders where task_id=v_task.id
      and sent_at is null and reminder_at<=clock_timestamp() order by reminder_at,id
      limit greatest(p_limit-v_count,0) for update skip locked
    loop
      insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,organizer_task_id)
        values(v_task.user_id,v_task.user_id,'Органайзер','organizer_reminder','Нагадування: ' || v_task.title,false,v_task.id)
        returning id into v_notification;
      update public.organizer_task_reminders set sent_at=clock_timestamp(),notification_id=v_notification where id=v_reminder.id;
      -- Trigger keeps content version stable, and the reminder receipt remains
      -- compatible with older clients; queue rows are the authoritative dedup.
      if v_task.reminder_at=v_reminder.reminder_at then
        update public.organizer_tasks set reminder_sent_at=clock_timestamp() where id=v_task.id;
      end if;
      v_count := v_count+1;
    end loop;
    exit when v_count>=p_limit;
  end loop;
  return v_count;
end;
$$;
create or replace function public.xelay_deliver_organizer_reminders()
returns integer language plpgsql volatile security definer set search_path=public,pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'ORGANIZER_AUTH_REQUIRED' using errcode='42501'; end if;
  if not public.xelay_has_participant_access(auth.uid()) then return 0; end if;
  return public.xelay_private_dispatch_organizer_reminders(auth.uid(),100);
end;
$$;
create or replace function public.xelay_dispatch_organizer_reminders(p_limit integer default 20)
returns integer language plpgsql volatile security definer set search_path=public,pg_temp
as $$
begin
  if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'ORGANIZER_INVALID_LIMIT' using errcode='22023'; end if;
  return public.xelay_private_dispatch_organizer_reminders(null,p_limit);
end;
$$;
revoke all on function public.xelay_prepare_organizer_task(),public.xelay_private_organizer_after_change(),
  public.xelay_private_dispatch_organizer_reminders(uuid,integer),public.xelay_dispatch_organizer_reminders(integer),
  public.xelay_deliver_organizer_reminders() from public,anon,authenticated,service_role;
grant execute on function public.xelay_dispatch_organizer_reminders(integer) to service_role;
grant execute on function public.xelay_deliver_organizer_reminders() to authenticated;
comment on function public.xelay_dispatch_organizer_reminders(integer) is
  'Service-only cron entry point. Inserts at most p_limit due organizer_reminder notifications, atomically deduplicated with foreground delivery. Rechecks participant access and general notification preferences. Push delivery is handled by the separate notification push queue.';
comment on column public.organizer_tasks.recurrence_rule is
  'Personal unlinked tasks only. Completing an occurrence creates at most one next future occurrence, using a Kyiv calendar anchor. Missed occurrences are skipped; source assignment snapshots never repeat.';
notify pgrst,'reload schema';
commit;
