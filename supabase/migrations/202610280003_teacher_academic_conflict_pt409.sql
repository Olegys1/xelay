-- Teacher academic revision conflicts must not signal database serialization retries.
-- The approved two-function fix was applied in live Supabase by the coordinator
-- on 2026-10-28. This local migration records the same idempotent SQL for future
-- source synchronization; it does not grant rights or modify user rows.
-- PostgREST 14 can retry custom SQLSTATE 40001 indefinitely. This is a business
-- revision conflict, so retain its guard/message but return explicit HTTP409.
-- Read the installed definitions; preserve every later departmental patch,
-- function signature/default, owner, ACL, SECURITY DEFINER and search_path.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $teacher_academic_nonretryable_conflict$
declare
  v_signature text;
  v_oid oid;
  v_before text;
  v_after text;
  v_catalog_before jsonb;
  v_catalog_after jsonb;
  v_old text := 'raise exception ''TEACHER_ACADEMIC_CONFLICT'' using errcode=''40001'';';
  v_new text := 'raise exception ''TEACHER_ACADEMIC_CONFLICT'' using errcode=''PT409'';';
  v_old_count integer;
  v_new_count integer;
begin
  foreach v_signature in array array[
    'public.xelay_teacher_academic_profile_save(jsonb)',
    'public.xelay_teacher_academic_period_review(uuid,date,timestamptz,uuid)'
  ] loop
    v_oid := to_regprocedure(v_signature);
    if v_oid is null then
      raise exception 'TEACHER_CONFLICT_HOTFIX_MISSING: %', v_signature;
    end if;
    select replace(pg_get_functiondef(p.oid),chr(13),''),to_jsonb(p)-'prosrc'
      into v_before,v_catalog_before from pg_proc p where p.oid=v_oid;
    if not coalesce((v_catalog_before->>'prosecdef')::boolean,false)
      or (select l.lanname from pg_language l join pg_proc p on p.prolang=l.oid where p.oid=v_oid)<>'plpgsql' then
      raise exception 'TEACHER_CONFLICT_HOTFIX_CONTRACT_DRIFT: %', v_signature;
    end if;
    v_old_count := (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
    v_new_count := (length(v_before)-length(replace(v_before,v_new,'')))/length(v_new);
    if v_old_count=0 and v_new_count=1 then
      continue; -- Idempotent rerun of this exact patch.
    end if;
    if v_old_count<>1 or v_new_count<>0 then
      raise exception 'TEACHER_CONFLICT_HOTFIX_SOURCE_DRIFT: %', v_signature;
    end if;
    execute replace(v_before,v_old,v_new);
    select replace(pg_get_functiondef(p.oid),chr(13),''),to_jsonb(p)-'prosrc'
      into v_after,v_catalog_after from pg_proc p where p.oid=v_oid;
    if v_after is distinct from replace(v_before,v_old,v_new)
      or v_catalog_after is distinct from v_catalog_before then
      raise exception 'TEACHER_CONFLICT_HOTFIX_METADATA_CHANGED: %', v_signature;
    end if;
  end loop;
end;
$teacher_academic_nonretryable_conflict$;

notify pgrst,'reload schema';
commit;

-- Read-only receipt: no applicant, contact or key values.
select p.oid::regprocedure::text as function_name,
  p.prosecdef as security_definer,
  pg_get_userbyid(p.proowner) as owner,
  p.proacl,
  p.proconfig,
  position('''TEACHER_ACADEMIC_CONFLICT'' using errcode=''PT409''' in p.prosrc)>0 as nonretryable_conflict,
  position('''TEACHER_ACADEMIC_CONFLICT'' using errcode=''40001''' in p.prosrc)=0 as no_old_business_code
from pg_proc p where p.oid in(
  'public.xelay_teacher_academic_profile_save(jsonb)'::regprocedure,
  'public.xelay_teacher_academic_period_review(uuid,date,timestamptz,uuid)'::regprocedure)
order by p.proname;
