-- A student selects the needed subset, then orders it. Ordinary sequence
-- questions retain their existing full-permutation rules.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter function public.xelay_private_test_validate_question(jsonb)
  rename to xelay_private_test_validate_question_before_sequence_select;
create function public.xelay_private_test_validate_question(p_question jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  expected jsonb := p_question->'answer';
  count_required numeric;
  options jsonb := p_question->'options';
  all_ids jsonb;
begin
  if p_question->>'kind' is distinct from 'sequence_select' then
    return public.xelay_private_test_validate_question_before_sequence_select(p_question);
  end if;
  if jsonb_typeof(options) is distinct from 'array'
    or jsonb_typeof(expected) is distinct from 'array'
    or coalesce(p_question->>'id','') !~ '^[A-Za-z0-9_-]{1,64}$'
    or jsonb_typeof(p_question->'selection_count') is distinct from 'number' then return false; end if;
  count_required := (p_question->>'selection_count')::numeric;
  if count_required <> trunc(count_required) or count_required < 1
    or count_required >= jsonb_array_length(options)
    or jsonb_array_length(expected) <> count_required then return false; end if;
  select jsonb_agg(o->'id' order by n) into all_ids
    from jsonb_array_elements(options) with ordinality entries(o,n);
  if public.xelay_private_test_validate_question_before_sequence_select(
    p_question || jsonb_build_object('kind','sequence','answer',all_ids)) is not true then return false; end if;
  return (select count(distinct value #>> '{}') from jsonb_array_elements(expected)) = count_required
    and not exists (
      select 1 from jsonb_array_elements(expected) answer
      where jsonb_typeof(answer) <> 'string' or not all_ids @> jsonb_build_array(answer)
    );
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;
$$;

alter function public.xelay_private_test_valid_answer(jsonb,jsonb)
  rename to xelay_private_test_valid_answer_before_sequence_select;
create function public.xelay_private_test_valid_answer(p_question jsonb,p_answer jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare required_count integer;
begin
  if p_question->>'kind' is distinct from 'sequence_select' then
    return public.xelay_private_test_valid_answer_before_sequence_select(p_question,p_answer);
  end if;
  if p_answer is null or p_answer = 'null'::jsonb then return true; end if;
  if jsonb_typeof(p_question->'selection_count') is distinct from 'number'
    or (p_question->>'selection_count')::numeric <> trunc((p_question->>'selection_count')::numeric)
    or jsonb_typeof(p_question->'options') is distinct from 'array' then return false; end if;
  required_count := (p_question->>'selection_count')::integer;
  if required_count is null or required_count < 1 or required_count >= jsonb_array_length(p_question->'options')
    or jsonb_typeof(p_answer) is distinct from 'array'
    or jsonb_array_length(p_answer) > required_count then return false; end if;
  return (select count(distinct value #>> '{}') from jsonb_array_elements(p_answer)) = jsonb_array_length(p_answer)
    and not exists (
      select 1 from jsonb_array_elements(p_answer) answer
      where jsonb_typeof(answer) <> 'string' or not exists (
        select 1 from jsonb_array_elements(p_question->'options') option where option->'id' = answer
      )
    );
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;
$$;

alter function public.xelay_private_test_question_points(jsonb,jsonb)
  rename to xelay_private_test_question_points_before_sequence_select;
create function public.xelay_private_test_question_points(p_question jsonb,p_answer jsonb)
returns numeric language plpgsql immutable set search_path = '' as $$
declare correct_count integer;
begin
  if p_question->>'kind' is distinct from 'sequence_select' then
    return public.xelay_private_test_question_points_before_sequence_select(p_question,p_answer);
  end if;
  if p_answer is null or p_answer = 'null'::jsonb
    or public.xelay_private_test_valid_answer(p_question,p_answer) is not true then return 0; end if;
  if p_answer = p_question->'answer' then return (p_question->>'points')::numeric; end if;
  if not (p_question->>'partial_credit')::boolean then return 0; end if;
  select count(*) into correct_count
    from jsonb_array_elements(p_question->'answer') with ordinality expected(value,n)
    where p_answer->(n::integer - 1) = value;
  return (p_question->>'points')::numeric * correct_count / (p_question->>'selection_count')::numeric;
end;
$$;

alter function public.xelay_private_assessment_snapshot(public.teaching_tests,uuid)
  rename to xelay_private_assessment_snapshot_before_sequence_select;
create function public.xelay_private_assessment_snapshot(p_test public.teaching_tests,p_attempt uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare questions jsonb;
begin
  questions := public.xelay_private_assessment_snapshot_before_sequence_select(p_test,p_attempt);
  return coalesce((
    select jsonb_agg(
      case when q->>'kind' = 'sequence_select' then
        jsonb_set(q,'{options}',(
          select jsonb_agg(option order by md5(p_attempt::text || ':' || (q->>'id') || ':' || (option->>'id')))
          from jsonb_array_elements(q->'options') option
        ))
      else q end order by n
    )
    from jsonb_array_elements(questions) with ordinality entries(q,n)
  ),'[]'::jsonb);
end;
$$;

alter function public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean)
  rename to xelay_private_test_attempt_view_before_sequence_select;
create function public.xelay_private_test_attempt_view(p_attempt public.teaching_test_attempts,p_test public.teaching_tests,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
  question jsonb := p_attempt.questions->p_attempt.current_index;
begin
  result := public.xelay_private_test_attempt_view_before_sequence_select(p_attempt,p_test,p_full);
  if not p_full and question->>'kind' = 'sequence_select'
    and jsonb_typeof(result->'current_question') = 'object' then
    result := jsonb_set(result,'{current_question,selection_count}',question->'selection_count');
  end if;
  return result;
end;
$$;

revoke all on function
  public.xelay_private_test_validate_question_before_sequence_select(jsonb),
  public.xelay_private_test_validate_question(jsonb),
  public.xelay_private_test_valid_answer_before_sequence_select(jsonb,jsonb),
  public.xelay_private_test_valid_answer(jsonb,jsonb),
  public.xelay_private_test_question_points_before_sequence_select(jsonb,jsonb),
  public.xelay_private_test_question_points(jsonb,jsonb),
  public.xelay_private_assessment_snapshot_before_sequence_select(public.teaching_tests,uuid),
  public.xelay_private_assessment_snapshot(public.teaching_tests,uuid),
  public.xelay_private_test_attempt_view_before_sequence_select(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean)
from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
