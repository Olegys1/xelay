-- Authored variants live outside the public test row. Only staff receive their
-- definitions, and the existing attempt snapshot carries the chosen questions.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.teaching_test_manual_variants (
  test_id uuid primary key references public.teaching_tests(id) on delete cascade,
  variants jsonb not null check(jsonb_typeof(variants)='array')
);
alter table public.teaching_test_manual_variants enable row level security;
revoke all on public.teaching_test_manual_variants from public,anon,authenticated,service_role;

alter function public.xelay_private_assessment_snapshot(public.teaching_tests,uuid)
  rename to xelay_private_assessment_snapshot_before_manual_variants;
create function public.xelay_private_assessment_snapshot(p_test public.teaching_tests,p_attempt uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_variants jsonb;v_index integer;
begin
  select variants into v_variants from public.teaching_test_manual_variants where test_id=p_test.id;
  if v_variants is not null then
    -- The server creates a random attempt UUID. A separate salt keeps the
    -- authored-variant choice independent of question and answer shuffling.
    v_index:=(('x'||substr(md5(p_attempt::text||':manual-variant'),1,8))::bit(32)::bigint
      %(jsonb_array_length(v_variants)::bigint+1))::integer;
    if v_index>0 then
      p_test.questions:=v_variants->(v_index-1)->'questions';
    end if;
  end if;
  return public.xelay_private_assessment_snapshot_before_manual_variants(p_test,p_attempt);
end $$;

alter function public.xelay_private_test_view(public.teaching_tests,uuid,boolean)
  rename to xelay_private_test_view_before_manual_variants;
create function public.xelay_private_test_view(p_test public.teaching_tests,p_user uuid,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;v_variants jsonb;
begin
  v_result:=public.xelay_private_test_view_before_manual_variants(p_test,p_user,p_full);
  if p_full then
    select variants into v_variants from public.teaching_test_manual_variants where test_id=p_test.id;
    v_result:=v_result||jsonb_build_object('variants',coalesce(v_variants,'[]'::jsonb));
  end if;
  return v_result;
end $$;

alter function public.xelay_teaching_test_mutate(text,jsonb)
  rename to xelay_private_test_mutate_before_manual_variants;
create function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb;v_test public.teaching_tests%rowtype;v_variants jsonb;v_variant jsonb;
  v_questions jsonb;v_expected_count integer;
begin
  if p_action is distinct from 'save_test' then
    return public.xelay_private_test_mutate_before_manual_variants(p_action,p_payload);
  end if;

  -- The existing save enforces authorization, version and immutability and
  -- holds the test lock used by start. A failed variant check rolls it back.
  v_result:=public.xelay_private_test_mutate_before_manual_variants(p_action,p_payload-'variants');
  select * into v_test from public.teaching_tests where id=(p_payload->>'id')::uuid;
  if p_payload?'variants' then
    v_variants:=p_payload->'variants';
  else
    select variants into v_variants from public.teaching_test_manual_variants where test_id=v_test.id;
    if not found then return v_result;end if;
  end if;
  if jsonb_typeof(v_variants) is distinct from 'array' then raise exception 'TEST_INVALID_INPUT';end if;
  v_expected_count:=coalesce(v_test.draw_count,jsonb_array_length(v_test.questions));
  for v_variant in select value from jsonb_array_elements(v_variants) loop
    if jsonb_typeof(v_variant) is distinct from 'object'
      or jsonb_typeof(v_variant->'id') is distinct from 'string'
      or v_variant->>'id' !~ '^[A-Za-z0-9_-]{1,64}$'
      or jsonb_typeof(v_variant->'title') is distinct from 'string'
      or length(btrim(v_variant->>'title')) not between 1 and 120
      or jsonb_typeof(v_variant->'questions') is distinct from 'array'
      or v_variant-array['id','title','questions']<>'{}'::jsonb then raise exception 'TEST_INVALID_INPUT';end if;
    v_questions:=v_variant->'questions';
    if jsonb_array_length(v_questions) not between 1 and 100
      or v_expected_count>jsonb_array_length(v_questions)
      or(v_test.draw_count is null and v_expected_count<>jsonb_array_length(v_questions))
      or(select count(distinct q->>'id') from jsonb_array_elements(v_questions)q)<>jsonb_array_length(v_questions)
      or(select sum(octet_length((q-'images')::text)) from jsonb_array_elements(v_questions)q)>500000
      or exists(select 1 from jsonb_array_elements(v_questions)q where public.xelay_private_test_validate_question(q) is not true)
      then raise exception 'TEST_INVALID_INPUT';end if;
  end loop;
  if (select count(distinct v->>'id') from jsonb_array_elements(v_variants)v)<>jsonb_array_length(v_variants)
    or exists(
      select question_id from (
        select q->>'id' as question_id from jsonb_array_elements(v_test.questions)q
        union all
        select q->>'id' from jsonb_array_elements(v_variants)v cross join lateral jsonb_array_elements(v->'questions')q
      ) ids group by question_id having count(*)>1
    )
    then raise exception 'TEST_INVALID_INPUT';end if;

  if p_payload?'variants' then
    if v_variants='[]'::jsonb then
      delete from public.teaching_test_manual_variants where test_id=v_test.id;
    else
      insert into public.teaching_test_manual_variants(test_id,variants) values(v_test.id,v_variants)
      on conflict(test_id) do update set variants=excluded.variants;
    end if;
    if v_result->'test'?'variants' then
      v_result:=jsonb_set(v_result,'{test,variants}',v_variants);
    end if;
  end if;
  return v_result;
end $$;

revoke all on function
  public.xelay_private_assessment_snapshot_before_manual_variants(public.teaching_tests,uuid),
  public.xelay_private_assessment_snapshot(public.teaching_tests,uuid),
  public.xelay_private_test_view_before_manual_variants(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_view(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_mutate_before_manual_variants(text,jsonb),
  public.xelay_teaching_test_mutate(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_test_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
