-- Reopen selection, not class chronology. Existing dates, rotation history,
-- teacher privacy, licensing and group/deputy advisory locks stay authoritative.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $preflight$
begin
  if to_regprocedure('public.xelay_current_academic_year()') is null
    or to_regprocedure('public.xelay_lock_seminar_group(uuid,boolean)') is null
    or to_regprocedure('public.xelay_can_view_seminars(uuid)') is null
    or position('xelay_lock_study_group_permission(p_group_id,''seminars'',true)' in pg_get_functiondef('public.xelay_lock_seminar_group(uuid,boolean)'::regprocedure))=0
    or position('Rotation of primary/supplement roles is advisory' in pg_get_functiondef('public.xelay_assert_seminar_streaks(uuid,uuid)'::regprocedure))=0
    or position('academic_projection_date_contract' in pg_get_functiondef('public.xelay_save_seminar(uuid,uuid,uuid,date,text,text,text,jsonb,jsonb)'::regprocedure))=0
    or position('TEACHING_SEMINARS_MANAGED_BY_GROUP' in pg_get_functiondef('public.xelay_classroom_seminar_mutate(text,jsonb)'::regprocedure))=0 then
    raise exception 'SEMINAR_SELECTION_REOPEN_PREREQUISITES';
  end if;
end;
$preflight$;

alter table public.study_group_seminars
  add column selection_deadline_at timestamptz check(selection_deadline_at is null or isfinite(selection_deadline_at)),
  add column selection_version integer not null default 0 check(selection_version>=0);

create function public.xelay_seminar_selection_current_date(p_date date)
returns boolean language sql volatile set search_path='' as $$
  select p_date is not null and isfinite(p_date) and extract(year from p_date)::integer
    - case when extract(month from p_date)<9 then 1 else 0 end = extract(year from n.kyiv_now)::integer
      - case when extract(month from n.kyiv_now)<9 then 1 else 0 end
  from(select clock_timestamp() at time zone 'Europe/Kyiv' kyiv_now)n;
$$;
create function public.xelay_seminar_selection_is_open(p_seminar_id uuid)
returns boolean language sql volatile security definer set search_path='' as $$
  select exists(select 1 from public.study_group_seminars s where s.id=p_seminar_id
    and public.xelay_seminar_selection_current_date(s.lesson_date)
    and coalesce(s.selection_deadline_at,public.xelay_seminar_start(s.lesson_date,s.starts_at))>clock_timestamp());
$$;
create function public.xelay_seminar_selection_edit_target(p_group_id uuid,p_seminar_id uuid,p_schedule_id uuid,p_date date,p_start time,p_end time)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare v_old public.study_group_seminars%rowtype;
begin
  if not public.xelay_seminar_selection_current_date(p_date) then return false; end if;
  if p_seminar_id is null then return public.xelay_seminar_start(p_date,p_start)>clock_timestamp(); end if;
  select * into v_old from public.study_group_seminars where id=p_seminar_id and group_id=p_group_id;
  if not found or not public.xelay_seminar_selection_is_open(p_seminar_id) then return false; end if;
  if public.xelay_seminar_start(v_old.lesson_date,v_old.starts_at)<=clock_timestamp() then
    return p_schedule_id=v_old.schedule_id and p_date=v_old.lesson_date and p_start=v_old.starts_at and p_end=v_old.ends_at;
  end if;
  return public.xelay_seminar_start(p_date,p_start)>clock_timestamp();
end;
$$;

create function public.xelay_assert_reopened_seminar_items(p_seminar_id uuid,p_format text,p_questions jsonb,p_teams jsonb)
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_seminar public.study_group_seminars%rowtype;v_question record;v_team record;v_item jsonb;
begin
  if p_seminar_id is null then return; end if;
  select * into v_seminar from public.study_group_seminars where id=p_seminar_id;
  if not found or public.xelay_seminar_start(v_seminar.lesson_date,v_seminar.starts_at)>clock_timestamp() then return; end if;
  for v_question in select q.* from public.study_group_seminar_questions q where q.seminar_id=p_seminar_id
    and exists(select 1 from public.study_group_seminar_reservations r where r.question_id=q.id) loop
    select value into v_item from jsonb_array_elements(p_questions) where value->>'id'=v_question.id::text;
    if not found or p_format not in('questions','booking') or btrim(v_item->>'body') is distinct from v_question.body
      or (v_item->>'primary_capacity')::integer is distinct from v_question.primary_capacity
      or coalesce((v_item->>'supplement_capacity')::integer,v_question.supplement_capacity) is distinct from v_question.supplement_capacity then
      raise exception 'SEMINAR_OCCUPIED_ITEM_IMMUTABLE' using errcode='22023';
    end if;
  end loop;
  for v_team in select t.* from public.study_group_seminar_teams t where t.seminar_id=p_seminar_id
    and exists(select 1 from public.study_group_seminar_reservations r where r.team_id=t.id) loop
    select value into v_item from jsonb_array_elements(p_teams) where value->>'id'=v_team.id::text;
    if not found or p_format<>'teams' or btrim(v_item->>'name') is distinct from v_team.name
      or (v_item->>'capacity')::integer is distinct from v_team.capacity then
      raise exception 'SEMINAR_OCCUPIED_ITEM_IMMUTABLE' using errcode='22023';
    end if;
  end loop;
end;
$$;

create function public.xelay_set_seminar_selection_deadline(p_group_id uuid,p_seminar_id uuid,p_deadline timestamptz,p_expected_version integer)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_seminar public.study_group_seminars%rowtype;v_deadline timestamptz;
begin
  perform public.xelay_lock_seminar_group(p_group_id,true);
  select * into v_seminar from public.study_group_seminars where id=p_seminar_id and group_id=p_group_id for update;
  if not found then raise exception 'SEMINAR_NOT_FOUND' using errcode='22023'; end if;
  if not public.xelay_seminar_selection_current_date(v_seminar.lesson_date) then raise exception 'SEMINAR_SELECTION_ARCHIVE_READ_ONLY' using errcode='42501'; end if;
  if p_expected_version is null or p_expected_version<>v_seminar.selection_version then raise exception 'SEMINAR_SELECTION_CONFLICT' using errcode='PT409'; end if;
  if p_deadline is not null and(not isfinite(p_deadline) or p_deadline<=clock_timestamp()) then raise exception 'SEMINAR_SELECTION_DEADLINE_INVALID' using errcode='22023'; end if;
  -- NULL is an explicit close command. Initial NULL only exists on untouched
  -- rows and means the original Kyiv class start, never an indefinite window.
  v_deadline:=coalesce(p_deadline,clock_timestamp());
  update public.study_group_seminars set selection_deadline_at=v_deadline,selection_version=selection_version+1,updated_at=clock_timestamp()
    where id=p_seminar_id and group_id=p_group_id returning * into v_seminar;
  return jsonb_build_object('seminar_id',v_seminar.id,'selection_deadline_at',v_seminar.selection_deadline_at,'selection_version',v_seminar.selection_version);
end;
$$;

-- Patch only known gates in the current authoritative group RPCs. All other
-- code, signatures, owner, EXECUTE ACLs, projection and licensing checks remain.
create function pg_temp.xelay_selection_patch(p_signature text,p_old text,p_new text)
returns void language plpgsql as $$
declare v_oid oid:=to_regprocedure(p_signature);v_definition text;v_metadata jsonb;v_after jsonb;
begin
  if v_oid is null then raise exception 'SEMINAR_SELECTION_PATCH_MISSING: %',p_signature; end if;
  select to_jsonb(p)-array['prosrc','xmin','cmin','xmax','cmax','ctid'] into v_metadata from pg_proc p where oid=v_oid;
  v_definition:=replace(pg_get_functiondef(v_oid),chr(13),'');
  if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then raise exception 'SEMINAR_SELECTION_SOURCE_DRIFT: %',p_signature; end if;
  execute replace(v_definition,p_old,p_new);
  select to_jsonb(p)-array['prosrc','xmin','cmin','xmax','cmax','ctid'] into v_after from pg_proc p where oid=v_oid;
  if v_after is distinct from v_metadata then raise exception 'SEMINAR_SELECTION_SECURITY_CHANGED: %',p_signature; end if;
end;
$$;

select pg_temp.xelay_selection_patch('public.xelay_save_seminar(uuid,uuid,uuid,date,text,text,text,jsonb,jsonb)',
  $old$if public.xelay_seminar_start(p_lesson_date, v_schedule.starts_at) <= clock_timestamp() then raise exception 'SEMINAR_LOCKED'; end if;$old$,
  $new$if not public.xelay_seminar_selection_edit_target(p_group_id,p_seminar_id,p_schedule_id,p_lesson_date,v_schedule.starts_at,v_schedule.ends_at) then raise exception 'SEMINAR_LOCKED'; end if;$new$);
select pg_temp.xelay_selection_patch('public.xelay_save_seminar(uuid,uuid,uuid,date,text,text,text,jsonb,jsonb)',
  $old$if public.xelay_seminar_start(v_old.lesson_date, v_old.starts_at) <= clock_timestamp() then raise exception 'SEMINAR_LOCKED'; end if;$old$,
  $new$if not public.xelay_seminar_selection_is_open(v_old.id) then raise exception 'SEMINAR_LOCKED'; end if;
    perform public.xelay_assert_reopened_seminar_items(v_old.id,p_format,p_questions,p_teams);$new$);
do $patch_mutations$
declare v_signature text;
begin
  foreach v_signature in array array['public.xelay_reserve_seminar(uuid,text,uuid)','public.xelay_cancel_seminar_reservation(uuid)','public.xelay_delete_seminar(uuid)'] loop
    perform pg_temp.xelay_selection_patch(v_signature,
      $old$if public.xelay_seminar_start(v_seminar.lesson_date, v_seminar.starts_at) <= clock_timestamp() then raise exception 'SEMINAR_LOCKED'; end if;$old$,
      $new$if not public.xelay_seminar_selection_is_open(v_seminar.id) then raise exception 'SEMINAR_LOCKED'; end if;$new$);
  end loop;
end;
$patch_mutations$;
select pg_temp.xelay_selection_patch('public.xelay_delete_seminar(uuid)',
  $old$  delete from public.study_group_seminars where id = p_seminar_id and group_id = v_group_id;$old$,
  $new$  if exists(select 1 from public.study_group_seminar_reservations where seminar_id=p_seminar_id) then raise exception 'SEMINAR_HAS_RESERVATIONS'; end if;
  delete from public.study_group_seminars where id = p_seminar_id and group_id = v_group_id;$new$);
select pg_temp.xelay_selection_patch('public.xelay_delete_seminar_subject(uuid)',
  $old$  delete from public.study_group_seminar_subjects where id = p_subject_id and group_id = v_group_id;$old$,
  $new$  if exists(select 1 from public.study_group_seminars s join public.study_group_seminar_reservations r on r.seminar_id=s.id where s.subject_id=p_subject_id) then raise exception 'SEMINAR_HAS_RESERVATIONS'; end if;
  delete from public.study_group_seminar_subjects where id = p_subject_id and group_id = v_group_id;$new$);
select pg_temp.xelay_selection_patch('public.xelay_delete_seminar_schedule(uuid)',
  $old$  delete from public.study_group_seminar_schedule where id = p_schedule_id and group_id = v_group_id;$old$,
  $new$  if exists(select 1 from public.study_group_seminars s join public.study_group_seminar_reservations r on r.seminar_id=s.id where s.schedule_id=p_schedule_id) then raise exception 'SEMINAR_HAS_RESERVATIONS'; end if;
  delete from public.study_group_seminar_schedule where id = p_schedule_id and group_id = v_group_id;$new$);

create table public.xelay_seminar_team_creation_receipts(
  team_id uuid primary key,group_id uuid not null,seminar_id uuid not null,user_id uuid not null,
  name text not null,capacity integer not null check(capacity between 1 and 50),
  created_at timestamptz not null default clock_timestamp(),unique(seminar_id,user_id)
);
alter table public.xelay_seminar_team_creation_receipts enable row level security;
revoke all on public.xelay_seminar_team_creation_receipts from public,anon,authenticated,service_role;

create function public.xelay_create_seminar_team(p_group_id uuid,p_seminar_id uuid,p_team_id uuid,p_name text,p_capacity integer)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_seminar public.study_group_seminars%rowtype;v_team public.study_group_seminar_teams%rowtype;
  v_receipt public.xelay_seminar_team_creation_receipts%rowtype;v_position integer;v_name text:=btrim(p_name);
begin
  perform public.xelay_lock_seminar_group(p_group_id,false);
  select * into v_seminar from public.study_group_seminars where id=p_seminar_id and group_id=p_group_id;
  if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
  if not public.xelay_seminar_selection_is_open(p_seminar_id) then raise exception 'SEMINAR_LOCKED'; end if;
  if v_seminar.format<>'teams' or p_team_id is null or v_name is null or length(v_name) not between 1 and 80
    or v_name ~ '[[:cntrl:]]' or p_capacity is null or p_capacity not between 1 and 50 then raise exception 'SEMINAR_INVALID_INPUT'; end if;
  -- A globally reused client UUID must not race another group's receipt. Keep
  -- the group lock first and recheck the real clock after this additional wait.
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminar-team-create:'||p_team_id::text,0));
  if not public.xelay_seminar_selection_is_open(p_seminar_id) then raise exception 'SEMINAR_LOCKED'; end if;
  select * into v_receipt from public.xelay_seminar_team_creation_receipts where team_id=p_team_id;
  if found then
    if v_receipt.user_id<>auth.uid() or v_receipt.group_id<>p_group_id or v_receipt.seminar_id<>p_seminar_id or v_receipt.name<>v_name or v_receipt.capacity<>p_capacity then raise exception 'SEMINAR_TEAM_CONFLICT' using errcode='PT409'; end if;
    select * into v_team from public.study_group_seminar_teams where id=p_team_id and seminar_id=p_seminar_id;
    if not found or v_team.name<>v_name or v_team.capacity<>p_capacity then raise exception 'SEMINAR_TEAM_CONFLICT' using errcode='PT409'; end if;
    return to_jsonb(v_team);
  end if;
  if exists(select 1 from public.xelay_seminar_team_creation_receipts where seminar_id=p_seminar_id and user_id=auth.uid()) then raise exception 'SEMINAR_TEAM_ALREADY_CREATED' using errcode='PT409'; end if;
  if exists(select 1 from public.study_group_seminar_reservations where seminar_id=p_seminar_id and user_id=auth.uid()) then raise exception 'SEMINAR_ALREADY_RESERVED' using errcode='PT409'; end if;
  if exists(select 1 from public.study_group_seminar_teams where id=p_team_id or(seminar_id=p_seminar_id and lower(btrim(name))=lower(v_name))) then raise exception 'SEMINAR_TEAM_CONFLICT' using errcode='PT409'; end if;
  select slots.position into v_position from generate_series(1,30) as slots(position) where not exists(select 1 from public.study_group_seminar_teams t where t.seminar_id=p_seminar_id and t.position=slots.position) order by slots.position limit 1;
  if v_position is null then raise exception 'SEMINAR_TEAM_LIMIT' using errcode='22023'; end if;
  insert into public.study_group_seminar_teams(id,seminar_id,position,name,capacity) values(p_team_id,p_seminar_id,v_position,v_name,p_capacity) returning * into v_team;
  perform public.xelay_reserve_seminar(p_seminar_id,'team',p_team_id);
  insert into public.xelay_seminar_team_creation_receipts(team_id,group_id,seminar_id,user_id,name,capacity) values(p_team_id,p_group_id,p_seminar_id,auth.uid(),v_name,p_capacity);
  return to_jsonb(v_team);
end;
$$;

create function public.xelay_open_seminar_selections(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_ids uuid[];v_now timestamptz:=clock_timestamp();
begin
  if not public.xelay_can_view_seminars(p_group_id) then raise exception 'SEMINAR_MEMBER_REQUIRED' using errcode='42501'; end if;
  select coalesce(array_agg(id order by selection_deadline_at,lesson_date,id),'{}'::uuid[]) into v_ids from public.study_group_seminars
    where group_id=p_group_id and selection_deadline_at>v_now and public.xelay_seminar_selection_current_date(lesson_date);
  return jsonb_build_object(
    'seminars',coalesce((select jsonb_agg(to_jsonb(s) order by selection_deadline_at,lesson_date,id) from public.study_group_seminars s where id=any(v_ids)),'[]'::jsonb),
    'schedule',coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.study_group_seminar_schedule t where group_id=p_group_id and id in(select schedule_id from public.study_group_seminars where id=any(v_ids))),'[]'::jsonb),
    'occupancy',coalesce((select jsonb_agg(jsonb_build_object('seminar_id',q.seminar_id,'question_id',q.question_id,'team_id',q.team_id,'role',q.role,'count',q.n) order by q.seminar_id,q.role,q.question_id,q.team_id)
      from(select seminar_id,question_id,team_id,role,count(*)::integer n from public.study_group_seminar_reservations where seminar_id=any(v_ids) group by seminar_id,question_id,team_id,role)q),'[]'::jsonb));
end;
$$;

revoke all on function public.xelay_seminar_selection_current_date(date),public.xelay_seminar_selection_is_open(uuid),
  public.xelay_seminar_selection_edit_target(uuid,uuid,uuid,date,time,time),public.xelay_assert_reopened_seminar_items(uuid,text,jsonb,jsonb),
  public.xelay_set_seminar_selection_deadline(uuid,uuid,timestamptz,integer),public.xelay_create_seminar_team(uuid,uuid,uuid,text,integer),public.xelay_open_seminar_selections(uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_set_seminar_selection_deadline(uuid,uuid,timestamptz,integer),public.xelay_create_seminar_team(uuid,uuid,uuid,text,integer),public.xelay_open_seminar_selections(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
