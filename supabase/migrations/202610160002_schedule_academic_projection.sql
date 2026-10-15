-- The timetable owns automatic subjects and empty seminar calendar slots.
-- Dated seminar work, questions, reservations, resources and manual slots are
-- never copied, rewritten or deleted by this projection. Homework is untouched.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if to_regclass('public.study_group_material_subjects') is null
    or to_regclass('public.study_group_seminar_schedule') is null
    or to_regprocedure('public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date)') is null
    or not exists(select 1 from pg_attribute where attrelid='public.study_group_schedule'::regclass
      and attname='excluded_dates' and not attisdropped) then
    raise exception 'Apply timetable, materials, classroom and occurrence cancellation migrations first';
  end if;
end $$;

alter table public.study_group_seminar_subjects
  add column if not exists has_schedule_sources boolean not null default false;
alter table public.study_group_material_subjects
  add column if not exists has_schedule_sources boolean not null default false;
-- No truncation: distinct full subject names must remain distinct.
alter table public.study_group_seminar_subjects drop constraint if exists study_group_seminar_subjects_name_check;
alter table public.study_group_seminar_subjects add constraint study_group_seminar_subjects_name_check
  check(length(btrim(name)) between 1 and 180);
-- A one-character timetable subject is valid. The existing manual materials RPC
-- keeps its original minimum of two characters.
alter table public.study_group_material_subjects drop constraint if exists study_group_material_subjects_name_check;
alter table public.study_group_material_subjects add constraint study_group_material_subjects_name_check
  check(name=btrim(name) and length(name) between 1 and 180 and name !~ '[[:cntrl:]]');

alter table public.study_group_seminar_schedule
  add column if not exists source_schedule_id uuid references public.study_group_schedule(id) on delete set null,
  add column if not exists source_managed boolean not null default false,
  add column if not exists source_active boolean not null default true,
  add column if not exists week_pattern text not null default 'every',
  add column if not exists week_anchor_date date,
  add column if not exists excluded_dates date[] not null default '{}'::date[];
-- Legacy timetable bounds may be infinite. Copy those exact bounds only for
-- trusted source projections; manual calendar creation remains finite.
do $$ declare v_constraint record; begin
  for v_constraint in select conname from pg_constraint
    where conrelid='public.study_group_seminar_schedule'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%isfinite(valid_from)%'
      and pg_get_constraintdef(oid) like '%isfinite(valid_until)%' loop
    execute format('alter table public.study_group_seminar_schedule drop constraint %I',v_constraint.conname);
  end loop;
end $$;
alter table public.study_group_seminar_schedule add constraint study_group_seminar_schedule_source_bounds_check
  check(valid_until>=valid_from and(source_managed or(isfinite(valid_from) and isfinite(valid_until))));
alter table public.study_group_seminar_schedule
  drop constraint if exists study_group_seminar_schedule_source_recurrence_check;
alter table public.study_group_seminar_schedule
  add constraint study_group_seminar_schedule_source_recurrence_check check(
    week_pattern in('every','upper','lower')
    and ((week_pattern='every' and week_anchor_date is null)
      or (week_pattern in('upper','lower') and week_anchor_date is not null
        and isfinite(week_anchor_date) and extract(isodow from week_anchor_date)=1))
    and cardinality(excluded_dates)<=366
    and coalesce(array_ndims(excluded_dates),1)=1 and array_position(excluded_dates,null) is null);
create unique index if not exists study_group_seminar_schedule_active_source_idx
  on public.study_group_seminar_schedule(source_schedule_id)
  where source_managed and source_active and source_schedule_id is not null;

-- Unforgeable, transaction-local provenance for nested subject/slot triggers.
-- API users cannot read, insert, or set this context with a session GUC.
create table if not exists public.study_group_schedule_projection_context(
  transaction_id bigint not null,
  backend_pid integer not null,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  source_schedule_id uuid references public.study_group_schedule(id) on delete set null,
  source_reference_id uuid not null,
  subject_name text not null,
  source_author uuid not null,
  primary key(transaction_id,backend_pid,group_id)
);
alter table public.study_group_schedule_projection_context enable row level security;
revoke all on table public.study_group_schedule_projection_context from public,anon,authenticated,service_role;

create or replace function public.xelay_academic_subject_key(p_name text)
returns text language sql immutable set search_path='' as $$
  select lower(btrim(regexp_replace(coalesce(p_name,''),
    '[[:space:]'||chr(160)||chr(5760)||chr(8192)||'-'||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||']+',' ','g')));
$$;
revoke all on function public.xelay_academic_subject_key(text) from public,anon,authenticated,service_role;

create or replace function public.xelay_seminar_schedule_occurs_on_date(
  p_slot public.study_group_seminar_schedule,p_date date
)
returns boolean language sql immutable set search_path='' as $$
  select (not p_slot.source_managed or p_slot.source_active)
    and public.xelay_schedule_occurs_on_date(p_slot.weekday,p_slot.valid_from,p_slot.valid_until,
      p_slot.week_pattern,p_slot.week_anchor_date,p_date)
    and not(p_date=any(p_slot.excluded_dates));
$$;
revoke all on function public.xelay_seminar_schedule_occurs_on_date(public.study_group_seminar_schedule,date)
  from public,anon,authenticated,service_role;

create or replace function public.xelay_guard_academic_projection_subject()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_group uuid; v_context public.study_group_schedule_projection_context%rowtype; v_sync boolean:=false;
begin
  v_group:=case when tg_op='DELETE' then old.group_id else new.group_id end;
  if not exists(select 1 from public.study_groups where id=v_group) then
    if tg_op='DELETE' then return old; end if; return new;
  end if;
  select * into v_context from public.study_group_schedule_projection_context
    where transaction_id=txid_current() and backend_pid=pg_backend_pid() and group_id=v_group;
  if found and (pg_trigger_depth()>1 or (auth.uid() is null
      and coalesce(current_setting('role',true),'none') in('none','postgres','supabase_admin'))) then
    v_sync:=case when tg_op='INSERT' then
      new.created_by=v_context.source_author
      and public.xelay_academic_subject_key(new.name)=public.xelay_academic_subject_key(v_context.subject_name)
      and exists(select 1 from public.study_group_schedule s where s.id=v_context.source_schedule_id
        and s.group_id=v_group and s.created_by=v_context.source_author
        and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(new.name))
    when tg_op='UPDATE' then (to_jsonb(new)-array['has_schedule_sources','updated_at'])
      is not distinct from(to_jsonb(old)-array['has_schedule_sources','updated_at'])
    else false end;
  end if;
  if not v_sync and tg_op<>'INSERT' and (tg_op='DELETE' or new.name is distinct from old.name)
    and exists(select 1 from public.study_group_schedule s where s.group_id=v_group
      and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(old.name)) then
    raise exception '%',case when tg_table_name='study_group_material_subjects'
      then 'MATERIAL_SUBJECT_SOURCE_MANAGED' else 'SUBJECT_SOURCE_MANAGED' end using errcode='42501';
  end if;
  if not v_sync and ((tg_op='INSERT' and new.has_schedule_sources)
    or (tg_op='UPDATE' and new.has_schedule_sources is distinct from old.has_schedule_sources)) then
    raise exception 'ACADEMIC_PROJECTION_PROVENANCE_REQUIRED' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.xelay_guard_academic_projection_subject() from public,anon,authenticated,service_role;
drop trigger if exists academic_projection_subject_guard on public.study_group_seminar_subjects;
create trigger academic_projection_subject_guard before insert or update or delete on public.study_group_seminar_subjects
  for each row execute function public.xelay_guard_academic_projection_subject();
drop trigger if exists academic_projection_subject_guard on public.study_group_material_subjects;
create trigger academic_projection_subject_guard before insert or update or delete on public.study_group_material_subjects
  for each row execute function public.xelay_guard_academic_projection_subject();

-- Keep all existing material permissions, immutable identity, nonempty-subject
-- deletion and author checks. Only the private exact nested INSERT/metadata
-- projection may skip the unrelated materials permission.
create or replace function public.xelay_guard_material_subject()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_group_id uuid; v_role text:=coalesce(current_setting('role',true),'none');
  v_context public.study_group_schedule_projection_context%rowtype; v_sync boolean:=false;
begin
  v_group_id:=case when tg_op='DELETE' then old.group_id else new.group_id end;
  select * into v_context from public.study_group_schedule_projection_context
    where transaction_id=txid_current() and backend_pid=pg_backend_pid() and group_id=v_group_id;
  if found and (pg_trigger_depth()>1 or(auth.uid() is null and v_role in('none','postgres','supabase_admin'))) then
    v_sync:=case when tg_op='INSERT' then
      new.has_schedule_sources and new.created_by=v_context.source_author
      and public.xelay_academic_subject_key(new.name)=public.xelay_academic_subject_key(v_context.subject_name)
      and exists(select 1 from public.study_group_schedule s where s.id=v_context.source_schedule_id
        and s.group_id=v_group_id and s.created_by=v_context.source_author
        and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(new.name))
    when tg_op='UPDATE' then (to_jsonb(new)-array['has_schedule_sources','updated_at'])
      is not distinct from(to_jsonb(old)-array['has_schedule_sources','updated_at'])
    else false end;
  end if;
  if exists(select 1 from public.study_groups where id=v_group_id) then
    if auth.uid() is not null and not v_sync then perform public.xelay_lock_study_group_permission(v_group_id,'materials',true);
    elsif auth.uid() is null and v_role not in('none','postgres','supabase_admin') then
      raise exception 'MATERIAL_AUTH_REQUIRED' using errcode='42501'; end if;
  end if;
  if tg_op='DELETE' then
    if exists(select 1 from public.study_groups where id=v_group_id)
      and exists(select 1 from public.study_group_materials where subject_id=old.id and group_id=old.group_id) then
      raise exception 'MATERIAL_SUBJECT_NOT_EMPTY' using errcode='23503';
    end if;
    return old;
  end if;
  if tg_op='UPDATE' and(new.id is distinct from old.id or new.group_id is distinct from old.group_id
    or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at) then
    raise exception 'MATERIAL_IDENTITY_IMMUTABLE' using errcode='42501';
  end if;
  if tg_op='INSERT' and auth.uid() is not null and new.created_by is distinct from auth.uid() and not v_sync then
    raise exception 'MATERIAL_UPLOAD_OWNER_REQUIRED' using errcode='42501';
  end if;
  new.name:=btrim(new.name); new.updated_at:=clock_timestamp();
  return new;
end $$;
revoke all on function public.xelay_guard_material_subject() from public,anon,authenticated,service_role;

create or replace function public.xelay_guard_seminar_schedule_projection()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_group uuid; v_context public.study_group_schedule_projection_context%rowtype; v_sync boolean:=false;
begin
  v_group:=case when tg_op='DELETE' then old.group_id else new.group_id end;
  if not exists(select 1 from public.study_groups where id=v_group) then
    if tg_op='DELETE' then return old; end if; return new;
  end if;
  select * into v_context from public.study_group_schedule_projection_context
    where transaction_id=txid_current() and backend_pid=pg_backend_pid() and group_id=v_group;
  if found and(pg_trigger_depth()>1 or(auth.uid() is null
    and coalesce(current_setting('role',true),'none') in('none','postgres','supabase_admin'))) then
    if tg_op='INSERT' then
      v_sync:=new.source_managed and new.source_schedule_id=v_context.source_schedule_id
        and new.created_by=v_context.source_author
        and exists(select 1 from public.study_group_schedule s where s.id=new.source_schedule_id and s.group_id=new.group_id)
        and exists(select 1 from public.study_group_seminar_subjects s where s.id=new.subject_id and s.group_id=new.group_id
          and public.xelay_academic_subject_key(s.name)=public.xelay_academic_subject_key(v_context.subject_name));
    elsif tg_op='UPDATE' then
      v_sync:=old.source_managed and new.source_managed and old.source_schedule_id=v_context.source_reference_id
        and new.id=old.id and new.group_id=old.group_id and new.subject_id=old.subject_id
        and new.created_by=old.created_by and new.created_at=old.created_at
        and new.teaching_course_id is not distinct from old.teaching_course_id;
      -- FK SET NULL may run before the source's AFTER DELETE projection.
      v_sync:=v_sync or(old.source_managed and new.source_managed and old.source_schedule_id is null
        and v_context.source_schedule_id is null and new.source_schedule_id is null
        and (to_jsonb(new)-array['source_active','updated_at','teaching_version'])
          is not distinct from(to_jsonb(old)-array['source_active','updated_at','teaching_version']));
    end if;
  end if;
  if tg_op='UPDATE' and old.source_managed and old.source_schedule_id is not null
    and new.source_schedule_id is null and not exists(select 1 from public.study_group_schedule where id=old.source_schedule_id)
    and (to_jsonb(new)-array['source_schedule_id','updated_at','teaching_version'])
      is not distinct from(to_jsonb(old)-array['source_schedule_id','updated_at','teaching_version']) then
    new.source_active:=false;
    return new;
  end if;
  if not v_sync and ((tg_op='INSERT' and(new.source_managed or new.source_schedule_id is not null
      or not new.source_active or new.week_pattern<>'every' or new.week_anchor_date is not null or cardinality(new.excluded_dates)>0))
    or(tg_op<>'INSERT' and old.source_managed)
    or(tg_op='UPDATE' and(new.source_managed is distinct from old.source_managed
      or new.source_schedule_id is distinct from old.source_schedule_id
      or new.source_active is distinct from old.source_active
      or new.week_pattern is distinct from old.week_pattern
      or new.week_anchor_date is distinct from old.week_anchor_date or new.excluded_dates is distinct from old.excluded_dates))) then
    raise exception 'SEMINAR_SOURCE_SCHEDULE_MANAGED' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.xelay_guard_seminar_schedule_projection() from public,anon,authenticated,service_role;
drop trigger if exists academic_projection_schedule_guard on public.study_group_seminar_schedule;
create trigger academic_projection_schedule_guard before insert or update or delete on public.study_group_seminar_schedule
  for each row execute function public.xelay_guard_seminar_schedule_projection();

create or replace function public.xelay_guard_seminar_projection_date()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_slot public.study_group_seminar_schedule%rowtype;
begin
  select * into v_slot from public.study_group_seminar_schedule where id=new.schedule_id
    and group_id=new.group_id and subject_id=new.subject_id;
  if not found or not v_slot.source_managed then return new; end if;
  if tg_op='UPDATE' and new.schedule_id=old.schedule_id and new.lesson_date=old.lesson_date
    and new.subject_id=old.subject_id and new.group_id=old.group_id then
    -- Editing existing work on a cancelled/retired source retains its actual
    -- chronology, rather than silently moving its deadline to the new template.
    new.starts_at:=old.starts_at; new.ends_at:=old.ends_at;
  elsif not public.xelay_seminar_schedule_occurs_on_date(v_slot,new.lesson_date) then
    raise exception 'SEMINAR_DATE_MISMATCH' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function public.xelay_guard_seminar_projection_date() from public,anon,authenticated,service_role;
drop trigger if exists academic_projection_date_guard on public.study_group_seminars;
create trigger academic_projection_date_guard before insert or update on public.study_group_seminars
  for each row execute function public.xelay_guard_seminar_projection_date();

create or replace function public.xelay_private_sync_schedule_projection(
  p_source_id uuid,p_group_id uuid,p_subject text,p_author uuid,p_deleted boolean
)
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_source public.study_group_schedule%rowtype; v_subject uuid; v_slot uuid; v_key text; v_name text;
begin
  if auth.uid() is not null and pg_trigger_depth()<1 then
    raise exception 'ACADEMIC_PROJECTION_ORIGIN_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from public.study_groups where id=p_group_id) then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||p_group_id::text,0));
  if not p_deleted then
    select * into v_source from public.study_group_schedule where id=p_source_id and group_id=p_group_id;
    if not found or v_source.subject is distinct from p_subject or v_source.created_by is distinct from p_author then
      raise exception 'ACADEMIC_PROJECTION_SOURCE_MISMATCH' using errcode='42501'; end if;
  elsif exists(select 1 from public.study_group_schedule where id=p_source_id) then
    raise exception 'ACADEMIC_PROJECTION_SOURCE_MISMATCH' using errcode='42501';
  end if;
  insert into public.study_group_schedule_projection_context(transaction_id,backend_pid,group_id,source_schedule_id,
    source_reference_id,subject_name,source_author)
    values(txid_current(),pg_backend_pid(),p_group_id,case when p_deleted then null else p_source_id end,p_source_id,p_subject,p_author);
  if not p_deleted then
    v_key:=public.xelay_academic_subject_key(p_subject);
    v_name:=btrim(regexp_replace(p_subject,'[[:space:]'||chr(160)||chr(5760)||chr(8192)||'-'||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||']+',' ','g'));
    select id into v_subject from public.study_group_seminar_subjects where group_id=p_group_id
      and public.xelay_academic_subject_key(name)=v_key order by created_at,id limit 1;
    if v_subject is null then
      insert into public.study_group_seminar_subjects(group_id,name,created_by,has_schedule_sources)
        values(p_group_id,v_name,p_author,true) returning id into v_subject;
    end if;
    if not exists(select 1 from public.study_group_material_subjects where group_id=p_group_id
      and public.xelay_academic_subject_key(name)=v_key) then
      insert into public.study_group_material_subjects(group_id,name,created_by,has_schedule_sources)
        values(p_group_id,v_name,p_author,true);
    end if;
  end if;
  -- Retire mismatched projections; never delete them or touch their dated work.
  update public.study_group_seminar_schedule set source_active=false,updated_at=clock_timestamp()
    where group_id=p_group_id and source_schedule_id=p_source_id and source_managed and source_active
      and(p_deleted or v_source.lesson_type<>'seminar' or subject_id is distinct from v_subject);
  if not p_deleted and v_source.lesson_type='seminar' then
    select id into v_slot from public.study_group_seminar_schedule
      where group_id=p_group_id and source_schedule_id=p_source_id and source_managed and subject_id=v_subject
      order by source_active desc,created_at,id limit 1;
    if v_slot is null then
      insert into public.study_group_seminar_schedule(group_id,subject_id,weekday,starts_at,ends_at,valid_from,valid_until,
        created_by,source_schedule_id,source_managed,source_active,week_pattern,week_anchor_date,excluded_dates)
        values(p_group_id,v_subject,v_source.weekday,v_source.starts_at,v_source.ends_at,v_source.valid_from,v_source.valid_until,
          p_author,p_source_id,true,true,v_source.week_pattern,v_source.week_anchor_date,v_source.excluded_dates);
    else
      update public.study_group_seminar_schedule set weekday=v_source.weekday,starts_at=v_source.starts_at,ends_at=v_source.ends_at,
        valid_from=v_source.valid_from,valid_until=v_source.valid_until,source_active=true,
        week_pattern=v_source.week_pattern,week_anchor_date=v_source.week_anchor_date,excluded_dates=v_source.excluded_dates,
        updated_at=clock_timestamp()
        where id=v_slot and (weekday,starts_at,ends_at,valid_from,valid_until,source_active,week_pattern,week_anchor_date,excluded_dates)
          is distinct from(v_source.weekday,v_source.starts_at,v_source.ends_at,v_source.valid_from,v_source.valid_until,true,
            v_source.week_pattern,v_source.week_anchor_date,v_source.excluded_dates);
    end if;
  end if;
  update public.study_group_seminar_subjects s set has_schedule_sources=exists(select 1 from public.study_group_schedule x
    where x.group_id=s.group_id and public.xelay_academic_subject_key(x.subject)=public.xelay_academic_subject_key(s.name))
    where s.group_id=p_group_id and s.has_schedule_sources is distinct from exists(select 1 from public.study_group_schedule x
      where x.group_id=s.group_id and public.xelay_academic_subject_key(x.subject)=public.xelay_academic_subject_key(s.name));
  update public.study_group_material_subjects s set has_schedule_sources=exists(select 1 from public.study_group_schedule x
    where x.group_id=s.group_id and public.xelay_academic_subject_key(x.subject)=public.xelay_academic_subject_key(s.name))
    where s.group_id=p_group_id and s.has_schedule_sources is distinct from exists(select 1 from public.study_group_schedule x
      where x.group_id=s.group_id and public.xelay_academic_subject_key(x.subject)=public.xelay_academic_subject_key(s.name));
  delete from public.study_group_schedule_projection_context where transaction_id=txid_current()
    and backend_pid=pg_backend_pid() and group_id=p_group_id;
end $$;
revoke all on function public.xelay_private_sync_schedule_projection(uuid,uuid,text,uuid,boolean)
  from public,anon,authenticated,service_role;

create or replace function public.xelay_sync_schedule_academic_projection()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    perform public.xelay_private_sync_schedule_projection(old.id,old.group_id,old.subject,old.created_by,true);
    return old;
  end if;
  perform public.xelay_private_sync_schedule_projection(new.id,new.group_id,new.subject,new.created_by,false);
  return new;
end $$;
revoke all on function public.xelay_sync_schedule_academic_projection() from public,anon,authenticated,service_role;
drop trigger if exists study_group_schedule_academic_projection on public.study_group_schedule;
create trigger study_group_schedule_academic_projection after insert or update or delete on public.study_group_schedule
  for each row execute function public.xelay_sync_schedule_academic_projection();

-- Keep public RPC signatures, ACLs and the mature resource/reservation checks.
-- Only replace the old weekday/range date test and use stored dated chronology
-- when editing an existing occurrence. Assert every expected anchor so drift
-- fails the migration instead of silently omitting an access/date guard.
do $$
declare v_body text; v_old text; v_new text;
begin
  select pg_get_functiondef('public.xelay_save_seminar_subject(uuid,uuid,text)'::regprocedure) into v_body;
  v_body:=replace(v_body,'not between 1 and 120','not between 1 and 180');
  execute v_body;
  select pg_get_functiondef('public.xelay_delete_seminar_subject(uuid)'::regprocedure) into v_body;
  if position('academic_projection_subject_contract' in v_body)=0 then
    v_old:='perform public.xelay_lock_seminar_group(v_group_id, true);';
    v_new:=v_old||'
  -- academic_projection_subject_contract
  if exists(select 1 from public.study_group_seminar_subjects s join public.study_group_schedule x on x.group_id=s.group_id
    and public.xelay_academic_subject_key(x.subject)=public.xelay_academic_subject_key(s.name)
    where s.id=p_subject_id and s.group_id=v_group_id) then
    raise exception ''SUBJECT_SOURCE_MANAGED'' using errcode=''42501'';
  end if;';
    if position(v_old in v_body)=0 then raise exception 'Unexpected seminar subject delete contract'; end if;
    execute replace(v_body,v_old,v_new);
  end if;
  select pg_get_functiondef('public.xelay_delete_material_subject(uuid,uuid)'::regprocedure) into v_body;
  if position('academic_projection_subject_contract' in v_body)=0 then
    v_old:='perform public.xelay_lock_study_group_permission(p_group_id,''materials'',true);';
    v_new:=v_old||'
  -- academic_projection_subject_contract
  if exists(select 1 from public.study_group_material_subjects s join public.study_group_schedule x on x.group_id=s.group_id
    and public.xelay_academic_subject_key(x.subject)=public.xelay_academic_subject_key(s.name)
    where s.id=p_subject_id and s.group_id=p_group_id) then
    raise exception ''MATERIAL_SUBJECT_SOURCE_MANAGED'' using errcode=''42501'';
  end if;';
    if position(v_old in v_body)=0 then raise exception 'Unexpected material subject delete contract'; end if;
    execute replace(v_body,v_old,v_new);
  end if;
  select pg_get_functiondef('public.xelay_save_seminar_schedule(uuid,uuid,uuid,integer,time without time zone,time without time zone,date,date)'::regprocedure) into v_body;
  if position('academic_projection_schedule_contract' in v_body)=0 then
    v_old:='perform public.xelay_lock_seminar_group(p_group_id, true);';
    v_new:=v_old||'
  -- academic_projection_schedule_contract
  if exists(select 1 from public.study_group_seminar_schedule where id=p_schedule_id and group_id=p_group_id and source_managed) then
    raise exception ''SEMINAR_SOURCE_SCHEDULE_MANAGED'' using errcode=''42501'';
  end if;';
    if position(v_old in v_body)=0 then raise exception 'Unexpected seminar schedule write contract'; end if;
    execute replace(v_body,v_old,v_new);
  end if;
  select pg_get_functiondef('public.xelay_delete_seminar_schedule(uuid)'::regprocedure) into v_body;
  if position('academic_projection_schedule_contract' in v_body)=0 then
    v_old:='perform public.xelay_lock_seminar_group(v_group_id, true);';
    v_new:=v_old||'
  -- academic_projection_schedule_contract
  if exists(select 1 from public.study_group_seminar_schedule where id=p_schedule_id and group_id=v_group_id and source_managed) then
    raise exception ''SEMINAR_SOURCE_SCHEDULE_MANAGED'' using errcode=''42501'';
  end if;';
    if position(v_old in v_body)=0 then raise exception 'Unexpected seminar schedule delete contract'; end if;
    execute replace(v_body,v_old,v_new);
  end if;
  select pg_get_functiondef('public.xelay_classroom_seminars(uuid,uuid)'::regprocedure) into v_body;
  if position('academic_projection_retained_schedule_contract' in v_body)=0 then
    v_old:='and s.valid_from<=v_course.ends_on and s.valid_until>=v_course.starts_on),''[]''::jsonb),';
    v_new:='-- academic_projection_retained_schedule_contract: only already-authorized dated sessions.
          and ((s.valid_from<=v_course.ends_on and s.valid_until>=v_course.starts_on)
            or exists(select 1 from sessions dated where dated.schedule_id=s.id
              and dated.group_id=s.group_id and dated.subject_id=s.subject_id))),''[]''::jsonb),';
    if position(v_old in v_body)=0 then raise exception 'Unexpected classroom seminar schedule read contract'; end if;
    execute replace(v_body,v_old,v_new);
  end if;
  select pg_get_functiondef('public.xelay_save_seminar(uuid,uuid,uuid,date,text,text,text,jsonb,jsonb)'::regprocedure) into v_body;
  if position('academic_projection_date_contract' in v_body)=0 then
    v_old:='if extract(isodow from p_lesson_date)::integer <> v_schedule.weekday
    or p_lesson_date not between v_schedule.valid_from and v_schedule.valid_until then raise exception ''SEMINAR_DATE_MISMATCH''; end if;';
    v_new:='-- academic_projection_date_contract: existing work survives source cancellation.
  if not (exists(select 1 from public.study_group_seminars s where s.id=p_seminar_id and s.group_id=p_group_id
      and s.schedule_id=p_schedule_id and s.lesson_date=p_lesson_date)
    or public.xelay_seminar_schedule_occurs_on_date(v_schedule,p_lesson_date)) then raise exception ''SEMINAR_DATE_MISMATCH''; end if;
  if exists(select 1 from public.study_group_seminars s where s.id=p_seminar_id and s.group_id=p_group_id
    and s.schedule_id=p_schedule_id and s.lesson_date=p_lesson_date) then
    select starts_at,ends_at into v_schedule.starts_at,v_schedule.ends_at from public.study_group_seminars
      where id=p_seminar_id and group_id=p_group_id;
  end if;';
    if position(v_old in v_body)=0 then raise exception 'Unexpected xelay_save_seminar date contract'; end if;
    execute replace(v_body,v_old,v_new);
  end if;
  select pg_get_functiondef('public.xelay_classroom_seminar_mutate(text,jsonb)'::regprocedure) into v_body;
  if position('academic_projection_date_contract' in v_body)=0 then
    v_old:='or extract(isodow from v_date)::integer<>v_schedule.weekday or v_date not between v_schedule.valid_from and v_schedule.valid_until then';
    v_new:='-- academic_projection_date_contract
    or not (exists(select 1 from public.study_group_seminars s where s.id=v_id and s.group_id=v_group
        and s.subject_id=v_subject and s.schedule_id=v_schedule.id and s.lesson_date=v_date)
      or public.xelay_seminar_schedule_occurs_on_date(v_schedule,v_date)) then';
    if position(v_old in v_body)=0 then raise exception 'Unexpected classroom seminar date contract'; end if;
    v_body:=replace(v_body,v_old,v_new);
    v_old:='if public.xelay_seminar_start(v_date,v_schedule.starts_at)<=clock_timestamp() then raise exception ''SEMINAR_LOCKED''; end if;';
    v_new:='if exists(select 1 from public.study_group_seminars s where s.id=v_id and s.group_id=v_group
      and s.subject_id=v_subject and s.schedule_id=v_schedule.id and s.lesson_date=v_date) then
    select starts_at,ends_at into v_schedule.starts_at,v_schedule.ends_at from public.study_group_seminars where id=v_id and group_id=v_group;
  end if;
  if public.xelay_seminar_start(v_date,v_schedule.starts_at)<=clock_timestamp() then raise exception ''SEMINAR_LOCKED''; end if;';
    if position(v_old in v_body)=0 then raise exception 'Unexpected classroom seminar chronology contract'; end if;
    execute replace(v_body,v_old,v_new);
  end if;
end $$;

-- Existing manual rows/assignments retain their IDs and contents. Operator
-- migration has no auth actor, so the existing notification producer is silent.
do $$ declare v_source public.study_group_schedule%rowtype; begin
  for v_source in select * from public.study_group_schedule order by group_id,id loop
    perform public.xelay_private_sync_schedule_projection(v_source.id,v_source.group_id,v_source.subject,v_source.created_by,false);
  end loop;
end $$;

comment on column public.study_group_seminar_schedule.source_managed is
  'Timetable projection; edit the source lesson. Retired slots and all dated work remain stored.';
comment on column public.study_group_seminar_subjects.has_schedule_sources is
  'Current timetable names use this subject. Rename/remove the source timetable subjects first.';
comment on column public.study_group_material_subjects.has_schedule_sources is
  'Current timetable names use this subject. Existing material topics and files are never copied or removed by synchronization.';
notify pgrst,'reload schema';
commit;
