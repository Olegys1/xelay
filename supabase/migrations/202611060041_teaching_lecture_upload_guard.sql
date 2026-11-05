begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog,public;
lock table storage.objects in share row exclusive mode;

-- The bucket and MIME validator already allow lecture video. Keep the
-- independent Storage preflight and final INSERT checks aligned with them.
do $lecture_upload_guard$
declare
  v_expected record;
  v_policy record;
  v_roles text[];
  v_expression text;
  v_extensions constant text := $extensions$ARRAY['pdf'::text, 'doc'::text, 'docx'::text, 'xls'::text, 'xlsx'::text, 'ppt'::text, 'pptx'::text, 'png'::text, 'jpg'::text, 'jpeg'::text, 'webp'::text, 'txt'::text, 'csv'::text]$extensions$;
begin
  foreach v_expression in array array[
    'public.xelay_teaching_can_upload_file(text)',
    'public.xelay_teaching_file_allowed(text,text)'
  ] loop
    if to_regprocedure(v_expression) is null then
      raise exception 'COURSE_MODULE_LECTURE_UPLOAD_FUNCTION_MISSING: %',v_expression;
    end if;
  end loop;

  for v_expected in select * from(values
    ('Teaching file uploads',true,array['authenticated']::text[]),
    ('Teaching upload boundary',false,array['anon','authenticated']::text[])
  ) expected(policy_name,permissive,roles) loop
    select p.* into v_policy from pg_catalog.pg_policy p
      where p.polrelid='storage.objects'::regclass and p.polname=v_expected.policy_name;
    if not found then raise exception 'COURSE_MODULE_LECTURE_UPLOAD_POLICY_MISSING: %',v_expected.policy_name; end if;

    select array_agg(r.rolname::text order by r.rolname::text) into v_roles
      from pg_catalog.pg_roles r where r.oid=any(v_policy.polroles);
    v_expression:=pg_catalog.pg_get_expr(v_policy.polwithcheck,v_policy.polrelid);
    if v_policy.polcmd<>'a' or v_policy.polpermissive is distinct from v_expected.permissive
      or v_policy.polqual is not null or v_roles is distinct from v_expected.roles or v_expression is null
      or strpos(v_expression,quote_literal('xelay-teaching-files'))=0
      or strpos(v_expression,'xelay_teaching_can_upload_file(name)')=0
      or strpos(v_expression,'xelay_teaching_file_allowed(name,')=0
      or (length(v_expression)-length(replace(v_expression,v_extensions,'')))/length(v_extensions)<>1 then
      raise exception 'COURSE_MODULE_LECTURE_UPLOAD_POLICY_DRIFT: %',v_expected.policy_name;
    end if;

    execute format('alter policy %I on storage.objects with check (%s)',v_expected.policy_name,
      replace(v_expression,v_extensions,left(v_extensions,-1)||', ''mp4''::text, ''webm''::text]'));
  end loop;
end $lecture_upload_guard$;
commit;
