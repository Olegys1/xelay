-- Scheduled teaching publications and independently configurable submission closure.
-- Prepared only: apply as postgres after the current classroom/material/lesson migrations.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $prerequisites$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.xelay_teaching_mutate(text,jsonb)',
    'public.xelay_teaching_item_json(public.teaching_items,uuid)',
    'public.xelay_teaching_can_read_item(uuid,uuid)',
    'public.xelay_teaching_assert_user()',
    'public.xelay_teaching_permissions(uuid,uuid)',
    'public.xelay_teaching_notify(uuid,text,text,uuid,uuid,uuid)',
    'public.xelay_private_assert_teaching_assignment_lesson(uuid,uuid,date,uuid,text,timestamp with time zone)',
    'public.xelay_classroom_assignment(uuid,uuid)',
    'public.xelay_classroom_submission_json(public.teaching_submissions,boolean,boolean)',
    'public.xelay_classroom_submission_mutate(text,jsonb)',
    'public.xelay_classroom_assignment_mutate(text,jsonb)',
    'public.xelay_classroom_mutate(text,jsonb)'
  ] loop
    if to_regprocedure(v_signature) is null then raise exception 'TEACHING_WORKFLOW_PREREQUISITE: %',v_signature; end if;
  end loop;
  if position('teacher_assignment_explicit_lesson_contract' in pg_get_functiondef('public.xelay_teaching_mutate(text,jsonb)'::regprocedure))=0
    or position('teacher_material_author_withdrawal_contract' in pg_get_functiondef('public.xelay_teaching_mutate(text,jsonb)'::regprocedure))=0
    or to_regclass('public.teaching_submission_extensions') is not null
    or exists(select 1 from pg_attribute where attrelid='public.teaching_items'::regclass
      and attname in('publish_at','scheduled_by','submission_format') and not attisdropped)
    or not exists(select 1 from pg_constraint where conrelid='public.teaching_items'::regclass
      and conname='teaching_items_status_check' and contype='c'
      and pg_get_constraintdef(oid)='CHECK ((status = ANY (ARRAY[''draft''::text, ''published''::text])))') then
    raise exception 'TEACHING_WORKFLOW_SCHEMA_OR_FUNCTION_DRIFT';
  end if;
end;
$prerequisites$;

alter table public.teaching_items drop constraint teaching_items_status_check;
alter table public.teaching_items
  add column publish_at timestamptz,
  add column scheduled_by uuid references public.profiles(id) on delete restrict,
  add column submission_format text not null default 'written',
  add constraint teaching_items_status_check check(status in('draft','scheduled','published')),
  add constraint teaching_items_schedule_complete check(
    (status='scheduled' and publish_at is not null and isfinite(publish_at) and scheduled_by is not null)
    or(status<>'scheduled' and publish_at is null and scheduled_by is null)),
  add constraint teaching_items_submission_format_check check(submission_format in('written','oral','defense')
    and(kind='assignment' or submission_format='written'));
create index teaching_items_scheduled_due_idx on public.teaching_items(publish_at,course_id,id) where status='scheduled';
alter table public.teaching_item_targets add column closes_at timestamptz,
  add constraint teaching_targets_closes_at_valid check(closes_at is null or(isfinite(closes_at)
    and(due_at is null or closes_at>=due_at)));

create table public.teaching_scheduled_publication_checks(
  item_id uuid primary key references public.teaching_items(id) on delete cascade,
  item_version integer not null,
  attempts integer not null default 1 check(attempts>0),
  checked_at timestamptz not null default clock_timestamp(),
  next_attempt_at timestamptz not null,
  error_code text not null
);
create table public.teaching_submission_extensions(
  item_id uuid not null references public.teaching_items(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  closes_at timestamptz check(closes_at is null or isfinite(closes_at)),
  version integer not null default 1 check(version>0),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  primary key(item_id,group_id,user_id)
);
create table public.teaching_submission_extension_audit(
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.teaching_items(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  old_closes_at timestamptz,new_closes_at timestamptz,
  version integer not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.teaching_scheduled_publication_checks enable row level security;
alter table public.teaching_submission_extensions enable row level security;
alter table public.teaching_submission_extension_audit enable row level security;
revoke all on public.teaching_scheduled_publication_checks,public.teaching_submission_extensions,
  public.teaching_submission_extension_audit from public,anon,authenticated,service_role;

create function public.xelay_private_teaching_closes_at(p_item uuid,p_group uuid,p_user uuid)
returns timestamptz language sql stable security definer set search_path='' as $$
  select case when t.closes_at is null then null else greatest(t.closes_at,coalesce(e.closes_at,t.closes_at)) end
  from public.teaching_item_targets t left join public.teaching_submission_extensions e
    on e.item_id=t.item_id and e.group_id=t.group_id and e.user_id=p_user
  where t.item_id=p_item and t.group_id=p_group;
$$;
revoke all on function public.xelay_private_teaching_closes_at(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.xelay_private_teaching_scheduler_ready()
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from pg_extension where extname='pg_cron') or to_regclass('cron.job') is null then return false; end if;
  return exists(select 1 from cron.job where jobname='xelay-teaching-publications' and active
    and username='postgres' and database=current_database()
    and command='select public.xelay_publish_due_teaching_items();' and schedule='* * * * *');
end $$;
revoke all on function public.xelay_private_teaching_scheduler_ready() from public,anon,authenticated,service_role;

create function public.xelay_teaching_scheduled_items(p_group_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();
begin
  return jsonb_build_object('items',coalesce((select jsonb_agg(
    public.xelay_teaching_item_json(i)||jsonb_build_object('course_title',c.title,'kind',i.kind,
      'schedule_error',q.error_code,'schedule_checked_at',q.checked_at) order by i.publish_at,i.id)
    from public.teaching_items i join public.teaching_courses c on c.id=i.course_id
    left join public.teaching_scheduled_publication_checks q on q.item_id=i.id and q.item_version=i.version
    where i.status='scheduled' and i.withdrawn_at is null and c.archived_at is null
      and(case when i.kind='assignment' then 'assignments' else 'materials' end)=any(public.xelay_teaching_permissions(i.course_id,v_uid))
      and(i.kind<>'material' or i.created_by=v_uid)
      and(p_group_id is null or exists(select 1 from public.teaching_item_targets t where t.item_id=i.id and t.group_id=p_group_id))
  ),'[]'::jsonb));
end $$;
revoke all on function public.xelay_teaching_scheduled_items(uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_scheduled_items(uuid) to authenticated;

create function public.xelay_private_cancel_scheduled_teaching(p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_item public.teaching_items%rowtype;
  v_id uuid:=(p_payload->>'id')::uuid;v_version integer:=(p_payload->>'version')::integer;
  v_course uuid;v_kind text;v_request uuid:=nullif(p_payload->>'request_id','')::uuid;v_receipt public.teaching_create_receipts%rowtype;v_result jsonb;
begin
  if v_id is null or v_version is null or v_version<1 or v_request is null then raise exception 'TEACHING_INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:cancel-scheduled:'||v_uid::text||':'||v_request::text,0));
  select * into v_receipt from public.teaching_create_receipts
    where user_id=v_uid and action='cancel_scheduled_publication' and request_id=v_request;
  if found then
    if v_receipt.payload is distinct from p_payload then raise exception 'TEACHING_CONFLICT'; end if;
    return v_receipt.result;
  end if;
  select course_id,kind into v_course,v_kind from public.teaching_items where id=v_id;
  if not found or(p_payload ? 'course_id' and(p_payload->>'course_id')::uuid is distinct from v_course) then
    raise exception 'TEACHING_NOT_FOUND'; end if;
  perform public.xelay_teaching_lock_course(v_course,case when v_kind='assignment' then 'assignments' else 'materials' end);
  select * into v_item from public.teaching_items where id=v_id and course_id=v_course for update;
  if v_item.kind='material' and v_item.created_by<>v_uid then raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501'; end if;
  if v_item.version is distinct from v_version then raise exception 'TEACHING_CONFLICT'; end if;
  if v_item.status<>'scheduled' or v_item.withdrawn_at is not null then raise exception 'TEACHING_NOT_SCHEDULED'; end if;
  update public.teaching_items set status='draft',publish_at=null,scheduled_by=null,version=version+1,updated_at=clock_timestamp()
    where id=v_id returning * into v_item;
  delete from public.teaching_scheduled_publication_checks where item_id=v_id;
  v_result:=jsonb_build_object('id',v_id,'version',v_item.version,'status','draft');
  insert into public.teaching_create_receipts(user_id,action,request_id,payload,result)
    values(v_uid,'cancel_scheduled_publication',v_request,p_payload,v_result);
  return v_result;
end $$;
revoke all on function public.xelay_private_cancel_scheduled_teaching(jsonb) from public,anon,authenticated,service_role;

create function public.xelay_private_set_submission_extension(p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_item public.teaching_items%rowtype;v_prior public.teaching_submission_extensions%rowtype;
  v_item_id uuid:=(p_payload->>'item_id')::uuid;v_group uuid:=(p_payload->>'group_id')::uuid;
  v_user uuid:=(p_payload->>'user_id')::uuid;v_version integer:=coalesce((p_payload->>'version')::integer,0);
  v_close timestamptz;v_base timestamptz;v_new_version integer;
begin
  if v_item_id is null or v_group is null or v_user is null or not(p_payload ? 'closes_at')
    or(p_payload->'closes_at'<>'null'::jsonb and jsonb_typeof(p_payload->'closes_at') is distinct from 'string')
    or(p_payload ? 'request_id' and(p_payload->>'request_id')::uuid is distinct from(p_payload->>'id')::uuid) then
    raise exception 'TEACHING_INVALID_INPUT'; end if;
  select * into v_item from public.teaching_items where id=v_item_id and kind='assignment';
  if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
  perform public.xelay_classroom_lock_group(v_item.course_id,v_group,'assignments');
  select * into v_item from public.teaching_items where id=v_item_id for update;
  if v_item.status<>'published' or v_item.withdrawn_at is not null or not public.xelay_teaching_is_member(v_group,v_user) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  select closes_at into v_base from public.teaching_item_targets where item_id=v_item_id and group_id=v_group for update;
  if not found then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  v_close:=nullif(p_payload->>'closes_at','')::timestamptz;
  if v_close is not null and(not isfinite(v_close) or v_base is null or v_close<v_base) then
    raise exception 'TEACHING_EXTENSION_INVALID' using errcode='22023'; end if;
  select * into v_prior from public.teaching_submission_extensions
    where item_id=v_item_id and group_id=v_group and user_id=v_user for update;
  if v_version is distinct from coalesce(v_prior.version,0) then raise exception 'TEACHING_CONFLICT'; end if;
  v_new_version:=coalesce(v_prior.version,0)+1;
  insert into public.teaching_submission_extensions(item_id,group_id,user_id,closes_at,version,updated_by)
    values(v_item_id,v_group,v_user,v_close,v_new_version,v_uid)
    on conflict(item_id,group_id,user_id) do update set closes_at=excluded.closes_at,version=excluded.version,
      updated_by=excluded.updated_by,updated_at=clock_timestamp();
  insert into public.teaching_submission_extension_audit(item_id,group_id,user_id,actor_id,old_closes_at,new_closes_at,version)
    values(v_item_id,v_group,v_user,v_uid,v_prior.closes_at,v_close,v_new_version);
  perform public.xelay_teaching_notify(v_user,'teaching-extension:'||v_item_id::text||':'||v_group::text||':'||v_new_version::text,
    case when v_close is null then 'Викладач оновив ваш термін завершення приймання роботи.' else 'Викладач продовжив для вас приймання роботи.' end,
    v_item.course_id,v_group,v_uid);
  return jsonb_build_object('id',p_payload->>'id','version',v_new_version,'item_id',v_item_id,'group_id',v_group,
    'user_id',v_user,'closes_at',v_close,'effective_closes_at',public.xelay_private_teaching_closes_at(v_item_id,v_group,v_user));
end $$;
revoke all on function public.xelay_private_set_submission_extension(jsonb) from public,anon,authenticated,service_role;

-- The worker never runs with an end user's JWT and never calls a mutation RPC
-- while pretending to be its author. Its only caller is postgres (including cron).
create function public.xelay_publish_due_teaching_items()
returns integer language plpgsql volatile security definer set search_path='' as $$
declare v_candidate record;v_item public.teaching_items%rowtype;v_course public.teaching_courses%rowtype;
  v_target record;v_file jsonb;v_object storage.objects%rowtype;v_recipient uuid;v_permission text;
  v_actor uuid;v_identity uuid;v_count integer:=0;v_error text;
begin
  if session_user<>'postgres' or coalesce(current_setting('role',true),'none') not in('none','postgres') then
    raise exception 'TEACHING_SCHEDULER_FORBIDDEN' using errcode='42501'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('xelay:teaching:scheduled-publication',0)) then return 0; end if;
  for v_candidate in select i.id,i.course_id from public.teaching_items i
    left join public.teaching_scheduled_publication_checks q on q.item_id=i.id and q.item_version=i.version
    where i.status='scheduled' and i.publish_at<=clock_timestamp() and i.withdrawn_at is null
      and(q.next_attempt_at is null or q.next_attempt_at<=clock_timestamp())
    order by q.checked_at nulls first,i.publish_at,i.id limit 100 loop
    begin
      -- Match ordinary editor lock order: course -> group timetable -> links -> item.
      select * into v_course from public.teaching_courses where id=v_candidate.course_id for update skip locked;
      if not found then continue; end if;
      select * into v_item from public.teaching_items where id=v_candidate.id and status='scheduled'
        and publish_at<=clock_timestamp() and withdrawn_at is null;
      if not found then continue; end if;
      v_permission:=case when v_item.kind='assignment' then 'assignments' else 'materials' end;
      v_actor:=v_item.scheduled_by;
      if v_course.archived_at is not null or v_actor is null then raise exception 'TEACHING_SCHEDULE_AUTHOR_ACCESS_CHANGED'; end if;
      -- Hold the identity/verification rows through publication. A concurrent
      -- ban, scope change or verification revocation cannot slip in between
      -- the fresh permission check and visibility/notification changes. NOWAIT
      -- avoids a course -> identity / account-deletion -> course FK deadlock;
      -- the per-item exception block releases these locks and schedules retry.
      for v_identity in select distinct u from unnest(array[v_item.created_by,v_actor]) as identities(u) order by u loop
        perform 1 from auth.users where id=v_identity for share nowait;
        if not found then raise exception 'TEACHING_SCHEDULE_AUTHOR_ACCESS_CHANGED'; end if;
        perform 1 from public.profiles where id=v_identity for share nowait;
        if not found then raise exception 'TEACHING_SCHEDULE_AUTHOR_ACCESS_CHANGED'; end if;
        perform 1 from public.teacher_verification_requests where user_id=v_identity for share nowait;
        if not found then raise exception 'TEACHING_SCHEDULE_AUTHOR_ACCESS_CHANGED'; end if;
      end loop;
      if not v_permission=any(public.xelay_teaching_permissions(v_item.course_id,v_actor))
        or not v_permission=any(public.xelay_teaching_permissions(v_item.course_id,v_item.created_by)) then
        raise exception 'TEACHING_SCHEDULE_AUTHOR_ACCESS_CHANGED'; end if;
      if not exists(select 1 from public.teaching_item_targets where item_id=v_item.id) then raise exception 'TEACHING_SCHEDULE_TARGET_REQUIRED'; end if;
      for v_target in select * from public.teaching_item_targets where item_id=v_item.id order by group_id loop
        perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||v_target.group_id::text,0));
        perform 1 from public.teaching_course_groups where course_id=v_item.course_id and group_id=v_target.group_id and status='accepted' for update;
        if not found then raise exception 'TEACHING_SCHEDULE_GROUP_ACCESS_CHANGED'; end if;
        if v_item.kind='assignment' then
          perform public.xelay_private_assert_teaching_assignment_lesson(v_item.course_id,v_target.group_id,
            v_target.lesson_date,v_target.schedule_item_id,v_target.placement_mode,v_target.due_at);
        end if;
      end loop;
      select * into v_item from public.teaching_items where id=v_item.id and status='scheduled' for update;
      if not found then continue; end if;
      if v_item.kind='material' and(v_item.rights_accepted_by is distinct from v_item.created_by
        or v_actor is distinct from v_item.created_by or v_item.rights_accepted_at is null
        or v_item.rights_terms_version is distinct from '2026-10-21.1') then raise exception 'TEACHING_MATERIAL_RIGHTS_REQUIRED'; end if;
      perform public.xelay_teaching_validate_resources(v_item.course_id,v_item.links,v_item.attachments,v_item.attachments);
      for v_file in select value from jsonb_array_elements(v_item.attachments) order by value->>'storage_path' loop
        perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-file:'||(v_file->>'storage_path'),0));
        select * into v_object from storage.objects where bucket_id='xelay-teaching-files' and name=v_file->>'storage_path' for key share;
        -- Exact descriptors retained by the existing trusted semester/group-copy
        -- paths may use the original course directory. They were validated at
        -- save time; recheck the actual private object without changing attribution.
        if not found or public.xelay_teaching_file_course(v_file->>'storage_path') is null
          or coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner') is distinct from split_part(v_file->>'storage_path','/',2)
          or(v_object.metadata->>'size')::numeric is distinct from(v_file->>'size')::numeric
          or v_object.metadata->>'mimetype' is distinct from v_file->>'mime_type' then raise exception 'TEACHING_FILE_FORBIDDEN'; end if;
      end loop;
      update public.teaching_items set status='published',published_at=clock_timestamp(),publish_at=null,scheduled_by=null,
        version=version+1,updated_at=clock_timestamp() where id=v_item.id and status='scheduled' returning * into v_item;
      if not found then continue; end if;
      if v_item.kind='assignment' then perform public.xelay_teaching_sync_assignment_activity(v_item.id); end if;
      for v_recipient in select distinct p.id from public.profiles p join public.teaching_item_targets t
        on public.xelay_teaching_is_member(t.group_id,p.id) where t.item_id=v_item.id order by p.id loop
        perform public.xelay_teaching_notify(v_recipient,'teaching-item:'||v_item.id::text||':'||v_item.version::text,
          case when v_item.kind='assignment' then 'Нове завдання' else 'Нові матеріали' end||' з предмета «'||v_course.title||'».',
          v_item.course_id,null,v_actor);
      end loop;
      delete from public.teaching_scheduled_publication_checks where item_id=v_item.id;
      v_count:=v_count+1;
    exception when others then
      v_error:=case when sqlerrm~'^[A-Z][A-Z0-9_]{2,100}$' then sqlerrm else sqlstate end;
      insert into public.teaching_scheduled_publication_checks(item_id,item_version,next_attempt_at,error_code)
        select i.id,i.version,clock_timestamp()+interval '5 minutes',v_error from public.teaching_items i where i.id=v_candidate.id and i.status='scheduled'
        on conflict(item_id) do update set item_version=excluded.item_version,attempts=public.teaching_scheduled_publication_checks.attempts+1,
          checked_at=clock_timestamp(),next_attempt_at=excluded.next_attempt_at,error_code=excluded.error_code;
    end;
  end loop;
  return v_count;
end $$;
revoke all on function public.xelay_publish_due_teaching_items() from public,anon,authenticated,service_role;

create function public.xelay_install_teaching_publication_cron()
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare v_job bigint;
begin
  if session_user<>'postgres' or coalesce(current_setting('role',true),'none') not in('none','postgres') then
    raise exception 'TEACHING_SCHEDULER_FORBIDDEN' using errcode='42501'; end if;
  if not exists(select 1 from pg_extension where extname='pg_cron') or to_regclass('cron.job') is null then
    raise exception 'TEACHING_SCHEDULER_EXTENSION_REQUIRED'; end if;
  if exists(select 1 from cron.job where jobname='xelay-teaching-publications' and username<>'postgres') then
    raise exception 'TEACHING_SCHEDULER_JOB_OWNER_CHANGED'; end if;
  select cron.schedule('xelay-teaching-publications','* * * * *','select public.xelay_publish_due_teaching_items();') into v_job;
  if not public.xelay_private_teaching_scheduler_ready() then raise exception 'TEACHING_SCHEDULER_UNAVAILABLE'; end if;
  return v_job;
end $$;
revoke all on function public.xelay_install_teaching_publication_cron() from public,anon,authenticated,service_role;

-- Strict, small fragments preserve all installed grading, upload, material-rights,
-- lesson-binding, version and receipt checks. Normalize CRLF symmetrically in
-- catalog bodies and migration literals because the SQL editor can send CRLF.
-- Every other character and the exact expected occurrence count stay guarded.
do $patches$
declare v_patch record;v_body text;v_old text;v_count integer;
begin
  for v_patch in select * from(values
    (1,'public.xelay_teaching_mutate(text,jsonb)',
      $old$  v_version:=nullif(p_payload->>'version','')::integer;$old$,
      $new$  v_version:=nullif(p_payload->>'version','')::integer;
  -- teaching_workflow_expansion_contract
  if p_action='cancel_scheduled_publication' then return public.xelay_private_cancel_scheduled_teaching(p_payload); end if;$new$),
    (2,'public.xelay_teaching_mutate(text,jsonb)',
      $old$if coalesce(p_payload->>'status','draft')='published'$old$,
      $new$if coalesce(p_payload->>'status','draft') in('published','scheduled')$new$),
    (3,'public.xelay_teaching_mutate(text,jsonb)',
      $old$if v_status not in('draft','published') or jsonb_typeof(p_payload->'targets') is distinct from 'array'$old$,
      $new$if v_status not in('draft','scheduled','published') or jsonb_typeof(p_payload->'targets') is distinct from 'array'$new$),
    (4,'public.xelay_teaching_mutate(text,jsonb)',
      $old$or(v_status='published' and jsonb_array_length(p_payload->'targets')=0) then raise exception 'TEACHING_INVALID_INPUT'; end if;$old$,
      $new$or(v_status in('published','scheduled') and jsonb_array_length(p_payload->'targets')=0) then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if p_payload ? 'submission_format' and(p_payload->>'submission_format' is null
      or p_payload->>'submission_format' not in('written','oral','defense') or(v_kind='material' and p_payload->>'submission_format'<>'written')) then
      raise exception 'TEACHING_INVALID_INPUT'; end if;
    if v_status='scheduled' then
      if not public.xelay_private_teaching_scheduler_ready() then raise exception 'TEACHING_SCHEDULER_UNAVAILABLE'; end if;
      if v_record.status='published' or v_record.published_at is not null then raise exception 'TEACHING_PUBLISHED_CANNOT_SCHEDULE'; end if;
      if nullif(p_payload->>'publish_at','') is null or not isfinite((p_payload->>'publish_at')::timestamptz)
        or(p_payload->>'publish_at')::timestamptz<=clock_timestamp() then raise exception 'TEACHING_SCHEDULE_TIME_INVALID'; end if;
    end if;$new$),
    (5,'public.xelay_teaching_mutate(text,jsonb)',
      $old$if v_kind='assignment' and(v_status='published' or nullif(v_target->>'schedule_item_id','') is not null) then$old$,
      $new$if v_kind='assignment' and(v_status in('published','scheduled') or nullif(v_target->>'schedule_item_id','') is not null) then$new$),
    (6,'public.xelay_teaching_mutate(text,jsonb)',
      $old$rights_accepted_by,rights_accepted_at,rights_terms_version)$old$,
      $new$rights_accepted_by,rights_accepted_at,rights_terms_version,publish_at,scheduled_by,submission_format)$new$),
    (7,'public.xelay_teaching_mutate(text,jsonb)',
      $old$case when v_kind='material' and v_status='published' then v_uid end,
        case when v_kind='material' and v_status='published' then clock_timestamp() end,
        case when v_kind='material' and v_status='published' then '2026-10-21.1' end) returning * into v_record;$old$,
      $new$case when v_kind='material' and v_status in('published','scheduled') then v_uid end,
        case when v_kind='material' and v_status in('published','scheduled') then clock_timestamp() end,
        case when v_kind='material' and v_status in('published','scheduled') then '2026-10-21.1' end,
        case when v_status='scheduled' then(p_payload->>'publish_at')::timestamptz end,
        case when v_status='scheduled' then v_uid end,coalesce(p_payload->>'submission_format','written')) returning * into v_record;$new$),
    (8,'public.xelay_teaching_mutate(text,jsonb)',
      $old$rights_accepted_by=case when v_kind='material' and v_status='published' then v_uid else rights_accepted_by end,
        rights_accepted_at=case when v_kind='material' and v_status='published' then clock_timestamp() else rights_accepted_at end,
        rights_terms_version=case when v_kind='material' and v_status='published' then '2026-10-21.1' else rights_terms_version end,$old$,
      $new$rights_accepted_by=case when v_kind='material' and v_status in('published','scheduled') then v_uid else rights_accepted_by end,
        rights_accepted_at=case when v_kind='material' and v_status in('published','scheduled') then clock_timestamp() else rights_accepted_at end,
        rights_terms_version=case when v_kind='material' and v_status in('published','scheduled') then '2026-10-21.1' else rights_terms_version end,
        publish_at=case when v_status='scheduled' then(p_payload->>'publish_at')::timestamptz end,
        scheduled_by=case when v_status='scheduled' then v_uid end,
        submission_format=coalesce(p_payload->>'submission_format',submission_format),$new$),
    (9,'public.xelay_teaching_mutate(text,jsonb)',
      $old$delete from public.teaching_item_targets where item_id=v_record.id;$old$,
      $new$-- Preserve existing closures when a legacy client does not send the new target field.
    select coalesce(jsonb_object_agg(t.group_id::text,to_jsonb(t.closes_at)),'{}'::jsonb) into v_prior
      from public.teaching_item_targets t where t.item_id=v_record.id;
    delete from public.teaching_item_targets where item_id=v_record.id;$new$),
    (10,'public.xelay_teaching_mutate(text,jsonb)',
      $old$insert into public.teaching_item_targets(item_id,group_id,due_at,lesson_date,schedule_item_id,placement_mode)
      select v_record.id,(value->>'group_id')::uuid,nullif(value->>'due_at','')::timestamptz,$old$,
      $new$insert into public.teaching_item_targets(item_id,group_id,due_at,closes_at,lesson_date,schedule_item_id,placement_mode)
      select v_record.id,(value->>'group_id')::uuid,nullif(value->>'due_at','')::timestamptz,
        case when v_kind='assignment' then case when value ? 'closes_at' then nullif(value->>'closes_at','')::timestamptz
          else nullif(v_prior->>(value->>'group_id'),'')::timestamptz end end,$new$),
    (11,'public.xelay_teaching_mutate(text,jsonb)',
      $old$if v_kind='assignment' then perform public.xelay_teaching_sync_assignment_activity(v_record.id); end if;$old$,
      $new$delete from public.teaching_scheduled_publication_checks where item_id=v_record.id;
    if v_kind='assignment' then perform public.xelay_teaching_sync_assignment_activity(v_record.id); end if;$new$),
    (12,'public.xelay_guard_teacher_material_author()',
      $old$if new.status='published' and(new.rights_accepted_by is distinct from v_uid$old$,
      $new$if new.status in('published','scheduled') and(new.rights_accepted_by is distinct from v_uid$new$),
    (13,'public.xelay_teaching_item_json(public.teaching_items,uuid)',
      $old$'group_id',t.group_id,'due_at',t.due_at,$old$,
      $new$'group_id',t.group_id,'due_at',t.due_at,'closes_at',t.closes_at,$new$),
    (14,'public.xelay_classroom_submission_json(public.teaching_submissions,boolean,boolean)',
      $old$'late',coalesce(p_submission.submitted_at>t.due_at,false))$old$,
      $new$'late',coalesce(p_submission.submitted_at>t.due_at,false),
    'effective_closes_at',public.xelay_private_teaching_closes_at(p_submission.item_id,p_submission.group_id,p_submission.user_id),
    'extension_version',coalesce((select e.version from public.teaching_submission_extensions e
      where e.item_id=p_submission.item_id and e.group_id=p_submission.group_id and e.user_id=p_submission.user_id),0),
    'extension_closes_at',(select e.closes_at from public.teaching_submission_extensions e
      where e.item_id=p_submission.item_id and e.group_id=p_submission.group_id and e.user_id=p_submission.user_id))$new$),
    (15,'public.xelay_classroom_assignment(uuid,uuid)',
      $old$'permissions',v_permissions,'can_submit',v_student and v_course.archived_at is null,$old$,
      $new$'permissions',v_permissions,
    'effective_closes_at',public.xelay_private_teaching_closes_at(p_item_id,p_group_id,v_uid),
    'is_closed',coalesce(public.xelay_private_teaching_closes_at(p_item_id,p_group_id,v_uid)<=statement_timestamp(),false),
    'can_save_draft',v_student and v_course.archived_at is null,
    'can_submit',v_student and v_course.archived_at is null
      and coalesce(public.xelay_private_teaching_closes_at(p_item_id,p_group_id,v_uid)>statement_timestamp(),true),
    'submission_extensions',case when 'assignments'=any(v_permissions) then coalesce((select jsonb_agg(to_jsonb(e)-array['updated_by','updated_at'])
      from public.teaching_submission_extensions e where e.item_id=p_item_id and e.group_id=p_group_id),'[]'::jsonb) else '[]'::jsonb end,$new$),
    (16,'public.xelay_classroom_assignment(uuid,uuid)',
      $old$jsonb_build_object('user_id',p.id,'full_name',p.full_name,'username',p.username) order by p.full_name$old$,
      $new$jsonb_build_object('user_id',p.id,'full_name',p.full_name,'username',p.username,
      'effective_closes_at',public.xelay_private_teaching_closes_at(p_item_id,p_group_id,p.id),
      'extension_version',coalesce((select e.version from public.teaching_submission_extensions e where e.item_id=p_item_id and e.group_id=p_group_id and e.user_id=p.id),0),
      'extension_closes_at',(select e.closes_at from public.teaching_submission_extensions e where e.item_id=p_item_id and e.group_id=p_group_id and e.user_id=p.id)) order by p.full_name$new$),
    (17,'public.xelay_classroom_submission_mutate(text,jsonb)',
      $old$if length(btrim(v_submission.draft_body))=0 and jsonb_array_length(v_submission.draft_links)=0$old$,
      $new$if v_item.submission_format='written' and length(btrim(v_submission.draft_body))=0 and jsonb_array_length(v_submission.draft_links)=0$new$),
    (18,'public.xelay_classroom_submission_mutate(text,jsonb)',
      $old$      update public.teaching_submissions set status='submitted',body=draft_body,links=draft_links,attachments=draft_attachments,
        attempt=attempt+1,submitted_at=now(),reviewed_at=null,reviewed_by=null,feedback='',version=version+1,updated_at=now()$old$,
      $new$      -- Only final submission closes. Private drafts, teacher review/return and grades remain independent.
      if coalesce(public.xelay_private_teaching_closes_at(v_submission.item_id,v_submission.group_id,v_uid)<=clock_timestamp(),false) then
        raise exception 'CLASSROOM_SUBMISSIONS_CLOSED'; end if;
      update public.teaching_submissions set status='submitted',body=draft_body,links=draft_links,attachments=draft_attachments,
        attempt=attempt+1,submitted_at=clock_timestamp(),reviewed_at=null,reviewed_by=null,feedback='',version=version+1,updated_at=now()$new$),
    (19,'public.xelay_classroom_mutate(text,jsonb)',
      $old$'copy_assignment','save_group_assignment','delete_group_assignment','save_seminar_schedule','save_seminar','delete_seminar')$old$,
      $new$'copy_assignment','save_group_assignment','delete_group_assignment','save_seminar_schedule','save_seminar','delete_seminar','set_submission_extension')$new$),
    (20,'public.xelay_classroom_mutate(text,jsonb)',
      $old$  if p_action in('reserve_submission','save_submission','submit_submission','withdraw_submission','review_submission') then$old$,
      $new$  if p_action='set_submission_extension' then
    v_result:=public.xelay_private_set_submission_extension(p_payload);
  elsif p_action in('reserve_submission','save_submission','submit_submission','withdraw_submission','review_submission') then$new$),
    (21,'public.xelay_classroom_assignment_mutate(text,jsonb)',
      $old$insert into public.teaching_item_targets(item_id,group_id,due_at,lesson_date,schedule_item_id,placement_mode)
        select v_id,group_id,due_at,lesson_date,schedule_item_id,placement_mode from public.teaching_item_targets$old$,
      $new$insert into public.teaching_item_targets(item_id,group_id,due_at,closes_at,lesson_date,schedule_item_id,placement_mode)
        select v_id,group_id,due_at,closes_at,lesson_date,schedule_item_id,placement_mode from public.teaching_item_targets$new$),
    (22,'public.xelay_classroom_assignment_mutate(text,jsonb)',
      $old$update public.teaching_submissions set item_id=v_id,updated_at=now(),version=version+1 where item_id=v_source.id and group_id=v_group;$old$,
      $new$update public.teaching_submissions set item_id=v_id,updated_at=now(),version=version+1 where item_id=v_source.id and group_id=v_group;
      update public.teaching_submission_extensions set item_id=v_id where item_id=v_source.id and group_id=v_group;
      update public.teaching_submission_extension_audit set item_id=v_id where item_id=v_source.id and group_id=v_group;$new$)
  ) as patches(check_no,signature,old_fragment,new_fragment) order by check_no loop
    select replace(pg_get_functiondef(to_regprocedure(v_patch.signature)),chr(13),'') into v_body;
    if v_body is null then raise exception 'TEACHING_WORKFLOW_FUNCTION_DRIFT: %, patch %, source missing',v_patch.signature,v_patch.check_no; end if;
    v_old:=replace(v_patch.old_fragment,chr(13),'');
    v_count:=cardinality(string_to_array(v_body,v_old))-1;
    if v_count<>1 then
      raise exception 'TEACHING_WORKFLOW_FUNCTION_DRIFT: %, patch %, count %, fragment_md5 %, body_md5 %',
        v_patch.signature,v_patch.check_no,v_count,md5(v_old),md5(v_body); end if;
    execute replace(v_body,v_old,replace(v_patch.new_fragment,chr(13),''));
  end loop;
end;
$patches$;

-- New semester and independent group copies remain drafts without schedules or
-- prior extensions. A same-group shared-publication fork retains its cutoff,
-- extensions and audit above, along with the existing submissions and grades.
do $copy_formats$
declare v_body text;v_old text;v_new text;
begin
  select replace(pg_get_functiondef('public.xelay_teaching_mutate(text,jsonb)'::regprocedure),chr(13),'') into v_body;
  v_old:=$old$course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,created_by)
        values(v_id,v_source.kind$old$;
  v_new:=$new$course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,created_by,submission_format)
        values(v_id,v_source.kind$new$;
  v_old:=replace(v_old,chr(13),'');v_new:=replace(v_new,chr(13),'');
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'TEACHING_WORKFLOW_COURSE_COPY_DRIFT'; end if;
  v_body:=replace(v_body,v_old,v_new);
  v_old:=$old$v_source.max_points,v_source.category,'draft',v_uid);$old$;
  v_new:=$new$v_source.max_points,v_source.category,'draft',v_uid,v_source.submission_format);$new$;
  v_old:=replace(v_old,chr(13),'');v_new:=replace(v_new,chr(13),'');
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'TEACHING_WORKFLOW_COURSE_COPY_FORMAT_DRIFT'; end if;
  execute replace(v_body,v_old,v_new);

  select replace(pg_get_functiondef('public.xelay_classroom_assignment_mutate(text,jsonb)'::regprocedure),chr(13),'') into v_body;
  v_old:=$old$id,course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,created_by)$old$;
  v_new:=$new$id,course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,created_by,submission_format)$new$;
  v_old:=replace(v_old,chr(13),'');v_new:=replace(v_new,chr(13),'');
  if cardinality(string_to_array(v_body,v_old))<>3 then raise exception 'TEACHING_WORKFLOW_GROUP_COPY_DRIFT'; end if;
  v_body:=replace(v_body,v_old,v_new);
  v_old:=$old$v_source.material_date,v_source.max_points,v_source.category,'draft',v_uid);$old$;
  v_new:=$new$v_source.material_date,v_source.max_points,v_source.category,'draft',v_uid,v_source.submission_format);$new$;
  v_old:=replace(v_old,chr(13),'');v_new:=replace(v_new,chr(13),'');
  if cardinality(string_to_array(v_body,v_old))<>3 then raise exception 'TEACHING_WORKFLOW_GROUP_COPY_FORMAT_DRIFT'; end if;
  execute replace(v_body,v_old,v_new);
end;
$copy_formats$;

do $cron_install$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then perform public.xelay_install_teaching_publication_cron(); end if;
end;
$cron_install$;

comment on column public.teaching_items.publish_at is 'Server publication instant for scheduled rows. No student visibility, projection or notification before the postgres cron worker publishes.';
comment on column public.teaching_items.submission_format is 'Written/oral/defense presentation preference only. Never a prerequisite for awarding manual grades; oral/defense can be submitted without an attachment.';
comment on column public.teaching_item_targets.closes_at is 'Optional final-submission cutoff, independent of late marker due_at. Draft saving and teacher grading/review do not close.';
comment on table public.teaching_submission_extensions is 'Private CAS-versioned individual extensions. NULL tombstone removes the override; an extension can never shorten the current group cutoff.';
notify pgrst,'reload schema';
commit;
