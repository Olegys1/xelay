-- Let different students work independently while keeping test-wide edits atomic.
begin;
set local lock_timeout='5s';

create function public.xelay_private_test_student_lock_key(p_test_id uuid,p_user_id uuid)
returns bigint language sql immutable strict set search_path='' as $$
  select pg_catalog.hashtextextended('xelay:teaching-test-student:'||p_test_id||':'||p_user_id,0);
$$;
revoke all on function public.xelay_private_test_student_lock_key(uuid,uuid) from public,anon,authenticated,service_role;

-- Keep the established admission, code, retry, grading and permission paths.
-- Fail closed if any expected function body has diverged.
do $patch$
declare v_target record;v_pair record;v_source text;v_anchor text;
begin
  for v_target in select distinct signature from (values
    ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)'),
    ('public.xelay_private_test_mutate_before_admission_20261105(text,jsonb)'),
    ('public.xelay_private_test_mutate_before_close_20261105(text,jsonb)'),
    ('public.xelay_private_test_mutate_before_integrity_20261106(text,jsonb)'),
    ('public.xelay_private_test_mutate_before_manual_variants(text,jsonb)'),
    ('public.xelay_private_test_detail_before_admission_20261105(uuid)')
  )f(signature) loop
    v_source:=replace(pg_get_functiondef(v_target.signature::regprocedure),chr(13),'');
    for v_pair in select * from (values
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        'v_now timestamptz:=clock_timestamp();',
        'v_received_at constant timestamptz:=statement_timestamp();v_now timestamptz;'),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$-- A test row and its attempts always lock in this order. Starting and editing
  -- share the same key so an attempt can never use a half-updated definition.
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
  select * into v_test from public.teaching_tests where id=v_id for update;$old$,
        $new$-- Test settings use an exclusive guard. Student work uses the same
  -- guard in shared mode, followed by a lock for this student's attempts.
  if p_action in('start','retry','save_answer','navigate','finish') then
    perform pg_advisory_xact_lock_shared(hashtextextended('xelay:teaching-test:'||v_id,0));
    perform pg_advisory_xact_lock(public.xelay_private_test_student_lock_key(v_id,v_uid));
    select * into v_test from public.teaching_tests where id=v_id;
  else
    perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
    select * into v_test from public.teaching_tests where id=v_id for update;
  end if;$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        'if v_attempt.expires_at<=v_now then perform public.xelay_private_test_finish(v_attempt.id,v_now);return public.xelay_teaching_test(v_id);end if;',
        $new$-- Judge a save by the database statement's arrival, even when the
  -- previous operation on this attempt finishes after its deadline.
  if v_attempt.expires_at<=(case when p_action='save_answer' then v_received_at else v_now end) then
    perform public.xelay_private_test_finish(v_attempt.id,v_now);return public.xelay_teaching_test(v_id);
  end if;$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        'or v_deadline<=v_now then raise exception ''TEST_ANSWER_LOCKED'';',
        $new$or v_deadline<=v_received_at
      or v_received_at<coalesce((v_attempt.opened_at->>v_question_id)::timestamptz,v_attempt.started_at)
    then raise exception 'TEST_ANSWER_LOCKED';$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$if v_attempt.answers->v_question_id is not distinct from v_answer then return public.xelay_teaching_test(v_id);end if;
    update public.teaching_test_attempts set answers=jsonb_set(answers,array[v_question_id],coalesce(v_answer,'null')),version=version+1 where id=v_attempt.id;$old$,
        $new$if v_attempt.answers->v_question_id is distinct from v_answer then
      update public.teaching_test_attempts set answers=jsonb_set(answers,array[v_question_id],coalesce(v_answer,'null')),version=version+1 where id=v_attempt.id;
    end if;
    if v_attempt.expires_at<=clock_timestamp() then
      perform public.xelay_private_test_finish(v_attempt.id,clock_timestamp());
    end if;$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        'if v_test.closed_early_at is null and v_now<greatest(v_test.closes_at,',
        'if v_test.closed_early_at is null and v_received_at<greatest(v_test.closes_at,'),
      ('public.xelay_private_test_mutate_before_admission_20261105(text,jsonb)',
        $old$hashtextextended('xelay:teaching-test:'||(p_payload->>'id'),0)$old$,
        $new$hashtextextended('xelay:teaching-test:'||((p_payload->>'id')::uuid)::text,0)$new$),
      ('public.xelay_private_test_mutate_before_close_20261105(text,jsonb)',
        $old$perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
  select * into v_test from public.teaching_tests where id=v_id for update;$old$,
        $new$if p_action='start' then
    perform pg_advisory_xact_lock_shared(hashtextextended('xelay:teaching-test:'||v_id,0));
    select * into v_test from public.teaching_tests where id=v_id;
  else
    perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
    select * into v_test from public.teaching_tests where id=v_id for update;
  end if;$new$),
      ('public.xelay_private_test_mutate_before_integrity_20261106(text,jsonb)',
        $old$where test_id=v_id and status='in_progress' and expires_at>v_now$old$,
        $new$where test_id=v_id and status='in_progress' and expires_at>statement_timestamp()$new$),
      ('public.xelay_private_test_mutate_before_manual_variants(text,jsonb)',
        $old$perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
  select * into v_test from public.teaching_tests where id=v_id for update;$old$,
        $new$if p_action='record_tab_exit' then
    perform pg_advisory_xact_lock_shared(hashtextextended('xelay:teaching-test:'||v_id,0));
    perform pg_advisory_xact_lock(public.xelay_private_test_student_lock_key(v_id,v_uid));
    select * into v_test from public.teaching_tests where id=v_id;
  else
    perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
    select * into v_test from public.teaching_tests where id=v_id for update;
  end if;$new$),
      ('public.xelay_private_test_detail_before_admission_20261105(uuid)',
        $old$-- Details can finish an expired attempt. Use the same test-before-attempt
  -- order as mutations before touching either the teacher's or student's view.
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||p_test_id,0));
  select * into v_test from public.teaching_tests where id=p_test_id for update;$old$,
        $new$-- A refresh must not make other students wait behind the report.
  perform pg_advisory_xact_lock_shared(hashtextextended('xelay:teaching-test:'||p_test_id,0));
  select * into v_test from public.teaching_tests where id=p_test_id;$new$),
      ('public.xelay_private_test_detail_before_admission_20261105(uuid)',
        'for v_expired in select a.id from public.teaching_test_attempts a where a.test_id=p_test_id',
        'for v_expired in select a.id,a.user_id from public.teaching_test_attempts a where a.test_id=p_test_id'),
      ('public.xelay_private_test_detail_before_admission_20261105(uuid)',
        'a.status=''in_progress'' and a.expires_at<=v_now',
        'a.status=''in_progress'' and a.expires_at<=statement_timestamp()'),
      ('public.xelay_private_test_detail_before_admission_20261105(uuid)',
        'perform public.xelay_private_test_finish(v_expired.id,v_now);',
        $new$-- An in-flight save may still be applying a timely answer.
      if pg_try_advisory_xact_lock(public.xelay_private_test_student_lock_key(p_test_id,v_expired.user_id)) then
        perform 1 from public.teaching_test_attempts where id=v_expired.id and status='in_progress'
          and expires_at<=statement_timestamp() for update skip locked;
        if found then perform public.xelay_private_test_finish(v_expired.id,v_now);end if;
      end if;$new$),
      ('public.xelay_private_test_detail_before_admission_20261105(uuid)',
        $old$if v_attempt.status='in_progress' and v_attempt.expires_at<=v_now then
    perform public.xelay_private_test_finish(v_attempt.id,v_now);
    select * into v_attempt from public.teaching_test_attempts where id=v_attempt.id;
  end if;$old$,
        $new$if v_attempt.status='in_progress' and v_attempt.expires_at<=statement_timestamp() then
    perform pg_advisory_xact_lock(public.xelay_private_test_student_lock_key(p_test_id,v_uid));
    -- A concurrent save or retry may have changed the attempt while we waited.
    -- The current-attempt marker was introduced with module retries.
    select a.* into v_attempt from public.teaching_test_attempts a
      where a.test_id=p_test_id and a.user_id=v_uid and to_jsonb(a)->>'superseded_at' is null for update;
    v_now:=clock_timestamp();
    if v_attempt.status='in_progress' and v_attempt.expires_at<=statement_timestamp() then
      perform public.xelay_private_test_finish(v_attempt.id,v_now);
      select * into v_attempt from public.teaching_test_attempts where id=v_attempt.id;
    end if;
  end if;$new$)
    )p(signature,anchor,replacement) where p.signature=v_target.signature loop
      -- SQL Editor can paste CRLF into dollar-quoted anchors and replacements.
      v_anchor:=replace(v_pair.anchor,chr(13),'');
      if (length(v_source)-length(replace(v_source,v_anchor,'')))/length(v_anchor)<>1 then
        raise exception 'TEST_CONCURRENCY_SOURCE_CHANGED: % / %',v_target.signature,left(v_pair.anchor,100);
      end if;
      v_source:=replace(v_source,v_anchor,replace(v_pair.replacement,chr(13),''));
    end loop;
    execute v_source;
  end loop;
end $patch$;

notify pgrst,'reload schema';
commit;
