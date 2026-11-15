-- The original common-deadline regexp captured through the last grade loop.
-- Its notification IF therefore enclosed later dispatcher actions. Restore
-- only the two displaced block boundaries; keep all writers and access guards.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $repair$
declare
  v_signature text:='public.xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)';
  v_definition text;v_original text;
  v_bad_assignment text:=$pattern$(end loop;)(\s+end if;\s+v_result:=jsonb_build_object\('id',v_record\.id,'version',v_record\.version\);)$pattern$;
  v_good_assignment text:=$pattern$end loop;\s+end if;\s+end if;\s+v_result:=jsonb_build_object\('id',v_record\.id,'version',v_record\.version\);$pattern$;
  v_bad_grade text:=$pattern$(end loop;)\s+end if;(\s+return jsonb_build_object\('id',v_activity\.id\);)$pattern$;
  v_good_grade text:=$pattern$end loop;\s+return jsonb_build_object\('id',v_activity\.id\);$pattern$;
  v_bad_assignment_count integer;v_bad_grade_count integer;v_good_assignment_count integer;v_good_grade_count integer;
begin
  select replace(pg_get_functiondef(to_regprocedure(v_signature)),chr(13),'') into v_definition;
  if v_definition is null
    or position('v_deadline_prior_item jsonb' in v_definition)=0
    or position('public.xelay_private_notify_assignment_edit(v_record.id,v_deadline_prior_item,v_deadline_prior_targets)' in v_definition)=0
    or position('if p_action=''save_grade'' then' in v_definition)=0
    or position('if p_action=''publish_grades'' then' in v_definition)=0 then
    raise exception 'TEACHING_GRADEBOOK_DISPATCH_SOURCE_CHANGED';
  end if;
  v_original:=v_definition;
  select count(*) into v_bad_assignment_count from regexp_matches(v_definition,v_bad_assignment,'g');
  select count(*) into v_bad_grade_count from regexp_matches(v_definition,v_bad_grade,'g');
  select count(*) into v_good_assignment_count from regexp_matches(v_definition,v_good_assignment,'g');
  select count(*) into v_good_grade_count from regexp_matches(v_definition,v_good_grade,'g');
  if v_bad_assignment_count=1 and v_bad_grade_count=1 and v_good_assignment_count=0 and v_good_grade_count=0 then
    v_definition:=regexp_replace(v_definition,v_bad_assignment,E'\\1\n      end if;\\2');
    v_definition:=regexp_replace(v_definition,v_bad_grade,'\1\2');
  elsif v_bad_assignment_count=0 and v_bad_grade_count=0 and v_good_assignment_count=1 and v_good_grade_count=1 then
    -- Reapplying the repair must leave the already-correct function unchanged.
    return;
  else
    raise exception 'TEACHING_GRADEBOOK_DISPATCH_SOURCE_CHANGED: %, %, %, %',
      v_bad_assignment_count,v_bad_grade_count,v_good_assignment_count,v_good_grade_count;
  end if;
  select count(*) into v_good_assignment_count from regexp_matches(v_definition,v_good_assignment,'g');
  select count(*) into v_good_grade_count from regexp_matches(v_definition,v_good_grade,'g');
  if v_good_assignment_count<>1 or v_good_grade_count<>1 or v_definition=v_original then
    raise exception 'TEACHING_GRADEBOOK_DISPATCH_REPAIR_FAILED';
  end if;
  -- CREATE OR REPLACE preserves the existing owner, grants and function options.
  execute v_definition;
end $repair$;

commit;
