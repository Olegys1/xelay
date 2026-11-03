-- The audience release wrote submission_mode after every publication save.
-- Materials have an author/version guard, so even that no-op UPDATE rejected
-- a new material with TEACHING_CONFLICT. Only assignments use submission_mode.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $fix_group_material_save$
declare
  v_oid oid:=to_regprocedure('public.xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)');
  v_guard oid:=to_regprocedure('public.xelay_guard_teacher_material_author()');
  v_before text;v_after text;v_expected text;v_guard_before text;
  v_metadata_before jsonb;v_metadata_after jsonb;
  v_old text:=$old$update public.teaching_items set submission_mode=coalesce(p_payload->>'submission_mode',submission_mode) where id=v_record.id;
    if v_kind='assignment' then perform public.xelay_teaching_sync_assignment_activity(v_record.id); end if;$old$;
  v_new text:=$new$if v_kind='assignment' then
      update public.teaching_items set submission_mode=coalesce(p_payload->>'submission_mode',submission_mode) where id=v_record.id;
      perform public.xelay_teaching_sync_assignment_activity(v_record.id);
    end if;$new$;
begin
  if v_oid is null or v_guard is null
    or to_regprocedure('public.xelay_teaching_mutate(text,jsonb)') is null then
    raise exception 'GROUP_MATERIAL_SAVE_PREREQUISITE';
  end if;
  v_before:=replace(pg_get_functiondef(v_oid),chr(13),'');
  v_guard_before:=pg_get_functiondef(v_guard);
  if strpos(v_before,'teacher_material_author_withdrawal_contract')=0
    or strpos(v_before,'perform public.xelay_private_teaching_mutation_scope(p_action,p_payload);')=0
    or strpos(v_before,'perform public.xelay_private_teaching_assert_audience_payload(v_id,p_payload->''targets'');')=0
    or strpos(v_guard_before,'if new.version<>old.version+1 then raise exception ''TEACHING_CONFLICT'';end if;')=0
    or (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old)<>1
    or strpos(v_before,v_new)<>0 then
    raise exception 'GROUP_MATERIAL_SAVE_SOURCE_DRIFT';
  end if;
  select jsonb_build_object('owner',proowner,'acl',to_jsonb(proacl),'security_definer',prosecdef,
    'config',to_jsonb(proconfig),'volatility',provolatile)
    into v_metadata_before from pg_proc where oid=v_oid;
  v_expected:=replace(v_before,v_old,v_new);
  execute v_expected;
  v_after:=replace(pg_get_functiondef(v_oid),chr(13),'');
  select jsonb_build_object('owner',proowner,'acl',to_jsonb(proacl),'security_definer',prosecdef,
    'config',to_jsonb(proconfig),'volatility',provolatile)
    into v_metadata_after from pg_proc where oid=v_oid;
  if v_after is distinct from v_expected or v_metadata_after is distinct from v_metadata_before
    or pg_get_functiondef(v_guard) is distinct from v_guard_before then
    raise exception 'GROUP_MATERIAL_SAVE_POSTCONDITION';
  end if;
end $fix_group_material_save$;

commit;
