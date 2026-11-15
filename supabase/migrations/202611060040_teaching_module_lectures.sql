-- A lecture belongs to an existing module, and its quiz remains a canonical
-- test item. Existing modules continue to use their original prerequisite rules.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

create table public.teaching_course_module_lectures(
  module_id uuid primary key references public.teaching_course_modules(id) on delete cascade,
  test_item_id uuid not null references public.teaching_course_module_items(id),
  file jsonb not null check(jsonb_typeof(file)='object'),
  storage_path text generated always as (file->>'storage_path') stored not null unique,
  duration_seconds integer not null check(duration_seconds between 1 and 14400)
);
create table public.teaching_course_module_lecture_progress(
  module_id uuid not null references public.teaching_course_modules(id) on delete cascade,
  group_id uuid not null references public.study_groups(id),
  user_id uuid not null references public.profiles(id),
  storage_path text not null,
  watched_seconds integer not null default 0 check(watched_seconds>=0),
  heartbeat_at timestamptz not null,
  primary key(module_id,group_id,user_id,storage_path)
);
alter table public.teaching_course_module_lectures enable row level security;
alter table public.teaching_course_module_lecture_progress enable row level security;
revoke all on public.teaching_course_module_lectures,public.teaching_course_module_lecture_progress
  from public,anon,authenticated,service_role;

create function public.xelay_private_module_lecture_watched(p_module uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_course_module_lectures l
    join public.teaching_course_module_lecture_progress p on p.module_id=l.module_id and p.storage_path=l.storage_path
    where l.module_id=p_module and p.group_id=p_group and p.user_id=p_user
      and p.watched_seconds>=ceil(l.duration_seconds*0.9));
$$;

create function public.xelay_private_module_lecture_open(p_module uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_course_modules m join public.teaching_course_groups g
      on g.course_id=m.course_id and g.group_id=p_group and g.status='accepted'
    where m.id=p_module and m.status='published' and p_group=any(m.group_ids)
      and public.xelay_teaching_is_member(p_group,p_user)
      and not exists(select 1 from unnest(m.prerequisite_item_ids) d
        where not coalesce((public.xelay_private_module_item_completion(d,p_group,p_user)->>'completed')::boolean,false))
      and not exists(select 1 from public.teaching_course_modules prior
        join public.teaching_course_module_lectures lecture on lecture.module_id=prior.id
        where prior.course_id=m.course_id and prior.status='published' and p_group=any(prior.group_ids)
          and (prior.position,prior.id)<(m.position,m.id)
          and (not public.xelay_private_module_lecture_watched(prior.id,p_group,p_user)
            or not coalesce((public.xelay_private_module_item_completion(lecture.test_item_id,p_group,p_user)->>'completed')::boolean,false))));
$$;

alter function public.xelay_private_module_item_gate(uuid,uuid,uuid) rename to xelay_private_module_item_gate_before_lectures;
create function public.xelay_private_module_item_gate(p_item uuid,p_group uuid,p_user uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_gate jsonb:=public.xelay_private_module_item_gate_before_lectures(p_item,p_group,p_user);
  v_item public.teaching_course_module_items%rowtype;v_lecture public.teaching_course_module_lectures%rowtype;
begin
  if coalesce((v_gate->>'locked')::boolean,false) then return v_gate;end if;
  select i.* into v_item from public.teaching_course_module_items i
    join public.teaching_course_modules m on m.id=i.module_id
    where i.id=p_item and i.archived_at is null and m.status='published' and p_group=any(m.group_ids);
  if not found then return v_gate;end if;
  select * into v_lecture from public.teaching_course_module_lectures where module_id=v_item.module_id;
  if not found then return v_gate;end if;
  -- Never interrupt existing work when a teacher restructures the course.
  if (v_item.resource_type='test' and exists(select 1 from public.teaching_test_attempts
      where test_id=v_item.resource_id and group_id=p_group and user_id=p_user))
    or (v_item.resource_type='assignment' and public.xelay_private_module_existing_work(v_item.resource_id,p_group,p_user)) then return v_gate;end if;
  if not public.xelay_private_module_lecture_open(v_item.module_id,p_group,p_user) then
    return jsonb_build_object('locked',true,'reason','Спочатку завершіть попередні лекції та їхні тести.');
  end if;
  if v_lecture.test_item_id=p_item and not public.xelay_private_module_lecture_watched(v_item.module_id,p_group,p_user) then
    return jsonb_build_object('locked',true,'reason','Перегляньте щонайменше 90% відеолекції, щоб відкрити тест.');
  end if;
  return v_gate;
end $$;

alter function public.xelay_private_module_json(uuid,uuid,uuid,boolean) rename to xelay_private_module_json_before_lectures;
create function public.xelay_private_module_json(p_module uuid,p_user uuid,p_group uuid default null,p_staff boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb:=public.xelay_private_module_json_before_lectures(p_module,p_user,p_group,p_staff);
  v_lecture public.teaching_course_module_lectures%rowtype;v_open boolean;v_watched integer;v_required integer;
  v_count integer;v_total integer;
begin
  if v_result is null then return null;end if;
  select * into v_lecture from public.teaching_course_module_lectures where module_id=p_module;
  if not found then return v_result;end if;
  if p_staff then
    return v_result||jsonb_build_object('lecture',jsonb_build_object(
      'file',v_lecture.file,'duration_seconds',v_lecture.duration_seconds,'test_item_id',v_lecture.test_item_id));
  end if;
  v_open:=public.xelay_private_module_lecture_open(p_module,p_group,p_user);
  select watched_seconds into v_watched from public.teaching_course_module_lecture_progress
    where module_id=p_module and group_id=p_group and user_id=p_user and storage_path=v_lecture.storage_path;
  v_watched:=coalesce(v_watched,0);
  v_required:=ceil(v_lecture.duration_seconds*0.9);
  v_count:=(v_result->>'completed')::integer+case when v_watched>=v_required then 1 else 0 end;
  v_total:=(v_result->>'total')::integer+1;
  return v_result||jsonb_build_object('lecture',jsonb_build_object('file',case when v_open then v_lecture.file else null end,
    'duration_seconds',v_lecture.duration_seconds,'test_item_id',v_lecture.test_item_id,'watched_seconds',v_watched,
    'required_seconds',v_required,'completed',v_watched>=v_required),'locked',not v_open,
    'reason',case when v_open then '' else coalesce(nullif(v_result->>'reason',''),'Спочатку завершіть попередні лекції та їхні тести.') end,
    'description',case when v_open then v_result->>'description' else '' end,
    'completed',v_count,'total',v_total,'percent',round(v_count::numeric/v_total*100,2));
end $$;

create function public.xelay_private_module_lecture_validate(p_course uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if exists(select 1 from public.teaching_course_modules m join public.teaching_course_module_lectures l on l.module_id=m.id
    left join public.teaching_course_module_items i on i.id=l.test_item_id and i.module_id=m.id
    left join public.teaching_tests t on t.id=i.resource_id and t.course_id=m.course_id
    where m.course_id=p_course and m.status<>'archived'
      and (i.id is null or i.archived_at is not null or i.resource_type<>'test' or not i.required or t.id is null
        or (m.status='published' and (t.status='draft' or exists(select 1 from unnest(m.group_ids) g
          where not exists(select 1 from jsonb_array_elements(t.targets) a where (a->>'group_id')::uuid=g and a->>'audience_mode'='all')))))) then
    raise exception 'COURSE_MODULE_LECTURE_TEST_REQUIRED';
  end if;
  if exists(with recursive lecture_modules as (
      select m.id,m.group_ids,m.position,m.prerequisite_item_ids,l.test_item_id
      from public.teaching_course_modules m join public.teaching_course_module_lectures l on l.module_id=m.id
      where m.course_id=p_course and m.status='published'
    ),edges as(
      select 'item:'||i.id id,'item:'||dep dependency
      from public.teaching_course_module_items i join public.teaching_course_modules m on m.id=i.module_id
      cross join lateral unnest(i.prerequisite_item_ids||m.prerequisite_item_ids) dep
      where i.course_id=p_course and i.archived_at is null and m.status='published'
      union select 'item:'||i.id,'lecture:'||m.id from lecture_modules m
        join public.teaching_course_module_items i on i.module_id=m.id and i.archived_at is null
      union select 'lecture:'||m.id,'item:'||dep from lecture_modules m cross join lateral unnest(m.prerequisite_item_ids) dep
      union select 'lecture:'||m.id,'item:'||prior.test_item_id from lecture_modules m join lecture_modules prior
        on m.group_ids&&prior.group_ids and (prior.position,prior.id)<(m.position,m.id)
    ), paths as(
      select id,dependency from edges
      union select p.id,e.dependency from paths p join edges e on e.id=p.dependency
    ) select 1 from paths where id=dependency) then raise exception 'COURSE_MODULE_CYCLE';end if;
end $$;

alter function public.xelay_teaching_course_modules(uuid) rename to xelay_private_teaching_course_modules_before_lectures;
create function public.xelay_teaching_course_modules(p_course_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb:=public.xelay_private_teaching_course_modules_before_lectures(p_course_id);v_resources jsonb;
begin
  select coalesce(jsonb_agg(case when t.id is null then resource else resource||jsonb_build_object('whole_group_ids',array(
    select target->>'group_id' from jsonb_array_elements(t.targets) target
    where target->>'audience_mode'='all' and (resource->'group_ids')?(target->>'group_id')
    order by target->>'group_id')) end order by ordinal),'[]'::jsonb) into v_resources
  from jsonb_array_elements(v_result->'resources') with ordinality r(resource,ordinal)
    left join public.teaching_tests t on resource->>'resource_type'='test' and t.id=(resource->>'id')::uuid and t.course_id=p_course_id;
  return jsonb_set(v_result,'{resources}',v_resources);
end $$;

alter function public.xelay_teaching_course_module_save(jsonb) rename to xelay_private_course_module_save_before_lectures;
create function public.xelay_teaching_course_module_save(p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_result jsonb;v_module uuid;v_course uuid;v_file jsonb;v_lecture jsonb;
  v_test_item uuid;v_path text;v_duration integer;v_size integer;v_object storage.objects%rowtype;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>500000 then raise exception 'COURSE_MODULE_INVALID';end if;
  -- The original write checks owner, actor, audiences, optimistic version, and
  -- explicit prerequisite graph while holding the course lock.
  v_result:=public.xelay_private_course_module_save_before_lectures(p_payload-'lecture');
  v_module:=(p_payload->>'id')::uuid;v_course:=(p_payload->>'course_id')::uuid;
  if p_payload?'lecture' then
    v_lecture:=p_payload->'lecture';
    if v_lecture='null'::jsonb then
      delete from public.teaching_course_module_lectures where module_id=v_module;
    else
      v_file:=v_lecture->'file';
      if jsonb_typeof(v_lecture) is distinct from 'object' or v_lecture-array['file','duration_seconds','test_item_id']<>'{}'::jsonb
        or jsonb_typeof(v_file) is distinct from 'object' or v_file-array['storage_path','name','mime_type','size']<>'{}'::jsonb
        or jsonb_typeof(v_lecture->'duration_seconds') is distinct from 'number' or coalesce(v_lecture->>'duration_seconds','') !~ '^[0-9]{1,5}$'
        or jsonb_typeof(v_file->'size') is distinct from 'number' or coalesce(v_file->>'size','') !~ '^[0-9]{1,8}$'
        or jsonb_typeof(v_file->'name') is distinct from 'string' or length(btrim(v_file->>'name')) not between 1 and 240
        or jsonb_typeof(v_file->'storage_path') is distinct from 'string' then raise exception 'COURSE_MODULE_INVALID';end if;
      v_path:=v_file->>'storage_path';v_duration:=(v_lecture->>'duration_seconds')::integer;v_size:=(v_file->>'size')::integer;
      v_test_item:=(v_lecture->>'test_item_id')::uuid;
      if v_duration not between 1 and 14400 or v_size not between 1 and 52428800 or v_test_item is null
        or public.xelay_teaching_file_course(v_path) is distinct from v_course or split_part(v_path,'/',2)<>v_uid::text
        or not coalesce((v_path~'\.mp4$' and v_file->>'mime_type'='video/mp4')
          or (v_path~'\.webm$' and v_file->>'mime_type'='video/webm'),false) then raise exception 'COURSE_MODULE_INVALID';end if;
      perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-file:'||v_path,0));
      select * into v_object from storage.objects where bucket_id='xelay-teaching-files' and name=v_path for share;
      if not found or coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner','')<>v_uid::text
        or v_object.metadata->>'size' is distinct from v_file->>'size'
        or v_object.metadata->>'mimetype' is distinct from v_file->>'mime_type'
        or not coalesce(public.xelay_upload_object_verified('xelay-teaching-files',v_path),false) then
        raise exception 'COURSE_MODULE_LECTURE_FILE_UNVERIFIED' using errcode='42501';
      end if;
      if not exists(select 1 from public.teaching_course_module_items where id=v_test_item and module_id=v_module and resource_type='test' and required) then
        raise exception 'COURSE_MODULE_LECTURE_TEST_REQUIRED';
      end if;
      if exists(select 1 from public.teaching_course_module_lectures where storage_path=v_path and module_id<>v_module) then
        raise exception 'COURSE_MODULE_LECTURE_FILE_USED';
      end if;
      if exists(select 1 from public.teaching_course_module_lectures where module_id=v_module and storage_path=v_path and duration_seconds<>v_duration) then
        raise exception 'COURSE_MODULE_INVALID';
      end if;
      insert into public.teaching_course_module_lectures(module_id,test_item_id,file,duration_seconds)
        values(v_module,v_test_item,v_file,v_duration)
        on conflict(module_id) do update set test_item_id=excluded.test_item_id,file=excluded.file,duration_seconds=excluded.duration_seconds;
    end if;
  end if;
  if exists(select 1 from public.teaching_course_module_lectures l join public.teaching_course_modules m on m.id=l.module_id where m.course_id=v_course) then
    perform public.xelay_private_module_lecture_validate(v_course);
  end if;
  if p_payload?'lecture' then return public.xelay_teaching_course_modules(v_course);end if;
  return v_result;
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'COURSE_MODULE_INVALID' using errcode='22023';
end $$;

alter function public.xelay_teaching_course_modules_reorder(uuid,uuid[],jsonb,uuid) rename to xelay_private_course_modules_reorder_before_lectures;
create function public.xelay_teaching_course_modules_reorder(p_course_id uuid,p_module_ids uuid[],p_versions jsonb,p_expected_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb;
begin
  v_result:=public.xelay_private_course_modules_reorder_before_lectures(p_course_id,p_module_ids,p_versions,p_expected_user_id);
  perform public.xelay_private_module_lecture_validate(p_course_id);
  return v_result;
end $$;

create function public.xelay_student_module_lecture_progress(p_item_id uuid,p_group_id uuid,p_expected_user_id uuid,p_position_seconds integer,
  p_expected_storage_path text default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_course uuid;v_lecture public.teaching_course_module_lectures%rowtype;
  v_progress public.teaching_course_module_lecture_progress%rowtype;v_now timestamptz;v_elapsed numeric;
begin
  if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
  select course_id into v_course from public.teaching_course_modules where id=p_item_id;
  perform 1 from public.teaching_courses where id=v_course for share;
  select l.* into v_lecture from public.teaching_course_module_lectures l join public.teaching_course_modules m on m.id=l.module_id
    where l.module_id=p_item_id and m.status='published' and p_group_id=any(m.group_ids) and public.xelay_teaching_is_member(p_group_id,v_uid)
      and exists(select 1 from public.teaching_course_groups g where g.course_id=m.course_id and g.group_id=p_group_id and g.status='accepted') for share of l,m;
  if not found then raise exception 'COURSE_MODULE_FORBIDDEN' using errcode='42501';end if;
  if not public.xelay_private_module_lecture_open(p_item_id,p_group_id,v_uid) then raise exception 'COURSE_MODULE_LOCKED' using errcode='42501';end if;
  if p_expected_storage_path is not null and p_expected_storage_path<>v_lecture.storage_path then raise exception 'COURSE_MODULE_CONFLICT';end if;
  if not public.xelay_upload_object_verified('xelay-teaching-files',v_lecture.storage_path) then
    raise exception 'COURSE_MODULE_LECTURE_FILE_UNVERIFIED' using errcode='42501';
  end if;
  if p_position_seconds is null or p_position_seconds not between 0 and v_lecture.duration_seconds then raise exception 'COURSE_MODULE_INVALID';end if;
  insert into public.teaching_course_module_lecture_progress(module_id,group_id,user_id,storage_path,heartbeat_at)
    values(p_item_id,p_group_id,v_uid,v_lecture.storage_path,clock_timestamp())
    on conflict do nothing;
  select * into v_progress from public.teaching_course_module_lecture_progress
    where module_id=p_item_id and group_id=p_group_id and user_id=v_uid and storage_path=v_lecture.storage_path for update;
  v_now:=clock_timestamp();
  v_elapsed:=extract(epoch from (v_now-v_progress.heartbeat_at));
  -- Accept only a contiguous playback prefix at at most 2x wall-clock speed,
  -- with a bounded interval. Seeking and missed reports cannot skip the video.
  if p_position_seconds>v_progress.watched_seconds
    and p_position_seconds-v_progress.watched_seconds<=least(30,floor(v_elapsed*2)) then
    update public.teaching_course_module_lecture_progress set watched_seconds=p_position_seconds,heartbeat_at=v_now
      where module_id=p_item_id and group_id=p_group_id and user_id=v_uid and storage_path=v_lecture.storage_path;
  end if;
  return public.xelay_student_course_modules(v_course,p_group_id);
end $$;

create function public.xelay_teaching_module_lecture_statistics(p_module_id uuid,p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_course uuid;v_lecture public.teaching_course_module_lectures%rowtype;
  v_test public.teaching_tests%rowtype;v_students jsonb;v_questions jsonb;
begin
  select m.course_id,l.module_id,l.test_item_id,l.file,l.storage_path,l.duration_seconds
    into v_course,v_lecture.module_id,v_lecture.test_item_id,v_lecture.file,v_lecture.storage_path,v_lecture.duration_seconds
    from public.teaching_course_modules m join public.teaching_course_module_lectures l on l.module_id=m.id
    join public.teaching_course_groups g on g.course_id=m.course_id and g.group_id=p_group_id and g.status='accepted'
    where m.id=p_module_id and p_group_id=any(m.group_ids);
  if not found or not public.xelay_teaching_has_current_access(v_uid)
    or not ('grades'=any(public.xelay_teaching_group_permissions(v_course,p_group_id,v_uid))) then
    raise exception 'COURSE_MODULE_FORBIDDEN' using errcode='42501';
  end if;
  select t.* into v_test from public.teaching_tests t join public.teaching_course_module_items i
    on i.resource_type='test' and t.id=i.resource_id and t.course_id=i.course_id where i.id=v_lecture.test_item_id and i.module_id=p_module_id;
  select coalesce(jsonb_agg(jsonb_build_object('user_id',p.id,'full_name',p.full_name,
    'watched_seconds',coalesce(w.watched_seconds,0),'watched',coalesce(w.watched_seconds>=ceil(v_lecture.duration_seconds*0.9),false),
    'test_status',coalesce(a.status,'not_started'),'score',case when a.status='submitted' then a.score else null end,
    'published_score',case when gr.published_at is not null and not coalesce(gr.published_absent,false) then gr.published_score else null end,
    'max_points',v_test.max_points) order by p.full_name,p.id),'[]'::jsonb) into v_students
  from (select representative_id id from public.study_groups where id=p_group_id
      union select user_id from public.study_group_members where group_id=p_group_id and status='accepted') members
    join public.profiles p on p.id=members.id
    left join public.teaching_course_module_lecture_progress w on w.module_id=p_module_id and w.group_id=p_group_id
      and w.user_id=p.id and w.storage_path=v_lecture.storage_path
    left join public.teaching_test_attempts a on a.test_id=v_test.id and a.group_id=p_group_id and a.user_id=p.id
    left join public.teaching_test_activities act on act.test_id=v_test.id and act.group_id=p_group_id
    left join public.teaching_entries e on e.course_id=v_course and e.group_id=p_group_id and e.user_id=p.id and e.active
    left join public.teaching_grades gr on gr.activity_id=act.activity_id and gr.entry_id=e.id;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.incorrect desc,q.attempted desc,q.question_id),'[]'::jsonb) into v_questions
  from (select q->>'id' question_id,min(q->>'text') text,count(*) attempted,
    count(*) filter(where case when coalesce(a.question_reviews->(q->>'id')->>'mode','auto')='auto'
      then public.xelay_private_test_question_points(q,a.answers->(q->>'id'))
      else(a.question_reviews->(q->>'id')->>'points')::numeric end <(q->>'points')::numeric) incorrect
    from public.teaching_test_attempts a cross join lateral jsonb_array_elements(coalesce(a.questions,v_test.questions)) q
    where a.test_id=v_test.id and a.group_id=p_group_id and a.status='submitted'
      and public.xelay_teaching_is_member(p_group_id,a.user_id)
      and (q->>'kind'<>'essay' or coalesce(a.question_reviews->(q->>'id')->>'mode','auto')<>'auto')
    group by q->>'id') q;
  return jsonb_build_object('module_id',p_module_id,'group_id',p_group_id,'lecture_duration_seconds',v_lecture.duration_seconds,
    'students',v_students,'questions',v_questions);
end $$;

create function public.xelay_private_module_lecture_file_allows(p_path text,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_course_module_lectures l join public.teaching_course_modules m on m.id=l.module_id
    cross join lateral unnest(m.group_ids) g
    where l.storage_path=p_path and public.xelay_private_module_lecture_open(m.id,g,p_user));
$$;

-- Keep the private teaching bucket's existing RLS, receipts and size limits.
-- Replace only the known policy-bound function bodies, preserving their OIDs.
do $lecture_files$
declare v_definition text;v_anchor text;v_replacement text;v_signature text;
begin
  for v_signature,v_anchor,v_replacement in values
    ('public.xelay_teaching_file_allowed(text,text)', 'when ''pdf'' then p_mime=''application/pdf''',
      'when ''mp4'' then p_mime=''video/mp4'' when ''webm'' then p_mime=''video/webm'' when ''pdf'' then p_mime=''application/pdf'''),
    ('public.xelay_teaching_can_upload_file(text)', 'where c.id=public.xelay_teaching_file_course(p_name) and c.archived_at is null',
      'where c.id=public.xelay_teaching_file_course(p_name) and c.archived_at is null and (p_name!~''\.(mp4|webm)$'' or c.owner_id=auth.uid())'),
    ('public.xelay_upload_format_allowed(text,text,text)', 'select case when p_bucket in(''xelay-teaching-files'',''xelay-submission-files'')',
      'select case when p_bucket=''xelay-submission-files'' and p_path~''\.(mp4|webm)$'' then false when p_bucket in(''xelay-teaching-files'',''xelay-submission-files'')'),
    ('public.xelay_teaching_can_read_file(text)', chr(10)||'    exists(select 1 from public.teaching_items i where i.attachments @>',
      chr(10)||'    public.xelay_private_module_lecture_file_allows(p_name,auth.uid()) or exists(select 1 from public.teaching_items i where i.attachments @>'),
    ('public.xelay_teaching_can_remove_file(text)', 'return not exists(select 1 from public.teaching_items i where i.attachments @>',
      'return not exists(select 1 from public.teaching_course_module_lectures where storage_path=p_name) and not exists(select 1 from public.teaching_items i where i.attachments @>')
  loop
    v_definition:=replace(pg_get_functiondef(to_regprocedure(v_signature)),chr(13),'');
    if v_definition is null or (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 then
      raise exception 'COURSE_MODULE_LECTURE_STORAGE_DRIFT: %',v_signature;
    end if;
    execute replace(v_definition,v_anchor,v_replacement);
  end loop;
  update storage.buckets set allowed_mime_types=array(select distinct unnest(allowed_mime_types||array['video/mp4','video/webm']))
    where id='xelay-teaching-files' and not public and file_size_limit=52428800;
  if not found then raise exception 'COURSE_MODULE_LECTURE_BUCKET_DRIFT';end if;
end $lecture_files$;
create policy "Lectures do not expand submission formats" on storage.objects as restrictive for insert to anon,authenticated
  with check(bucket_id<>'xelay-submission-files' or name!~'\.(mp4|webm)$');

-- Videos belong to the private lecture gate, so the same object cannot
-- bypass it by being linked as an unrestricted ordinary attachment.
create function public.xelay_private_module_lecture_attachment_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from jsonb_array_elements(new.attachments) a where a->>'storage_path'~'\.(mp4|webm)$') then
    raise exception 'COURSE_MODULE_LECTURE_FILE_USED';
  end if;
  return new;
end $$;
create trigger teaching_lecture_file_attachment_guard before insert or update of attachments on public.teaching_items
  for each row execute function public.xelay_private_module_lecture_attachment_guard();

-- Updating a linked test through the ordinary builder must not silently
-- remove the audience that the preceding lecture requires for progression.
create function public.xelay_private_module_lecture_test_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (new.targets is distinct from old.targets or (new.status='draft' and old.status<>'draft'))
    and exists(select 1 from public.teaching_course_module_items i
      join public.teaching_course_module_lectures l on l.test_item_id=i.id
      join public.teaching_course_modules m on m.id=l.module_id
      where i.resource_type='test' and i.resource_id=old.id and i.archived_at is null and m.status='published'
        and (new.status='draft' or exists(select 1 from unnest(m.group_ids) g
          where not exists(select 1 from jsonb_array_elements(new.targets) a
            where (a->>'group_id')::uuid=g and a->>'audience_mode'='all')))) then
    raise exception 'COURSE_MODULE_LECTURE_TEST_REQUIRED';
  end if;
  return new;
end $$;
create trigger teaching_lecture_test_guard before update of targets,status on public.teaching_tests
  for each row execute function public.xelay_private_module_lecture_test_guard();

revoke all on function
  public.xelay_private_module_lecture_watched(uuid,uuid,uuid),public.xelay_private_module_lecture_open(uuid,uuid,uuid),
  public.xelay_private_module_item_gate_before_lectures(uuid,uuid,uuid),public.xelay_private_module_item_gate(uuid,uuid,uuid),
  public.xelay_private_module_json_before_lectures(uuid,uuid,uuid,boolean),public.xelay_private_module_json(uuid,uuid,uuid,boolean),
  public.xelay_private_module_lecture_validate(uuid),public.xelay_private_module_lecture_file_allows(text,uuid),
  public.xelay_private_module_lecture_attachment_guard(),public.xelay_private_module_lecture_test_guard(),
  public.xelay_private_course_module_save_before_lectures(jsonb),public.xelay_private_teaching_course_modules_before_lectures(uuid),
  public.xelay_private_course_modules_reorder_before_lectures(uuid,uuid[],jsonb,uuid),
  public.xelay_teaching_course_modules(uuid),public.xelay_teaching_course_module_save(jsonb),public.xelay_teaching_course_modules_reorder(uuid,uuid[],jsonb,uuid),
  public.xelay_student_module_lecture_progress(uuid,uuid,uuid,integer,text),public.xelay_teaching_module_lecture_statistics(uuid,uuid)
from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_course_modules(uuid),public.xelay_teaching_course_module_save(jsonb),public.xelay_teaching_course_modules_reorder(uuid,uuid[],jsonb,uuid),
  public.xelay_student_module_lecture_progress(uuid,uuid,uuid,integer,text),public.xelay_teaching_module_lecture_statistics(uuid,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
