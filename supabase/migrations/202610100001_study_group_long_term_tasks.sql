-- One shared subject assignment across every matching seminar/lesson.
-- Apply after the free study-group policy (202610070001). Lesson removal never
-- removes a task: only its group is referenced, and closing preserves history.
begin;

do $long_term_tasks_preflight$
begin
  if to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_group_deputy_requests') is null
    or to_regprocedure('public.xelay_lock_study_group_permission(uuid,text,boolean)') is null
    or to_regprocedure('public.xelay_free_groups_available()') is null then
    raise exception 'LONG_TERM_TASK_PREREQUISITES_MISSING'
      using hint='Apply study-group academic/deputy permissions and 202610070001_free_study_groups first. No changes were made.';
  end if;
end;
$long_term_tasks_preflight$;

-- This generated/index key stays server-internal. Client subject matching
-- normalizes task.subject and lesson/subject names in the same browser runtime.
-- Keep the whitespace and apostrophe sets equivalent to the client normalizer.
create or replace function public.xelay_long_term_subject_key(p_subject text)
returns text language sql immutable set search_path = '' as $$
  select lower(btrim(regexp_replace(
    translate(coalesce(p_subject,''),U&'\2018\2019\02BC\02BB\0060\00B4\FF07',repeat(chr(39),7)),
    U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',' ','g')));
$$;

create table if not exists public.study_group_long_term_tasks(
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  subject text not null check(length(subject) between 1 and 120 and subject=btrim(subject) and subject !~ '[[:cntrl:]]'),
  subject_key text generated always as (public.xelay_long_term_subject_key(subject)) stored not null check(length(subject_key)>0),
  title text not null check(length(title) between 1 and 240 and title=btrim(title) and title !~ '[[:cntrl:]]'),
  description text not null default '' check(length(description)<=10000),
  due_date date not null check(isfinite(due_date) and due_date between date '1900-01-01' and date '2200-12-31'),
  closed_at timestamptz check(closed_at is null or isfinite(closed_at)),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists study_group_long_term_tasks_group_subject_due_idx
  on public.study_group_long_term_tasks(group_id,subject_key,due_date,id) where closed_at is null;
create index if not exists study_group_long_term_tasks_group_id_idx
  on public.study_group_long_term_tasks(group_id,id);

-- Pending invitations and platform status alone do not expose academic content.
-- There is no payment check: accepted members can always read these assignments.
create or replace function public.xelay_can_read_study_group_long_term_tasks(p_group_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists(
    select 1 from public.study_groups g where g.id=p_group_id and (
      g.representative_id=auth.uid() or exists(select 1 from public.study_group_members m
        where m.group_id=g.id and m.user_id=auth.uid() and m.status='accepted')));
$$;

-- Reuse the role/membership advisory lock, then verify the actual appointment
-- independently of older permission helpers that once included platform admins.
create or replace function public.xelay_lock_study_group_long_term_tasks(p_group_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public.xelay_lock_study_group_permission(p_group_id,'homework',true);
  if not exists(select 1 from public.study_groups g where g.id=p_group_id and (
    g.representative_id=auth.uid() or exists(select 1 from public.study_group_deputy_requests d
      join public.study_group_members m on m.group_id=d.group_id and m.user_id=d.user_id and m.status='accepted'
      where d.group_id=g.id and d.user_id=auth.uid() and d.status='approved' and 'homework'=any(d.permissions)))) then
    raise exception 'STUDY_GROUP_PERMISSION_REQUIRED' using errcode='42501';
  end if;
end;
$$;

alter table public.study_group_long_term_tasks enable row level security;
revoke all on table public.study_group_long_term_tasks from public,anon,authenticated,service_role;
grant select on table public.study_group_long_term_tasks to authenticated;
drop policy if exists "Accepted members read long-term tasks" on public.study_group_long_term_tasks;
create policy "Accepted members read long-term tasks" on public.study_group_long_term_tasks
  for select to authenticated using(public.xelay_can_read_study_group_long_term_tasks(group_id));

-- The trigger also guards privileged RPCs and future direct-write paths. Client
-- DELETE is deliberately unavailable; parent-group cleanup may still cascade.
create or replace function public.xelay_guard_study_group_long_term_task()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_group_id uuid; v_role text:=coalesce(current_setting('role',true),'none');
begin
  v_group_id:=case when tg_op='DELETE' then old.group_id else new.group_id end;
  if tg_op='DELETE' then
    if not exists(select 1 from public.study_groups where id=v_group_id) then return old; end if;
    raise exception 'LONG_TERM_TASK_CLOSE_REQUIRED' using errcode='42501';
  end if;
  if auth.uid() is not null then
    perform public.xelay_lock_study_group_long_term_tasks(v_group_id);
  elsif v_role not in('none','postgres','supabase_admin') then
    raise exception 'LONG_TERM_TASK_AUTH_REQUIRED' using errcode='42501';
  end if;
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.group_id is distinct from old.group_id
      or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'LONG_TERM_TASK_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    if new.closed_at is not null and new.closed_at is distinct from old.closed_at then
      new.closed_at:=clock_timestamp();
    end if;
    new.updated_at:=greatest(clock_timestamp(),old.updated_at+interval '1 microsecond');
  else
    if auth.uid() is not null and new.created_by is distinct from auth.uid() then
      raise exception 'LONG_TERM_TASK_AUTHOR_REQUIRED' using errcode='42501';
    end if;
    new.closed_at:=null;
    new.created_at:=clock_timestamp(); new.updated_at:=new.created_at;
  end if;
  new.subject:=btrim(regexp_replace(new.subject,
    U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',' ','g'));
  new.title:=btrim(new.title); new.description:=coalesce(new.description,'');
  if new.subject is null or length(new.subject) not between 1 and 120 or new.subject ~ '[[:cntrl:]]'
    or length(public.xelay_long_term_subject_key(new.subject))=0 then
    raise exception 'LONG_TERM_TASK_INVALID_SUBJECT' using errcode='22023';
  end if;
  if new.title is null or length(new.title) not between 1 and 240 or new.title ~ '[[:cntrl:]]'
    or length(new.description)>10000 then
    raise exception 'LONG_TERM_TASK_INVALID_CONTENT' using errcode='22023';
  end if;
  if new.due_date is null or not isfinite(new.due_date)
    or new.due_date not between date '1900-01-01' and date '2200-12-31' then
    raise exception 'LONG_TERM_TASK_INVALID_DEADLINE' using errcode='22023';
  end if;
  return new;
end;
$$;
drop trigger if exists study_group_long_term_task_guard on public.study_group_long_term_tasks;
create trigger study_group_long_term_task_guard before insert or update or delete
  on public.study_group_long_term_tasks for each row execute function public.xelay_guard_study_group_long_term_task();

create or replace function public.xelay_save_study_group_long_term_task(
  p_group_id uuid,p_task_id uuid,p_subject text,p_title text,p_description text,p_due_date date
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.xelay_lock_study_group_long_term_tasks(p_group_id);
  if p_task_id is null then
    insert into public.study_group_long_term_tasks(group_id,subject,title,description,due_date,created_by)
      values(p_group_id,p_subject,p_title,p_description,p_due_date,auth.uid()) returning id into v_id;
  else
    perform 1 from public.study_group_long_term_tasks where id=p_task_id and group_id=p_group_id for update;
    if not found then raise exception 'LONG_TERM_TASK_NOT_FOUND' using errcode='22023'; end if;
    update public.study_group_long_term_tasks set subject=p_subject,title=p_title,description=p_description,due_date=p_due_date
      where id=p_task_id and group_id=p_group_id returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.xelay_set_study_group_long_term_task_closed(p_group_id uuid,p_task_id uuid,p_closed boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_task public.study_group_long_term_tasks%rowtype;
begin
  perform public.xelay_lock_study_group_long_term_tasks(p_group_id);
  if p_closed is null then raise exception 'LONG_TERM_TASK_INVALID_STATUS' using errcode='22023'; end if;
  select * into v_task from public.study_group_long_term_tasks where id=p_task_id and group_id=p_group_id for update;
  if not found then raise exception 'LONG_TERM_TASK_NOT_FOUND' using errcode='22023'; end if;
  if (v_task.closed_at is not null)=p_closed then return; end if;
  update public.study_group_long_term_tasks set closed_at=case when p_closed then clock_timestamp() else null end
    where id=p_task_id and group_id=p_group_id;
end;
$$;

revoke all on function public.xelay_long_term_subject_key(text),public.xelay_lock_study_group_long_term_tasks(uuid),
  public.xelay_guard_study_group_long_term_task(),public.xelay_can_read_study_group_long_term_tasks(uuid),
  public.xelay_save_study_group_long_term_task(uuid,uuid,text,text,text,date),
  public.xelay_set_study_group_long_term_task_closed(uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.xelay_can_read_study_group_long_term_tasks(uuid),
  public.xelay_save_study_group_long_term_task(uuid,uuid,text,text,text,date),
  public.xelay_set_study_group_long_term_task_closed(uuid,uuid,boolean) to authenticated;

do $long_term_tasks_realtime$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime' and not puballtables)
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='study_group_long_term_tasks') then
    alter publication supabase_realtime add table public.study_group_long_term_tasks;
  end if;
end;
$long_term_tasks_realtime$;

comment on table public.study_group_long_term_tasks is
  'Private subject-level assignments, independent of schedule dates and seminar records. Accepted members read free; representative and accepted approved homework deputies manage through RPC. Close/reopen retains the shared record and archive.';
comment on column public.study_group_long_term_tasks.created_by is
  'Immutable historical author ID; account deletion does not delete shared subject assignments.';
comment on column public.study_group_long_term_tasks.subject_key is
  'Server-internal generated/index key with database case, whitespace and apostrophe normalization. Client subject matching normalizes task.subject and lesson/subject names in the same browser runtime.';
notify pgrst,'reload schema';
commit;
