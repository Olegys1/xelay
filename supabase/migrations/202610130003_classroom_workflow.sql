-- Group-first teaching: independent homework, private student submissions,
-- feedback and scoped seminar editing. Apply AFTER 202610130002 in one transaction.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$ begin
  if to_regclass('public.teaching_items') is null
    or to_regclass('public.study_group_seminars') is null
    or to_regprocedure('public.xelay_teaching_mutate(text,jsonb)') is null
    or to_regprocedure('public.xelay_seminar_items_valid(jsonb,text)') is null then
    raise exception 'CLASSROOM_PREREQUISITES_MISSING';
  end if;
end $$;

create table public.teaching_submissions (
  id uuid primary key,
  item_id uuid not null references public.teaching_items(id) on delete restrict,
  course_id uuid not null references public.teaching_courses(id) on delete restrict,
  group_id uuid not null references public.study_groups(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'draft' check(status in('draft','submitted','returned','reviewed')),
  body text not null default '' check(length(body)<=50000),
  links jsonb not null default '[]'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  draft_body text not null default '' check(length(draft_body)<=50000),
  draft_links jsonb not null default '[]'::jsonb,
  draft_attachments jsonb not null default '[]'::jsonb,
  version integer not null default 1 check(version>0),
  attempt integer not null default 0 check(attempt>=0),
  submitted_at timestamptz,
  feedback text not null default '' check(length(feedback)<=5000),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(item_id,group_id,user_id),
  -- The old assignment editor deletes/reinserts targets in one transaction.
  -- Deferred verification permits that edit but prevents losing handed-in work
  -- by removing its group. Explicit classroom forks move both work and grades.
  foreign key(item_id,group_id) references public.teaching_item_targets(item_id,group_id)
    deferrable initially deferred,
  check(jsonb_typeof(links)='array' and jsonb_array_length(links)<=20),
  check(jsonb_typeof(attachments)='array' and jsonb_array_length(attachments)<=10),
  check(jsonb_typeof(draft_links)='array' and jsonb_array_length(draft_links)<=20),
  check(jsonb_typeof(draft_attachments)='array' and jsonb_array_length(draft_attachments)<=10)
);
create index teaching_submissions_item_group_idx on public.teaching_submissions(item_id,group_id,status);
create index teaching_submissions_files_idx on public.teaching_submissions using gin(attachments jsonb_path_ops);

create table public.teaching_submission_history (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.teaching_submissions(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check(action in('submitted','withdrawn','returned','reviewed')),
  status text not null check(status in('draft','submitted','returned','reviewed')),
  version integer not null,
  attempt integer not null,
  body text not null default '',
  links jsonb not null default '[]'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  feedback text not null default '',
  score numeric(8,2),
  created_at timestamptz not null default now()
);
create index teaching_submission_history_submission_idx on public.teaching_submission_history(submission_id,created_at);
create index teaching_submission_history_files_idx on public.teaching_submission_history using gin(attachments jsonb_path_ops);

create table public.classroom_request_receipts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null,
  request_id uuid not null,
  expected_version integer not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,action,request_id,expected_version)
);
alter table public.teaching_submissions enable row level security;
alter table public.teaching_submission_history enable row level security;
alter table public.classroom_request_receipts enable row level security;
revoke all on public.teaching_submissions,public.teaching_submission_history,public.classroom_request_receipts from public,anon,authenticated,service_role;

create or replace function public.xelay_classroom_guard_assignment_visibility()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.kind='assignment' and old.status='published' and new.status<>'published'
    and exists(select 1 from public.teaching_submissions where item_id=old.id) then
    raise exception 'CLASSROOM_ASSIGNMENT_HAS_SUBMISSIONS';
  end if;
  return new;
end $$;
create trigger classroom_assignment_visibility before update on public.teaching_items
  for each row execute function public.xelay_classroom_guard_assignment_visibility();

alter table public.study_group_seminars add column if not exists teaching_course_id uuid references public.teaching_courses(id) on delete set null;
alter table public.study_group_seminars add column if not exists teaching_author_id uuid references public.profiles(id) on delete set null;
alter table public.study_group_seminars add column if not exists teaching_version integer not null default 1 check(teaching_version>0);
alter table public.study_group_seminar_schedule add column if not exists teaching_course_id uuid references public.teaching_courses(id) on delete set null;
alter table public.study_group_seminar_schedule add column if not exists teaching_version integer not null default 1 check(teaching_version>0);

-- A head's existing editor also changes the version. Reservation/comment parent
-- refreshes only change updated_at and do not cause unrelated edit conflicts.
create or replace function public.xelay_classroom_seminar_version()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' then
    if new.teaching_version>old.teaching_version or (to_jsonb(new)-array['updated_at','teaching_version']) is distinct from
       (to_jsonb(old)-array['updated_at','teaching_version']) then
      new.teaching_version:=old.teaching_version+1;
    else new.teaching_version:=old.teaching_version; end if;
  end if;
  return new;
end $$;
create trigger classroom_seminar_version before update on public.study_group_seminars
  for each row execute function public.xelay_classroom_seminar_version();
create trigger classroom_schedule_version before update on public.study_group_seminar_schedule
  for each row execute function public.xelay_classroom_seminar_version();

create or replace function public.xelay_classroom_guard_provenance()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  -- SECURITY DEFINER classroom/head RPCs run as their owner. A direct browser
  -- write never gets to manufacture the teacher marker, even under a legacy
  -- permissive RLS policy. Organizational heads keep their existing RPCs.
  if current_user in('anon','authenticated') then
    if(tg_op='INSERT' and(new.teaching_course_id is not null or(tg_table_name='study_group_seminars' and to_jsonb(new)->>'teaching_author_id' is not null)))
      or(tg_op='UPDATE' and(new.teaching_course_id is distinct from old.teaching_course_id
        or(tg_table_name='study_group_seminars' and to_jsonb(new)->>'teaching_author_id' is distinct from to_jsonb(old)->>'teaching_author_id'))) then
      raise exception 'CLASSROOM_PROVENANCE_IMMUTABLE' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
create trigger classroom_seminar_provenance before insert or update on public.study_group_seminars
  for each row execute function public.xelay_classroom_guard_provenance();
create trigger classroom_schedule_provenance before insert or update on public.study_group_seminar_schedule
  for each row execute function public.xelay_classroom_guard_provenance();

create or replace function public.xelay_classroom_touch_seminar_content()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_id uuid; begin
  v_id:=case when tg_op='DELETE' then old.seminar_id else new.seminar_id end;
  update public.study_group_seminars set teaching_version=teaching_version+1 where id=v_id;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger classroom_question_content after insert or update or delete on public.study_group_seminar_questions
  for each row execute function public.xelay_classroom_touch_seminar_content();
create trigger classroom_team_content after insert or update or delete on public.study_group_seminar_teams
  for each row execute function public.xelay_classroom_touch_seminar_content();

-- Published homework is readable by an accepted colleague who grades it.
-- Draft homework remains restricted to the assignments permission.
create or replace function public.xelay_teaching_can_read_item(p_item_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_items i where i.id=p_item_id and (
    (case when i.kind='assignment' then 'assignments' else 'materials' end)=any(public.xelay_teaching_permissions(i.course_id,p_user_id))
    or(i.kind='assignment' and i.status='published' and 'grades'=any(public.xelay_teaching_permissions(i.course_id,p_user_id)))
    or(i.status='published' and exists(select 1 from public.teaching_item_targets t
      join public.teaching_course_groups g on g.course_id=i.course_id and g.group_id=t.group_id and g.status='accepted'
      where t.item_id=i.id and public.xelay_teaching_is_member(t.group_id,p_user_id)))));
$$;

create or replace function public.xelay_classroom_staff(p_course uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_teaching_permissions(p_course,p_user)&&array['assignments','grades']::text[]
    and exists(select 1 from public.teaching_course_groups l where l.course_id=p_course and l.group_id=p_group and l.status='accepted');
$$;

create or replace function public.xelay_classroom_student(p_item uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_teaching_is_member(p_group,p_user) and exists(
    select 1 from public.teaching_items i join public.teaching_item_targets t on t.item_id=i.id and t.group_id=p_group
    join public.teaching_course_groups l on l.course_id=i.course_id and l.group_id=p_group and l.status='accepted'
    where i.id=p_item and i.kind='assignment' and i.status='published');
$$;

create or replace function public.xelay_classroom_workspace()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user(); begin
  return jsonb_build_object('classrooms',coalesce((select jsonb_agg(jsonb_build_object(
    'group_id',g.id,'group_name',g.group_name,'specialty',g.specialty,
    'courses',(select jsonb_agg(jsonb_build_object('course_id',l.course_id,'subject_id',l.subject_id,'status',l.status) order by c.title)
      from public.teaching_course_groups l join public.teaching_courses c on c.id=l.course_id
      where l.group_id=g.id and l.status='accepted' and cardinality(public.xelay_teaching_permissions(c.id,v_uid))>0)
    ) order by g.group_name) from public.study_groups g where exists(select 1 from public.teaching_course_groups l
      where l.group_id=g.id and l.status='accepted' and cardinality(public.xelay_teaching_permissions(l.course_id,v_uid))>0)),'[]'::jsonb));
end $$;

create or replace function public.xelay_teaching_group_context(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user(); begin
  if not exists(select 1 from public.teaching_course_groups l where l.group_id=p_group_id
    and l.status='accepted' and cardinality(public.xelay_teaching_permissions(l.course_id,v_uid))>0) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  return jsonb_build_object('group',(select jsonb_build_object('id',g.id,'group_id',g.id,'group_name',g.group_name,
      'specialty',g.specialty,'representative_id',g.representative_id,'university_id',g.university_id,'academic_unit_id',g.academic_unit_id)
      from public.study_groups g where g.id=p_group_id),
    'courses',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('subject_id',l.subject_id,'link_id',l.id,
      'permissions',public.xelay_teaching_permissions(c.id,v_uid))) from public.teaching_courses c
      join public.teaching_course_groups l on l.course_id=c.id where l.group_id=p_group_id and l.status='accepted'
      and cardinality(public.xelay_teaching_permissions(c.id,v_uid))>0),'[]'::jsonb));
end $$;

create or replace function public.xelay_classroom_submission_json(p_submission public.teaching_submissions,p_owner boolean,p_grades boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select (to_jsonb(p_submission)-array['draft_body','draft_links','draft_attachments'])||jsonb_build_object(
    'body',case when p_owner and p_submission.status in('draft','returned') then p_submission.draft_body else p_submission.body end,
    'links',case when p_owner and p_submission.status in('draft','returned') then p_submission.draft_links else p_submission.links end,
    'attachments',case when p_owner and p_submission.status in('draft','returned') then p_submission.draft_attachments else p_submission.attachments end,
    'student_name',p.full_name,'reviewer_name',r.full_name,
    'grade_id',case when p_owner or p_grades then s.id else null end,
    'grade_version',case when p_owner or p_grades then coalesce(s.version,0) else 0 end,
    'grade_published_at',case when p_owner or p_grades then s.published_at else null end,
    'published_score',case when(p_owner or p_grades) and s.published_at is not null then s.published_score else null end,
    'published_comment',case when(p_owner or p_grades) and s.published_at is not null then s.published_comment else '' end,
    'late',coalesce(p_submission.submitted_at>t.due_at,false))
  from public.profiles p left join public.profiles r on r.id=p_submission.reviewed_by
    left join public.teaching_item_targets t on t.item_id=p_submission.item_id and t.group_id=p_submission.group_id
    left join public.teaching_activities a on a.item_id=p_submission.item_id and a.group_id=p_submission.group_id
    left join public.teaching_entries e on e.course_id=p_submission.course_id and e.group_id=p_submission.group_id and e.user_id=p_submission.user_id
    left join public.teaching_grades s on s.activity_id=a.id and s.entry_id=e.id
  where p.id=p_submission.user_id;
$$;

create or replace function public.xelay_classroom_assignment(p_item_id uuid,p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_item public.teaching_items%rowtype;
  v_course public.teaching_courses%rowtype;v_staff boolean;v_student boolean;v_permissions text[];
begin
  select * into v_item from public.teaching_items where id=p_item_id and kind='assignment';
  if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
  select * into v_course from public.teaching_courses where id=v_item.course_id;
  v_permissions:=public.xelay_teaching_permissions(v_item.course_id,v_uid);
  v_staff:=public.xelay_classroom_staff(v_item.course_id,p_group_id,v_uid);
  v_student:=public.xelay_classroom_student(p_item_id,p_group_id,v_uid);
  if not(v_staff or v_student) or not exists(select 1 from public.teaching_item_targets where item_id=p_item_id and group_id=p_group_id)
    or(not v_student and not public.xelay_teaching_can_read_item(p_item_id,v_uid)) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  return jsonb_build_object('item',public.xelay_teaching_item_json(v_item),
    'group',(select jsonb_build_object('id',g.id,'group_id',g.id,'group_name',g.group_name,'specialty',g.specialty,
      'representative_id',g.representative_id) from public.study_groups g where g.id=p_group_id),
    'permissions',v_permissions,'can_submit',v_student and v_course.archived_at is null,
    'can_review',v_staff and v_course.archived_at is null,'course_archived_at',v_course.archived_at,
    'is_assessed',v_item.max_points is not null,'max_points',v_item.max_points,
    'activity_id',(select id from public.teaching_activities where item_id=p_item_id and group_id=p_group_id),
    'students',case when v_staff then coalesce((select jsonb_agg(jsonb_build_object('user_id',p.id,'full_name',p.full_name,'username',p.username) order by p.full_name)
      from public.profiles p where public.xelay_teaching_is_member(p_group_id,p.id)),'[]'::jsonb) else '[]'::jsonb end,
    'my_submission',case when v_student then (select public.xelay_classroom_submission_json(s,true,false) from public.teaching_submissions s
      where s.item_id=p_item_id and s.group_id=p_group_id and s.user_id=v_uid) else null end,
    'submissions',case when v_staff then coalesce((select jsonb_agg(public.xelay_classroom_submission_json(s,false,'grades'=any(v_permissions)) order by s.submitted_at nulls last)
      from public.teaching_submissions s where s.item_id=p_item_id and s.group_id=p_group_id and s.status<>'draft'),'[]'::jsonb) else '[]'::jsonb end,
    'history',coalesce((select jsonb_agg((to_jsonb(h)-array['actor_id','score'])||jsonb_build_object('actor_name',p.full_name,'event',h.action,
      'score',case when s.user_id=v_uid or 'grades'=any(v_permissions) then h.score else null end,
      'published_score',case when s.user_id=v_uid or 'grades'=any(v_permissions) then h.score else null end) order by h.created_at)
      from public.teaching_submission_history h join public.teaching_submissions s on s.id=h.submission_id join public.profiles p on p.id=h.actor_id
      where s.item_id=p_item_id and s.group_id=p_group_id and(v_staff or s.user_id=v_uid)),'[]'::jsonb));
end $$;

create or replace function public.xelay_classroom_seminars(p_course_id uuid,p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_subject uuid;v_course public.teaching_courses%rowtype;v_permissions text[];v_result jsonb;
begin
  v_permissions:=public.xelay_teaching_permissions(p_course_id,v_uid);
  select subject_id into v_subject from public.teaching_course_groups where course_id=p_course_id and group_id=p_group_id and status='accepted';
  if not found or cardinality(v_permissions)=0 then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  select * into v_course from public.teaching_courses where id=p_course_id;
  with sessions as(select s.* from public.study_group_seminars s where s.group_id=p_group_id and s.subject_id=v_subject
      and s.lesson_date between v_course.starts_on and v_course.ends_on),
    reservations as(select r.* from public.study_group_seminar_reservations r join sessions s on s.id=r.seminar_id)
    select jsonb_build_object('subject_id',v_subject,'can_edit','assignments'=any(v_permissions) and v_course.archived_at is null,
      'schedule',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('version',s.teaching_version) order by s.weekday,s.starts_at)
        from public.study_group_seminar_schedule s where s.group_id=p_group_id and s.subject_id=v_subject
          and s.valid_from<=v_course.ends_on and s.valid_until>=v_course.starts_on),'[]'::jsonb),
      'seminars',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('version',s.teaching_version,'author_name',p.full_name) order by s.lesson_date,s.starts_at)
        from sessions s left join public.profiles p on p.id=s.teaching_author_id),'[]'::jsonb),
      'questions',coalesce((select jsonb_agg(to_jsonb(q) order by q.position) from public.study_group_seminar_questions q join sessions s on s.id=q.seminar_id),'[]'::jsonb),
      'teams',coalesce((select jsonb_agg(to_jsonb(t) order by t.position) from public.study_group_seminar_teams t join sessions s on s.id=t.seminar_id),'[]'::jsonb),
      'reservations',coalesce((select jsonb_agg(to_jsonb(r)) from reservations r),'[]'::jsonb),
      'profiles',coalesce((select jsonb_object_agg(p.id::text,jsonb_build_object('full_name',p.full_name)) from public.profiles p
        where p.id in(select user_id from reservations)),'{}'::jsonb)) into v_result;
  return v_result;
end $$;

create or replace function public.xelay_classroom_file_submission(p_name text)
returns uuid language plpgsql immutable set search_path='' as $$
begin
  if p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}$' then return null; end if;
  return split_part(p_name,'/',1)::uuid;
exception when invalid_text_representation then return null;
end $$;

create or replace function public.xelay_classroom_can_upload_file(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and split_part(p_name,'/',2)=auth.uid()::text
    and exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null
      and u.deleted_at is null and coalesce(u.banned_until,'-infinity'::timestamptz)<=now())
    and exists(select 1 from public.teaching_submissions s join public.teaching_courses c on c.id=s.course_id
      where s.id=public.xelay_classroom_file_submission(p_name) and s.user_id=auth.uid()
      and s.status in('draft','returned') and c.archived_at is null
      and public.xelay_classroom_student(s.item_id,s.group_id,auth.uid()));
$$;

create or replace function public.xelay_classroom_can_read_file(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and exists(select 1 from auth.users u where u.id=auth.uid()
    and u.email_confirmed_at is not null and u.deleted_at is null and coalesce(u.banned_until,'-infinity'::timestamptz)<=now())
    and exists(select 1 from public.teaching_submissions s where s.id=public.xelay_classroom_file_submission(p_name) and (
      (s.user_id=auth.uid() and public.xelay_classroom_student(s.item_id,s.group_id,auth.uid())
        and(s.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))
          or s.draft_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))
          or exists(select 1 from public.teaching_submission_history h where h.submission_id=s.id and h.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name)))
          or public.xelay_classroom_can_upload_file(p_name)))
      or(public.xelay_classroom_staff(s.course_id,s.group_id,auth.uid())
        and((s.status<>'draft' and s.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name)))
          or exists(select 1 from public.teaching_submission_history h where h.submission_id=s.id and h.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name)))))
    ));
$$;

create or replace function public.xelay_classroom_can_remove_file(p_name text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
  if not public.xelay_classroom_can_upload_file(p_name) then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:submission-file:'||p_name,0));
  return not exists(select 1 from public.teaching_submissions s where s.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))
    or s.draft_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name)))
    and not exists(select 1 from public.teaching_submission_history h where h.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name)));
end $$;

create or replace function public.xelay_classroom_validate_resources(p_submission uuid,p_links jsonb,p_files jsonb,p_prior jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare v_file jsonb;v_path text;v_object storage.objects%rowtype;v_link text; begin
  if jsonb_typeof(p_links) is distinct from 'array' or jsonb_array_length(p_links)>20
    or jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files)>10
    or octet_length(p_links::text)+octet_length(p_files::text)>30000 then raise exception 'TEACHING_INVALID_INPUT'; end if;
  for v_file in select value from jsonb_array_elements(p_links) loop
    v_link:=v_file #>> '{}';
    if jsonb_typeof(v_file)<>'string' or length(v_link)>2000 or v_link !~* '^https?://[^/?#[:space:]\\@]+([/?#][^[:space:]\\]*)?$'
      or v_link ~ '[[:cntrl:]]' then raise exception 'TEACHING_INVALID_INPUT'; end if;
  end loop;
  if(select count(*) from jsonb_array_elements(p_files))<>(select count(distinct value->>'storage_path') from jsonb_array_elements(p_files)) then
    raise exception 'TEACHING_INVALID_INPUT'; end if;
  for v_path in select distinct value->>'storage_path' from jsonb_array_elements(p_files||p_prior) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('xelay:submission-file:'||coalesce(v_path,''),0));
  end loop;
  for v_file in select value from jsonb_array_elements(p_files) loop
    v_path:=v_file->>'storage_path';
    if jsonb_typeof(v_file)<>'object' or public.xelay_classroom_file_submission(v_path) is distinct from p_submission
      or split_part(v_path,'/',2)<>auth.uid()::text
      or length(btrim(coalesce(v_file->>'name',''))) not between 1 and 240 or(v_file->>'name')~'[[:cntrl:]]'
      or not coalesce(public.xelay_teaching_file_allowed(v_path,v_file->>'mime_type'),false)
      or jsonb_typeof(v_file->'size') is distinct from 'number' or(v_file->>'size')::numeric not between 1 and 20971520 then
      raise exception 'TEACHING_INVALID_INPUT'; end if;
    if p_prior @> jsonb_build_array(v_file) then continue; end if;
    if p_prior @> jsonb_build_array(jsonb_build_object('storage_path',v_path)) then raise exception 'TEACHING_FILE_METADATA_IMMUTABLE'; end if;
    select * into v_object from storage.objects where bucket_id='xelay-submission-files' and name=v_path for update;
    if not found or coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner') is distinct from auth.uid()::text
      or(v_object.metadata->>'size')::numeric is distinct from(v_file->>'size')::numeric
      or v_object.metadata->>'mimetype' is distinct from v_file->>'mime_type' then
      raise exception 'TEACHING_FILE_FORBIDDEN' using errcode='42501'; end if;
  end loop;
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('xelay-submission-files','xelay-submission-files',false,20971520,array[
  'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png','image/jpeg','image/webp','text/plain','text/csv'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy "Submission uploads" on storage.objects for insert to authenticated with check(
  bucket_id='xelay-submission-files' and public.xelay_classroom_can_upload_file(name)
  and public.xelay_teaching_file_allowed(name,metadata->>'mimetype') and(metadata->>'size')::bigint between 1 and 20971520);
create policy "Submission reads" on storage.objects for select to authenticated using(
  bucket_id='xelay-submission-files' and public.xelay_classroom_can_read_file(name));
create policy "Submission unused removal" on storage.objects for delete to authenticated using(
  bucket_id='xelay-submission-files' and public.xelay_classroom_can_remove_file(name));
create policy "Submission upload boundary" on storage.objects as restrictive for insert to anon,authenticated with check(
  case when bucket_id='xelay-submission-files' then case when auth.uid() is null then false else
    public.xelay_classroom_can_upload_file(name) and public.xelay_teaching_file_allowed(name,metadata->>'mimetype')
    and(metadata->>'size')::bigint between 1 and 20971520 end else true end);
create policy "Submission read boundary" on storage.objects as restrictive for select to anon,authenticated using(
  case when bucket_id='xelay-submission-files' then case when auth.uid() is null then false else public.xelay_classroom_can_read_file(name) end else true end);
create policy "Submission remove boundary" on storage.objects as restrictive for delete to anon,authenticated using(
  case when bucket_id='xelay-submission-files' then case when auth.uid() is null then false else public.xelay_classroom_can_remove_file(name) end else true end);
create policy "Submission overwrite boundary" on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id<>'xelay-submission-files') with check(bucket_id<>'xelay-submission-files');

create or replace function public.xelay_classroom_lock_group(p_course uuid,p_group uuid,p_permission text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.xelay_teaching_lock_course(p_course,p_permission);
  perform 1 from public.teaching_course_groups where course_id=p_course and group_id=p_group and status='accepted' for update;
  if not found then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
end $$;

create or replace function public.xelay_classroom_notify_staff(p_submission public.teaching_submissions)
returns void language plpgsql security definer set search_path='' as $$
declare v_recipient uuid; begin
  for v_recipient in select c.owner_id from public.teaching_courses c where c.id=p_submission.course_id
    union select t.user_id from public.teaching_course_teachers t where t.course_id=p_submission.course_id and t.status='accepted' loop
    if public.xelay_classroom_staff(p_submission.course_id,p_submission.group_id,v_recipient) then
      perform public.xelay_teaching_notify(v_recipient,'classroom-submit:'||p_submission.id::text||':'||p_submission.attempt::text,
        'Студент здав роботу. Відкрийте завдання своєї групи для перевірки.',p_submission.course_id,p_submission.group_id);
    end if;
  end loop;
end $$;

create or replace function public.xelay_classroom_write_history(p_submission public.teaching_submissions,p_action text,p_score numeric default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  insert into public.teaching_submission_history(submission_id,actor_id,action,status,version,attempt,body,links,attachments,feedback,score)
    values(p_submission.id,auth.uid(),p_action,p_submission.status,p_submission.version,p_submission.attempt,
      case when p_action='withdrawn' then '' else p_submission.body end,
      case when p_action='withdrawn' then '[]'::jsonb else p_submission.links end,
      case when p_action='withdrawn' then '[]'::jsonb else p_submission.attachments end,
      p_submission.feedback,p_score);
end $$;

-- Private function: only the outer dispatcher can call it and record a receipt.
create or replace function public.xelay_classroom_assignment_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_id uuid:=(p_payload->>'id')::uuid;v_version integer:=coalesce((p_payload->>'version')::integer,0);
  v_course_id uuid:=(p_payload->>'course_id')::uuid;v_group uuid;v_source public.teaching_items%rowtype;
  v_existing public.teaching_items%rowtype;v_result jsonb;v_payload jsonb;v_due timestamptz;v_source_id uuid;
begin
  if p_action='copy_assignment' then
    v_source_id:=(p_payload->>'source_item_id')::uuid;
    select * into v_source from public.teaching_items where id=v_source_id and kind='assignment';
    if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
    v_course_id:=v_source.course_id;v_group:=(p_payload->>'destination_group_id')::uuid;
    perform public.xelay_classroom_lock_group(v_course_id,v_group,'assignments');
    select * into v_source from public.teaching_items where id=v_source_id for update;
    if (p_payload->>'source_version')::integer is distinct from v_source.version then raise exception 'TEACHING_CONFLICT'; end if;
    if v_version<>0 or v_id=v_source.id or exists(select 1 from public.teaching_items where id=v_id) then raise exception 'TEACHING_CONFLICT'; end if;
    if not exists(select 1 from public.teaching_item_targets t join public.teaching_course_groups l
      on l.course_id=v_course_id and l.group_id=t.group_id and l.status='accepted' where t.item_id=v_source.id) then
      raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    perform public.xelay_teaching_validate_resources(v_course_id,v_source.links,v_source.attachments,v_source.attachments);
    v_due:=nullif(p_payload->>'due_at','')::timestamptz;
    insert into public.teaching_items(id,course_id,kind,title,body,links,attachments,material_date,max_points,category,status,created_by)
      values(v_id,v_course_id,'assignment',v_source.title,v_source.body,v_source.links,v_source.attachments,
        v_source.material_date,v_source.max_points,v_source.category,'draft',v_uid);
    insert into public.teaching_item_targets(item_id,group_id,due_at) values(v_id,v_group,v_due);
    return jsonb_build_object('id',v_id,'version',1);
  end if;

  if p_action='save_group_assignment' then
    if jsonb_typeof(p_payload->'targets') is distinct from 'array' or jsonb_array_length(p_payload->'targets')<>1 then
      raise exception 'CLASSROOM_SINGLE_GROUP_REQUIRED'; end if;
    v_group:=(p_payload->'targets'->0->>'group_id')::uuid;
    perform public.xelay_classroom_lock_group(v_course_id,v_group,'assignments');
    v_payload:=p_payload-'source_item_id'-'source_version';
    if p_payload ? 'source_item_id' then
      v_source_id:=(p_payload->>'source_item_id')::uuid;
      select * into v_source from public.teaching_items where id=v_source_id and course_id=v_course_id and kind='assignment' for update;
      if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
      if v_version<>0 or v_id=v_source.id or(p_payload->>'source_version')::integer is distinct from v_source.version
        or exists(select 1 from public.teaching_items where id=v_id) then raise exception 'TEACHING_CONFLICT'; end if;
      if(select count(*) from public.teaching_item_targets where item_id=v_source.id)<=1
        or not exists(select 1 from public.teaching_item_targets where item_id=v_source.id and group_id=v_group) then
        raise exception 'CLASSROOM_SHARED_ASSIGNMENT_REQUIRED'; end if;
      if coalesce(p_payload->>'status','draft')<>'published'
        and exists(select 1 from public.teaching_submissions where item_id=v_source.id and group_id=v_group) then
        raise exception 'CLASSROOM_ASSIGNMENT_HAS_SUBMISSIONS'; end if;
      -- Install a trusted prior snapshot. Exact copied attachments remain valid
      -- even when originally uploaded by a colleague; changed metadata does not.
      perform public.xelay_teaching_validate_resources(v_course_id,v_source.links,v_source.attachments,v_source.attachments);
      insert into public.teaching_items(id,course_id,kind,title,body,links,attachments,material_date,max_points,category,status,created_by)
        values(v_id,v_course_id,'assignment',v_source.title,v_source.body,v_source.links,v_source.attachments,
          v_source.material_date,v_source.max_points,v_source.category,'draft',v_uid);
      insert into public.teaching_item_targets(item_id,group_id,due_at)
        select v_id,group_id,due_at from public.teaching_item_targets where item_id=v_source.id and group_id=v_group;
      -- Same column/grades/audit, same student work/history: only canonical item
      -- changes. Other groups continue to use the unmodified source content.
      update public.teaching_activities set item_id=v_id where item_id=v_source.id and group_id=v_group;
      update public.teaching_submissions set item_id=v_id,updated_at=now(),version=version+1 where item_id=v_source.id and group_id=v_group;
      delete from public.teaching_item_targets where item_id=v_source.id and group_id=v_group;
      update public.teaching_items set version=version+1,updated_at=now() where id=v_source.id;
      v_payload:=v_payload||jsonb_build_object('version',1);
    elsif v_version>0 then
      select * into v_existing from public.teaching_items where id=v_id and course_id=v_course_id and kind='assignment' for update;
      if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
      if(select count(*) from public.teaching_item_targets where item_id=v_id)<>1
        or not exists(select 1 from public.teaching_item_targets where item_id=v_id and group_id=v_group) then
        raise exception 'CLASSROOM_EXPLICIT_FORK_REQUIRED'; end if;
    end if;
    v_result:=public.xelay_teaching_mutate('save_assignment',v_payload);
    return v_result;
  end if;

  if p_action='delete_group_assignment' then
    select * into v_existing from public.teaching_items where id=v_id and kind='assignment';
    if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
    v_group:=(p_payload->>'group_id')::uuid;
    perform public.xelay_classroom_lock_group(v_existing.course_id,v_group,'assignments');
    select * into v_existing from public.teaching_items where id=v_id for update;
    if v_version is distinct from v_existing.version then raise exception 'TEACHING_CONFLICT'; end if;
    if not exists(select 1 from public.teaching_item_targets where item_id=v_id and group_id=v_group) then
      raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    if exists(select 1 from public.teaching_submissions where item_id=v_id and group_id=v_group) then
      raise exception 'CLASSROOM_ASSIGNMENT_HAS_SUBMISSIONS'; end if;
    if(select count(*) from public.teaching_item_targets where item_id=v_id)>1 then
      delete from public.teaching_item_targets where item_id=v_id and group_id=v_group;
      update public.teaching_items set version=version+1,updated_at=now() where id=v_id returning version into v_version;
      -- Only this group's empty columns disappear. Do not upsert other
      -- groups' activities or increment their versions during a target removal.
      delete from public.teaching_activities a where a.item_id=v_id and a.group_id=v_group
        and not exists(select 1 from public.teaching_grades g where g.activity_id=a.id);
      return jsonb_build_object('id',v_id,'version',v_version);
    end if;
    return public.xelay_teaching_mutate('delete_assignment',p_payload);
  end if;
  raise exception 'TEACHING_INVALID_ACTION';
end $$;

create or replace function public.xelay_classroom_submission_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_id uuid:=(p_payload->>'id')::uuid;v_version integer:=coalesce((p_payload->>'version')::integer,0);
  v_submission public.teaching_submissions%rowtype;v_course public.teaching_courses%rowtype;v_item public.teaching_items%rowtype;
  v_item_id uuid;v_group uuid;v_activity public.teaching_activities%rowtype;v_entry public.teaching_entries%rowtype;
  v_grade public.teaching_grades%rowtype;v_result jsonb;v_score numeric;v_feedback text;v_status text;v_prior jsonb;
begin
  if p_action='reserve_submission' or(p_action='save_submission' and v_version=0) then
    v_item_id:=(p_payload->>'item_id')::uuid;v_group:=(p_payload->>'group_id')::uuid;
    select * into v_item from public.teaching_items where id=v_item_id and kind='assignment';
    if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
    select * into v_course from public.teaching_courses where id=v_item.course_id for update;
    if v_course.archived_at is not null then raise exception 'TEACHING_ARCHIVED'; end if;
    if not public.xelay_classroom_student(v_item_id,v_group,v_uid) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    select * into v_submission from public.teaching_submissions where item_id=v_item_id and group_id=v_group and user_id=v_uid for update;
    if found then
      if v_submission.status not in('draft','returned') then raise exception 'CLASSROOM_WORK_LOCKED'; end if;
      if p_action='reserve_submission' then return jsonb_build_object('id',v_submission.id,'version',v_submission.version); end if;
      raise exception 'TEACHING_CONFLICT';
    end if;
    if exists(select 1 from public.teaching_submissions where id=v_id) then raise exception 'TEACHING_CONFLICT'; end if;
    insert into public.teaching_submissions(id,item_id,course_id,group_id,user_id)
      values(v_id,v_item_id,v_item.course_id,v_group,v_uid) returning * into v_submission;
    if p_action='reserve_submission' then return jsonb_build_object('id',v_submission.id,'version',v_submission.version); end if;
  else
    select * into v_submission from public.teaching_submissions where id=v_id;
    if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
    select * into v_course from public.teaching_courses where id=v_submission.course_id for update;
    select * into v_submission from public.teaching_submissions where id=v_id for update;
    select * into v_item from public.teaching_items where id=v_submission.item_id;
    if v_version is distinct from v_submission.version then raise exception 'TEACHING_CONFLICT'; end if;
    if v_course.archived_at is not null then raise exception 'TEACHING_ARCHIVED'; end if;
  end if;

  if p_action in('save_submission','submit_submission','withdraw_submission') then
    if v_submission.user_id<>v_uid or not public.xelay_classroom_student(v_submission.item_id,v_submission.group_id,v_uid)
      or(p_payload ? 'item_id' and(p_payload->>'item_id')::uuid is distinct from v_submission.item_id)
      or(p_payload ? 'group_id' and(p_payload->>'group_id')::uuid is distinct from v_submission.group_id) then
      raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    if p_action='save_submission' then
      if v_submission.status not in('draft','returned') then raise exception 'CLASSROOM_WORK_LOCKED'; end if;
      if jsonb_typeof(p_payload->'body') is distinct from 'string' or length(p_payload->>'body')>50000 then raise exception 'TEACHING_INVALID_INPUT'; end if;
      -- Handed-in metadata can be reused exactly. New files always belong to
      -- this reserved submission and this student; staff never see draft_*.
      v_prior:=v_submission.attachments||v_submission.draft_attachments;
      perform public.xelay_classroom_validate_resources(v_submission.id,coalesce(p_payload->'links','[]'::jsonb),
        coalesce(p_payload->'attachments','[]'::jsonb),v_prior);
      update public.teaching_submissions set draft_body=p_payload->>'body',draft_links=coalesce(p_payload->'links','[]'::jsonb),
        draft_attachments=coalesce(p_payload->'attachments','[]'::jsonb),version=version+1,updated_at=now()
        where id=v_submission.id returning * into v_submission;
    elsif p_action='submit_submission' then
      if v_submission.status not in('draft','returned') then raise exception 'CLASSROOM_WORK_LOCKED'; end if;
      if length(btrim(v_submission.draft_body))=0 and jsonb_array_length(v_submission.draft_links)=0
        and jsonb_array_length(v_submission.draft_attachments)=0 then raise exception 'CLASSROOM_EMPTY_SUBMISSION'; end if;
      perform public.xelay_classroom_validate_resources(v_submission.id,v_submission.draft_links,v_submission.draft_attachments,
        v_submission.attachments||v_submission.draft_attachments);
      update public.teaching_submissions set status='submitted',body=draft_body,links=draft_links,attachments=draft_attachments,
        attempt=attempt+1,submitted_at=now(),reviewed_at=null,reviewed_by=null,feedback='',version=version+1,updated_at=now()
        where id=v_submission.id returning * into v_submission;
      perform public.xelay_classroom_write_history(v_submission,'submitted');
      perform public.xelay_classroom_notify_staff(v_submission);
    else
      if v_submission.status<>'submitted' then raise exception 'CLASSROOM_WORK_LOCKED'; end if;
      update public.teaching_submissions set status='draft',draft_body=body,draft_links=links,draft_attachments=attachments,
        version=version+1,updated_at=now() where id=v_submission.id returning * into v_submission;
      perform public.xelay_classroom_write_history(v_submission,'withdrawn');
    end if;
    return jsonb_build_object('id',v_submission.id,'version',v_submission.version);
  end if;

  if p_action='review_submission' then
    if not public.xelay_classroom_staff(v_submission.course_id,v_submission.group_id,v_uid)
      or not public.xelay_teaching_can_read_item(v_submission.item_id,v_uid) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    v_status:=p_payload->>'status';v_feedback:=coalesce(p_payload->>'feedback','');
    if v_status not in('returned','reviewed') or length(v_feedback)>5000
      or(v_status='returned' and length(btrim(v_feedback))<2) then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if v_submission.status<>'submitted' and not(v_submission.status='reviewed' and v_status='returned') then
      raise exception 'CLASSROOM_WORK_LOCKED'; end if;
    if p_payload ? 'score' then
      if not 'grades'=any(public.xelay_teaching_permissions(v_submission.course_id,v_uid)) then
        raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
      if(p_payload->'score'<>'null'::jsonb and jsonb_typeof(p_payload->'score') is distinct from 'number')
        or jsonb_typeof(p_payload->'grade_version') is distinct from 'number' then raise exception 'TEACHING_INVALID_INPUT'; end if;
      select * into v_activity from public.teaching_activities where item_id=v_submission.item_id and group_id=v_submission.group_id for update;
      if not found or v_item.max_points is null then raise exception 'CLASSROOM_ASSIGNMENT_NOT_ASSESSED'; end if;
      perform public.xelay_teaching_sync_roster(v_submission.course_id,v_submission.group_id);
      select * into v_entry from public.teaching_entries where course_id=v_submission.course_id and group_id=v_submission.group_id
        and user_id=v_submission.user_id and active for update;
      if not found then raise exception 'CLASSROOM_ROSTER_LINK_REQUIRED'; end if;
      select * into v_grade from public.teaching_grades where activity_id=v_activity.id and entry_id=v_entry.id for update;
      if(p_payload->>'grade_version')::integer is distinct from coalesce(v_grade.version,0) then raise exception 'TEACHING_CONFLICT'; end if;
      v_result:=public.xelay_teaching_mutate('save_grade',jsonb_build_object('activity_id',v_activity.id,'entry_id',v_entry.id,
        'score',p_payload->'score','comment',left(v_feedback,3000),'reason',coalesce(p_payload->>'reason',''),
        'version',(p_payload->>'grade_version')::integer));
      perform public.xelay_teaching_mutate('publish_grades',jsonb_build_object('activity_id',v_activity.id,
        'expected_versions',jsonb_build_array(jsonb_build_object('entry_id',v_entry.id,'version',(v_result->>'version')::integer))));
      select * into v_grade from public.teaching_grades where activity_id=v_activity.id and entry_id=v_entry.id;
      v_score:=v_grade.published_score;
    else
      -- Feedback only does not mutate, publish or even reveal a draft grade.
      select s.published_score into v_score from public.teaching_grades s join public.teaching_entries e on e.id=s.entry_id
        join public.teaching_activities a on a.id=s.activity_id where a.item_id=v_submission.item_id and a.group_id=v_submission.group_id
          and e.user_id=v_submission.user_id and s.published_at is not null;
    end if;
    update public.teaching_submissions set status=v_status,feedback=v_feedback,reviewed_by=v_uid,reviewed_at=now(),
      version=version+1,updated_at=now() where id=v_submission.id returning * into v_submission;
    perform public.xelay_classroom_write_history(v_submission,v_status,v_score);
    perform public.xelay_teaching_notify(v_submission.user_id,'classroom-review:'||v_submission.id::text||':'||v_submission.version::text,
      case when v_status='returned' then 'Викладач повернув вашу роботу на доопрацювання.' else 'Викладач перевірив вашу роботу. Відповідь доступна в завданні.' end,
      v_submission.course_id,v_submission.group_id);
    return jsonb_build_object('id',v_submission.id,'version',v_submission.version);
  end if;
  raise exception 'TEACHING_INVALID_ACTION';
end $$;

create or replace function public.xelay_classroom_seminar_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_id uuid:=(p_payload->>'id')::uuid;v_version integer:=coalesce((p_payload->>'version')::integer,0);
  v_course_id uuid:=(p_payload->>'course_id')::uuid;v_group uuid:=(p_payload->>'group_id')::uuid;
  v_course public.teaching_courses%rowtype;v_link public.teaching_course_groups%rowtype;
  v_schedule public.study_group_seminar_schedule%rowtype;v_old public.study_group_seminars%rowtype;
  v_subject uuid;v_name text;v_weekday integer;v_start time;v_end time;v_from date;v_until date;v_date date;
  v_format text;v_questions jsonb;v_teams jsonb;v_items jsonb;v_item jsonb;v_child uuid;v_keep uuid[]:='{}';v_position integer:=0;v_capacity integer;
  v_recipient uuid;v_final_version integer;
begin
  perform public.xelay_classroom_lock_group(v_course_id,v_group,'assignments');
  select * into v_course from public.teaching_courses where id=v_course_id;
  select * into v_link from public.teaching_course_groups where course_id=v_course_id and group_id=v_group;
  -- Same lock used by the head/student seminar RPCs: no reservation can appear
  -- between a capacity/deletion check and a teacher update.
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||v_group::text,0));
  v_subject:=v_link.subject_id;

  if p_action='save_seminar_schedule' then
    v_weekday:=(p_payload->>'weekday')::integer;v_start:=(p_payload->>'starts_at')::time;v_end:=(p_payload->>'ends_at')::time;
    v_from:=(p_payload->>'valid_from')::date;v_until:=(p_payload->>'valid_until')::date;
    if v_weekday is null or v_weekday not between 1 and 7 or v_start is null or v_end is null or v_end<=v_start
      or v_from is null or v_until is null or not isfinite(v_from) or not isfinite(v_until)
      or v_until<v_from or v_from<v_course.starts_on or v_until>v_course.ends_on then raise exception 'SEMINAR_INVALID_INPUT'; end if;
    if v_subject is null then
      if v_version<>0 then raise exception 'TEACHING_CONFLICT'; end if;
      v_name:=left(v_course.title,120);
      if exists(select 1 from public.study_group_seminar_subjects where group_id=v_group and lower(btrim(name))=lower(v_name)) then
        v_name:=left(v_course.title,108)||' · '||left(v_course.id::text,8);
      end if;
      insert into public.study_group_seminar_subjects(group_id,name,created_by) values(v_group,v_name,v_uid) returning id into v_subject;
      update public.teaching_course_groups set subject_id=v_subject,updated_at=now() where id=v_link.id;
    end if;
    if v_version=0 then
      if exists(select 1 from public.study_group_seminar_schedule where id=v_id) then raise exception 'TEACHING_CONFLICT'; end if;
      insert into public.study_group_seminar_schedule(id,group_id,subject_id,weekday,starts_at,ends_at,valid_from,valid_until,created_by,teaching_course_id)
        values(v_id,v_group,v_subject,v_weekday,v_start,v_end,v_from,v_until,v_uid,v_course_id) returning teaching_version into v_final_version;
    else
      select * into v_schedule from public.study_group_seminar_schedule where id=v_id and group_id=v_group and subject_id=v_subject for update;
      if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
      if v_version is distinct from v_schedule.teaching_version then raise exception 'TEACHING_CONFLICT'; end if;
      if v_schedule.valid_from<v_course.starts_on or v_schedule.valid_until>v_course.ends_on
        or(v_schedule.teaching_course_id is not null and v_schedule.teaching_course_id<>v_course_id) then
        raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
      if exists(select 1 from public.study_group_seminars s where s.schedule_id=v_id and (
          extract(isodow from s.lesson_date)::integer<>v_weekday or s.lesson_date not between v_from and v_until
          or(public.xelay_seminar_start(s.lesson_date,s.starts_at)>clock_timestamp()
            and public.xelay_seminar_start(s.lesson_date,v_start)<=clock_timestamp())
          or((s.starts_at is distinct from v_start or s.ends_at is distinct from v_end)
            and exists(select 1 from public.study_group_seminar_reservations r where r.seminar_id=s.id)))) then
        raise exception 'SEMINAR_SCHEDULE_HAS_ASSIGNMENTS'; end if;
      update public.study_group_seminar_schedule set weekday=v_weekday,starts_at=v_start,ends_at=v_end,valid_from=v_from,valid_until=v_until,
        updated_at=now() where id=v_id returning teaching_version into v_final_version;
      update public.study_group_seminars set starts_at=v_start,ends_at=v_end,updated_at=now()
        where schedule_id=v_id and public.xelay_seminar_start(lesson_date,starts_at)>clock_timestamp();
    end if;
    return jsonb_build_object('id',v_id,'version',v_final_version,'subject_id',v_subject);
  end if;

  if v_subject is null then raise exception 'CLASSROOM_SUBJECT_REQUIRED'; end if;
  if p_action='delete_seminar' then
    select * into v_old from public.study_group_seminars where id=v_id and group_id=v_group and subject_id=v_subject for update;
    if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
    if v_old.lesson_date not between v_course.starts_on and v_course.ends_on then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    if v_version is distinct from v_old.teaching_version then raise exception 'TEACHING_CONFLICT'; end if;
    if public.xelay_seminar_start(v_old.lesson_date,v_old.starts_at)<=clock_timestamp() then raise exception 'SEMINAR_LOCKED'; end if;
    if exists(select 1 from public.study_group_seminar_reservations where seminar_id=v_id)
      or exists(select 1 from public.study_group_seminar_comments where seminar_id=v_id)
      or exists(select 1 from public.teaching_activities where seminar_id=v_id) then raise exception 'SEMINAR_HAS_RESERVATIONS'; end if;
    delete from public.study_group_seminars where id=v_id;
    return jsonb_build_object('id',v_id);
  end if;
  if p_action<>'save_seminar' then raise exception 'TEACHING_INVALID_ACTION'; end if;
  v_format:=p_payload->>'format';v_date:=(p_payload->>'lesson_date')::date;
  -- Position is presentation metadata; the array's order is authoritative.
  if jsonb_typeof(p_payload->'questions') is distinct from 'array' or jsonb_typeof(p_payload->'teams') is distinct from 'array' then
    raise exception 'SEMINAR_INVALID_INPUT'; end if;
  select coalesce(jsonb_agg(value-'position'),'[]'::jsonb) into v_questions from jsonb_array_elements(p_payload->'questions');
  select coalesce(jsonb_agg(value-'position'),'[]'::jsonb) into v_teams from jsonb_array_elements(p_payload->'teams');
  if length(btrim(coalesce(p_payload->>'title',''))) not between 1 and 160 or length(coalesce(p_payload->>'instructions',''))>10000
    or v_format is null or v_format not in('questions','teams','booking')
    or(v_format in('questions','booking') and(not public.xelay_seminar_items_valid(v_questions,v_format) or jsonb_array_length(v_teams)<>0))
    or(v_format='teams' and(not public.xelay_seminar_items_valid(v_teams,v_format) or jsonb_array_length(v_questions)<>0)) then
    raise exception 'SEMINAR_INVALID_INPUT'; end if;
  select * into v_schedule from public.study_group_seminar_schedule where id=(p_payload->>'schedule_id')::uuid and group_id=v_group and subject_id=v_subject;
  if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
  if v_date is null or not isfinite(v_date) or v_date not between v_course.starts_on and v_course.ends_on
    or extract(isodow from v_date)::integer<>v_schedule.weekday or v_date not between v_schedule.valid_from and v_schedule.valid_until then
    raise exception 'SEMINAR_DATE_MISMATCH'; end if;
  if public.xelay_seminar_start(v_date,v_schedule.starts_at)<=clock_timestamp() then raise exception 'SEMINAR_LOCKED'; end if;
  if exists(select 1 from public.study_group_seminars where schedule_id=v_schedule.id and lesson_date=v_date and id<>v_id) then
    raise exception 'SEMINAR_ALREADY_EXISTS'; end if;
  if v_version>0 then
    select * into v_old from public.study_group_seminars where id=v_id and group_id=v_group and subject_id=v_subject for update;
    if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
    if v_old.lesson_date not between v_course.starts_on and v_course.ends_on then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    if v_version is distinct from v_old.teaching_version then raise exception 'TEACHING_CONFLICT'; end if;
    if public.xelay_seminar_start(v_old.lesson_date,v_old.starts_at)<=clock_timestamp() then raise exception 'SEMINAR_LOCKED'; end if;
    if(v_old.format<>v_format or v_old.schedule_id<>v_schedule.id or v_old.lesson_date<>v_date)
      and exists(select 1 from public.study_group_seminar_reservations where seminar_id=v_id) then raise exception 'SEMINAR_HAS_RESERVATIONS'; end if;
  elsif exists(select 1 from public.study_group_seminars where id=v_id) then raise exception 'TEACHING_CONFLICT'; end if;
  v_items:=case when v_format='teams' then v_teams else v_questions end;
  for v_item in select value from jsonb_array_elements(v_items) loop
    if v_item ? 'id' then
      v_child:=(v_item->>'id')::uuid;
      if exists(select 1 from public.study_group_seminar_questions where id=v_child and(seminar_id<>v_id or v_format='teams'))
        or exists(select 1 from public.study_group_seminar_teams where id=v_child and(seminar_id<>v_id or v_format<>'teams')) then
        raise exception 'SEMINAR_INVALID_INPUT'; end if;
      v_keep:=array_append(v_keep,v_child);
    end if;
  end loop;
  if exists(select 1 from public.study_group_seminar_reservations r where r.seminar_id=v_id and(
      (r.question_id is not null and(v_format='teams' or not(r.question_id=any(v_keep))))
      or(r.team_id is not null and(v_format<>'teams' or not(r.team_id=any(v_keep)))))) then raise exception 'SEMINAR_HAS_RESERVATIONS'; end if;
  if v_version=0 then
    insert into public.study_group_seminars(id,group_id,subject_id,schedule_id,lesson_date,starts_at,ends_at,title,instructions,format,
      created_by,teaching_course_id,teaching_author_id)
      values(v_id,v_group,v_subject,v_schedule.id,v_date,v_schedule.starts_at,v_schedule.ends_at,btrim(p_payload->>'title'),
        coalesce(p_payload->>'instructions',''),v_format,v_uid,v_course_id,v_uid);
  else
    update public.study_group_seminars set schedule_id=v_schedule.id,lesson_date=v_date,starts_at=v_schedule.starts_at,ends_at=v_schedule.ends_at,
      title=btrim(p_payload->>'title'),instructions=coalesce(p_payload->>'instructions',''),format=v_format,
      teaching_course_id=coalesce(teaching_course_id,v_course_id),teaching_author_id=coalesce(teaching_author_id,v_uid),updated_at=now() where id=v_id;
    -- Existing group resource_links/resource_attachments are deliberately kept.
  end if;
  delete from public.study_group_seminar_questions where seminar_id=v_id and(v_format='teams' or not(id=any(v_keep)));
  delete from public.study_group_seminar_teams where seminar_id=v_id and(v_format<>'teams' or not(id=any(v_keep)));
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_position:=v_position+1;v_child:=coalesce((v_item->>'id')::uuid,gen_random_uuid());
    if v_format='teams' then
      v_capacity:=(v_item->>'capacity')::integer;
      if(select count(*) from public.study_group_seminar_reservations where team_id=v_child)>v_capacity then raise exception 'SEMINAR_CAPACITY_BELOW_MEMBERS'; end if;
      insert into public.study_group_seminar_teams(id,seminar_id,position,name,capacity) values(v_child,v_id,v_position,btrim(v_item->>'name'),v_capacity)
        on conflict(id) do update set position=excluded.position,name=excluded.name,capacity=excluded.capacity,updated_at=now();
    else
      v_capacity:=(v_item->>'primary_capacity')::integer;
      if(select count(*) from public.study_group_seminar_reservations where question_id=v_child and role in('primary','booking'))>v_capacity then
        raise exception 'SEMINAR_CAPACITY_BELOW_MEMBERS'; end if;
      insert into public.study_group_seminar_questions(id,seminar_id,position,body,primary_capacity) values(v_child,v_id,v_position,btrim(v_item->>'body'),v_capacity)
        on conflict(id) do update set position=excluded.position,body=excluded.body,primary_capacity=excluded.primary_capacity,updated_at=now();
    end if;
  end loop;
  select teaching_version into v_final_version from public.study_group_seminars where id=v_id;
  for v_recipient in select p.id from public.profiles p where public.xelay_teaching_is_member(v_group,p.id) loop
    perform public.xelay_teaching_notify(v_recipient,'classroom-seminar:'||v_id::text||':'||v_final_version::text,
      'Викладач додав або оновив семінар з предмета «'||v_course.title||'».',v_course_id,v_group);
  end loop;
  return jsonb_build_object('id',v_id,'version',v_final_version);
end $$;

create or replace function public.xelay_classroom_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_id uuid;v_version integer;v_receipt public.classroom_request_receipts%rowtype;v_result jsonb;
begin
  if p_action is null or p_action not in('reserve_submission','save_submission','submit_submission','withdraw_submission','review_submission',
    'copy_assignment','save_group_assignment','delete_group_assignment','save_seminar_schedule','save_seminar','delete_seminar')
    or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>180000 then raise exception 'TEACHING_INVALID_INPUT'; end if;
  v_id:=(p_payload->>'id')::uuid;
  if v_id is null then raise exception 'TEACHING_INVALID_INPUT'; end if;
  v_version:=coalesce((p_payload->>'version')::integer,0);
  if v_version<0 then raise exception 'TEACHING_INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:classroom-request:'||v_uid::text||':'||p_action||':'||v_id::text,0));
  select * into v_receipt from public.classroom_request_receipts where user_id=v_uid and action=p_action and request_id=v_id and expected_version=v_version;
  if found then
    if v_receipt.payload is distinct from p_payload then raise exception 'TEACHING_CONFLICT'; end if;
    -- Reservation is a current editing token, not a historical save receipt.
    -- A second upload after saving must receive today's canonical version.
    if p_action='reserve_submission' then return public.xelay_classroom_submission_mutate(p_action,p_payload); end if;
    return v_receipt.result;
  end if;
  if p_action in('reserve_submission','save_submission','submit_submission','withdraw_submission','review_submission') then
    v_result:=public.xelay_classroom_submission_mutate(p_action,p_payload);
  elsif p_action in('copy_assignment','save_group_assignment','delete_group_assignment') then
    v_result:=public.xelay_classroom_assignment_mutate(p_action,p_payload);
  else v_result:=public.xelay_classroom_seminar_mutate(p_action,p_payload); end if;
  insert into public.classroom_request_receipts(user_id,action,request_id,expected_version,payload,result)
    values(v_uid,p_action,v_id,v_version,p_payload,v_result);
  return v_result;
exception when unique_violation then raise exception 'TEACHING_CONFLICT';
  when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation or datetime_field_overflow then
  raise exception 'TEACHING_INVALID_INPUT' using errcode='22023';
end $$;

-- Only facades and narrowly defined Storage predicates are browser-callable.
revoke all on function public.xelay_classroom_guard_assignment_visibility(),public.xelay_classroom_seminar_version(),
  public.xelay_classroom_guard_provenance(),public.xelay_classroom_touch_seminar_content(),
  public.xelay_classroom_staff(uuid,uuid,uuid),public.xelay_classroom_student(uuid,uuid,uuid),
  public.xelay_classroom_submission_json(public.teaching_submissions,boolean,boolean),
  public.xelay_classroom_file_submission(text),public.xelay_classroom_validate_resources(uuid,jsonb,jsonb,jsonb),
  public.xelay_classroom_lock_group(uuid,uuid,text),public.xelay_classroom_notify_staff(public.teaching_submissions),
  public.xelay_classroom_write_history(public.teaching_submissions,text,numeric),
  public.xelay_classroom_assignment_mutate(text,jsonb),public.xelay_classroom_submission_mutate(text,jsonb),
  public.xelay_classroom_seminar_mutate(text,jsonb),public.xelay_teaching_can_read_item(uuid,uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.xelay_classroom_workspace(),public.xelay_teaching_group_context(uuid),
  public.xelay_classroom_assignment(uuid,uuid),public.xelay_classroom_seminars(uuid,uuid),public.xelay_classroom_mutate(text,jsonb),
  public.xelay_classroom_can_upload_file(text),public.xelay_classroom_can_read_file(text),public.xelay_classroom_can_remove_file(text)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_classroom_workspace(),public.xelay_teaching_group_context(uuid),
  public.xelay_classroom_assignment(uuid,uuid),public.xelay_classroom_seminars(uuid,uuid),public.xelay_classroom_mutate(text,jsonb),
  public.xelay_classroom_can_upload_file(text),public.xelay_classroom_can_read_file(text),public.xelay_classroom_can_remove_file(text)
  to authenticated;

notify pgrst,'reload schema';
commit;

