-- Repair only the explicitly scoped owner-QA transport. Ordinary student
-- identity, admission, optimistic versions and server-arrival deadlines remain
-- enforced by the same established save and exit handlers.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $patch$
declare target record; change record; source text; anchor text;
begin
  for target in select * from (values
    ('public.xelay_teaching_test_qa(text,jsonb)'),
    ('public.xelay_private_test_mutate_before_manual_variants(text,jsonb)')
  ) functions(signature) loop
    source:=replace(pg_get_functiondef(target.signature::regprocedure),chr(13),'');
    for change in select * from (values
      ('public.xelay_teaching_test_qa(text,jsonb)',
        $old$or octet_length(p_payload::text)>(case when p_action='save_answer' then 500000 else 2000 end)$old$,
        $new$or octet_length(p_payload::text)>(case when p_action='save_answer' then 500000 when p_action='record_tab_exit' then 100000 else 2000 end)$new$),
      ('public.xelay_teaching_test_qa(text,jsonb)',
        $old$or p_payload->>'expected_user_id' is distinct from v_uid::text then raise exception 'TEST_INVALID_INPUT';end if;$old$,
        $new$or p_payload->>'expected_user_id' is distinct from v_uid::text
    or p_payload?'qa_internal_session'
    or (p_action='record_tab_exit' and exists(
      select 1 from jsonb_object_keys(p_payload) key
      where key not in('id','expected_user_id','group_id','attempt_id','event_id','pending_answer')
    )) then raise exception 'TEST_INVALID_INPUT';end if;$new$),
      ('public.xelay_teaching_test_qa(text,jsonb)',
        $old$or (p_action='start' and p_payload->>'group_id' is distinct from v_group::text) then$old$,
        $new$or ((p_action='start' or p_payload?'group_id') and p_payload->>'group_id' is distinct from v_group::text) then$new$),
      ('public.xelay_teaching_test_qa(text,jsonb)',
        $old$v_detail:=public.xelay_private_test_mutate_before_qa(p_action,p_payload-'qa_internal_session');$old$,
        $new$-- group_id is validated above, but is not part of the ordinary
    -- record_tab_exit schema. Accept the old UI's correct scoped group only
    -- here; unknown fields and an external internal marker are rejected.
    v_detail:=public.xelay_private_test_mutate_before_qa(p_action,p_payload-'group_id');$new$),
      ('public.xelay_private_test_mutate_before_manual_variants(text,jsonb)',
        $old$perform public.xelay_teaching_test_mutate('save_answer',jsonb_build_object(
          'id',v_id,'attempt_id',v_attempt.id,'expected_user_id',v_uid,
          'version',v_result->'version','question_id',v_result->'question_id','answer',v_result->'answer'));$old$,
        $new$if v_test.qa_own_attempt then
          -- Re-enter the existing QA boundary instead of trusting a marker
          -- from this payload or weakening the ordinary author/staff guard.
          -- It revalidates the exact verified owner and hidden group before
          -- invoking the same versioned save in this transaction.
          perform public.xelay_teaching_test_qa('save_answer',jsonb_build_object(
            'id',v_id,'attempt_id',v_attempt.id,'expected_user_id',v_uid,
            'version',v_result->'version','question_id',v_result->'question_id','answer',v_result->'answer'));
        else
          perform public.xelay_teaching_test_mutate('save_answer',jsonb_build_object(
            'id',v_id,'attempt_id',v_attempt.id,'expected_user_id',v_uid,
            'version',v_result->'version','question_id',v_result->'question_id','answer',v_result->'answer'));
        end if;$new$)
    ) patches(signature,anchor,replacement) where signature=target.signature loop
      anchor:=replace(change.anchor,chr(13),'');
      if (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then
        raise exception 'TEST_QA_EXIT_SOURCE_CHANGED: % / %',target.signature,left(anchor,90);
      end if;
      source:=replace(source,anchor,replace(change.replacement,chr(13),''));
    end loop;
    execute source;
  end loop;
end $patch$;

-- CREATE OR REPLACE preserves the existing grants. Assert the private engine
-- stays private; neither the new QA branch nor its marker is a public shortcut.
revoke all on function public.xelay_private_test_mutate_before_manual_variants(text,jsonb)
  from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
