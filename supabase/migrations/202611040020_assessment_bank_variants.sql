-- Local preparation only. Private course banks and frozen individual variants.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

alter table public.teaching_tests add column shuffle_questions boolean not null default false,
  add column shuffle_answers boolean not null default false,add column draw_count integer,
  add column overrides jsonb not null default '[]',
  add constraint teaching_test_draw_count_valid check(draw_count is null or draw_count between 1 and 100);
alter table public.teaching_test_attempts add column questions jsonb;
-- Preserve the exact sequence layout already shown to pre-migration attempts.
update public.teaching_test_attempts a set questions=(select jsonb_agg(case when q->>'kind'='sequence'
  then jsonb_set(q,'{options}',(select jsonb_agg(o order by md5(a.id::text||(o->>'id'))) from jsonb_array_elements(q->'options')o))
  else q end order by n) from jsonb_array_elements(t.questions) with ordinality x(q,n))
  from public.teaching_tests t where t.id=a.test_id;
alter table public.teaching_test_attempts alter column questions set not null;

create table public.teaching_question_bank(
  id uuid primary key default gen_random_uuid(),course_id uuid not null references public.teaching_courses(id) on delete cascade,
  category text not null default '',tags text[] not null default '{}',question jsonb not null,
  version integer not null default 1,created_by uuid not null references public.profiles(id),
  archived_at timestamptz,created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
  check(length(category)<=120 and cardinality(tags)<=20)
);
create index teaching_question_bank_course_idx on public.teaching_question_bank(course_id,updated_at desc);
alter table public.teaching_question_bank enable row level security;
revoke all on public.teaching_question_bank from public,anon,authenticated,service_role;

-- A deliberately small recursive-descent arithmetic grammar. It never evaluates
-- JavaScript, SQL, function calls, powers, property access or regular expressions.
create function public.xelay_private_assessment_parse(p_text text,p_vars jsonb,p_pos integer,p_mode integer,p_depth integer)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_pos integer:=p_pos;v_result jsonb;v_value numeric;v_right numeric;v_char text;v_token text;
begin
  if p_depth>30 or length(p_text)>500 then raise exception 'TEST_INVALID_FORMULA';end if;
  while substr(p_text,v_pos,1)~'^[[:space:]]$' loop v_pos:=v_pos+1;end loop;
  if p_mode<2 then
    v_result:=public.xelay_private_assessment_parse(p_text,p_vars,v_pos,p_mode+1,p_depth+1);
    v_value:=(v_result->>'value')::numeric;v_pos:=(v_result->>'pos')::integer;
    loop
      while substr(p_text,v_pos,1)~'^[[:space:]]$' loop v_pos:=v_pos+1;end loop;
      v_char:=substr(p_text,v_pos,1);
      exit when (p_mode=0 and v_char not in('+','-')) or(p_mode=1 and v_char not in('*','/'));
      v_result:=public.xelay_private_assessment_parse(p_text,p_vars,v_pos+1,p_mode+1,p_depth+1);
      v_right:=(v_result->>'value')::numeric;v_pos:=(v_result->>'pos')::integer;
      if v_char='+' then v_value:=v_value+v_right;
      elsif v_char='-' then v_value:=v_value-v_right;
      elsif v_char='*' then v_value:=v_value*v_right;
      elsif v_right=0 then raise exception 'TEST_INVALID_FORMULA';
      else v_value:=v_value/v_right;end if;
      if abs(v_value)>1000000000000 then raise exception 'TEST_INVALID_FORMULA';end if;
    end loop;
  else
    v_char:=substr(p_text,v_pos,1);
    if v_char in('+','-') then
      v_result:=public.xelay_private_assessment_parse(p_text,p_vars,v_pos+1,2,p_depth+1);
      v_value:=(v_result->>'value')::numeric*case when v_char='-' then -1 else 1 end;v_pos:=(v_result->>'pos')::integer;
    elsif v_char='(' then
      v_result:=public.xelay_private_assessment_parse(p_text,p_vars,v_pos+1,0,p_depth+1);
      v_value:=(v_result->>'value')::numeric;v_pos:=(v_result->>'pos')::integer;
      while substr(p_text,v_pos,1)~'^[[:space:]]$' loop v_pos:=v_pos+1;end loop;
      if substr(p_text,v_pos,1)<>')' then raise exception 'TEST_INVALID_FORMULA';end if;v_pos:=v_pos+1;
    elsif v_char~'^[A-Za-z]$' then
      v_token:=substring(substr(p_text,v_pos) from '^[A-Za-z][A-Za-z0-9_]{0,19}');
      if jsonb_typeof(p_vars->v_token) is distinct from 'number' then raise exception 'TEST_INVALID_FORMULA';end if;
      v_value:=(p_vars->>v_token)::numeric;v_pos:=v_pos+length(v_token);
    else
      v_token:=substring(substr(p_text,v_pos) from '^([0-9]+([.][0-9]*)?|[.][0-9]+)');
      if v_token is null or length(v_token)>30 then raise exception 'TEST_INVALID_FORMULA';end if;
      v_value:=v_token::numeric;v_pos:=v_pos+length(v_token);
    end if;
  end if;
  if v_value is null or abs(v_value)>1000000000000 then raise exception 'TEST_INVALID_FORMULA';end if;
  return jsonb_build_object('value',v_value,'pos',v_pos);
end $$;
create function public.xelay_private_assessment_arithmetic(p_text text,p_vars jsonb)
returns numeric language plpgsql immutable set search_path='' as $$
declare v_result jsonb;v_pos integer;
begin
  if length(btrim(coalesce(p_text,''))) not between 1 and 500 or jsonb_typeof(p_vars)<>'object' then raise exception 'TEST_INVALID_FORMULA';end if;
  v_result:=public.xelay_private_assessment_parse(p_text,p_vars,1,0,0);v_pos:=(v_result->>'pos')::integer;
  if btrim(substr(p_text,v_pos))<>'' then raise exception 'TEST_INVALID_FORMULA';end if;
  return (v_result->>'value')::numeric;
end $$;

alter function public.xelay_private_test_validate_question(jsonb) rename to xelay_private_test_validate_question_before_phase1;
create function public.xelay_private_test_validate_question(p_question jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_kind text:=p_question->>'kind';v_answer jsonb:=p_question->'answer';v_ids text[];v_gap jsonb;v_var jsonb;v_values jsonb:='{}';
  v_min numeric;v_max numeric;v_step numeric;v_number numeric;
begin
  if v_kind in('choice','boolean','sorting','sequence') then
    -- Choice imports may have between two and thirty answers, rather than four.
    if v_kind='choice' and jsonb_array_length(p_question->'options')<>4 then
      return public.xelay_private_test_validate_question_before_phase1(jsonb_set(p_question,'{kind}','"boolean"')||
        jsonb_build_object('kind','sequence','answer',(select jsonb_agg(o->>'id') from jsonb_array_elements(p_question->'options')o)))
        and jsonb_typeof(v_answer)='string' and exists(select 1 from jsonb_array_elements(p_question->'options')o where o->>'id'=v_answer#>>'{}');
    end if;
    return public.xelay_private_test_validate_question_before_phase1(p_question);
  end if;
  if jsonb_typeof(p_question)<>'object' or coalesce(p_question->>'id','')!~'^[A-Za-z0-9_-]{1,64}$'
    or length(btrim(coalesce(p_question->>'text',''))) not between 1 and 10000
    or v_kind not in('multiple','short_text','numerical','calculated','cloze','essay')
    or jsonb_typeof(p_question->'points') is distinct from 'number' or(p_question->>'points')::numeric<=0
    or(p_question->>'points')::numeric>10000 or scale((p_question->>'points')::numeric)>2
    or jsonb_typeof(p_question->'partial_credit') is distinct from 'boolean'
    or jsonb_typeof(p_question->'options') is distinct from 'array' or jsonb_typeof(p_question->'buckets') is distinct from 'array'
    or jsonb_array_length(p_question->'buckets')<>0 then return false;end if;
  if p_question->'time_limit_seconds'<>'null'::jsonb and(p_question->'time_limit_seconds' is null
    or jsonb_typeof(p_question->'time_limit_seconds')<>'number' or(p_question->>'time_limit_seconds')::numeric not between 1 and 86400
    or trunc((p_question->>'time_limit_seconds')::numeric)<>(p_question->>'time_limit_seconds')::numeric) then return false;end if;
  if v_kind='multiple' then
    if jsonb_array_length(p_question->'options') not between 2 and 30 or jsonb_typeof(v_answer)<>'array'
      or jsonb_array_length(v_answer) not between 1 and jsonb_array_length(p_question->'options') then return false;end if;
    v_ids:=array(select o->>'id' from jsonb_array_elements(p_question->'options')o);
    return cardinality(v_ids)=(select count(distinct x) from unnest(v_ids)x)
      and not exists(select 1 from jsonb_array_elements(p_question->'options')o where coalesce(o->>'id','')!~'^[A-Za-z0-9_-]{1,64}$'
        or length(btrim(coalesce(o->>'text',''))) not between 1 and 2000)
      and not exists(select 1 from jsonb_array_elements(v_answer)a where jsonb_typeof(a)<>'string' or not(a#>>'{}')=any(v_ids))
      and jsonb_array_length(v_answer)=(select count(distinct a#>>'{}') from jsonb_array_elements(v_answer)a);
  end if;
  if jsonb_array_length(p_question->'options')<>0 then return false;end if;
  if p_question?'case_sensitive' and jsonb_typeof(p_question->'case_sensitive')<>'boolean' then return false;end if;
  if v_kind='essay' then return v_answer is null or v_answer='null'::jsonb;end if;
  if v_kind='short_text' then
    return jsonb_typeof(v_answer)='array' and jsonb_array_length(v_answer) between 1 and 30
      and not exists(select 1 from jsonb_array_elements(v_answer)a where jsonb_typeof(a)<>'string' or length(btrim(a#>>'{}')) not between 1 and 2000);
  end if;
  if v_kind='cloze' then
    if jsonb_typeof(p_question->'gaps') is distinct from 'array' or jsonb_array_length(p_question->'gaps') not between 1 and 20 then return false;end if;
    v_ids:=array(select g->>'id' from jsonb_array_elements(p_question->'gaps')g);
    if cardinality(v_ids)<>(select count(distinct x) from unnest(v_ids)x) then return false;end if;
    for v_gap in select value from jsonb_array_elements(p_question->'gaps') loop
      if coalesce(v_gap->>'id','')!~'^[A-Za-z0-9_-]{1,32}$' or position('{{'||(v_gap->>'id')||'}}' in(p_question->>'text'))=0
        or jsonb_typeof(v_gap->'answers') is distinct from 'array' or jsonb_array_length(v_gap->'answers') not between 1 and 30
        or exists(select 1 from jsonb_array_elements(v_gap->'answers')a where jsonb_typeof(a)<>'string' or length(btrim(a#>>'{}')) not between 1 and 2000) then return false;end if;
    end loop;return true;
  end if;
  if jsonb_typeof(p_question->'tolerance') is distinct from 'number' or(p_question->>'tolerance')::numeric not between 0 and 1000000000 then return false;end if;
  if v_kind='numerical' then
    return jsonb_typeof(v_answer)='string' and(v_answer#>>'{}')~'^[-+]?[0-9]+([.][0-9]+)?$' and abs((v_answer#>>'{}')::numeric)<=1000000000000;
  end if;
  if jsonb_typeof(p_question->'calculation') is distinct from 'object'
    or jsonb_typeof(p_question->'calculation'->'variables') is distinct from 'array'
    or jsonb_array_length(p_question->'calculation'->'variables') not between 1 and 10 then return false;end if;
  v_ids:=array(select x->>'name' from jsonb_array_elements(p_question->'calculation'->'variables')x);
  if cardinality(v_ids)<>(select count(distinct x) from unnest(v_ids)x) then return false;end if;
  for v_var in select value from jsonb_array_elements(p_question->'calculation'->'variables') loop
    if coalesce(v_var->>'name','')!~'^[A-Za-z][A-Za-z0-9_]{0,19}$'
      or jsonb_typeof(v_var->'min') is distinct from 'number' or jsonb_typeof(v_var->'max') is distinct from 'number'
      or jsonb_typeof(v_var->'step') is distinct from 'number' then return false;end if;
    v_min:=(v_var->>'min')::numeric;v_max:=(v_var->>'max')::numeric;v_step:=(v_var->>'step')::numeric;
    if abs(v_min)>1000000 or abs(v_max)>1000000 or v_max<v_min or v_step<=0 or(v_max-v_min)/v_step>10000 then return false;end if;
    v_values:=v_values||jsonb_build_object(v_var->>'name',v_min);
  end loop;
  v_number:=public.xelay_private_assessment_arithmetic(p_question->'calculation'->>'formula',v_values);return true;
exception when others then return false;
end $$;

alter function public.xelay_private_test_valid_answer(jsonb,jsonb) rename to xelay_private_test_valid_answer_before_phase1;
create function public.xelay_private_test_valid_answer(p_question jsonb,p_answer jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_kind text:=p_question->>'kind';v_ids text[];
begin
  if p_answer is null or p_answer='null'::jsonb then return true;end if;
  if v_kind in('choice','boolean','sequence','sorting') then return public.xelay_private_test_valid_answer_before_phase1(p_question,p_answer);end if;
  if v_kind='multiple' then
    v_ids:=array(select o->>'id' from jsonb_array_elements(p_question->'options')o);
    return jsonb_typeof(p_answer)='array' and jsonb_array_length(p_answer)<=cardinality(v_ids)
      and jsonb_array_length(p_answer)=(select count(distinct a#>>'{}') from jsonb_array_elements(p_answer)a)
      and not exists(select 1 from jsonb_array_elements(p_answer)a where jsonb_typeof(a)<>'string' or not(a#>>'{}')=any(v_ids));
  elsif v_kind='cloze' then
    v_ids:=array(select g->>'id' from jsonb_array_elements(p_question->'gaps')g);
    return jsonb_typeof(p_answer)='object' and(select count(*) from jsonb_object_keys(p_answer))<=cardinality(v_ids)
      and not exists(select 1 from jsonb_each(p_answer)x where not x.key=any(v_ids) or jsonb_typeof(x.value)<>'string' or length(x.value#>>'{}')>2000);
  elsif v_kind in('numerical','calculated') then
    return jsonb_typeof(p_answer)='string' and length(p_answer#>>'{}')<=100
      and (btrim(p_answer#>>'{}')='' or replace(btrim(p_answer#>>'{}'),',','.')~'^[-+]?[0-9]+([.][0-9]+)?$');
  end if;
  return v_kind in('short_text','essay') and jsonb_typeof(p_answer)='string' and length(p_answer#>>'{}')<=case when v_kind='essay' then 20000 else 2000 end;
exception when others then return false;
end $$;

create function public.xelay_private_assessment_text_equal(p_actual text,p_expected text,p_case boolean)
returns boolean language sql immutable set search_path='' as $$
  select case when p_case then regexp_replace(btrim(p_actual),'[[:space:]]+',' ','g')=regexp_replace(btrim(p_expected),'[[:space:]]+',' ','g')
    else lower(regexp_replace(btrim(p_actual),'[[:space:]]+',' ','g'))=lower(regexp_replace(btrim(p_expected),'[[:space:]]+',' ','g')) end;
$$;
alter function public.xelay_private_test_question_points(jsonb,jsonb) rename to xelay_private_test_question_points_before_phase1;
create function public.xelay_private_test_question_points(p_question jsonb,p_answer jsonb)
returns numeric language plpgsql immutable set search_path='' as $$
declare v_kind text:=p_question->>'kind';v_points numeric:=(p_question->>'points')::numeric;v_correct numeric;v_wrong numeric;v_count numeric;
begin
  if p_answer is null or p_answer='null'::jsonb then return 0;end if;
  if not public.xelay_private_test_valid_answer(p_question,p_answer) then return 0;end if;
  if v_kind in('choice','boolean','sorting','sequence') then return public.xelay_private_test_question_points_before_phase1(p_question,p_answer);end if;
  if v_kind='essay' then return 0;end if;
  if v_kind='short_text' then
    return case when exists(select 1 from jsonb_array_elements_text(p_question->'answer')a
      where public.xelay_private_assessment_text_equal(p_answer#>>'{}',a,coalesce((p_question->>'case_sensitive')::boolean,false))) then v_points else 0 end;
  elsif v_kind in('numerical','calculated') then
    if btrim(p_answer#>>'{}')='' then return 0;end if;
    return case when abs(replace(btrim(p_answer#>>'{}'),',','.')::numeric-(p_question->>'answer')::numeric)<=(p_question->>'tolerance')::numeric then v_points else 0 end;
  elsif v_kind='multiple' then
    v_count:=jsonb_array_length(p_question->'answer');
    select count(*) filter(where(p_question->'answer')?x),count(*) filter(where not(p_question->'answer')?x)
      into v_correct,v_wrong from jsonb_array_elements_text(p_answer)x;
    if not(p_question->>'partial_credit')::boolean then return case when v_correct=v_count and v_wrong=0 then v_points else 0 end;end if;
    return v_points*greatest(0,v_correct/v_count-v_wrong/greatest(1,jsonb_array_length(p_question->'options')-v_count));
  elsif v_kind='cloze' then
    v_count:=jsonb_array_length(p_question->'gaps');
    select count(*) into v_correct from jsonb_array_elements(p_question->'gaps')g where exists(select 1 from jsonb_array_elements_text(g->'answers')a
      where public.xelay_private_assessment_text_equal(p_answer->>(g->>'id'),a,coalesce((p_question->>'case_sensitive')::boolean,false)));
    return case when v_correct=v_count then v_points when(p_question->>'partial_credit')::boolean then v_points*v_correct/v_count else 0 end;
  end if;return 0;
exception when others then return 0;
end $$;

create function public.xelay_private_assessment_snapshot(p_test public.teaching_tests,p_attempt uuid)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_question jsonb;v_questions jsonb:='[]';v_var jsonb;v_values jsonb;v_steps bigint;v_index bigint;v_value numeric;v_text text;
  v_try integer;v_valid boolean;v_answer numeric;
begin
  for v_question in select q from jsonb_array_elements(p_test.questions) with ordinality x(q,n)
    order by case when p_test.shuffle_questions or p_test.draw_count is not null then md5(p_attempt::text||':'||(q->>'id')) else lpad(n::text,5,'0') end
    limit coalesce(p_test.draw_count,jsonb_array_length(p_test.questions)) loop
    if v_question->>'kind'='calculated' then
      -- A valid template can contain individual undefined combinations, such as
      -- 1/a with a in [-1,1]. Retry deterministically, then use the minimum
      -- vector already checked when the teacher saved the question. The bound
      -- prevents enumeration and every successful variant is frozen as usual.
      v_valid:=false;
      for v_try in 0..31 loop
        v_values:='{}';v_text:=v_question->>'text';
        for v_var in select value from jsonb_array_elements(v_question->'calculation'->'variables') loop
          v_steps:=floor(((v_var->>'max')::numeric-(v_var->>'min')::numeric)/(v_var->>'step')::numeric)::bigint;
          v_index:=('x'||substr(md5(p_attempt::text||':'||(v_question->>'id')||':'||(v_var->>'name')||case when v_try=0 then '' else ':'||v_try::text end),1,8))::bit(32)::bigint%(v_steps+1);
          v_value:=(v_var->>'min')::numeric+v_index*(v_var->>'step')::numeric;
          v_values:=v_values||jsonb_build_object(v_var->>'name',v_value);v_text:=replace(v_text,'{{'||(v_var->>'name')||'}}',v_value::text);
        end loop;
        begin
          v_answer:=public.xelay_private_assessment_arithmetic(v_question->'calculation'->>'formula',v_values);
          v_valid:=true;
        exception when sqlstate 'P0001' or division_by_zero or numeric_value_out_of_range then
          v_valid:=false;
        end;
        exit when v_valid;
      end loop;
      if not v_valid then
        v_values:='{}';v_text:=v_question->>'text';
        for v_var in select value from jsonb_array_elements(v_question->'calculation'->'variables') loop
          v_value:=(v_var->>'min')::numeric;
          v_values:=v_values||jsonb_build_object(v_var->>'name',v_value);v_text:=replace(v_text,'{{'||(v_var->>'name')||'}}',v_value::text);
        end loop;
        -- Do not swallow an actually invalid authored formula.
        v_answer:=public.xelay_private_assessment_arithmetic(v_question->'calculation'->>'formula',v_values);
      end if;
      v_question:=v_question||jsonb_build_object('text',v_text,'answer',v_answer::text,'generated_variables',v_values);
    end if;
    if p_test.shuffle_answers and v_question->>'kind' in('choice','multiple','sorting') or v_question->>'kind'='sequence' then
      v_question:=jsonb_set(v_question,'{options}',coalesce((select jsonb_agg(o order by md5(p_attempt::text||':'||(v_question->>'id')||':'||(o->>'id'))) from jsonb_array_elements(v_question->'options')o),'[]'));
    end if;
    v_questions:=v_questions||jsonb_build_array(v_question);
  end loop;return v_questions;
end $$;

create function public.xelay_private_assessment_validate_overrides(p_test public.teaching_tests,p_overrides jsonb)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_item jsonb;v_open timestamptz;v_close timestamptz;
begin
  if jsonb_typeof(p_overrides) is distinct from 'array' or jsonb_array_length(p_overrides)>200
    or jsonb_array_length(p_overrides)<>(select count(distinct x->>'user_id') from jsonb_array_elements(p_overrides)x) then return false;end if;
  for v_item in select value from jsonb_array_elements(p_overrides) loop
    if jsonb_typeof(v_item) is distinct from 'object' or v_item->>'user_id' is null or v_item->>'group_id' is null
      or public.xelay_private_test_allows(p_test,(v_item->>'user_id')::uuid,(v_item->>'group_id')::uuid) is not true then return false;end if;
    v_open:=coalesce((v_item->>'opens_at')::timestamptz,p_test.opens_at);v_close:=coalesce((v_item->>'closes_at')::timestamptz,p_test.closes_at);
    if not isfinite(v_open) or not isfinite(v_close) or v_close<=v_open
      or not exists(select 1 from public.teaching_courses c where c.id=p_test.course_id and (v_open at time zone 'Europe/Kyiv')::date>=c.starts_on
        and(v_close at time zone 'Europe/Kyiv')::date<=c.ends_on)
      or(v_item->>'duration_seconds' is not null and(jsonb_typeof(v_item->'duration_seconds')<>'number'
        or(v_item->>'duration_seconds')::numeric not between 30 and 86400 or trunc((v_item->>'duration_seconds')::numeric)<>(v_item->>'duration_seconds')::numeric)) then return false;end if;
  end loop;return true;
exception when others then return false;
end $$;

create function public.xelay_teaching_question_bank(p_course_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();
begin
  if not public.xelay_teaching_is_verified(v_uid) or not public.xelay_teaching_has_current_access(v_uid)
    or not 'assignments'=any(public.xelay_teaching_permissions(p_course_id,v_uid)) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  return jsonb_build_object('entries',coalesce((select jsonb_agg(to_jsonb(q)-'created_by' order by q.updated_at desc,q.id) from public.teaching_question_bank q where q.course_id=p_course_id),'[]'));
end $$;
create function public.xelay_teaching_question_bank_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_course uuid:=(p_payload->>'course_id')::uuid;v_item jsonb;v_items jsonb;
  v_id uuid;v_entry public.teaching_question_bank%rowtype;v_tags text[];v_category text;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>2000000 or v_course is null
    or(p_payload?'expected_user_id' and(p_payload->>'expected_user_id')::uuid is distinct from v_uid) then raise exception 'TEST_INVALID_INPUT';end if;
  perform public.xelay_teaching_lock_course(v_course,'assignments');
  if p_action='archive_entry' then
    select * into v_entry from public.teaching_question_bank where id=(p_payload->>'id')::uuid and course_id=v_course for update;
    if not found then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
    if v_entry.version<>coalesce((p_payload->>'version')::integer,0) then raise exception 'TEST_CONFLICT';end if;
    update public.teaching_question_bank set archived_at=case when coalesce((p_payload->>'archived')::boolean,true) then clock_timestamp() else null end,
      version=version+1,updated_at=clock_timestamp() where id=v_entry.id;
  elsif p_action in('save_entry','import_entries') then
    v_items:=case when p_action='save_entry' then jsonb_build_array(p_payload) else p_payload->'entries' end;
    if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) not between 1 and 100 then raise exception 'TEST_INVALID_INPUT';end if;
    for v_item in select value from jsonb_array_elements(v_items) loop
      v_id:=coalesce((v_item->>'id')::uuid,gen_random_uuid());
      select * into v_entry from public.teaching_question_bank where id=v_id for update;
      if found and(v_entry.course_id<>v_course or p_action='import_entries') then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
      if coalesce(v_entry.version,0)<>coalesce((v_item->>'version')::integer,0) then raise exception 'TEST_CONFLICT';end if;
      v_category:=btrim(coalesce(v_item->>'category',''));
      if jsonb_typeof(coalesce(v_item->'tags','[]'))<>'array' or jsonb_array_length(coalesce(v_item->'tags','[]'))>20
        or exists(select 1 from jsonb_array_elements(coalesce(v_item->'tags','[]'))x where jsonb_typeof(x)<>'string' or length(btrim(x#>>'{}')) not between 1 and 60)
        or length(v_category)>120 or public.xelay_private_test_validate_question(v_item->'question') is not true then raise exception 'TEST_INVALID_INPUT';end if;
      v_tags:=array(select distinct btrim(value) from jsonb_array_elements_text(coalesce(v_item->'tags','[]')));
      insert into public.teaching_question_bank(id,course_id,category,tags,question,created_by) values(v_id,v_course,v_category,v_tags,v_item->'question',v_uid)
        on conflict(id) do update set category=excluded.category,tags=excluded.tags,question=excluded.question,version=teaching_question_bank.version+1,updated_at=clock_timestamp();
    end loop;
  else raise exception 'TEST_INVALID_INPUT';end if;
  return public.xelay_teaching_question_bank(v_course);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation then raise exception 'TEST_INVALID_INPUT' using errcode='22023';
end $$;

-- Replaced test functions follow. Existing journal ownership and audit paths are retained.

create or replace function public.xelay_private_test_finish(p_attempt uuid,p_now timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare v_attempt public.teaching_test_attempts%rowtype;v_test public.teaching_tests%rowtype;v_end timestamptz;
begin
  select * into v_attempt from public.teaching_test_attempts where id=p_attempt for update;
  if not found or v_attempt.status='submitted' then return;end if;
  select * into v_test from public.teaching_tests where id=v_attempt.test_id;
  v_end:=least(p_now,v_attempt.expires_at);
  update public.teaching_test_attempts set status='submitted',submitted_at=v_end,
    elapsed_seconds=greatest(0,extract(epoch from v_end-started_at)),auto_score=public.xelay_private_test_score(v_attempt.questions,answers,v_test.max_points),
    score=public.xelay_private_test_score(v_attempt.questions,answers,v_test.max_points),
    version=version+1 where id=p_attempt;
end $$;

create or replace function public.xelay_private_test_view(p_test public.teaching_tests,p_user uuid,p_full boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select (to_jsonb(p_test)-'questions'-'targets'-'overrides')||jsonb_build_object('course_title',(select title from public.teaching_courses where id=p_test.course_id),
    'question_count',coalesce(p_test.draw_count,jsonb_array_length(p_test.questions)),'questions',case when p_full then p_test.questions else '[]'::jsonb end,
    'results_ready_at',greatest(p_test.closes_at,(select max((o->>'closes_at')::timestamptz) from jsonb_array_elements(p_test.overrides)o)),
    'overrides',case when p_full then p_test.overrides else '[]'::jsonb end,
    'opens_at',case when p_full then p_test.opens_at else coalesce((select(o->>'opens_at')::timestamptz from jsonb_array_elements(p_test.overrides)o where(o->>'user_id')::uuid=p_user),p_test.opens_at) end,
    'closes_at',case when p_full then p_test.closes_at else coalesce((select(o->>'closes_at')::timestamptz from jsonb_array_elements(p_test.overrides)o where(o->>'user_id')::uuid=p_user),p_test.closes_at) end,
    'duration_seconds',case when p_full then p_test.duration_seconds else coalesce((select(o->>'duration_seconds')::integer from jsonb_array_elements(p_test.overrides)o where(o->>'user_id')::uuid=p_user),p_test.duration_seconds) end,
    'targets',case when p_full then p_test.targets else coalesce((select jsonb_agg(t) from jsonb_array_elements(p_test.targets)t
      where public.xelay_private_test_allows(p_test,p_user,(t->>'group_id')::uuid)),'[]') end,
    'has_attempts',exists(select 1 from public.teaching_test_attempts where test_id=p_test.id),
    'can_edit',public.xelay_private_test_staff(p_test,p_user,'assignments',true) and public.xelay_private_test_staff(p_test,p_user,'grades',true),
    'can_review',public.xelay_private_test_staff(p_test,p_user,'grades',true),
    'my_attempt',(select jsonb_build_object('id',a.id,'status',case when a.status='submitted' or a.expires_at<=clock_timestamp() then 'submitted' else 'in_progress' end,
      'submitted_at',case when a.status='submitted' then a.submitted_at when a.expires_at<=clock_timestamp() then a.expires_at else null end,
      'published_score',g.published_score,'published_absent',coalesce((to_jsonb(g)->>'published_absent')::boolean,false),'grade_published_at',g.published_at)
      from public.teaching_test_attempts a left join public.teaching_grades g on g.id=a.grade_id
      where a.test_id=p_test.id and a.user_id=p_user and public.xelay_private_test_allows(p_test,p_user,a.group_id)));
$$;

create or replace function public.xelay_private_test_attempt_view(p_attempt public.teaching_test_attempts,p_test public.teaching_tests,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_question jsonb;v_result jsonb;v_deadline timestamptz;
begin
  v_result:=to_jsonb(p_attempt)||jsonb_build_object('question_count',jsonb_array_length(p_attempt.questions))||jsonb_build_object('student_name',(select full_name from public.profiles where id=p_attempt.user_id));
  if p_full then
    v_result:=(v_result-'question_reviews')||jsonb_build_object('current_grade',public.xelay_private_test_grade_snapshot(p_test.id,p_attempt.group_id,p_attempt.user_id),
      'question_results',(select jsonb_agg(jsonb_build_object(
      'question_id',q->>'id','automatic_points',round(public.xelay_private_test_question_points(q,p_attempt.answers->(q->>'id')),4),
      'points',case when coalesce(p_attempt.question_reviews->(q->>'id')->>'mode','auto')='auto'
        then round(public.xelay_private_test_question_points(q,p_attempt.answers->(q->>'id')),4) else(p_attempt.question_reviews->(q->>'id')->>'points')::numeric end,
      'requires_review',q->>'kind'='essay' and coalesce(p_attempt.question_reviews->(q->>'id')->>'mode','auto')='auto','max_points',(q->>'points')::numeric,'manual',coalesce(p_attempt.question_reviews->(q->>'id')->>'mode','auto')<>'auto',
      'mode',coalesce(p_attempt.question_reviews->(q->>'id')->>'mode','auto'),'reason',coalesce(p_attempt.question_reviews->(q->>'id')->>'reason',''),
      'reviewed_at',p_attempt.question_reviews->(q->>'id')->'reviewed_at','reviewed_by',p_attempt.question_reviews->(q->>'id')->'reviewed_by') order by n)
      from jsonb_array_elements(p_attempt.questions) with ordinality x(q,n)),
      'review_history',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'question_id',h.question_id,'old_points',round(h.old_points,4),'new_points',round(h.new_points,4),
        'mode',h.mode,'reason',h.reason,'actor_name',p.full_name,'created_at',h.created_at) order by h.created_at,h.id)
        from public.teaching_test_review_audit h join public.profiles p on p.id=h.actor_id where h.attempt_id=p_attempt.id),'[]'));
  else
    v_result:=v_result-array['questions','score','auto_score','question_reviews','bonus_score','final_score','rank','bonus_winner','grade_snapshot','grade_id','student_name'];
    v_question:=p_attempt.questions->p_attempt.current_index;
    if p_attempt.status='in_progress' then
      v_question:=(select jsonb_object_agg(key,value) from jsonb_each(v_question) where key=any(array['id','kind','text','points','time_limit_seconds','partial_credit','options','buckets']));
      if p_attempt.questions->p_attempt.current_index->>'kind'='cloze' then
        v_question:=v_question||jsonb_build_object('gaps',(select jsonb_agg(jsonb_build_object('id',g->>'id')) from jsonb_array_elements(p_attempt.questions->p_attempt.current_index->'gaps')g));
      end if;
      if nullif(v_question->>'time_limit_seconds','') is not null then
        v_deadline:=(p_attempt.opened_at->>(v_question->>'id'))::timestamptz+make_interval(secs=>(v_question->>'time_limit_seconds')::integer);
      end if;
      v_result:=v_result||jsonb_build_object('current_question',v_question,'question_expires_at',case when v_deadline is null then null else least(v_deadline,p_attempt.expires_at) end);
    else v_result:=v_result||jsonb_build_object('current_question',null);end if;
  end if;
  return v_result||coalesce((select jsonb_build_object('published_score',g.published_score,'published_comment',g.published_comment,
    'published_absent',coalesce((to_jsonb(g)->>'published_absent')::boolean,false),
    'grade_published_at',g.published_at,'grade_version',case when p_full then g.version else null end) from public.teaching_grades g where id=p_attempt.grade_id),'{}');
end $$;

create or replace function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_uid uuid:=public.xelay_teaching_assert_user();v_id uuid:=(p_payload->>'id')::uuid;v_version integer:=coalesce((p_payload->>'version')::integer,0);
  v_test public.teaching_tests%rowtype;v_attempt public.teaching_test_attempts%rowtype;v_course uuid;v_group uuid;v_target jsonb;v_question jsonb;
  v_now timestamptz:=clock_timestamp();v_index integer;v_question_id text;v_deadline timestamptz;v_answer jsonb;v_activity uuid;v_entry uuid;v_grade public.teaching_grades%rowtype;
  v_result jsonb;v_rank integer:=0;v_bonus_count integer;v_score numeric;v_count integer;v_old_targets jsonb;
  v_mark jsonb;v_mode text;v_reason text;v_points numeric;v_old_points numeric;v_reviews jsonb;v_changed boolean:=false;v_snapshot jsonb;
  v_journal_date date;v_obsolete record;v_variant jsonb;v_override jsonb;v_overrides jsonb;v_attempt_id uuid;v_open timestamptz;v_close timestamptz;v_duration integer;
begin
  if v_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>500000
    or(p_payload?'expected_user_id' and(p_payload->>'expected_user_id')::uuid is distinct from v_uid) then raise exception 'TEST_INVALID_INPUT';end if;
  -- A test row and its attempts always lock in this order. Starting and editing
  -- share the same key so an attempt can never use a half-updated definition.
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
  select * into v_test from public.teaching_tests where id=v_id for update;
  v_now:=clock_timestamp();
  if p_action='save_test' then
    v_course:=coalesce(v_test.course_id,(p_payload->>'course_id')::uuid);
    perform public.xelay_teaching_lock_course(v_course,'assignments');
    if v_test.id is not null then
      if v_test.version<>v_version then raise exception 'TEST_CONFLICT';end if;
      if exists(select 1 from public.teaching_test_attempts where test_id=v_id) then raise exception 'TEST_IMMUTABLE';end if;
      v_old_targets:=v_test.targets;
      for v_target in select value from jsonb_array_elements(v_old_targets) loop
        perform public.xelay_private_assert_teaching_group(v_course,(v_target->>'group_id')::uuid,'assignments');
      end loop;
    elsif v_version<>0 then raise exception 'TEST_CONFLICT';end if;
    if p_payload->>'status' not in('draft','published','closed') or jsonb_typeof(p_payload->'targets') is distinct from 'array'
      or jsonb_array_length(p_payload->'targets') not between 1 and 100 or jsonb_typeof(p_payload->'questions') is distinct from 'array'
      or jsonb_array_length(p_payload->'questions') not between 1 and 100
      or (select count(distinct q->>'id') from jsonb_array_elements(p_payload->'questions')q)<>jsonb_array_length(p_payload->'questions')
      or (select count(distinct q->>'group_id') from jsonb_array_elements(p_payload->'targets')q)<>jsonb_array_length(p_payload->'targets')
      or exists(select 1 from jsonb_array_elements(p_payload->'questions')q where public.xelay_private_test_validate_question(q) is not true) then raise exception 'TEST_INVALID_INPUT';end if;
    for v_target in select value from jsonb_array_elements(p_payload->'targets') loop
      v_group:=(v_target->>'group_id')::uuid;
      perform public.xelay_private_assert_teaching_group(v_course,v_group,'assignments');
      perform public.xelay_private_assert_teaching_group(v_course,v_group,'grades');
      if coalesce(v_target->>'audience_mode','') not in('all','subgroups') then raise exception 'TEST_INVALID_INPUT';end if;
      perform public.xelay_private_validate_teaching_audience(v_course,null,v_target);
    end loop;
    if not exists(select 1 from public.teaching_courses c where c.id=v_course
      and((p_payload->>'opens_at')::timestamptz at time zone 'Europe/Kyiv')::date>=c.starts_on
      and((p_payload->>'closes_at')::timestamptz at time zone 'Europe/Kyiv')::date<=c.ends_on
      and(coalesce(p_payload->>'category','')='' or exists(select 1 from jsonb_array_elements(c.grading_rules->'categories')k where k->>'id'=p_payload->>'category')))
      or(p_payload->>'max_points')::numeric<=0 or scale((p_payload->>'max_points')::numeric)>2
      or(p_payload->>'bonus_points')::numeric<0 or scale((p_payload->>'bonus_points')::numeric)>2 then raise exception 'TEST_INVALID_INPUT';end if;
    v_journal_date:=coalesce(nullif(p_payload->>'journal_date','')::date,((p_payload->>'opens_at')::timestamptz at time zone 'Europe/Kyiv')::date);
    if not exists(select 1 from public.teaching_courses where id=v_course and v_journal_date between starts_on and ends_on)
      or length(btrim(coalesce(p_payload->>'work_type','Тест'))) not between 1 and 100 then raise exception 'TEST_INVALID_INPUT';end if;
    for v_obsolete in select l.group_id,l.activity_id from public.teaching_test_activities l where l.test_id=v_id
      and not exists(select 1 from jsonb_array_elements(p_payload->'targets')t where(t->>'group_id')::uuid=l.group_id) order by l.group_id loop
      perform public.xelay_private_assert_teaching_group(v_course,v_obsolete.group_id,'grades');
      -- Journal writers and grade requests also lock the course before the
      -- activity, so a new grade cannot race this empty-column removal.
      perform 1 from public.teaching_activities where id=v_obsolete.activity_id for update;
      if exists(select 1 from public.teaching_grades where activity_id=v_obsolete.activity_id)
        or exists(select 1 from public.teaching_grade_audit where activity_id=v_obsolete.activity_id)
        or exists(select 1 from public.teaching_grade_requests where activity_id=v_obsolete.activity_id)
        or exists(select 1 from public.teaching_grade_batch_receipts where activity_id=v_obsolete.activity_id) then
        raise exception 'TEST_TARGET_HAS_GRADES';
      end if;
      delete from public.teaching_test_activities where test_id=v_id and group_id=v_obsolete.group_id;
      delete from public.teaching_activities where id=v_obsolete.activity_id;
    end loop;
    insert into public.teaching_tests(id,course_id,title,description,status,opens_at,closes_at,duration_seconds,max_points,category,journal_date,work_type,allow_skip,allow_return,
      question_timer_policy,restrict_copy,bonus_percent,bonus_points,targets,questions,created_by)
    values(v_id,v_course,btrim(p_payload->>'title'),coalesce(p_payload->>'description',''),p_payload->>'status',(p_payload->>'opens_at')::timestamptz,
      (p_payload->>'closes_at')::timestamptz,(p_payload->>'duration_seconds')::integer,(p_payload->>'max_points')::numeric,coalesce(p_payload->>'category',''),v_journal_date,btrim(coalesce(p_payload->>'work_type','Тест')),
      (p_payload->>'allow_skip')::boolean,(p_payload->>'allow_return')::boolean,p_payload->>'question_timer_policy',(p_payload->>'restrict_copy')::boolean,
      (p_payload->>'bonus_percent')::integer,(p_payload->>'bonus_points')::numeric,p_payload->'targets',p_payload->'questions',v_uid)
    on conflict(id) do update set title=excluded.title,description=excluded.description,status=excluded.status,opens_at=excluded.opens_at,closes_at=excluded.closes_at,
      duration_seconds=excluded.duration_seconds,max_points=excluded.max_points,category=excluded.category,journal_date=excluded.journal_date,work_type=excluded.work_type,allow_skip=excluded.allow_skip,allow_return=excluded.allow_return,
      question_timer_policy=excluded.question_timer_policy,restrict_copy=excluded.restrict_copy,bonus_percent=excluded.bonus_percent,bonus_points=excluded.bonus_points,
      targets=excluded.targets,questions=excluded.questions,version=teaching_tests.version+1,updated_at=now();
    update public.teaching_tests set
      shuffle_questions=coalesce((p_payload->>'shuffle_questions')::boolean,shuffle_questions),
      shuffle_answers=coalesce((p_payload->>'shuffle_answers')::boolean,shuffle_answers),
      draw_count=case when p_payload?'draw_count' then(p_payload->>'draw_count')::integer else draw_count end,
      overrides=case when p_payload?'overrides' then p_payload->'overrides' else overrides end where id=v_id;
    select * into v_test from public.teaching_tests where id=v_id;
    if(v_test.draw_count is not null and(v_test.draw_count>jsonb_array_length(v_test.questions) or jsonb_typeof(p_payload->'draw_count') is distinct from 'number'
      or(p_payload->>'draw_count')::numeric<>v_test.draw_count))
      or public.xelay_private_assessment_validate_overrides(v_test,v_test.overrides) is not true then raise exception 'TEST_INVALID_INPUT';end if;
    if p_payload->>'status'<>'draft' or exists(select 1 from public.teaching_test_activities where test_id=v_id) then
      perform public.xelay_private_test_sync_activities(v_id);
    end if;
    return public.xelay_teaching_test(v_id);
  end if;
  if v_test.id is null then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if p_action='save_override' then
    v_override:=p_payload->'override';
    perform public.xelay_private_assert_teaching_group(v_test.course_id,(v_override->>'group_id')::uuid,'assignments');
    perform public.xelay_private_assert_teaching_group(v_test.course_id,(v_override->>'group_id')::uuid,'grades');
    if v_test.version<>v_version then raise exception 'TEST_CONFLICT';end if;
    if v_test.results_finalized_at is not null or v_test.status='closed' then raise exception 'TEST_IMMUTABLE';end if;
    if exists(select 1 from public.teaching_test_attempts where test_id=v_id and user_id=(v_override->>'user_id')::uuid) then raise exception 'TEST_IMMUTABLE';end if;
    v_overrides:=coalesce((select jsonb_agg(o) from jsonb_array_elements(v_test.overrides)o where o->>'user_id' is distinct from v_override->>'user_id'),'[]')||jsonb_build_array(v_override);
    if public.xelay_private_assessment_validate_overrides(v_test,v_overrides) is not true then raise exception 'TEST_INVALID_INPUT';end if;
    update public.teaching_tests set overrides=v_overrides,version=version+1,updated_at=clock_timestamp() where id=v_id;
    return public.xelay_teaching_test(v_id);
  end if;
  if p_action='save_review' then
    select * into v_attempt from public.teaching_test_attempts where id=(p_payload->>'attempt_id')::uuid and test_id=v_id for update;
    if not found then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
    perform public.xelay_private_assert_teaching_group(v_test.course_id,v_attempt.group_id,'grades');
    if v_attempt.status<>'submitted' then raise exception 'TEST_REVIEW_REQUIRED';end if;
    if v_attempt.version<>v_version then raise exception 'TEST_CONFLICT';end if;
    if jsonb_typeof(p_payload->'marks') is distinct from 'array' or jsonb_array_length(p_payload->'marks') not between 1 and 100
      or(select count(distinct m->>'question_id') from jsonb_array_elements(p_payload->'marks')m)<>jsonb_array_length(p_payload->'marks') then raise exception 'TEST_INVALID_INPUT';end if;
    v_reviews:=v_attempt.question_reviews;
    for v_mark in select value from jsonb_array_elements(p_payload->'marks') loop
      v_question_id:=v_mark->>'question_id';v_mode:=coalesce(v_mark->>'mode','custom');v_reason:=btrim(coalesce(v_mark->>'reason',''));
      select q into v_question from jsonb_array_elements(v_attempt.questions)q where q->>'id'=v_question_id;
      if v_question is null or v_mode not in('auto','full','zero','custom') or(v_question->>'kind'='essay' and v_mode='auto') then raise exception 'TEST_INVALID_INPUT';end if;
      if length(v_reason) not between 2 and 2000 then raise exception 'TEST_REVIEW_REASON_REQUIRED';end if;
      if v_mode='auto' then v_points:=public.xelay_private_test_question_points(v_question,v_attempt.answers->v_question_id);
      elsif v_mode='full' then v_points:=(v_question->>'points')::numeric;
      elsif v_mode='zero' then v_points:=0;
      else
        if jsonb_typeof(v_mark->'points') is distinct from 'number' then raise exception 'TEST_INVALID_INPUT';end if;
        v_points:=(v_mark->>'points')::numeric;
        if v_points<0 or v_points>(v_question->>'points')::numeric or scale(v_points)>2 then raise exception 'TEST_INVALID_INPUT';end if;
      end if;
      if v_reviews->v_question_id->>'mode'=v_mode and(v_reviews->v_question_id->>'points')::numeric=v_points
        and v_reviews->v_question_id->>'reason'=v_reason and v_reviews->v_question_id->>'reviewed_by'=v_uid::text then continue;end if;
      v_old_points:=case when coalesce(v_reviews->v_question_id->>'mode','auto')='auto'
        then public.xelay_private_test_question_points(v_question,v_attempt.answers->v_question_id) else(v_reviews->v_question_id->>'points')::numeric end;
      insert into public.teaching_test_review_audit(test_id,attempt_id,question_id,actor_id,old_points,new_points,mode,reason)
        values(v_id,v_attempt.id,v_question_id,v_uid,v_old_points,v_points,v_mode,v_reason);
      v_reviews:=jsonb_set(v_reviews,array[v_question_id],jsonb_build_object('mode',v_mode,'points',v_points,'reason',v_reason,'reviewed_by',v_uid,'reviewed_at',v_now));
      v_changed:=true;
    end loop;
    if not v_changed then return public.xelay_teaching_test(v_id);end if;
    update public.teaching_test_attempts set question_reviews=v_reviews,score=public.xelay_private_test_effective_score(v_attempt.questions,answers,v_reviews,v_test.max_points),
      reviewed_at=null,review_note='',version=version+1 where id=v_attempt.id;
    -- A correction can change the entire competition order. Previous journal
    -- publications stay intact while every transfer requires fresh approval.
    update public.teaching_test_attempts set final_score=null,bonus_score=0,rank=null,bonus_winner=false,reviewed_at=null,version=version+1
      where test_id=v_id and(final_score is not null or bonus_score<>0 or rank is not null or bonus_winner or reviewed_at is not null);
    update public.teaching_tests set review_revision=review_revision+1,approved_revision=null,results_finalized_at=null,version=version+1,updated_at=now() where id=v_id;
    return public.xelay_teaching_test(v_id);
  end if;
  if p_action in('finalize_results','review_results') then
    perform public.xelay_teaching_lock_course(v_test.course_id,'grades');
    if not public.xelay_private_test_staff(v_test,v_uid,'grades',true) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
    if p_action='finalize_results' then
      if v_test.results_finalized_at is not null and v_test.approved_revision=v_test.review_revision then
        if v_test.version<>v_version then return public.xelay_teaching_test(v_id);end if;
        -- Explicit reapproval refreshes journal snapshots without redistributing
        -- an already-confirmed competition ranking after membership changes.
        update public.teaching_test_attempts a set grade_snapshot=public.xelay_private_test_grade_snapshot(v_id,a.group_id,a.user_id),version=version+1 where test_id=v_id;
        update public.teaching_tests set version=version+1,updated_at=now() where id=v_id;
        return public.xelay_teaching_test(v_id);
      end if;
      if v_test.version<>v_version then raise exception 'TEST_CONFLICT';end if;
      if v_now<greatest(v_test.closes_at,(select max((o->>'closes_at')::timestamptz) from jsonb_array_elements(v_test.overrides)o)) then raise exception 'TEST_RESULTS_NOT_READY';end if;
      for v_attempt in select * from public.teaching_test_attempts where test_id=v_id and status='in_progress' order by id for update loop
        perform public.xelay_private_test_finish(v_attempt.id,v_now);
      end loop;
      if exists(select 1 from public.teaching_test_attempts a cross join lateral jsonb_array_elements(a.questions)q
        where a.test_id=v_id and q->>'kind'='essay' and coalesce(a.question_reviews->(q->>'id')->>'mode','auto')='auto') then raise exception 'TEST_MANUAL_REVIEW_REQUIRED';end if;
      select ceil(count(*)*v_test.bonus_percent/100.0)::integer into v_bonus_count from public.teaching_test_attempts
        where test_id=v_id and status='submitted' and public.xelay_private_test_allows(v_test,user_id,group_id);
      for v_attempt in select * from public.teaching_test_attempts where test_id=v_id and status='submitted' order by score desc,elapsed_seconds,id for update loop
        if public.xelay_private_test_allows(v_test,v_attempt.user_id,v_attempt.group_id) then v_rank:=v_rank+1;end if;
        v_score:=least(v_test.max_points,v_attempt.score+case when public.xelay_private_test_allows(v_test,v_attempt.user_id,v_attempt.group_id)
          and v_rank<=v_bonus_count then v_test.bonus_points else 0 end);
        update public.teaching_test_attempts set bonus_score=v_score-score,final_score=v_score,
          rank=case when public.xelay_private_test_allows(v_test,v_attempt.user_id,v_attempt.group_id) then v_rank else null end,
          bonus_winner=public.xelay_private_test_allows(v_test,v_attempt.user_id,v_attempt.group_id) and v_rank<=v_bonus_count,
          grade_snapshot=public.xelay_private_test_grade_snapshot(v_id,v_attempt.group_id,v_attempt.user_id),version=version+1 where id=v_attempt.id;
      end loop;
      update public.teaching_tests set results_finalized_at=v_now,approved_revision=review_revision,status='closed',version=version+1,updated_at=now() where id=v_id;
    else
      if v_test.results_finalized_at is null or v_test.approved_revision is distinct from v_test.review_revision then raise exception 'TEST_REVIEW_REQUIRED';end if;
      if v_test.version<>v_version then raise exception 'TEST_CONFLICT';end if;
      for v_attempt in select * from public.teaching_test_attempts where test_id=v_id and reviewed_at is null order by group_id,id for update loop
        perform public.xelay_private_assert_teaching_group(v_test.course_id,v_attempt.group_id,'grades');
        perform public.xelay_teaching_sync_roster(v_test.course_id,v_attempt.group_id);
        select id into v_entry from public.teaching_entries where course_id=v_test.course_id and group_id=v_attempt.group_id and user_id=v_attempt.user_id and active;
        if v_entry is null or not public.xelay_private_test_allows(v_test,v_attempt.user_id,v_attempt.group_id) then
          update public.teaching_test_attempts set review_note='Доступ учасника змінився. Результат збережено, передавання в журнал очікує перевірки складу групи.',version=version+1
            where id=v_attempt.id and review_note='';
          continue;
        end if;
        select activity_id into v_activity from public.teaching_test_activities where test_id=v_id and group_id=v_attempt.group_id;
        if v_activity is null then raise exception 'TEST_REVIEW_REQUIRED';end if;
        select * into v_grade from public.teaching_grades where activity_id=v_activity and entry_id=v_entry for update;
        if v_attempt.grade_snapshot is null or (v_attempt.grade_snapshot->>'version')::integer is distinct from coalesce(v_grade.version,0)
          or nullif(v_attempt.grade_snapshot->>'id','')::uuid is distinct from v_grade.id then raise exception 'TEST_GRADE_CONFLICT';end if;
        select h.reason into v_reason from public.teaching_test_review_audit h where h.attempt_id=v_attempt.id order by h.created_at desc,h.id desc limit 1;
        v_result:=public.xelay_teaching_mutate('save_grade',jsonb_build_object('activity_id',v_activity,'entry_id',v_entry,'version',coalesce(v_grade.version,0),
          'score',v_attempt.final_score,'absent',false,'comment','Результат тесту перевірено викладачем.'||
            case when exists(select 1 from jsonb_array_elements(v_attempt.questions)q where q->'rubric' is not null and q->'rubric'<>'null'::jsonb)
              then ' Оцінювання за критеріями. Перевірка №'||v_test.review_revision::text||'.' else '' end,
          'reason','Перевірка тесту. '||left(coalesce(v_reason,'Результати підтверджено викладачем.'),1900)));
        update public.teaching_test_attempts set reviewed_at=v_now,review_note='',grade_id=(v_result->>'id')::uuid,version=version+1 where id=v_attempt.id;
      end loop;
    end if;
    return public.xelay_teaching_test(v_id);
  end if;
  if v_test.status='draft' or not public.xelay_private_test_allows(v_test,v_uid) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if v_test.created_by=v_uid or public.xelay_private_test_staff(v_test,v_uid,'assignments') or public.xelay_private_test_staff(v_test,v_uid,'grades') then
    raise exception 'TEST_FORBIDDEN' using errcode='42501';
  end if;
  select * into v_attempt from public.teaching_test_attempts where test_id=v_id and user_id=v_uid for update;
  v_now:=clock_timestamp();
  if v_attempt.id is not null and not public.xelay_private_test_allows(v_test,v_uid,v_attempt.group_id) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if p_action='start' then
    if v_attempt.id is not null then return public.xelay_teaching_test(v_id);end if;
    v_group:=(p_payload->>'group_id')::uuid;
    if not public.xelay_private_test_allows(v_test,v_uid,v_group) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
    select o into v_override from jsonb_array_elements(v_test.overrides)o where(o->>'user_id')::uuid=v_uid and(o->>'group_id')::uuid=v_group;
    v_open:=coalesce((v_override->>'opens_at')::timestamptz,v_test.opens_at);v_close:=coalesce((v_override->>'closes_at')::timestamptz,v_test.closes_at);
    v_duration:=coalesce((v_override->>'duration_seconds')::integer,v_test.duration_seconds);
    if v_test.status<>'published' or v_now<v_open or v_now>=v_close then raise exception 'TEST_NOT_OPEN';end if;
    v_attempt_id:=gen_random_uuid();v_variant:=public.xelay_private_assessment_snapshot(v_test,v_attempt_id);
    insert into public.teaching_test_attempts(id,test_id,group_id,user_id,started_at,expires_at,opened_at,questions)
      values(v_attempt_id,v_id,v_group,v_uid,v_now,least(v_close,v_now+make_interval(secs=>v_duration)),jsonb_build_object(v_variant->0->>'id',v_now),v_variant);
    return public.xelay_teaching_test(v_id);
  end if;
  if v_attempt.id is null then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if v_attempt.status='submitted' then return public.xelay_teaching_test(v_id);end if;
  if v_attempt.expires_at<=v_now then perform public.xelay_private_test_finish(v_attempt.id,v_now);return public.xelay_teaching_test(v_id);end if;
  if v_attempt.version<>v_version then raise exception 'TEST_CONFLICT';end if;
  v_question:=v_attempt.questions->v_attempt.current_index;v_question_id:=v_question->>'id';
  if nullif(v_question->>'time_limit_seconds','') is not null then
    v_deadline:=(v_attempt.opened_at->>v_question_id)::timestamptz+make_interval(secs=>(v_question->>'time_limit_seconds')::integer);
  end if;
  if p_action='save_answer' then
    if p_payload->>'question_id' is distinct from v_question_id or v_question_id=any(v_attempt.locked) or v_deadline<=v_now then raise exception 'TEST_ANSWER_LOCKED';end if;
    v_answer:=p_payload->'answer';
    if not public.xelay_private_test_valid_answer(v_question,v_answer) then raise exception 'TEST_INVALID_INPUT';end if;
    if v_attempt.answers->v_question_id is not distinct from v_answer then return public.xelay_teaching_test(v_id);end if;
    update public.teaching_test_attempts set answers=jsonb_set(answers,array[v_question_id],coalesce(v_answer,'null')),version=version+1 where id=v_attempt.id;
  elsif p_action='navigate' then
    v_index:=(p_payload->>'index')::integer;
    if v_index=v_attempt.current_index then return public.xelay_teaching_test(v_id);end if;
    if v_index<0 or v_index>=jsonb_array_length(v_attempt.questions) or(v_index<v_attempt.current_index and not v_test.allow_return)
      or(v_index>v_attempt.current_index and v_index<>v_attempt.current_index+1)
      or(v_index<v_attempt.current_index and not(v_attempt.opened_at?(v_attempt.questions->v_index->>'id')))
      or(v_index>v_attempt.current_index and not v_test.allow_skip and coalesce(v_attempt.answers->v_question_id,'null') in('null'::jsonb,'{}'::jsonb,'[]'::jsonb,'""'::jsonb)
        and(v_deadline is null or v_deadline>v_now)) then raise exception 'TEST_NAVIGATION_BLOCKED';end if;
    update public.teaching_test_attempts set current_index=v_index,opened_at=case when opened_at?(v_attempt.questions->v_index->>'id') then opened_at
        else opened_at||jsonb_build_object(v_attempt.questions->v_index->>'id',v_now) end,
      locked=case when(v_test.question_timer_policy='lock_on_leave' or not v_test.allow_return or v_deadline<=v_now) and not v_question_id=any(locked)
        then array_append(locked,v_question_id) else locked end,version=version+1 where id=v_attempt.id;
  elsif p_action='finish' then perform public.xelay_private_test_finish(v_attempt.id,v_now);
  else raise exception 'TEST_INVALID_INPUT';end if;
  return public.xelay_teaching_test(v_id);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation or datetime_field_overflow then
  raise exception 'TEST_INVALID_INPUT' using errcode='22023';
end $$;

revoke all on function public.xelay_private_assessment_parse(text,jsonb,integer,integer,integer),public.xelay_private_assessment_arithmetic(text,jsonb),
  public.xelay_private_assessment_text_equal(text,text,boolean),public.xelay_private_assessment_snapshot(public.teaching_tests,uuid),
  public.xelay_private_assessment_validate_overrides(public.teaching_tests,jsonb),
  public.xelay_private_test_validate_question_before_phase1(jsonb),public.xelay_private_test_valid_answer_before_phase1(jsonb,jsonb),
  public.xelay_private_test_question_points_before_phase1(jsonb,jsonb),public.xelay_private_test_validate_question(jsonb),
  public.xelay_private_test_valid_answer(jsonb,jsonb),public.xelay_private_test_question_points(jsonb,jsonb),
  public.xelay_teaching_question_bank(uuid),public.xelay_teaching_question_bank_mutate(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_question_bank(uuid),public.xelay_teaching_question_bank_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
