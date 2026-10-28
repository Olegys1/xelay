-- Private voice replies to grade requests. Prepared locally, not applied here.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$ begin
  if to_regprocedure('public.xelay_private_assert_teaching_group(uuid,uuid,text)') is null
    or to_regprocedure('public.xelay_teaching_resolve_grade_request(uuid,integer,text)') is null
    or to_regclass('public.teaching_grade_voice_uploads') is not null
    or exists(select 1 from storage.buckets where id='teaching-grade-voices')
    or not exists(select 1 from pg_class where oid='public.teaching_grade_requests'::regclass and relrowsecurity) then
    raise exception 'TEACHING_GRADE_VOICE_PREREQUISITES_OR_STATE_CHANGED';
  end if;
end $$;

alter table public.teaching_grade_requests add column response_voice jsonb;
alter table public.teaching_grade_request_audit add column response_voice jsonb;
do $$ declare v_constraint text;v_count integer;begin
  select count(*),min(conname) into v_count,v_constraint from pg_constraint
    where conrelid='public.teaching_grade_requests'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%resolved_at%' and pg_get_constraintdef(oid) like '%resolved_by%'
      and pg_get_constraintdef(oid) like '%response%';
  if v_count<>1 then raise exception 'TEACHING_GRADE_VOICE_RESPONSE_CONSTRAINT_DRIFT';end if;
  execute format('alter table public.teaching_grade_requests drop constraint %I',v_constraint);
end $$;
alter table public.teaching_grade_requests add constraint teaching_grade_request_response_shape check(
  (status='open' and resolved_at is null and resolved_by is null and response='' and response_voice is null)
  or(status='resolved' and resolved_at is not null and resolved_by is not null
    and((response_voice is null and length(btrim(response)) between 2 and 2000)
      or(response_voice is not null and jsonb_typeof(response_voice)='object' and length(response)<=2000))));

create table public.teaching_grade_voice_uploads(
  storage_path text primary key,
  request_id uuid not null references public.teaching_grade_requests(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id) on delete cascade,
  upload_id uuid not null,
  mime_type text not null check(mime_type in('audio/webm','audio/ogg','audio/mp4')),
  size bigint not null check(size between 1 and 10485760),
  duration_seconds numeric not null check(duration_seconds>0 and duration_seconds<=300),
  created_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  unique(uploaded_by,upload_id),
  check(storage_path=request_id::text||'/'||uploaded_by::text||'/'||upload_id::text||case mime_type when 'audio/webm' then '.webm' when 'audio/ogg' then '.ogg' else '.mp4' end)
);
create index teaching_grade_voice_uploads_user_created_idx on public.teaching_grade_voice_uploads(uploaded_by,created_at desc);
alter table public.teaching_grade_voice_uploads enable row level security;
revoke all on public.teaching_grade_voice_uploads from public,anon,authenticated,service_role;

create function public.xelay_private_grade_voice_json(p_voice public.teaching_grade_voice_uploads)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('storage_path',(p_voice).storage_path,'mime_type',(p_voice).mime_type,
    'size',(p_voice).size,'duration_seconds',(p_voice).duration_seconds);
$$;
revoke all on function public.xelay_private_grade_voice_json(public.teaching_grade_voice_uploads) from public,anon,authenticated,service_role;

create function public.xelay_teaching_prepare_grade_voice(p_request_id uuid,p_upload_id uuid,p_mime_type text,p_size bigint,p_duration_seconds numeric)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_request public.teaching_grade_requests%rowtype;
  v_upload public.teaching_grade_voice_uploads%rowtype;v_path text;v_course uuid;
begin
  if p_request_id is null or p_upload_id is null or p_mime_type is null or p_mime_type not in('audio/webm','audio/ogg','audio/mp4')
    or p_size is null or p_size not between 1 and 10485760 or p_duration_seconds is null
    or p_duration_seconds<=0 or p_duration_seconds>300 then raise exception 'TEACHING_GRADE_VOICE_INVALID' using errcode='22023';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:grade-voice-user:'||v_uid::text,0));
  select course_id into v_course from public.teaching_grade_requests where id=p_request_id;
  if not found then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  perform public.xelay_teaching_lock_course(v_course,'grades');
  select * into v_request from public.teaching_grade_requests where id=p_request_id for update;
  perform public.xelay_private_assert_teaching_group(v_course,v_request.group_id,'grades');
  if v_request.status<>'open' or not public.xelay_private_grade_request_activity_visible(v_request.activity_id) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  v_path:=p_request_id::text||'/'||v_uid::text||'/'||p_upload_id::text||case p_mime_type when 'audio/webm' then '.webm' when 'audio/ogg' then '.ogg' else '.mp4' end;
  select * into v_upload from public.teaching_grade_voice_uploads where uploaded_by=v_uid and upload_id=p_upload_id;
  if found then
    if v_upload.storage_path<>v_path or v_upload.mime_type<>p_mime_type or v_upload.size<>p_size
      or v_upload.duration_seconds<>p_duration_seconds or v_upload.claimed_at is not null
      or v_upload.created_at<clock_timestamp()-interval '1 hour' then raise exception 'TEACHING_CONFLICT';end if;
    return public.xelay_private_grade_voice_json(v_upload);
  end if;
  if(select count(*) from public.teaching_grade_voice_uploads where uploaded_by=v_uid and created_at>clock_timestamp()-interval '1 hour')>=30
    or(select count(*) from public.teaching_grade_voice_uploads where uploaded_by=v_uid and created_at>clock_timestamp()-interval '1 day')>=100 then
    raise exception 'TEACHING_GRADE_VOICE_RATE_LIMIT';end if;
  insert into public.teaching_grade_voice_uploads(storage_path,request_id,uploaded_by,upload_id,mime_type,size,duration_seconds)
    values(v_path,p_request_id,v_uid,p_upload_id,p_mime_type,p_size,p_duration_seconds) returning * into v_upload;
  return public.xelay_private_grade_voice_json(v_upload);
end $$;

create function public.xelay_teaching_can_upload_grade_voice(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and public.xelay_teaching_has_current_access(auth.uid())
    and exists(select 1 from public.teaching_grade_voice_uploads u
      join public.teaching_grade_requests r on r.id=u.request_id
      join public.teaching_courses c on c.id=r.course_id
      where u.storage_path=p_name and u.uploaded_by=auth.uid() and u.claimed_at is null
        and u.created_at>statement_timestamp()-interval '1 hour' and r.status='open' and c.archived_at is null
        and 'grades'=any(public.xelay_teaching_group_permissions(r.course_id,r.group_id,auth.uid()))
        and public.xelay_private_grade_request_activity_visible(r.activity_id)
        and exists(select 1 from public.teaching_course_groups g where g.course_id=r.course_id and g.group_id=r.group_id and g.status='accepted'));
$$;

create function public.xelay_teaching_can_read_grade_voice(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and exists(select 1 from auth.users u where u.id=auth.uid()
    and u.email_confirmed_at is not null and u.deleted_at is null and coalesce(u.banned_until,'-infinity'::timestamptz)<=now())
    and (exists(select 1 from public.teaching_grade_voice_uploads u
      join public.teaching_grade_requests r on r.id=u.request_id
      join public.teaching_entries e on e.id=r.entry_id and e.user_id=r.user_id and e.course_id=r.course_id and e.group_id=r.group_id
      where u.storage_path=p_name and r.response_voice=public.xelay_private_grade_voice_json(u) and u.claimed_at is not null
        and r.status='resolved' and public.xelay_private_grade_request_activity_visible(r.activity_id)
        and exists(select 1 from public.teaching_course_groups g where g.course_id=r.course_id and g.group_id=r.group_id and g.status='accepted')
        and((r.user_id=auth.uid() and e.active and public.xelay_teaching_is_member(r.group_id,auth.uid()))
          or(public.xelay_teaching_has_current_access(auth.uid()) and 'grades'=any(public.xelay_teaching_group_permissions(r.course_id,r.group_id,auth.uid())))))
      or exists(select 1 from public.teaching_grade_voice_uploads u where u.storage_path=p_name and u.uploaded_by=auth.uid() and u.claimed_at is null));
$$;

create function public.xelay_teaching_can_remove_grade_voice(p_name text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
  if auth.uid() is null then return false;end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:grade-voice-file:'||coalesce(p_name,''),0));
  return exists(select 1 from public.teaching_grade_voice_uploads u where u.storage_path=p_name and u.uploaded_by=auth.uid() and u.claimed_at is null)
    and not exists(select 1 from public.teaching_grade_requests r where r.response_voice->>'storage_path'=p_name);
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('teaching-grade-voices','teaching-grade-voices',false,10485760,array['audio/webm','audio/ogg','audio/mp4']);
-- Policy subqueries cannot read the private reservation table as a browser.
-- The helper below provides the exact metadata comparison under its owner.
create function public.xelay_teaching_grade_voice_upload_valid(p_name text,p_metadata jsonb)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_teaching_can_upload_grade_voice(p_name) and exists(select 1 from public.teaching_grade_voice_uploads v
    where v.storage_path=p_name and p_metadata->>'mimetype'=v.mime_type and (p_metadata->>'size')::numeric=v.size);
$$;
create policy "Grade voice uploads" on storage.objects for insert to authenticated
  with check(bucket_id='teaching-grade-voices' and public.xelay_teaching_grade_voice_upload_valid(name,metadata));
create policy "Grade voice reads" on storage.objects for select to authenticated
  using(bucket_id='teaching-grade-voices' and public.xelay_teaching_can_read_grade_voice(name));
create policy "Grade voice unused removal" on storage.objects for delete to authenticated
  using(bucket_id='teaching-grade-voices' and public.xelay_teaching_can_remove_grade_voice(name));
create policy "Grade voice upload boundary" on storage.objects as restrictive for insert to authenticated
  with check(case when bucket_id='teaching-grade-voices' then auth.uid() is not null and public.xelay_teaching_grade_voice_upload_valid(name,metadata) else true end);
create policy "Grade voice read boundary" on storage.objects as restrictive for select to authenticated
  using(case when bucket_id='teaching-grade-voices' then auth.uid() is not null and public.xelay_teaching_can_read_grade_voice(name) else true end);
create policy "Grade voice removal boundary" on storage.objects as restrictive for delete to authenticated
  using(case when bucket_id='teaching-grade-voices' then auth.uid() is not null and public.xelay_teaching_can_remove_grade_voice(name) else true end);
create policy "Grade voice overwrite boundary" on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id<>'teaching-grade-voices') with check(bucket_id<>'teaching-grade-voices');
-- Anonymous bucket guards contain no authenticated-only helper references:
-- PostgreSQL checks function ACLs even in an unselected CASE branch, which
-- otherwise breaks anonymous reads of unrelated public buckets such as avatars.
create policy "Grade voice anon upload boundary" on storage.objects as restrictive for insert to anon
  with check(bucket_id<>'teaching-grade-voices');
create policy "Grade voice anon read boundary" on storage.objects as restrictive for select to anon
  using(bucket_id<>'teaching-grade-voices');
create policy "Grade voice anon removal boundary" on storage.objects as restrictive for delete to anon
  using(bucket_id<>'teaching-grade-voices');

create function public.xelay_teaching_resolve_grade_request_voice(p_request_id uuid,p_version integer,p_response text,p_voice jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_request public.teaching_grade_requests%rowtype;
  v_course uuid;v_response text:=btrim(coalesce(p_response,''));v_upload public.teaching_grade_voice_uploads%rowtype;
  v_object storage.objects%rowtype;v_path text;
begin
  if p_voice is null or p_voice='null'::jsonb then
    return public.xelay_teaching_resolve_grade_request(p_request_id,p_version,p_response);
  end if;
  if p_request_id is null or p_version is null or p_version<1 or length(v_response)>2000
    or jsonb_typeof(p_voice)<>'object' or octet_length(p_voice::text)>1500 then raise exception 'TEACHING_GRADE_VOICE_INVALID' using errcode='22023';end if;
  select course_id into v_course from public.teaching_grade_requests where id=p_request_id;
  if not found then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  perform public.xelay_teaching_lock_course(v_course,'grades');
  select * into v_request from public.teaching_grade_requests where id=p_request_id and course_id=v_course for update;
  perform public.xelay_private_assert_teaching_group(v_course,v_request.group_id,'grades');
  if not public.xelay_private_grade_request_activity_visible(v_request.activity_id) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  if v_request.status='resolved' and v_request.response=v_response and v_request.response_voice=p_voice and v_request.resolved_by=v_uid
    and p_version in(v_request.version,v_request.version-1) then
    return jsonb_build_object('id',v_request.id,'version',v_request.version,'status',v_request.status);
  end if;
  if v_request.version is distinct from p_version or v_request.status<>'open' then raise exception 'TEACHING_CONFLICT';end if;
  v_path:=p_voice->>'storage_path';
  if v_path is null then raise exception 'TEACHING_GRADE_VOICE_INVALID' using errcode='22023';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:grade-voice-file:'||v_path,0));
  select * into v_upload from public.teaching_grade_voice_uploads where storage_path=v_path for update;
  if not found or v_upload.request_id<>p_request_id or v_upload.uploaded_by<>v_uid or v_upload.claimed_at is not null
    or v_upload.created_at<clock_timestamp()-interval '1 hour' or p_voice<>public.xelay_private_grade_voice_json(v_upload) then
    raise exception 'TEACHING_GRADE_VOICE_FORBIDDEN' using errcode='42501';end if;
  select * into v_object from storage.objects where bucket_id='teaching-grade-voices' and name=v_path for update;
  if not found or coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner')<>v_uid::text
    or v_object.metadata->>'mimetype' is distinct from v_upload.mime_type
    or (v_object.metadata->>'size')::numeric is distinct from v_upload.size then
    raise exception 'TEACHING_GRADE_VOICE_FORBIDDEN' using errcode='42501';end if;
  update public.teaching_grade_voice_uploads set claimed_at=clock_timestamp() where storage_path=v_path;
  update public.teaching_grade_requests set status='resolved',response=v_response,response_voice=public.xelay_private_grade_voice_json(v_upload),
    resolved_by=v_uid,resolved_at=clock_timestamp(),version=version+1 where id=v_request.id returning * into v_request;
  insert into public.teaching_grade_request_audit(grade_request_id,actor_id,event,version,response,response_voice)
    values(v_request.id,v_uid,'resolved',v_request.version,v_response,v_request.response_voice);
  perform public.xelay_teaching_notify(v_request.user_id,'grade-request-resolved:'||v_request.id::text||':'||v_request.version::text,
    'Викладач відповів на ваше прохання перевірити результат. Перегляньте відповідь у розділі балів.',v_request.course_id,v_request.group_id,v_uid);
  return jsonb_build_object('id',v_request.id,'version',v_request.version,'status',v_request.status);
end $$;

revoke all on function public.xelay_teaching_prepare_grade_voice(uuid,uuid,text,bigint,numeric),
  public.xelay_teaching_can_upload_grade_voice(text),public.xelay_teaching_can_read_grade_voice(text),
  public.xelay_teaching_can_remove_grade_voice(text),public.xelay_teaching_grade_voice_upload_valid(text,jsonb),
  public.xelay_teaching_resolve_grade_request_voice(uuid,integer,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_prepare_grade_voice(uuid,uuid,text,bigint,numeric),
  public.xelay_teaching_can_upload_grade_voice(text),public.xelay_teaching_can_read_grade_voice(text),
  public.xelay_teaching_can_remove_grade_voice(text),public.xelay_teaching_grade_voice_upload_valid(text,jsonb),
  public.xelay_teaching_resolve_grade_request_voice(uuid,integer,text,jsonb) to authenticated;

-- Existing request reads use to_jsonb(r), so the attachment is projected only
-- through the same own-student/current-scoped-grader row visibility contract.
comment on table public.teaching_grade_voice_uploads is
  'Private server-owned upload reservations for teacher grade replies. One-hour authorization TTL, bounded per-teacher rates, exact metadata, immutable claimed files. Expired unused files may be removed by their uploader; no public media URLs or transcript.';
notify pgrst,'reload schema';
commit;
