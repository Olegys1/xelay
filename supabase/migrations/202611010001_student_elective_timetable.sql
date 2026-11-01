-- Private student elective timetables. Prepared locally; applying this migration
-- does not configure anybody's choices or change existing group lessons.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$ begin
  if to_regclass('public.study_group_schedule') is null or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_groups') is null or to_regclass('public.profiles') is null or to_regclass('auth.users') is null
    or to_regprocedure('public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date)') is null then
    raise exception 'STUDENT_ELECTIVE_PREREQUISITES_MISSING';
  end if;
end $preflight$;

alter table public.study_group_schedule add column if not exists is_elective_block boolean not null default false;
comment on column public.study_group_schedule.is_elective_block is 'A shared elective placeholder, set only through existing schedule permissions. Personal choices never update this row.';

-- The existing broad group helpers also admit admins/pending invitees. Personal
-- elective access intentionally requires the actual owner/accepted membership.
create or replace function public.xelay_can_manage_own_student_electives(p_group_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and exists(
    select 1 from auth.users u join public.profiles p on p.id=u.id
    where u.id=auth.uid() and u.email_confirmed_at is not null and u.deleted_at is null
      and(u.banned_until is null or u.banned_until<=clock_timestamp())
      and(exists(select 1 from public.study_groups g where g.id=p_group_id and g.representative_id=u.id)
        or exists(select 1 from public.study_group_members m where m.group_id=p_group_id and m.user_id=u.id and m.status='accepted'))
  );
$$;
revoke all on function public.xelay_can_manage_own_student_electives(uuid) from public,anon,service_role;
grant execute on function public.xelay_can_manage_own_student_electives(uuid) to authenticated;

create or replace function public.xelay_student_elective_text(p_value text,p_max integer,p_required boolean default false)
returns text language plpgsql immutable security definer set search_path='' as $$
declare v text;
begin
  if p_value is null then v:=''; else v:=btrim(regexp_replace(p_value,'[[:space:]]+',' ','g')); end if;
  if p_value ~ '[[:cntrl:]]' or p_value ~ U&'[\0080-\009F\202A-\202E\2066-\2069]'
    or char_length(v)>p_max or p_required and v='' then
    raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';
  end if;
  return v;
end $$;
revoke all on function public.xelay_student_elective_text(text,integer,boolean) from public,anon,authenticated,service_role;

create or replace function public.xelay_student_elective_url(p_value text)
returns text language plpgsql immutable security definer set search_path='' as $$
declare v text:=public.xelay_student_elective_text(p_value,2000,false);
begin
  if v='' then return null; end if;
  if v !~* '^https?://[^/?#@[:space:]]+([/?#][^[:space:]]*)?$' then
    raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';
  end if;
  return v;
end $$;
revoke all on function public.xelay_student_elective_url(text) from public,anon,authenticated,service_role;

create or replace function public.xelay_normalize_student_elective_lessons(p_lessons jsonb,p_from date,p_until date)
returns jsonb language plpgsql immutable security definer set search_path='' as $$
declare v_item jsonb; v_link jsonb; v_result jsonb:='[]'; v_links jsonb; v_id uuid;
  v_week text; v_anchor date; v_start time; v_end time; v_subject text; v_type text;
begin
  if p_from is null or p_until is null or p_from<date '2000-01-01' or p_until>=date '2100-01-01' or p_until<p_from or p_until-p_from>366 then
    raise exception 'STUDENT_ELECTIVE_TERM_INVALID' using errcode='22023';
  end if;
  if p_lessons is null or jsonb_typeof(p_lessons)<>'array' or jsonb_array_length(p_lessons)>20 or octet_length(p_lessons::text)>128000 then
    raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_lessons) loop
    if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k<>all(array[
      'id','subject','weekday','starts_at','ends_at','lesson_type','teacher_name','location','online_url','online_url_secondary',
      'online_url_label','online_url_secondary_label','online_links_extra','conference_id','conference_access_code','week_pattern','week_anchor_date']))
      or not(v_item ?& array['id','subject','weekday','starts_at','ends_at','lesson_type'])
      or exists(select 1 from unnest(array['id','subject','starts_at','ends_at','lesson_type']) k where jsonb_typeof(v_item->k)<>'string')
      or jsonb_typeof(v_item->'weekday')<>'number' or(v_item->>'weekday')!~'^[1-7]$'
      or exists(select 1 from unnest(array['teacher_name','location','online_url','online_url_secondary','online_url_label','online_url_secondary_label','conference_id','conference_access_code','week_pattern','week_anchor_date']) k where v_item ? k and jsonb_typeof(v_item->k) not in('string','null')) then
      raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';
    end if;
    if(v_item->>'id')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or(v_item->>'starts_at')!~'^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$' or(v_item->>'ends_at')!~'^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$' then
      raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';
    end if;
    v_id:=(v_item->>'id')::uuid;
    if v_id='00000000-0000-0000-0000-000000000000'::uuid or exists(select 1 from jsonb_array_elements(v_result) x where(x->>'id')::uuid=v_id) then
      raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';
    end if;
    v_start:=(v_item->>'starts_at')::time;v_end:=(v_item->>'ends_at')::time;
    if v_end<=v_start then raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';end if;
    v_subject:=public.xelay_student_elective_text(v_item->>'subject',120,true);v_type:=v_item->>'lesson_type';
    if v_type not in('lecture','seminar','practical','lab','makeup','replacement','module','final_assessment','test','other') then
      raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';
    end if;
    v_week:=coalesce(v_item->>'week_pattern','every');v_anchor:=null;
    if v_week not in('every','upper','lower') then raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';end if;
    if v_week<>'every' then
      if coalesce(v_item->>'week_anchor_date','')!~'^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';end if;
      begin v_anchor:=(v_item->>'week_anchor_date')::date; exception when others then raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';end;
      if extract(isodow from v_anchor)<>1 then raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';end if;
    end if;
    v_links:='[]';
    if v_item ? 'online_links_extra' and jsonb_typeof(v_item->'online_links_extra')<>'null' then
      if jsonb_typeof(v_item->'online_links_extra')<>'array' or jsonb_array_length(v_item->'online_links_extra')>18 then raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';end if;
      for v_link in select value from jsonb_array_elements(v_item->'online_links_extra') loop
        if jsonb_typeof(v_link)<>'object' or exists(select 1 from jsonb_object_keys(v_link) k where k not in('url','label'))
          or jsonb_typeof(v_link->'url') is distinct from 'string' or(v_link ? 'label' and jsonb_typeof(v_link->'label') not in('string','null')) then
          raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';
        end if;
        if btrim(v_link->>'url')='' and coalesce(btrim(v_link->>'label'),'')='' then continue;end if;
        if public.xelay_student_elective_url(v_link->>'url') is null then raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';end if;
        v_links:=v_links||jsonb_build_array(jsonb_build_object('url',public.xelay_student_elective_url(v_link->>'url'),'label',public.xelay_student_elective_text(v_link->>'label',80,false)));
      end loop;
    end if;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_id,'subject',v_subject,'weekday',(v_item->>'weekday')::integer,
      'starts_at',to_char(v_start,'HH24:MI'),'ends_at',to_char(v_end,'HH24:MI'),'lesson_type',v_type,
      'teacher_name',public.xelay_student_elective_text(v_item->>'teacher_name',180,false),'location',public.xelay_student_elective_text(v_item->>'location',160,false),
      'online_url',public.xelay_student_elective_url(v_item->>'online_url'),'online_url_secondary',public.xelay_student_elective_url(v_item->>'online_url_secondary'),
      'online_url_label',nullif(public.xelay_student_elective_text(v_item->>'online_url_label',80,false),''),'online_url_secondary_label',nullif(public.xelay_student_elective_text(v_item->>'online_url_secondary_label',80,false),''),
      'online_links_extra',v_links,'conference_id',nullif(public.xelay_student_elective_text(v_item->>'conference_id',120,false),''),
      'conference_access_code',nullif(public.xelay_student_elective_text(v_item->>'conference_access_code',120,false),''),'week_pattern',v_week,'week_anchor_date',v_anchor));
  end loop;
  if octet_length(v_result::text)>128000 then raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(v_result) with ordinality a(v,n) cross join jsonb_array_elements(v_result) with ordinality b(v,n)
    where a.n<b.n and(a.v->>'weekday')=(b.v->>'weekday') and(a.v->>'starts_at')::time<(b.v->>'ends_at')::time and(b.v->>'starts_at')::time<(a.v->>'ends_at')::time
      and exists(select 1 from generate_series(p_from::timestamp,p_until::timestamp,interval '1 day') d(day)
        where public.xelay_schedule_occurs_on_date((a.v->>'weekday')::smallint,p_from,p_until,a.v->>'week_pattern',(a.v->>'week_anchor_date')::date,d.day::date)
          and public.xelay_schedule_occurs_on_date((b.v->>'weekday')::smallint,p_from,p_until,b.v->>'week_pattern',(b.v->>'week_anchor_date')::date,d.day::date))) then
    raise exception 'STUDENT_ELECTIVE_OVERLAP' using errcode='22023';
  end if;
  return v_result;
end $$;
revoke all on function public.xelay_normalize_student_elective_lessons(jsonb,date,date) from public,anon,authenticated,service_role;

create table if not exists public.student_elective_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  valid_from date not null,valid_until date not null,configured boolean not null default true,
  version integer not null default 1 check(version between 1 and 1000000),
  lessons jsonb not null default '[]'::jsonb check(jsonb_typeof(lessons)='array' and jsonb_array_length(lessons)<=20 and octet_length(lessons::text)<=128000),
  created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
  constraint student_elective_term_check check(valid_from>=date '2000-01-01' and valid_until<date '2100-01-01' and valid_until>=valid_from and valid_until-valid_from<=366),
  constraint student_elective_owner_term_unique unique(user_id,group_id,valid_from,valid_until)
);
create index if not exists student_elective_owner_group_idx on public.student_elective_plans(user_id,group_id,valid_from,valid_until);
alter table public.student_elective_plans enable row level security;
revoke all on table public.student_elective_plans from public,anon,authenticated,service_role;
grant select on table public.student_elective_plans to authenticated;
drop policy if exists "Students read only their own active group elective plans" on public.student_elective_plans;
create policy "Students read only their own active group elective plans" on public.student_elective_plans for select to authenticated
  using(user_id=auth.uid() and public.xelay_can_manage_own_student_electives(group_id));

drop function if exists public.xelay_save_student_elective_plan(uuid,date,date,jsonb,integer,boolean);
create or replace function public.xelay_save_student_elective_plan(p_group_id uuid,p_valid_from date,p_valid_until date,p_lessons jsonb,p_expected_version integer default null,p_configured boolean default true,p_plan_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_previous public.student_elective_plans;v_saved public.student_elective_plans;v_lessons jsonb;
begin
  if auth.role() is distinct from 'authenticated' or v_user is null or not public.xelay_can_manage_own_student_electives(p_group_id) then
    raise exception 'STUDENT_ELECTIVE_MEMBER_REQUIRED' using errcode='42501';
  end if;
  if p_configured is null or p_expected_version is not null and p_expected_version not between 1 and 999999
    or p_plan_id is not null and(p_plan_id='00000000-0000-0000-0000-000000000000'::uuid or p_expected_version is null) then raise exception 'STUDENT_ELECTIVE_INVALID' using errcode='22023';end if;
  v_lessons:=public.xelay_normalize_student_elective_lessons(p_lessons,p_valid_from,p_valid_until);
  -- Serializes every term edit of this one owner's one group; different students
  -- never share a lock or a writable configuration.
  perform pg_advisory_xact_lock(hashtextextended('student-electives:'||v_user::text||':'||p_group_id::text,0));
  if not exists(select 1 from public.study_group_schedule s where s.group_id=p_group_id and s.is_elective_block
    and s.valid_from<=p_valid_until and s.valid_until>=p_valid_from
    and exists(select 1 from generate_series(greatest(s.valid_from,p_valid_from)::timestamp,least(s.valid_until,p_valid_until)::timestamp,interval '1 day') d(day)
      where public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,coalesce(s.week_pattern,'every'),s.week_anchor_date,d.day::date)
        and not(d.day::date=any(coalesce(s.excluded_dates,'{}'::date[]))))) then
    raise exception 'STUDENT_ELECTIVE_BLOCK_REQUIRED' using errcode='22023';
  end if;
  select * into v_previous from public.student_elective_plans p where p.user_id=v_user and p.group_id=p_group_id
    and(case when p_plan_id is not null then p.id=p_plan_id else p.valid_from=p_valid_from and p.valid_until=p_valid_until end) for update;
  if found then
    if p_expected_version is distinct from v_previous.version then raise exception 'STUDENT_ELECTIVE_CONFLICT' using errcode='P0001';end if;
  elsif p_expected_version is not null then raise exception 'STUDENT_ELECTIVE_CONFLICT' using errcode='P0001';
  elsif(select count(*) from public.student_elective_plans p where p.user_id=v_user and p.group_id=p_group_id)>=32 then raise exception 'STUDENT_ELECTIVE_TOO_MANY_TERMS' using errcode='22023';
  end if;
  if exists(select 1 from public.student_elective_plans p where p.user_id=v_user and p.group_id=p_group_id and p.valid_from<=p_valid_until and p.valid_until>=p_valid_from and p.id is distinct from v_previous.id) then
    raise exception 'STUDENT_ELECTIVE_TERM_CONFLICT' using errcode='P0001';
  end if;
  if not public.xelay_can_manage_own_student_electives(p_group_id) then raise exception 'STUDENT_ELECTIVE_MEMBER_REQUIRED' using errcode='42501';end if;
  if v_previous.id is not null then
    update public.student_elective_plans set valid_from=p_valid_from,valid_until=p_valid_until,lessons=v_lessons,configured=p_configured,version=version+1,updated_at=clock_timestamp() where id=v_previous.id and user_id=v_user returning * into v_saved;
  else
    insert into public.student_elective_plans(user_id,group_id,valid_from,valid_until,configured,lessons) values(v_user,p_group_id,p_valid_from,p_valid_until,p_configured,v_lessons) returning * into v_saved;
  end if;
  return to_jsonb(v_saved);
end $$;
revoke all on function public.xelay_save_student_elective_plan(uuid,date,date,jsonb,integer,boolean,uuid) from public,anon,service_role;
grant execute on function public.xelay_save_student_elective_plan(uuid,date,date,jsonb,integer,boolean,uuid) to authenticated;

create or replace function public.xelay_remove_student_elective_plan(p_id uuid,p_expected_version integer)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare v_plan public.student_elective_plans;v_user uuid:=auth.uid();
begin
  if auth.role() is distinct from 'authenticated' or v_user is null then raise exception 'STUDENT_ELECTIVE_MEMBER_REQUIRED' using errcode='42501';end if;
  select * into v_plan from public.student_elective_plans where id=p_id and user_id=v_user;
  if not found then raise exception 'STUDENT_ELECTIVE_NOT_FOUND' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('student-electives:'||v_user::text||':'||v_plan.group_id::text,0));
  select * into v_plan from public.student_elective_plans where id=p_id and user_id=v_user for update;
  if not found or not public.xelay_can_manage_own_student_electives(v_plan.group_id) then raise exception 'STUDENT_ELECTIVE_MEMBER_REQUIRED' using errcode='42501';end if;
  if p_expected_version is distinct from v_plan.version then raise exception 'STUDENT_ELECTIVE_CONFLICT' using errcode='P0001';end if;
  delete from public.student_elective_plans where id=p_id and user_id=v_user;
  return true;
end $$;
revoke all on function public.xelay_remove_student_elective_plan(uuid,integer) from public,anon,service_role;
grant execute on function public.xelay_remove_student_elective_plan(uuid,integer) to authenticated;

-- Copying a shared placeholder retains only its shared flag. No personal row is
-- copied, connected to a colleague, or changed by a shared schedule operation.
create or replace function public.xelay_copy_schedule_elective_flag()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.copied_from_schedule_id is not null and(tg_op='INSERT' or new.copied_from_schedule_id is distinct from old.copied_from_schedule_id) then
    select s.is_elective_block into new.is_elective_block from public.study_group_schedule s where s.id=new.copied_from_schedule_id and s.group_id=new.group_id;
    new.is_elective_block:=coalesce(new.is_elective_block,false);
  end if;
  return new;
end $$;
revoke all on function public.xelay_copy_schedule_elective_flag() from public,anon,authenticated,service_role;
drop trigger if exists study_group_schedule_elective_copy on public.study_group_schedule;
create trigger study_group_schedule_elective_copy before insert or update of copied_from_schedule_id on public.study_group_schedule for each row execute function public.xelay_copy_schedule_elective_flag();
comment on table public.student_elective_plans is 'Private owner/group/term elective timetable, max20 personal meetings. Accepted member/representative only. No colleague/admin/teacher visibility by role alone. Shared schedule, homework and teaching permissions remain unchanged.';
commit;
