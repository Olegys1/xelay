-- Opt-in tab control now submits on the first actual exit. Warnings happen
-- before a controlled navigation, never as a free first recorded violation.
-- The latest in-memory answer may accompany the event in the same transaction.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

-- Retain historical one-warning and two-exit rows, while allowing a submitted
-- first-exit row. No existing attempt, answer or grade is rewritten.
alter table public.teaching_test_attempts drop constraint teaching_test_tab_completion;
alter table public.teaching_test_attempts add constraint teaching_test_tab_completion check (
  (cardinality(tab_exit_events)<2 and completion_reason is null)
  or (cardinality(tab_exit_events) between 1 and 2 and completion_reason is not distinct from 'tab_switch' and status='submitted')
);

do $patch$
declare source text; pair record; anchor text;
begin
  source:=replace(pg_get_functiondef('public.xelay_private_test_mutate_before_manual_variants(text,jsonb)'::regprocedure),chr(13),'');
  for pair in select * from (values
    ($old$or octet_length(p_payload::text)>(case when p_action='save_test' then 500000 else 2000 end)$old$,
     $new$or octet_length(p_payload::text)>(case when p_action='save_test' then 500000 when p_action='record_tab_exit' then 100000 else 2000 end)$new$),
    ($old$and not (p_action='record_tab_exit' and k in('attempt_id','event_id'))$old$,
     $new$and not (p_action='record_tab_exit' and k in('attempt_id','event_id','pending_answer'))$new$),
    ($old$  v_now:=clock_timestamp();
  if v_test.restrict_tab_switch and v_attempt.status='in_progress' and v_attempt.expires_at>v_now
    and not(v_event=any(v_attempt.tab_exit_events)) then
    if cardinality(v_attempt.tab_exit_events)=1 then
      perform public.xelay_private_test_finish(v_attempt.id,v_now);
      update public.teaching_test_attempts set tab_exit_events=array_append(tab_exit_events,v_event),completion_reason='tab_switch' where id=v_attempt.id;
    else
      update public.teaching_test_attempts set tab_exit_events=array_append(tab_exit_events,v_event) where id=v_attempt.id;
    end if;
  end if;$old$,
     $new$  v_now:=clock_timestamp();
  if v_test.restrict_tab_switch and v_attempt.status='in_progress'
    and not(v_event=any(v_attempt.tab_exit_events)) then
    if p_payload?'pending_answer' then
      v_result:=p_payload->'pending_answer';
      if jsonb_typeof(v_result) is distinct from 'object'
        or not(v_result?&array['question_id','answer','version'])
        or exists(select 1 from jsonb_object_keys(v_result)k where k not in('question_id','answer','version'))
        or jsonb_typeof(v_result->'question_id') is distinct from 'string'
        or jsonb_typeof(v_result->'version') is distinct from 'number'
        or (v_result->>'version')!~'^[1-9][0-9]{0,9}$' then raise exception 'TEST_INVALID_INPUT';end if;
      begin
        -- Reuse the existing identity, optimistic version, answer validation,
        -- admission and statement-arrival deadline guards. Never write raw
        -- answer JSON directly and never trust a browser-provided deadline.
        perform public.xelay_teaching_test_mutate('save_answer',jsonb_build_object(
          'id',v_id,'attempt_id',v_attempt.id,'expected_user_id',v_uid,
          'version',v_result->'version','question_id',v_result->'question_id','answer',v_result->'answer'));
      exception when raise_exception then
        -- An edit arriving after its question deadline is not an accepted
        -- answer. The already-saved answers must still be submitted on exit.
        -- Conflicts and all other failures roll back and retain the event ID
        -- for a reconciled retry; they must not silently discard a valid edit.
        if sqlerrm<>'TEST_ANSWER_LOCKED' then raise;end if;
      end;
      select * into v_attempt from public.teaching_test_attempts where id=v_attempt.id for update;
    end if;
    if v_attempt.expires_at>statement_timestamp() then
      if v_attempt.status='in_progress' then perform public.xelay_private_test_finish(v_attempt.id,clock_timestamp());end if;
      update public.teaching_test_attempts set tab_exit_events=array_append(tab_exit_events,v_event),completion_reason='tab_switch' where id=v_attempt.id;
    end if;
  end if;$new$)
  ) changes(anchor,replacement) loop
    anchor:=replace(pair.anchor,chr(13),'');
    if (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then
      raise exception 'TEST_FIRST_EXIT_SOURCE_CHANGED: %',left(anchor,90);
    end if;
    source:=replace(source,anchor,replace(pair.replacement,chr(13),''));
  end loop;
  execute source;
end $patch$;

notify pgrst,'reload schema';
commit;
