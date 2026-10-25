-- Accept the additional document edition before publishing its matching form.
-- Cached forms retain their exact old edition; no historical consent is inferred,
-- rewritten or backfilled. Only these four version-handling fragments change.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $migration$
declare v_patch record;v_body text;v_old text;v_new text;v_index integer;v_old_count integer;v_new_count integer;
begin
  if to_regclass('public.user_privacy_consents') is null
    or to_regclass('public.xelay_privacy_consent_settings') is null
    or to_regclass('public.xelay_google_registrations') is null
    or to_regprocedure('public.xelay_require_signup_privacy_consent()') is null
    or to_regprocedure('public.xelay_record_signup_privacy_consent()') is null
    or to_regprocedure('public.xelay_accept_privacy_consent(text,text,boolean)') is null
    or to_regprocedure('public.xelay_complete_google_registration(jsonb,text,text,boolean)') is null
    or to_regprocedure('public.xelay_create_registration_profile()') is null then
    raise exception 'HOMEWORK_AI_PRIVACY_PREREQUISITES_MISSING';
  end if;
  -- Never restore an older trigger definition over the Google provisional-flow
  -- guard/recorder or the current academic profile creator.
  if position('google_provisional_registration' in pg_get_functiondef('public.xelay_require_signup_privacy_consent()'::regprocedure))=0
    or position('Google consent is recorded exclusively by the explicit completion RPC.' in pg_get_functiondef('public.xelay_record_signup_privacy_consent()'::regprocedure))=0
    or position('google_provisional_registration' in pg_get_functiondef('public.xelay_create_registration_profile()'::regprocedure))=0
    or position('registration_study_year_contract' in pg_get_functiondef('public.xelay_create_registration_profile()'::regprocedure))=0 then
    raise exception 'HOMEWORK_AI_PRIVACY_GOOGLE_FLOW_DRIFT';
  end if;

  for v_patch in select * from (values
    ('public.xelay_require_signup_privacy_consent()',
      array[$old$if v_meta->>'xelay_privacy_policy_version' is distinct from '2026-10-15.1'
    or v_meta->>'xelay_privacy_consent_version' is distinct from '2026-10-15.1' then$old$],
      array[$new$if row(v_meta->>'xelay_privacy_policy_version',v_meta->>'xelay_privacy_consent_version')
      is distinct from row('2026-10-15.1','2026-10-15.1')
    and row(v_meta->>'xelay_privacy_policy_version',v_meta->>'xelay_privacy_consent_version')
      is distinct from row('2026-10-25.1','2026-10-25.1') then$new$]),
    ('public.xelay_record_signup_privacy_consent()',
      array[
        $old$if v_meta->'xelay_privacy_consent' is distinct from 'true'::jsonb
    or v_meta->>'xelay_privacy_policy_version' is distinct from '2026-10-15.1'
    or v_meta->>'xelay_privacy_consent_version' is distinct from '2026-10-15.1' then$old$,
        $old$values(new.id,'2026-10-15.1','2026-10-15.1',clock_timestamp(),'signup')$old$],
      array[
        $new$if v_meta->'xelay_privacy_consent' is distinct from 'true'::jsonb
    or (row(v_meta->>'xelay_privacy_policy_version',v_meta->>'xelay_privacy_consent_version')
        is distinct from row('2026-10-15.1','2026-10-15.1')
      and row(v_meta->>'xelay_privacy_policy_version',v_meta->>'xelay_privacy_consent_version')
        is distinct from row('2026-10-25.1','2026-10-25.1')) then$new$,
        $new$values(new.id,v_meta->>'xelay_privacy_policy_version',v_meta->>'xelay_privacy_consent_version',clock_timestamp(),'signup')$new$]),
    ('public.xelay_accept_privacy_consent(text,text,boolean)',
      array[
        $old$if p_policy_version is distinct from '2026-10-15.1'
    or p_consent_version is distinct from '2026-10-15.1' then$old$,
        $old$values(v_uid,'2026-10-15.1','2026-10-15.1',clock_timestamp(),'account')$old$,
        $old$where r.user_id=v_uid and r.privacy_policy_version='2026-10-15.1'
      and r.consent_version='2026-10-15.1'$old$],
      array[
        $new$if row(p_policy_version,p_consent_version) is distinct from row('2026-10-15.1','2026-10-15.1')
    and row(p_policy_version,p_consent_version) is distinct from row('2026-10-25.1','2026-10-25.1') then$new$,
        $new$values(v_uid,p_policy_version,p_consent_version,clock_timestamp(),'account')$new$,
        $new$where r.user_id=v_uid and r.privacy_policy_version=p_policy_version
      and r.consent_version=p_consent_version$new$]),
    ('public.xelay_complete_google_registration(jsonb,text,text,boolean)',
      array[
        $old$if p_policy_version is distinct from '2026-10-15.1' or p_consent_version is distinct from '2026-10-15.1' then$old$,
        $old$'xelay_privacy_consent',true,'xelay_privacy_policy_version','2026-10-15.1',
    'xelay_privacy_consent_version','2026-10-15.1'$old$],
      array[
        $new$if row(p_policy_version,p_consent_version) is distinct from row('2026-10-15.1','2026-10-15.1')
    and row(p_policy_version,p_consent_version) is distinct from row('2026-10-25.1','2026-10-25.1') then$new$,
        $new$'xelay_privacy_consent',true,'xelay_privacy_policy_version',p_policy_version,
    'xelay_privacy_consent_version',p_consent_version$new$])
  ) as patches(signature,old_parts,new_parts) loop
    -- SQL Editor/clipboard may store CRLF in both function bodies and the
    -- dollar-quoted expected fragments. Canonicalize that exact line-ending
    -- pair symmetrically; never trim whitespace or remove a standalone CR.
    select replace(pg_get_functiondef(v_patch.signature::regprocedure),chr(13)||chr(10),chr(10)) into v_body;
    if position(chr(13) in v_body)>0 then
      raise exception 'HOMEWORK_AI_PRIVACY_LINE_ENDINGS_DRIFT: %',v_patch.signature;
    end if;
    for v_index in 1..cardinality(v_patch.old_parts) loop
      v_old:=replace(v_patch.old_parts[v_index],chr(13)||chr(10),chr(10));
      v_new:=replace(v_patch.new_parts[v_index],chr(13)||chr(10),chr(10));
      if position(chr(13) in v_old)>0 or position(chr(13) in v_new)>0 then
        raise exception 'HOMEWORK_AI_PRIVACY_LINE_ENDINGS_DRIFT: % fragment %',v_patch.signature,v_index;
      end if;
      v_old_count:=cardinality(string_to_array(v_body,v_old))-1;
      v_new_count:=cardinality(string_to_array(v_body,v_new))-1;
      if v_old_count=1 and v_new_count=0 then
        v_body:=replace(v_body,v_old,v_new);
      elsif v_old_count=0 and v_new_count=1 then
        -- Exact already-patched fragment: reruns preserve all existing receipts.
        null;
      else
        raise exception 'HOMEWORK_AI_PRIVACY_FUNCTION_DRIFT: % fragment %',v_patch.signature,v_index;
      end if;
    end loop;
    -- CREATE OR REPLACE preserves function ownership, grants and trigger links.
    -- Apart from CRLF line endings, every other guard and completion step is intact.
    execute v_body;
  end loop;
end;
$migration$;

notify pgrst,'reload schema';
commit;
