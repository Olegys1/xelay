-- Explicit category coefficients and atomic draft entry. Published scores and
-- historical grading rules are never rewritten by this migration.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if to_regprocedure('public.xelay_teaching_mutate(text,jsonb)') is null
    or to_regprocedure('public.xelay_teaching_lock_course(uuid,text)') is null
    or to_regprocedure('public.xelay_teaching_assert_user()') is null
    or to_regprocedure('public.xelay_teaching_validate_rules(jsonb)') is null then
    raise exception 'TEACHING_GRADING_PREREQUISITES_MISSING';
  end if;
end $$;

create or replace function public.xelay_teaching_validate_rules(p_rules jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_category jsonb;v_seen text[]:='{}';v_max numeric;v_coefficient numeric;
begin
  if p_rules is null or jsonb_typeof(p_rules)<>'object' or octet_length(p_rules::text)>20000
    or jsonb_typeof(p_rules->'categories') is distinct from 'array'
    or jsonb_array_length(p_rules->'categories')>30 then return false; end if;
  if p_rules ? 'rounding' and (jsonb_typeof(p_rules->'rounding') is distinct from 'string'
      or p_rules->>'rounding' not in('none','integer','hundredth')) then return false; end if;
  if p_rules ? 'total_max' then
    if jsonb_typeof(p_rules->'total_max') is distinct from 'number' then return false; end if;
    v_max:=(p_rules->>'total_max')::numeric;
    if v_max<=0 or v_max>10000 then return false; end if;
  end if;
  for v_category in select value from jsonb_array_elements(p_rules->'categories') loop
    if jsonb_typeof(v_category)<>'object' or length(coalesce(v_category->>'id','')) not between 1 and 100
      or length(btrim(coalesce(v_category->>'name',''))) not between 1 and 180
      or jsonb_typeof(v_category->'max_points') is distinct from 'number'
      or(v_category->>'id')=any(v_seen) then return false; end if;
    v_max:=(v_category->>'max_points')::numeric;
    if v_max<=0 or v_max>10000 then return false; end if;
    if v_category ? 'coefficient' then
      if jsonb_typeof(v_category->'coefficient') is distinct from 'number' then return false; end if;
      v_coefficient:=(v_category->>'coefficient')::numeric;
      if v_coefficient<0 or v_coefficient>100 or scale(v_coefficient)>4 then return false; end if;
    end if;
    v_seen:=array_append(v_seen,v_category->>'id');
  end loop;
  return true;
exception when others then return false;
end $$;

create table public.teaching_grade_batch_receipts(
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  activity_id uuid not null references public.teaching_activities(id) on delete cascade,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,request_id)
);
alter table public.teaching_grade_batch_receipts enable row level security;
revoke all on table public.teaching_grade_batch_receipts from public,anon,authenticated,service_role;

create function public.xelay_save_teaching_grades_batch(
  p_request_id uuid,p_course_id uuid,p_group_id uuid,p_activity_id uuid,
  p_expected_user_id uuid,p_rows jsonb
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_activity public.teaching_activities%rowtype;
  v_row jsonb;v_payload jsonb;v_receipt public.teaching_grade_batch_receipts%rowtype;
  v_result jsonb;v_version text;v_entry_id uuid;
begin
  if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  if p_request_id is null or p_course_id is null or p_group_id is null or p_activity_id is null
    or jsonb_typeof(p_rows) is distinct from 'array'
    or jsonb_array_length(p_rows) not between 1 and 500 or octet_length(p_rows::text)>3000000 then
    raise exception 'TEACHING_INVALID_INPUT'; end if;
  -- Current course permissions and accepted link are checked even on replay.
  perform pg_advisory_xact_lock(hashtextextended('xelay:grade-batch:'||v_uid::text||':'||p_request_id::text,0));
  perform public.xelay_teaching_lock_course(p_course_id,'grades');
  select * into v_activity from public.teaching_activities
    where id=p_activity_id and course_id=p_course_id and group_id=p_group_id for update;
  if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
  if not exists(select 1 from public.teaching_course_groups
    where course_id=p_course_id and group_id=p_group_id and status='accepted') then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  v_payload:=jsonb_build_object('course_id',p_course_id,'group_id',p_group_id,'activity_id',p_activity_id,'rows',p_rows);
  select * into v_receipt from public.teaching_grade_batch_receipts where user_id=v_uid and request_id=p_request_id;
  if found then
    if v_receipt.payload is distinct from v_payload then raise exception 'TEACHING_CONFLICT'; end if;
    return v_receipt.result;
  end if;
  if (select count(*) from jsonb_array_elements(p_rows)) is distinct from
    (select count(distinct (value->>'entry_id')::uuid) from jsonb_array_elements(p_rows)) then
    raise exception 'TEACHING_INVALID_INPUT'; end if;
  -- Whitelist all fields before delegating. The existing one-grade command owns
  -- score limits, audit/revision reasons and exact grade-version validation.
  for v_row in select value from jsonb_array_elements(p_rows) order by value->>'entry_id' loop
    if jsonb_typeof(v_row) is distinct from 'object'
      or(v_row-array['entry_id','score','comment','reason','version'])<>'{}'::jsonb
      or jsonb_typeof(v_row->'entry_id') is distinct from 'string'
      or not(v_row ? 'score') or (v_row->'score'<>'null'::jsonb and jsonb_typeof(v_row->'score') is distinct from 'number')
      or jsonb_typeof(v_row->'comment') is distinct from 'string'
      or jsonb_typeof(v_row->'reason') is distinct from 'string'
      or jsonb_typeof(v_row->'version') is distinct from 'number' then
      raise exception 'TEACHING_INVALID_INPUT'; end if;
    v_version:=v_row->>'version';
    if v_version !~ '^[0-9]{1,9}$' then raise exception 'TEACHING_INVALID_INPUT'; end if;
    v_entry_id:=(v_row->>'entry_id')::uuid;
    if not exists(select 1 from public.teaching_entries e where e.id=v_entry_id
      and e.course_id=p_course_id and e.group_id=p_group_id and e.active) then
      raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    perform public.xelay_teaching_mutate('save_grade',jsonb_build_object(
      'course_id',p_course_id,'activity_id',p_activity_id,'entry_id',v_entry_id,
      'score',v_row->'score','comment',v_row->>'comment','reason',v_row->>'reason','version',v_version::integer));
  end loop;
  v_result:=jsonb_build_object('id',p_activity_id,'count',jsonb_array_length(p_rows),'request_id',p_request_id);
  insert into public.teaching_grade_batch_receipts(user_id,request_id,course_id,activity_id,payload,result)
    values(v_uid,p_request_id,p_course_id,p_activity_id,v_payload,v_result);
  return v_result;
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation then
  raise exception 'TEACHING_INVALID_INPUT' using errcode='22023';
end $$;
revoke all on function public.xelay_save_teaching_grades_batch(uuid,uuid,uuid,uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_save_teaching_grades_batch(uuid,uuid,uuid,uuid,uuid,jsonb) to authenticated;

comment on function public.xelay_teaching_validate_rules(jsonb) is
  'Optional coefficient defaults to 1; final-sum rounding defaults to none. Category and total caps keep their original meanings. Raw published grades are unchanged.';
comment on function public.xelay_save_teaching_grades_batch(uuid,uuid,uuid,uuid,uuid,jsonb) is
  'Atomic own-authorized course/group/activity draft entry; reuses per-grade validation and audit, with private idempotency receipts. Publication remains a separate command.';
notify pgrst,'reload schema';
commit;
