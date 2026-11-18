-- LOCAL preparation only. This migration changes no plan, payment or global
-- project upload setting. Confirm that the project's global upload ceiling is
-- already >=200 MiB before a later production rollout. Original reads retain
-- their existing feature ACLs and content quarantine, including after expiry.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog,public;

-- Private owner lookup is used only after the upload/receipt's existing ACL.
-- Immutable billing audience and current verified teacher access are checked
-- by entitlement(); editable profile/JWT metadata cannot grant a larger file.
create function xelay_teacher_private.file_limit(p_user_id uuid,p_mime text default '')
returns bigint language plpgsql stable security definer set search_path='' as $$
declare v_state jsonb;
begin
  if p_user_id is null then return 52428800; end if;
  if p_mime is null or p_mime not in('','application/pdf','text/plain') then return 52428800; end if;
  v_state:=xelay_teacher_private.entitlement(p_user_id);
  if v_state->>'audience' is distinct from 'teacher' then return 52428800; end if;
  return case v_state->>'planId'
    when 'teacher_start' then 104857600::bigint
    when 'teacher_plus' then 157286400::bigint
    when 'teacher_max' then 209715200::bigint
    else 52428800::bigint end;
end $$;
revoke all on function xelay_teacher_private.file_limit(uuid,text) from public,anon,authenticated,service_role;

create function public.xelay_teaching_upload_file_limit(p_mime text default '')
returns bigint language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=public.xelay_teaching_assert_user();
begin
  return xelay_teacher_private.file_limit(v_user,p_mime);
end $$;
revoke all on function public.xelay_teaching_upload_file_limit(text) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_upload_file_limit(text) to authenticated;

-- Patch only the inspected size comparisons. Ownership, consent, retirement,
-- current verification and restrictive policies remain installed verbatim.
create function pg_temp.xelay_teacher_file_patch(p_signature text,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text;v_count integer;
begin
  if to_regprocedure(p_signature) is null then raise exception 'TEACHER_FILE_DEPENDENCY_MISSING: %',p_signature; end if;
  v_definition:=pg_get_functiondef(to_regprocedure(p_signature));
  v_count:=(length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old);
  if v_count<>1 then raise exception 'TEACHER_FILE_DEFINITION_DRIFT: %',p_signature; end if;
  execute replace(v_definition,p_old,p_new);
end $$;

select pg_temp.xelay_teacher_file_patch('public.xelay_teaching_validate_resources(uuid,jsonb,jsonb,jsonb)',
 'not between 1 and 52428800','not between 1 and 209715200');
select pg_temp.xelay_teacher_file_patch('public.xelay_teaching_material_file_access_before_content_20261030(uuid,text)',
 'not between 1 and 52428800','not between 1 and 209715200');

-- Paid files that already have a trusted receipt do not disappear on expiry.
-- Fresh verification is bounded by the owner's active plan again; expiry
-- during a scan cannot produce a receipt through the service-only finalizer.
select pg_temp.xelay_teacher_file_patch('public.xelay_upload_scan_candidate(text,text)',
 'if v_size not between 1 and 52428800 then',
 'if v_size not between 1 and (case when p_bucket=''xelay-teaching-files'' then 209715200 else 52428800 end) then');
select pg_temp.xelay_teacher_file_patch('public.xelay_upload_scan_candidate(text,text)',
 'if not v_verified then',
 $replacement$if not v_verified then
    if p_bucket='xelay-teaching-files' and v_size>xelay_teacher_private.file_limit(v_actor,v_object.metadata->>'mimetype') then
      raise exception 'UPLOAD_PLAN_FILE_LIMIT' using errcode='22023';
    end if;$replacement$);
select pg_temp.xelay_teacher_file_patch('public.xelay_upload_scan_candidate(text,text)',
 'v_budget.total_bytes+v_size>262144000',
 'v_budget.total_bytes+v_size>greatest(262144000::bigint,xelay_teacher_private.file_limit(v_actor,'''')*5)');
select pg_temp.xelay_teacher_file_patch('public.xelay_record_upload_content_verification(jsonb,text,text,text,integer)',
 'if v_size not between 1 and 52428800 or v_owner',
 $replacement$if v_size not between 1 and (case when v_object.bucket_id='xelay-teaching-files'
    then xelay_teacher_private.file_limit(case when v_owner ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_owner::uuid end,v_object.metadata->>'mimetype') else 52428800 end) or v_owner$replacement$);

do $$
declare v_policy record;v_expression text;v_old constant text:='(((metadata ->> ''size''::text))::numeric <= (52428800)::numeric)';v_count integer;
begin
  if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)
    or not exists(select 1 from storage.buckets where id='xelay-teaching-files' and public is false and file_size_limit=52428800)
    then raise exception 'TEACHER_FILE_STORAGE_DRIFT'; end if;
  for v_policy in select * from pg_policy where polrelid='storage.objects'::regclass
    and polname in('Teaching file uploads','Teaching upload boundary') loop
    v_expression:=pg_get_expr(v_policy.polwithcheck,v_policy.polrelid);
    v_count:=(length(v_expression)-length(replace(v_expression,v_old,'')))/length(v_old);
    if v_policy.polcmd<>'a' or v_count<>1 or strpos(v_expression,'xelay_teaching_can_upload_file(name)')=0
      then raise exception 'TEACHER_FILE_POLICY_DRIFT: %',v_policy.polname; end if;
    execute format('alter policy %I on storage.objects with check (%s)',v_policy.polname,
      replace(v_expression,v_old,'(((metadata ->> ''size''::text))::numeric <= public.xelay_teaching_upload_file_limit(metadata->>''mimetype''))'));
  end loop;
  get diagnostics v_count=row_count;
  if (select count(*) from pg_policy where polrelid='storage.objects'::regclass
    and polname in('Teaching file uploads','Teaching upload boundary'))<>2 then raise exception 'TEACHER_FILE_POLICY_MISSING'; end if;
  if not exists(select 1 from pg_constraint where conrelid='public.xelay_upload_content_receipts'::regclass
    and conname='xelay_upload_content_receipts_size_check'
    and pg_get_constraintdef(oid) like '%52428800%') then raise exception 'TEACHER_FILE_RECEIPT_DRIFT'; end if;
  if not exists(select 1 from pg_constraint where conrelid='public.xelay_upload_scan_budgets'::regclass
    and conname='xelay_upload_scan_budgets_total_bytes_check'
    and pg_get_constraintdef(oid) like '%262144000%') then raise exception 'TEACHER_FILE_SCAN_BUDGET_DRIFT'; end if;
end $$;
alter table public.xelay_upload_content_receipts drop constraint xelay_upload_content_receipts_size_check;
alter table public.xelay_upload_content_receipts add constraint xelay_upload_content_receipts_size_check
  check(size between 1 and case when bucket_id='xelay-teaching-files' then 209715200 else 52428800 end);
-- Rolling ten-minute processing budget, not retained-library storage. The
-- twenty-check ceiling is unchanged; paid users can inspect five full files.
alter table public.xelay_upload_scan_budgets drop constraint xelay_upload_scan_budgets_total_bytes_check;
alter table public.xelay_upload_scan_budgets add constraint xelay_upload_scan_budgets_total_bytes_check
  check(total_bytes between 0 and 1048576000);
update storage.buckets set file_size_limit=209715200 where id='xelay-teaching-files';

drop function pg_temp.xelay_teacher_file_patch(text,text,text);
comment on function public.xelay_teaching_upload_file_limit(text) is
  'Current caller PDF/TXT ceiling only: free50, teacher Start100/Plus150/Max200 MiB; all other formats remain50MiB. No total-library quota. Does not grant access to any course, object or original.';
notify pgrst,'reload schema';
commit;
