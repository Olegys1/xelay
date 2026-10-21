-- Apply only after 202610210003 and after confirming the existing project
-- upload limit permits 50 MiB without disabling the spend cap or adding charges.
-- The user selected 50 MiB now; 180 MiB remains deferred.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog,public;
lock table storage.objects in share row exclusive mode;
lock table storage.buckets in share mode;

do $teaching_upload_50mib$
declare
  v_policy record;
  v_expected record;
  v_expression text;
  v_compact text;
  v_roles text[];
  v_signature text;
  v_definition text;
  v_anchor constant text := 'not between 1 and 20971520';
  v_replacement constant text := 'not between 1 and 52428800';
  v_request_bound constant text := '(((metadata ->> ''contentLength''::text))::numeric <= (20971520)::numeric)';
  v_file_bound constant text := '(((metadata ->> ''size''::text))::numeric <= (20971520)::numeric)';
  v_file_bound_50mib constant text := '(((metadata ->> ''size''::text))::numeric <= (52428800)::numeric)';
  v_policy_patches jsonb := '[]'::jsonb;
  v_function_patches jsonb := '[]'::jsonb;
  v_patch jsonb;
  v_count integer;
  v_mimes constant text[] := array[
    'application/pdf','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/png','image/jpeg','image/webp','text/plain','text/csv'
  ];
begin
  if not exists(select 1 from pg_catalog.pg_class c
      where c.oid='storage.objects'::regclass and c.relrowsecurity) then
    raise exception 'TEACHING_UPLOAD_RLS_MISSING';
  end if;
  select count(*) into v_count from storage.buckets b
  where b.id in('xelay-teaching-files','xelay-submission-files')
    and b.public is false and b.file_size_limit=20971520
    and (select array_agg(m order by m) from unnest(b.allowed_mime_types) m)
      = (select array_agg(m order by m) from unnest(v_mimes) m);
  if v_count<>2 then raise exception 'TEACHING_UPLOAD_50MIB_BUCKET_DRIFT'; end if;

  -- Keep the installed policies in full. contentLength can include multipart
  -- envelope bytes, so remove only its exact upper-bound comparison, retaining
  -- positive/integer checks. Raise only final metadata.size to 50 MiB. Exact
  -- anchors captured from live 003 must each occur once; drift aborts.
  for v_expected in select * from(values
    ('Teaching file uploads',true,array['authenticated']::text[],'xelay-teaching-files','xelay_teaching_can_upload_file'),
    ('Teaching upload boundary',false,array['anon','authenticated']::text[],'xelay-teaching-files','xelay_teaching_can_upload_file'),
    ('Submission uploads',true,array['authenticated']::text[],'xelay-submission-files','xelay_classroom_can_upload_file'),
    ('Submission upload boundary',false,array['anon','authenticated']::text[],'xelay-submission-files','xelay_classroom_can_upload_file')
  ) expected(policy_name,permissive,roles,bucket_id,upload_predicate) loop
    select p.* into v_policy from pg_catalog.pg_policy p
      where p.polrelid='storage.objects'::regclass and p.polname=v_expected.policy_name;
    if not found then raise exception 'TEACHING_UPLOAD_50MIB_POLICY_MISSING: %',v_expected.policy_name; end if;
    select array_agg(r.rolname::text order by r.rolname::text) into v_roles
      from pg_catalog.pg_roles r where r.oid=any(v_policy.polroles);
    v_expression:=pg_catalog.pg_get_expr(v_policy.polwithcheck,v_policy.polrelid);
    v_compact:=regexp_replace(coalesce(v_expression,''),'[[:space:]]+','','g');
    v_count:=cardinality(regexp_split_to_array(coalesce(v_expression,''),'\m20971520\M'))-1;
    if v_policy.polcmd<>'a' or v_policy.polpermissive is distinct from v_expected.permissive
      or v_policy.polqual is not null or v_roles is distinct from v_expected.roles
      or v_count<>2
      or strpos(v_compact,v_expected.upload_predicate||'(name)')=0
      or strpos(v_expression,quote_literal(v_expected.bucket_id))=0
      or strpos(v_compact,'jsonb_typeof(metadata)')=0
      or strpos(v_compact,'xelay_teaching_file_allowed(name,(metadata->>''mimetype''::text))')=0 then
      raise exception 'TEACHING_UPLOAD_50MIB_POLICY_DRIFT: %',v_expected.policy_name;
    end if;
    v_count:=(length(v_expression)-length(replace(v_expression,v_request_bound,'')))/length(v_request_bound);
    if v_count<>1 then raise exception 'TEACHING_UPLOAD_REQUEST_BOUND_DRIFT: %',v_expected.policy_name; end if;
    v_count:=(length(v_expression)-length(replace(v_expression,v_file_bound,'')))/length(v_file_bound);
    if v_count<>1 then raise exception 'TEACHING_UPLOAD_FILE_BOUND_DRIFT: %',v_expected.policy_name; end if;
    v_expression:=replace(v_expression,v_request_bound,'true');
    v_expression:=replace(v_expression,v_file_bound,v_file_bound_50mib);
    if cardinality(regexp_split_to_array(v_expression,'\m20971520\M'))<>1 then
      raise exception 'TEACHING_UPLOAD_50MIB_UNPATCHED_BOUND: %',v_expected.policy_name;
    end if;
    v_policy_patches:=v_policy_patches||jsonb_build_array(jsonb_build_object(
      'name',v_expected.policy_name,
      'expression',v_expression));
  end loop;

  -- Read each installed validator so later ownership/consent fixes survive.
  -- No function is replaced unless its original upper-bound anchor is unique.
  foreach v_signature in array array[
    'public.xelay_teaching_validate_resources(uuid,jsonb,jsonb,jsonb)',
    'public.xelay_classroom_validate_resources(uuid,jsonb,jsonb,jsonb)'
  ] loop
    if to_regprocedure(v_signature) is null then
      raise exception 'TEACHING_UPLOAD_50MIB_VALIDATOR_MISSING: %',v_signature;
    end if;
    if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure(v_signature)
      and p.prosecdef and p.prokind='f') then
      raise exception 'TEACHING_UPLOAD_50MIB_VALIDATOR_DRIFT: %',v_signature;
    end if;
    v_definition:=pg_catalog.pg_get_functiondef(to_regprocedure(v_signature));
    v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
    if v_count<>1 then raise exception 'TEACHING_UPLOAD_50MIB_VALIDATOR_ANCHOR_DRIFT: %',v_signature; end if;
    v_function_patches:=v_function_patches||jsonb_build_array(
      jsonb_build_object('definition',replace(v_definition,v_anchor,v_replacement)));
  end loop;

  -- All checks passed before any mutation. CREATE OR REPLACE preserves the
  -- existing function identities, owners and execution grants.
  for v_patch in select value from jsonb_array_elements(v_function_patches) loop
    execute v_patch->>'definition';
  end loop;
  for v_patch in select value from jsonb_array_elements(v_policy_patches) loop
    execute format('alter policy %I on storage.objects with check (%s)',
      v_patch->>'name',v_patch->>'expression');
  end loop;
  update storage.buckets set file_size_limit=52428800
    where id in('xelay-teaching-files','xelay-submission-files');
  get diagnostics v_count=row_count;
  if v_count<>2 then raise exception 'TEACHING_UPLOAD_50MIB_BUCKET_UPDATE_MISMATCH'; end if;
end;
$teaching_upload_50mib$;
-- No global limit, spend-cap, plan, read permissions, MIME, upsert or file data
-- is changed. This transaction changes only the two teaching file-size ceilings.
commit;
