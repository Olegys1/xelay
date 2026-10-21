-- Storage preflight uses contentLength rather than final metadata.size.
-- Preserve existing audiences, upload actions, MIME types and 20 MiB limits.
-- The separately prepared 180 MiB change must not bypass the project spend cap.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Stable deparsing for the exact installed-policy drift checks below.
set local search_path=pg_catalog,public;

lock table storage.objects in share row exclusive mode;
lock table storage.buckets in share mode;

do $upload_preflight$
declare
  v_policy record;
  v_expected record;
  v_expression text;
  v_roles text[];
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
      where c.oid='storage.objects'::regclass and c.relrowsecurity)
    or to_regprocedure('public.xelay_teaching_can_upload_file(text)') is null
    or to_regprocedure('public.xelay_classroom_can_upload_file(text)') is null
    or to_regprocedure('public.xelay_teaching_file_allowed(text,text)') is null then
    raise exception 'TEACHING_UPLOAD_PREREQUISITES_MISSING';
  end if;

  -- Bucket limits/MIME filtering are enforced by Storage before accepting bytes.
  -- Abort on changed visibility, limits or MIME allowlists instead of replacing
  -- an operator's unrelated configuration.
  select count(*) into v_count from storage.buckets b
  where b.id in('xelay-teaching-files','xelay-submission-files')
    and b.public is false and b.file_size_limit=20971520
    and (select array_agg(m order by m) from unnest(b.allowed_mime_types) m)
      = (select array_agg(m order by m) from unnest(v_mimes) m);
  if v_count<>2 then raise exception 'TEACHING_UPLOAD_BUCKET_DRIFT'; end if;

  -- Exact expression/role/mode checks. Only whitespace is canonicalized;
  -- parentheses, casts, constants and logical operator order remain significant.
  for v_expected in select * from(values
    ('Teaching file uploads',true,array['authenticated']::text[],$old_teaching_upload$((bucket_id = 'xelay-teaching-files'::text) AND xelay_teaching_can_upload_file(name) AND xelay_teaching_file_allowed(name, (metadata ->> 'mimetype'::text)) AND ((((metadata ->> 'size'::text))::bigint >= 1) AND (((metadata ->> 'size'::text))::bigint <= 20971520)))$old_teaching_upload$),
    ('Teaching upload boundary',false,array['anon','authenticated']::text[],$old_teaching_boundary$CASE
 WHEN (bucket_id = 'xelay-teaching-files'::text) THEN
 CASE
 WHEN (auth.uid() IS NULL) THEN false
 ELSE (xelay_teaching_can_upload_file(name) AND xelay_teaching_file_allowed(name, (metadata ->> 'mimetype'::text)) AND ((((metadata ->> 'size'::text))::bigint >= 1) AND (((metadata ->> 'size'::text))::bigint <= 20971520)))
 END
 ELSE true
END$old_teaching_boundary$),
    ('Submission uploads',true,array['authenticated']::text[],$old_submission_upload$((bucket_id = 'xelay-submission-files'::text) AND xelay_classroom_can_upload_file(name) AND xelay_teaching_file_allowed(name, (metadata ->> 'mimetype'::text)) AND ((((metadata ->> 'size'::text))::bigint >= 1) AND (((metadata ->> 'size'::text))::bigint <= 20971520)))$old_submission_upload$),
    ('Submission upload boundary',false,array['anon','authenticated']::text[],$old_submission_boundary$CASE
 WHEN (bucket_id = 'xelay-submission-files'::text) THEN
 CASE
 WHEN (auth.uid() IS NULL) THEN false
 ELSE (xelay_classroom_can_upload_file(name) AND xelay_teaching_file_allowed(name, (metadata ->> 'mimetype'::text)) AND ((((metadata ->> 'size'::text))::bigint >= 1) AND (((metadata ->> 'size'::text))::bigint <= 20971520)))
 END
 ELSE true
END$old_submission_boundary$)
  ) expected(policy_name,permissive,roles,expression) loop
    select p.* into v_policy from pg_catalog.pg_policy p
      where p.polrelid='storage.objects'::regclass and p.polname=v_expected.policy_name;
    if not found then raise exception 'TEACHING_UPLOAD_POLICY_MISSING: %',v_expected.policy_name; end if;
    select array_agg(r.rolname::text order by r.rolname::text) into v_roles
      from pg_catalog.pg_roles r where r.oid=any(v_policy.polroles);
    v_expression:=pg_catalog.pg_get_expr(v_policy.polwithcheck,v_policy.polrelid);
    if v_policy.polcmd<>'a' or v_policy.polpermissive is distinct from v_expected.permissive
      or v_policy.polqual is not null or v_roles is distinct from v_expected.roles
      or regexp_replace(coalesce(v_expression,''),'[[:space:]]+','','g')
        is distinct from regexp_replace(v_expected.expression,'[[:space:]]+','','g') then
      raise exception 'TEACHING_UPLOAD_POLICY_DRIFT: %',v_expected.policy_name;
    end if;
  end loop;

end;
$upload_preflight$;

-- Supabase Storage permission preflight supplies {mimetype,contentLength,...}
-- and older upload flows may omit metadata; metadata.size is populated only
-- with the uploaded object's final metadata. Missing preflight fields are not
-- permission to publish a file: Storage enforces the private bucket's 20 MiB
-- limit/MIME allowlist, and both publication validators still require the actual
-- object, matching owner, path, size and MIME. Unsupported extensions are denied
-- independently. Supplied malformed/zero/oversized metadata fails closed.
--
-- Source: https://github.com/supabase/storage/blob/master/src/storage/uploader.ts
-- (canUpload preflight calls testPermission with mimetype and contentLength.)

alter policy "Teaching file uploads" on storage.objects
  with check(bucket_id='xelay-teaching-files'
    and public.xelay_teaching_can_upload_file(name)
    and lower(regexp_replace(name, '^.*\.', '')) = any(array[
      'pdf','doc','docx','xls','xlsx','ppt','pptx','png','jpg','jpeg','webp','txt','csv'
    ]::text[])
    and case
      when metadata is null then true
      when jsonb_typeof(metadata) is distinct from 'object' then false
      else
        (not(metadata ? 'mimetype') or case
          when jsonb_typeof(metadata->'mimetype') = 'string'
            then coalesce(public.xelay_teaching_file_allowed(name,metadata->>'mimetype'),false)
          else false end)
        and (not(metadata ? 'size') or case
          when jsonb_typeof(metadata->'size') = 'number'
            then (metadata->>'size')::numeric between 1 and 20971520
              and trunc((metadata->>'size')::numeric) = (metadata->>'size')::numeric
          else false end)
        and (not(metadata ? 'contentLength') or case
          when jsonb_typeof(metadata->'contentLength') = 'number'
            then (metadata->>'contentLength')::numeric between 1 and 20971520
              and trunc((metadata->>'contentLength')::numeric) = (metadata->>'contentLength')::numeric
          else false end)
    end);

alter policy "Teaching upload boundary" on storage.objects
  with check(case when bucket_id='xelay-teaching-files' then
    case when auth.uid() is null then false else
      public.xelay_teaching_can_upload_file(name)
      and lower(regexp_replace(name, '^.*\.', '')) = any(array[
      'pdf','doc','docx','xls','xlsx','ppt','pptx','png','jpg','jpeg','webp','txt','csv'
    ]::text[])
    and case
      when metadata is null then true
      when jsonb_typeof(metadata) is distinct from 'object' then false
      else
        (not(metadata ? 'mimetype') or case
          when jsonb_typeof(metadata->'mimetype') = 'string'
            then coalesce(public.xelay_teaching_file_allowed(name,metadata->>'mimetype'),false)
          else false end)
        and (not(metadata ? 'size') or case
          when jsonb_typeof(metadata->'size') = 'number'
            then (metadata->>'size')::numeric between 1 and 20971520
              and trunc((metadata->>'size')::numeric) = (metadata->>'size')::numeric
          else false end)
        and (not(metadata ? 'contentLength') or case
          when jsonb_typeof(metadata->'contentLength') = 'number'
            then (metadata->>'contentLength')::numeric between 1 and 20971520
              and trunc((metadata->>'contentLength')::numeric) = (metadata->>'contentLength')::numeric
          else false end)
    end
    end else true end);

alter policy "Submission uploads" on storage.objects
  with check(bucket_id='xelay-submission-files'
    and public.xelay_classroom_can_upload_file(name)
    and lower(regexp_replace(name, '^.*\.', '')) = any(array[
      'pdf','doc','docx','xls','xlsx','ppt','pptx','png','jpg','jpeg','webp','txt','csv'
    ]::text[])
    and case
      when metadata is null then true
      when jsonb_typeof(metadata) is distinct from 'object' then false
      else
        (not(metadata ? 'mimetype') or case
          when jsonb_typeof(metadata->'mimetype') = 'string'
            then coalesce(public.xelay_teaching_file_allowed(name,metadata->>'mimetype'),false)
          else false end)
        and (not(metadata ? 'size') or case
          when jsonb_typeof(metadata->'size') = 'number'
            then (metadata->>'size')::numeric between 1 and 20971520
              and trunc((metadata->>'size')::numeric) = (metadata->>'size')::numeric
          else false end)
        and (not(metadata ? 'contentLength') or case
          when jsonb_typeof(metadata->'contentLength') = 'number'
            then (metadata->>'contentLength')::numeric between 1 and 20971520
              and trunc((metadata->>'contentLength')::numeric) = (metadata->>'contentLength')::numeric
          else false end)
    end);

alter policy "Submission upload boundary" on storage.objects
  with check(case when bucket_id='xelay-submission-files' then
    case when auth.uid() is null then false else
      public.xelay_classroom_can_upload_file(name)
      and lower(regexp_replace(name, '^.*\.', '')) = any(array[
      'pdf','doc','docx','xls','xlsx','ppt','pptx','png','jpg','jpeg','webp','txt','csv'
    ]::text[])
    and case
      when metadata is null then true
      when jsonb_typeof(metadata) is distinct from 'object' then false
      else
        (not(metadata ? 'mimetype') or case
          when jsonb_typeof(metadata->'mimetype') = 'string'
            then coalesce(public.xelay_teaching_file_allowed(name,metadata->>'mimetype'),false)
          else false end)
        and (not(metadata ? 'size') or case
          when jsonb_typeof(metadata->'size') = 'number'
            then (metadata->>'size')::numeric between 1 and 20971520
              and trunc((metadata->>'size')::numeric) = (metadata->>'size')::numeric
          else false end)
        and (not(metadata ? 'contentLength') or case
          when jsonb_typeof(metadata->'contentLength') = 'number'
            then (metadata->>'contentLength')::numeric between 1 and 20971520
              and trunc((metadata->>'contentLength')::numeric) = (metadata->>'contentLength')::numeric
          else false end)
    end
    end else true end);

-- No new helper/RPC, grant, reader, overwrite/delete action or policy for any
-- other bucket. Existing RLS, signed URL reads and immutable bytes stay intact.
commit;
