-- Verified teaching accounts and a private semester workspace.
-- All academic data are reachable only through scoped RPCs. Platform admin
-- approval does not grant academic journal access. No broad profile guard is
-- required: this migration works with the existing live registration triggers.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$ begin
  if to_regclass('public.profiles') is null or to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_group_seminar_subjects') is null
    or to_regclass('public.notifications') is null
    or to_regclass('public.notification_preferences') is null
    or to_regclass('public.notification_email_outbox') is null
    or to_regclass('storage.objects') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null
    or to_regprocedure('public.xelay_create_registration_profile()') is null then
    raise exception 'TEACHING_PREREQUISITES_MISSING';
  end if;
end $$;

-- Presentation preference only: this field never grants teaching permissions.
alter table public.profiles add column if not exists account_type text not null default 'student';
alter table public.profiles drop constraint if exists profiles_account_type_check;
alter table public.profiles add constraint profiles_account_type_check check(account_type in('student','teacher'));

create table if not exists public.teacher_verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  full_name text not null,
  university_id uuid not null references public.universities(id) on delete restrict,
  academic_unit_id uuid not null,
  department text not null check(length(btrim(department)) between 2 and 180),
  position text not null default '' check(length(position)<=180),
  note text not null default '' check(length(note)<=2000),
  status text not null default 'pending' check(status in('pending','approved','rejected','revoked')),
  review_reason text not null default '' check(length(review_reason)<=2000),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(academic_unit_id,university_id) references public.academic_units(id,university_id) on delete restrict
);
create index if not exists teacher_verification_status_idx on public.teacher_verification_requests(status,created_at);

create table if not exists public.teaching_courses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete restrict,
  university_id uuid not null references public.universities(id) on delete restrict,
  academic_unit_id uuid not null,
  title text not null check(length(btrim(title)) between 2 and 180),
  semester text not null check(length(btrim(semester)) between 2 and 100),
  starts_on date not null,
  ends_on date not null,
  grading_rules jsonb not null default '{"categories":[]}'::jsonb,
  archived_at timestamptz,
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(academic_unit_id,university_id) references public.academic_units(id,university_id) on delete restrict,
  check(isfinite(starts_on) and isfinite(ends_on) and ends_on>=starts_on and ends_on-starts_on<=730),
  check(jsonb_typeof(grading_rules)='object' and octet_length(grading_rules::text)<=20000)
);
create index if not exists teaching_courses_owner_idx on public.teaching_courses(owner_id,starts_on desc);

create table if not exists public.teaching_course_teachers (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  permissions text[] not null check(permissions<@array['materials','assignments','grades']::text[] and cardinality(permissions) between 1 and 3),
  status text not null default 'pending' check(status in('pending','accepted','rejected','removed')),
  invited_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(course_id,user_id)
);
create index if not exists teaching_course_teachers_user_idx on public.teaching_course_teachers(user_id,status);

create table if not exists public.teaching_course_groups (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  subject_id uuid,
  status text not null check(status in('pending_teacher','pending_group','accepted','rejected','removed')),
  invited_by uuid not null references public.profiles(id) on delete restrict,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(course_id,group_id),
  foreign key(subject_id,group_id) references public.study_group_seminar_subjects(id,group_id) on delete set null (subject_id)
);
create index if not exists teaching_course_groups_group_idx on public.teaching_course_groups(group_id,status);

create table if not exists public.teaching_entries (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete restrict,
  user_id uuid references public.profiles(id) on delete set null,
  full_name text not null check(length(btrim(full_name)) between 1 and 180),
  active boolean not null default true,
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id,course_id,group_id),
  foreign key(course_id,group_id) references public.teaching_course_groups(course_id,group_id) on delete cascade
);
create unique index if not exists teaching_entries_user_idx on public.teaching_entries(course_id,group_id,user_id) where user_id is not null;

create table if not exists public.teaching_roster_claims (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.teaching_entries(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  proposed_by uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'pending' check(status in('pending','accepted','rejected')),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create unique index if not exists teaching_roster_claims_pending_idx on public.teaching_roster_claims(entry_id) where status='pending';

create table if not exists public.teaching_activities (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete restrict,
  title text not null check(length(btrim(title)) between 1 and 180),
  category text not null default '' check(length(category)<=100),
  activity_date date not null check(isfinite(activity_date)),
  max_points numeric(8,2) not null check(max_points>0 and max_points<=10000),
  seminar_id uuid,
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id,course_id,group_id),
  foreign key(course_id,group_id) references public.teaching_course_groups(course_id,group_id) on delete cascade,
  foreign key(seminar_id,group_id) references public.study_group_seminars(id,group_id) on delete set null (seminar_id)
);

create table if not exists public.teaching_grades (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null,
  group_id uuid not null,
  activity_id uuid not null,
  entry_id uuid not null,
  draft_score numeric(8,2) check(draft_score>=0 and draft_score<=10000),
  draft_comment text not null default '' check(length(draft_comment)<=3000),
  published_score numeric(8,2) check(published_score>=0 and published_score<=10000),
  published_comment text not null default '' check(length(published_comment)<=3000),
  published_at timestamptz,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(activity_id,entry_id),
  foreign key(activity_id,course_id,group_id) references public.teaching_activities(id,course_id,group_id) on delete cascade,
  foreign key(entry_id,course_id,group_id) references public.teaching_entries(id,course_id,group_id) on delete cascade
);
create index if not exists teaching_grades_entry_idx on public.teaching_grades(entry_id,published_at);

create table if not exists public.teaching_grade_audit (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  activity_id uuid not null references public.teaching_activities(id) on delete cascade,
  entry_id uuid not null references public.teaching_entries(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  old_score numeric(8,2),new_score numeric(8,2),
  old_comment text not null default '',new_comment text not null default '',
  reason text not null default '' check(length(reason)<=2000),
  event text not null check(event in('draft','publication')),
  created_at timestamptz not null default now()
);

create table if not exists public.teaching_items (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  kind text not null check(kind in('assignment','material')),
  title text not null check(length(btrim(title)) between 1 and 240),
  body text not null default '' check(length(body)<=50000),
  links jsonb not null default '[]'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  material_date date,
  max_points numeric(8,2) check(max_points>0 and max_points<=10000),
  category text not null default '' check(length(category)<=100),
  status text not null default 'draft' check(status in('draft','published')),
  published_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(material_date is null or isfinite(material_date)),
  check(kind='assignment' or(max_points is null and category='')),
  check(jsonb_typeof(links)='array' and jsonb_array_length(links)<=20),
  check(jsonb_typeof(attachments)='array' and jsonb_array_length(attachments)<=10)
);
create index if not exists teaching_items_course_idx on public.teaching_items(course_id,kind,status,created_at desc);
create index if not exists teaching_items_files_idx on public.teaching_items using gin(attachments jsonb_path_ops);
alter table public.teaching_activities add column if not exists item_id uuid references public.teaching_items(id) on delete set null;
create unique index if not exists teaching_activities_item_group_idx on public.teaching_activities(item_id,group_id) where item_id is not null;
create table if not exists public.teaching_create_receipts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null,
  request_id uuid not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,action,request_id)
);
create table if not exists public.teaching_item_targets (
  item_id uuid not null references public.teaching_items(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  due_at timestamptz,
  primary key(item_id,group_id),
  check(due_at is null or isfinite(due_at))
);

-- No academic table is directly writable or enumerable by browser roles.
do $$ declare v_table text; begin
  foreach v_table in array array['teacher_verification_requests','teaching_courses','teaching_course_teachers',
    'teaching_course_groups','teaching_entries','teaching_roster_claims','teaching_activities',
    'teaching_grades','teaching_grade_audit','teaching_items','teaching_item_targets','teaching_create_receipts'] loop
    execute format('alter table public.%I enable row level security',v_table);
    execute format('revoke all on table public.%I from public,anon,authenticated,service_role',v_table);
  end loop;
end $$;

create or replace function public.xelay_teaching_is_member(p_group_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select p_user_id is not null and exists(select 1 from public.study_groups g where g.id=p_group_id
    and (g.representative_id=p_user_id or exists(select 1 from public.study_group_members m
      where m.group_id=g.id and m.user_id=p_user_id and m.status='accepted')));
$$;

create or replace function public.xelay_teaching_is_verified(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select p_user_id is not null and exists(select 1 from public.teacher_verification_requests r
    join auth.users u on u.id=r.user_id join public.profiles p on p.id=r.user_id
    where r.user_id=p_user_id and r.status='approved' and u.email_confirmed_at is not null
      and u.deleted_at is null and coalesce(u.banned_until,'-infinity'::timestamptz)<=now()
      and p.university_id=r.university_id and p.academic_unit_id=r.academic_unit_id);
$$;

create or replace function public.xelay_teaching_permissions(p_course_id uuid,p_user_id uuid)
returns text[] language sql stable security definer set search_path='' as $$
  select case when not public.xelay_teaching_is_verified(p_user_id)
    or not exists(select 1 from public.teaching_courses c join public.teacher_verification_requests r
      on r.user_id=p_user_id and r.university_id=c.university_id where c.id=p_course_id) then '{}'::text[]
    when exists(select 1 from public.teaching_courses c where c.id=p_course_id and c.owner_id=p_user_id)
      then array['materials','assignments','grades','manage']::text[]
    else coalesce((select t.permissions from public.teaching_course_teachers t
      where t.course_id=p_course_id and t.user_id=p_user_id and t.status='accepted'),'{}'::text[]) end;
$$;

create or replace function public.xelay_teaching_can_read_course(p_course_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select cardinality(public.xelay_teaching_permissions(p_course_id,p_user_id))>0
    or exists(select 1 from public.teaching_course_groups g where g.course_id=p_course_id
      and g.status='accepted' and public.xelay_teaching_is_member(g.group_id,p_user_id));
$$;

create or replace function public.xelay_teaching_assert_user()
returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); begin
  if v_uid is null or not exists(select 1 from auth.users u where u.id=v_uid
    and u.email_confirmed_at is not null and u.deleted_at is null
    and coalesce(u.banned_until,'-infinity'::timestamptz)<=now()) then
    raise exception 'TEACHING_AUTH_REQUIRED' using errcode='42501'; end if;
  return v_uid;
end $$;



create or replace function public.xelay_teaching_lock_course(p_course_id uuid,p_permission text)
returns void language plpgsql security definer set search_path='' as $$
declare v_course public.teaching_courses%rowtype; begin
  select * into v_course from public.teaching_courses where id=p_course_id for update;
  if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
  if not p_permission=any(public.xelay_teaching_permissions(p_course_id,auth.uid())) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  if v_course.archived_at is not null then raise exception 'TEACHING_ARCHIVED'; end if;
end $$;

create or replace function public.xelay_teaching_validate_rules(p_rules jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_category jsonb;v_seen text[]:='{}';v_max numeric; begin
  if p_rules is null or jsonb_typeof(p_rules)<>'object' or octet_length(p_rules::text)>20000
    or jsonb_typeof(p_rules->'categories') is distinct from 'array'
    or jsonb_array_length(p_rules->'categories')>30 then return false; end if;
  if p_rules ? 'total_max' then
    if jsonb_typeof(p_rules->'total_max')<>'number' then return false; end if;
    v_max:=(p_rules->>'total_max')::numeric;
    if v_max<=0 or v_max>10000 then return false; end if;
  end if;
  for v_category in select value from jsonb_array_elements(p_rules->'categories') loop
    if jsonb_typeof(v_category)<>'object' or length(coalesce(v_category->>'id','')) not between 1 and 100
      or length(btrim(coalesce(v_category->>'name',''))) not between 1 and 180
      or jsonb_typeof(v_category->'max_points') is distinct from 'number'
      or (v_category->>'id')=any(v_seen) then return false; end if;
    v_max:=(v_category->>'max_points')::numeric;
    if v_max<=0 or v_max>10000 then return false; end if;
    v_seen:=array_append(v_seen,v_category->>'id');
  end loop;
  return true;
exception when others then return false;
end $$;

alter table public.teaching_courses drop constraint if exists teaching_courses_rules_valid;
alter table public.teaching_courses add constraint teaching_courses_rules_valid check(public.xelay_teaching_validate_rules(grading_rules));

alter table public.notifications add column if not exists teaching_course_id uuid references public.teaching_courses(id) on delete cascade;
alter table public.notifications add column if not exists teaching_event_key text;
create unique index if not exists notifications_teaching_event_unique on public.notifications(recipient_id,teaching_event_key) where teaching_event_key is not null;

-- Legacy client notification policies must not permit fabricated teaching
-- events or email jobs. SECURITY DEFINER owners create the real events.
drop policy if exists "Teaching notifications server insert boundary" on public.notifications;
create policy "Teaching notifications server insert boundary" on public.notifications as restrictive for insert to anon,authenticated
  with check(type is distinct from 'teaching_update' and teaching_event_key is null and teaching_course_id is null);

create or replace function public.xelay_teaching_is_backend_write()
returns boolean language sql stable security invoker set search_path='' as $$
  select coalesce(pg_catalog.current_setting('role',true),'none')='service_role'
    or(coalesce(pg_catalog.current_setting('role',true),'none') in('none','postgres','supabase_admin','supabase_auth_admin')
      and session_user in('postgres','supabase_admin','supabase_auth_admin','service_role'));
$$;

create or replace function public.xelay_teaching_guard_notification_update()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if public.xelay_teaching_is_backend_write() then return new; end if;
  if old.type='teaching_update' then
    if(to_jsonb(new)-'is_read') is distinct from(to_jsonb(old)-'is_read') then
      raise exception 'TEACHING_NOTIFICATION_IMMUTABLE' using errcode='42501'; end if;
  elsif new.type='teaching_update' or new.teaching_event_key is distinct from old.teaching_event_key
    or new.teaching_course_id is distinct from old.teaching_course_id then
    raise exception 'TEACHING_NOTIFICATION_IMMUTABLE' using errcode='42501';
  end if;
  return new;
end $$;
drop trigger if exists xelay_teaching_notification_update_guard on public.notifications;
create trigger xelay_teaching_notification_update_guard before update on public.notifications
  for each row execute function public.xelay_teaching_guard_notification_update();

drop function if exists public.xelay_teaching_notify(uuid,text,text,uuid,uuid);
create or replace function public.xelay_teaching_notify(p_recipient uuid,p_event text,p_message text,p_course uuid default null,p_group uuid default null,p_actor uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=coalesce(p_actor,auth.uid());
begin
  if p_recipient is null or v_actor is null or p_recipient=v_actor then return; end if;
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,teaching_course_id,teaching_event_key,study_group_id)
  select p_recipient,v_actor,coalesce((select full_name from public.profiles where id=v_actor),'Xelay'),
    'teaching_update',left(p_message,1000),false,p_course,p_event,p_group
  where exists(select 1 from auth.users u where u.id=p_recipient and u.deleted_at is null
    and coalesce(u.banned_until,'-infinity'::timestamptz)<=now())
  on conflict(recipient_id,teaching_event_key) where teaching_event_key is not null do nothing;
end $$;

create or replace function public.xelay_teacher_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_request jsonb; begin
  if v_uid is null then raise exception 'TEACHING_AUTH_REQUIRED' using errcode='42501'; end if;
  select to_jsonb(r) into v_request from public.teacher_verification_requests r where r.user_id=v_uid;
  return jsonb_build_object('status',coalesce(v_request->>'status','none'),'request',v_request,
    'verified',public.xelay_teaching_is_verified(v_uid),
    'scope_changed',coalesce(v_request->>'status' in('pending','approved') and not exists(select 1 from public.profiles p
      where p.id=v_uid and p.university_id=(v_request->>'university_id')::uuid and p.academic_unit_id=(v_request->>'academic_unit_id')::uuid),false),
    'requests',case when public.xelay_is_platform_admin() then coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc)
      from public.teacher_verification_requests r),'[]'::jsonb) else '[]'::jsonb end);
end $$;

create or replace function public.xelay_teacher_request(p_department text,p_position text default '',p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_profile public.profiles%rowtype;v_request public.teacher_verification_requests%rowtype;v_admin record; begin
  select * into v_profile from public.profiles where id=v_uid;
  if length(btrim(coalesce(p_department,''))) not between 2 and 180 or length(coalesce(p_position,''))>180
    or length(coalesce(p_note,''))>2000 or not exists(select 1 from public.academic_units f join public.universities u on u.id=f.university_id
      where f.id=v_profile.academic_unit_id and u.id=v_profile.university_id and f.is_active and u.is_active) then
    raise exception 'TEACHING_INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:teacher-request:'||v_uid::text,0));
  select * into v_request from public.teacher_verification_requests where user_id=v_uid for update;
  if found and v_request.status in('pending','approved') and v_request.university_id=v_profile.university_id
    and v_request.academic_unit_id=v_profile.academic_unit_id then return to_jsonb(v_request); end if;
  if found and v_request.status='revoked' then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  if found and v_request.status='rejected' and v_request.updated_at>now()-interval '1 day' then raise exception 'TEACHING_REQUEST_COOLDOWN'; end if;
  insert into public.teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department,position,note)
  values(v_uid,v_profile.full_name,v_profile.university_id,v_profile.academic_unit_id,btrim(p_department),btrim(coalesce(p_position,'')),btrim(coalesce(p_note,'')))
  on conflict(user_id) do update set full_name=excluded.full_name,university_id=excluded.university_id,academic_unit_id=excluded.academic_unit_id,
    department=excluded.department,position=excluded.position,note=excluded.note,status='pending',review_reason='',reviewed_by=null,reviewed_at=null,updated_at=now()
  returning * into v_request;
  for v_admin in select distinct user_id from public.user_roles where role='ADMIN' loop
    perform public.xelay_teaching_notify(v_admin.user_id,'teacher-request:'||v_request.id::text||':'||v_request.updated_at::text,
      'Нова заявка на підтвердження викладача: '||v_profile.full_name);
  end loop;
  return to_jsonb(v_request);
end $$;

create or replace function public.xelay_verified_teacher_public(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.xelay_teaching_is_verified(p_user_id) then return jsonb_build_object('verified',false,'department','','position',''); end if;
  return(select jsonb_build_object('verified',true,'department',r.department,'position',r.position)
    from public.teacher_verification_requests r where r.user_id=p_user_id);
end $$;

create or replace function public.xelay_teaching_file_course(p_name text)
returns uuid language plpgsql immutable set search_path='' as $$
begin
  if p_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.[a-z0-9]{1,8}$' then return null; end if;
  return split_part(p_name,'/',1)::uuid;
exception when invalid_text_representation then return null;
end $$;

create or replace function public.xelay_teaching_file_allowed(p_name text,p_mime text)
returns boolean language sql immutable set search_path='' as $$
  select case lower(regexp_replace(p_name,'^.*\.',''))
    when 'pdf' then p_mime='application/pdf'
    when 'doc' then p_mime='application/msword'
    when 'docx' then p_mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    when 'xls' then p_mime='application/vnd.ms-excel'
    when 'xlsx' then p_mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    when 'ppt' then p_mime='application/vnd.ms-powerpoint'
    when 'pptx' then p_mime='application/vnd.openxmlformats-officedocument.presentationml.presentation'
    when 'png' then p_mime='image/png'
    when 'jpg' then p_mime='image/jpeg'
    when 'jpeg' then p_mime='image/jpeg'
    when 'webp' then p_mime='image/webp'
    when 'txt' then p_mime='text/plain'
    when 'csv' then p_mime in('text/csv','application/vnd.ms-excel')
    else false end;
$$;

create or replace function public.xelay_teaching_can_read_item(p_item_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_items i where i.id=p_item_id and (
    (case when i.kind='assignment' then 'assignments' else 'materials' end)=any(public.xelay_teaching_permissions(i.course_id,p_user_id))
    or (i.status='published' and exists(select 1 from public.teaching_item_targets t
      join public.teaching_course_groups g on g.course_id=i.course_id and g.group_id=t.group_id and g.status='accepted'
      where t.item_id=i.id and public.xelay_teaching_is_member(t.group_id,p_user_id)))));
$$;

create or replace function public.xelay_teaching_can_upload_file(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and public.xelay_teaching_file_course(p_name) is not null
    and split_part(p_name,'/',2)=auth.uid()::text
    and exists(select 1 from public.teaching_courses c where c.id=public.xelay_teaching_file_course(p_name) and c.archived_at is null
      and public.xelay_teaching_permissions(c.id,auth.uid())&&array['materials','assignments']::text[]);
$$;

create or replace function public.xelay_teaching_can_read_file(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and exists(select 1 from auth.users u where u.id=auth.uid()
    and u.email_confirmed_at is not null and u.deleted_at is null
    and coalesce(u.banned_until,'-infinity'::timestamptz)<=now())
    and public.xelay_teaching_file_course(p_name) is not null and (
    exists(select 1 from public.teaching_items i where i.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))
      and public.xelay_teaching_can_read_item(i.id,auth.uid()))
    or (not exists(select 1 from public.teaching_items i where i.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name)))
      and split_part(p_name,'/',2)=auth.uid()::text and public.xelay_teaching_can_upload_file(p_name)));
$$;

create or replace function public.xelay_teaching_can_remove_file(p_name text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
  if not public.xelay_teaching_can_upload_file(p_name) then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-file:'||p_name,0));
  return not exists(select 1 from public.teaching_items i where i.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name)));
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('xelay-teaching-files','xelay-teaching-files',false,20971520,array[
  'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png','image/jpeg','image/webp','text/plain','text/csv'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists "Teaching file uploads" on storage.objects;
create policy "Teaching file uploads" on storage.objects for insert to authenticated
  with check(bucket_id='xelay-teaching-files' and public.xelay_teaching_can_upload_file(name)
    and public.xelay_teaching_file_allowed(name,metadata->>'mimetype')
    and (metadata->>'size')::bigint between 1 and 20971520);
drop policy if exists "Teaching file reads" on storage.objects;
create policy "Teaching file reads" on storage.objects for select to authenticated
  using(bucket_id='xelay-teaching-files' and public.xelay_teaching_can_read_file(name));
drop policy if exists "Teaching unreferenced file removal" on storage.objects;
create policy "Teaching unreferenced file removal" on storage.objects for delete to authenticated
  using(bucket_id='xelay-teaching-files' and public.xelay_teaching_can_remove_file(name));
-- No UPDATE/upsert policy: linked bytes cannot be replaced under a signed URL.
-- Restrictive bucket boundaries also close permissive legacy policies that may
-- still exist in the live project. Unrelated buckets retain their own policies.
drop policy if exists "Teaching upload boundary" on storage.objects;
create policy "Teaching upload boundary" on storage.objects as restrictive for insert to anon,authenticated
  with check(case when bucket_id='xelay-teaching-files' then
    case when auth.uid() is null then false else public.xelay_teaching_can_upload_file(name)
      and public.xelay_teaching_file_allowed(name,metadata->>'mimetype')
      and (metadata->>'size')::bigint between 1 and 20971520 end else true end);
drop policy if exists "Teaching read boundary" on storage.objects;
create policy "Teaching read boundary" on storage.objects as restrictive for select to anon,authenticated
  using(case when bucket_id='xelay-teaching-files' then
    case when auth.uid() is null then false else public.xelay_teaching_can_read_file(name) end else true end);
drop policy if exists "Teaching removal boundary" on storage.objects;
create policy "Teaching removal boundary" on storage.objects as restrictive for delete to anon,authenticated
  using(case when bucket_id='xelay-teaching-files' then
    case when auth.uid() is null then false else public.xelay_teaching_can_remove_file(name) end else true end);
drop policy if exists "Teaching overwrite boundary" on storage.objects;
create policy "Teaching overwrite boundary" on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id<>'xelay-teaching-files') with check(bucket_id<>'xelay-teaching-files');

create or replace function public.xelay_teaching_validate_resources(p_course uuid,p_links jsonb,p_files jsonb,p_prior jsonb default '[]'::jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare v_file jsonb;v_path text;v_object storage.objects%rowtype;v_link text; begin
  if jsonb_typeof(p_links) is distinct from 'array' or jsonb_array_length(p_links)>20
    or jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files)>10
    or octet_length(p_links::text)+octet_length(p_files::text)>30000 then raise exception 'TEACHING_INVALID_INPUT'; end if;
  for v_file in select value from jsonb_array_elements(p_links) loop
    v_link:=v_file #>> '{}';
    if jsonb_typeof(v_file)<>'string' or length(v_link)>2000
      or v_link !~* '^https?://[^/?#[:space:]\\@]+([/?#][^[:space:]\\]*)?$'
      or v_link ~ '[[:cntrl:]]' then raise exception 'TEACHING_INVALID_INPUT'; end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_files))<>(select count(distinct value->>'storage_path') from jsonb_array_elements(p_files)) then
    raise exception 'TEACHING_INVALID_INPUT'; end if;
  for v_path in select distinct value->>'storage_path' from jsonb_array_elements(p_files||p_prior) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-file:'||coalesce(v_path,''),0));
  end loop;
  for v_file in select value from jsonb_array_elements(p_files) loop
    v_path:=v_file->>'storage_path';
    if jsonb_typeof(v_file)<>'object'
      or length(btrim(coalesce(v_file->>'name',''))) not between 1 and 240
      or (v_file->>'name')~'[[:cntrl:]]'
      or not coalesce(public.xelay_teaching_file_allowed(v_path,v_file->>'mime_type'),false)
      or jsonb_typeof(v_file->'size') is distinct from 'number'
      or (v_file->>'size')::numeric not between 1 and 20971520 then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if p_prior @> jsonb_build_array(v_file) then continue; end if;
    if public.xelay_teaching_file_course(v_path) is distinct from p_course then raise exception 'TEACHING_FILE_FORBIDDEN' using errcode='42501'; end if;
    if p_prior @> jsonb_build_array(jsonb_build_object('storage_path',v_path)) then raise exception 'TEACHING_FILE_METADATA_IMMUTABLE'; end if;
    select * into v_object from storage.objects where bucket_id='xelay-teaching-files' and name=v_path for update;
    if not found or split_part(v_path,'/',2)<>auth.uid()::text
      or coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner')<>auth.uid()::text
      or (v_object.metadata->>'size')::numeric<>(v_file->>'size')::numeric
      or v_object.metadata->>'mimetype'<>v_file->>'mime_type' then raise exception 'TEACHING_FILE_FORBIDDEN' using errcode='42501'; end if;
  end loop;
end $$;

-- A teacher-only profile has no fabricated student degree or specialty. The
-- existing catalog labels remain authoritative for all actual student profiles.
create or replace function public.xelay_validate_profile_academic_specialty()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_program_name text;v_faculty_name text;v_changed boolean; begin
  if tg_op='UPDATE' then
    v_changed:=new.university_id is distinct from old.university_id or new.academic_unit_id is distinct from old.academic_unit_id
      or new.specialty_id is distinct from old.specialty_id or new.specialty is distinct from old.specialty
      or new.faculty is distinct from old.faculty or new.account_type is distinct from old.account_type;
    if not v_changed then return new; end if;
  elsif new.university_id is null and new.academic_unit_id is null and new.specialty_id is null
    and nullif(btrim(coalesce(new.specialty,'')),'') is null and nullif(btrim(coalesce(new.faculty,'')),'') is null then return new; end if;
  if new.account_type='teacher' and new.specialty_id is null and nullif(btrim(coalesce(new.experience,'')),'') is null then
    select unit.name into v_faculty_name from public.academic_units unit join public.universities university on university.id=unit.university_id
      where unit.id=new.academic_unit_id and unit.university_id=new.university_id and unit.is_active and university.is_active;
    if not found then raise exception 'ACADEMIC_SPECIALTY_INVALID' using errcode='23514'; end if;
    new.specialty:='';new.faculty:=v_faculty_name;new.study_year:=null;
    return new;
  end if;
  if new.specialty_id is null then raise exception 'ACADEMIC_SPECIALTY_REQUIRED' using errcode='23514'; end if;
  select specialty.name,unit.name into v_program_name,v_faculty_name from public.academic_specialties specialty
    join public.academic_units unit on unit.id=specialty.academic_unit_id and unit.university_id=specialty.university_id
    join public.universities university on university.id=specialty.university_id where specialty.id=new.specialty_id
      and specialty.academic_unit_id=new.academic_unit_id and specialty.university_id=new.university_id
      and specialty.is_active and unit.is_active and university.is_active;
  if not found then raise exception 'ACADEMIC_SPECIALTY_INVALID' using errcode='23514'; end if;
  new.specialty:=v_program_name;new.faculty:=v_faculty_name;return new;
end $$;

create or replace function public.xelay_teaching_signup_request()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_meta jsonb;v_request public.teacher_verification_requests%rowtype;v_admin record; begin
  select raw_user_meta_data into v_meta from auth.users where id=new.id;
  if new.account_type<>'teacher' or v_meta->>'account_type' is distinct from 'teacher'
    or v_meta->>'xelay_registration_version' is distinct from '1' or new.university_id is null or new.academic_unit_id is null then return new; end if;
  if length(btrim(coalesce(v_meta->>'teacher_department',''))) not between 2 and 180
    or length(coalesce(v_meta->>'teacher_position',''))>180 then raise exception 'TEACHING_INVALID_INPUT'; end if;
  insert into public.teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department,position)
    values(new.id,new.full_name,new.university_id,new.academic_unit_id,btrim(v_meta->>'teacher_department'),btrim(coalesce(v_meta->>'teacher_position','')))
    on conflict(user_id) do nothing returning * into v_request;
  if v_request.id is not null then
    for v_admin in select distinct user_id from public.user_roles where role='ADMIN' loop
      perform public.xelay_teaching_notify(v_admin.user_id,'teacher-request:'||v_request.id::text||':'||v_request.updated_at::text,
        'Нова заявка на підтвердження викладача: '||new.full_name,null,null,new.id);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists xelay_teaching_signup_request on public.profiles;
create trigger xelay_teaching_signup_request after insert or update of university_id,academic_unit_id,account_type on public.profiles
  for each row execute function public.xelay_teaching_signup_request();


create or replace function public.xelay_teaching_item_json(p_item public.teaching_items,p_group uuid default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select to_jsonb(p_item)||jsonb_build_object('author_name',(select full_name from public.profiles where id=p_item.created_by),
    'course_title',(select title from public.teaching_courses where id=p_item.course_id),
    'targets',coalesce((select jsonb_agg(jsonb_build_object('group_id',t.group_id,'due_at',t.due_at) order by t.group_id)
      from public.teaching_item_targets t where t.item_id=p_item.id and (p_group is null or t.group_id=p_group)
        and (cardinality(public.xelay_teaching_permissions(p_item.course_id,auth.uid()))>0
          or public.xelay_teaching_is_member(t.group_id,auth.uid()))),'[]'::jsonb));
$$;

create or replace function public.xelay_teaching_workspace()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_university uuid; begin
  select university_id into v_university from public.profiles where id=v_uid;
  return jsonb_build_object('teacher_status',public.xelay_teacher_status(),
    'courses',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('permissions',public.xelay_teaching_permissions(c.id,v_uid)) order by c.starts_on desc,c.title)
      from public.teaching_courses c where public.xelay_teaching_can_read_course(c.id,v_uid)
        or (c.owner_id=v_uid and public.xelay_teaching_is_verified(v_uid))
        or exists(select 1 from public.teaching_course_teachers t where t.course_id=c.id and t.user_id=v_uid and t.status='pending')),'[]'::jsonb),
    'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'group_id',g.id,'group_name',g.group_name,'specialty',g.specialty,
      'representative_id',g.representative_id,'representative_name',p.full_name,'university_id',g.university_id,'academic_unit_id',g.academic_unit_id,
      'is_representative',g.representative_id=v_uid,'subjects',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) order by s.name)
        from public.study_group_seminar_subjects s where s.group_id=g.id),'[]'::jsonb)) order by g.group_name)
      from public.study_groups g join public.profiles p on p.id=g.representative_id
      where public.xelay_teaching_is_member(g.id,v_uid) or (public.xelay_teaching_is_verified(v_uid) and g.university_id=v_university)),'[]'::jsonb),
    'teacher_directory',coalesce((select jsonb_agg(jsonb_build_object('id',r.user_id,'user_id',r.user_id,'full_name',p.full_name,
      'department',r.department,'position',r.position,'academic_unit_id',r.academic_unit_id) order by p.full_name)
      from public.teacher_verification_requests r join public.profiles p on p.id=r.user_id
      where r.university_id=v_university and public.xelay_teaching_is_verified(r.user_id)),'[]'::jsonb),
    'invitations',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('course_title',c.title,'semester',c.semester,'full_name',p.full_name))
      from public.teaching_course_teachers t join public.teaching_courses c on c.id=t.course_id
      join public.profiles p on p.id=c.owner_id where t.user_id=v_uid and t.status='pending'),'[]'::jsonb),
    'teacher_invites',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('course_title',c.title,'semester',c.semester))
      from public.teaching_course_teachers t join public.teaching_courses c on c.id=t.course_id where t.user_id=v_uid and t.status='pending'),'[]'::jsonb),
    'pending_invites',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('title',c.title,'semester',c.semester,'group_name',g.group_name,
      'teacher_name',p.full_name)) from public.teaching_course_groups l join public.teaching_courses c on c.id=l.course_id
      join public.study_groups g on g.id=l.group_id join public.profiles p on p.id=c.owner_id
      where (l.status='pending_teacher' and c.owner_id=v_uid) or (l.status='pending_group' and g.representative_id=v_uid)),'[]'::jsonb),
    'roster_claims',coalesce((select jsonb_agg(to_jsonb(q)||jsonb_build_object('full_name',e.full_name,'course_title',c.title,'group_id',e.group_id))
      from public.teaching_roster_claims q join public.teaching_entries e on e.id=q.entry_id join public.teaching_courses c on c.id=e.course_id
      where q.user_id=v_uid and q.status='pending'),'[]'::jsonb));
end $$;

create or replace function public.xelay_teaching_seminars(p_course_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  with sessions as (
    select s.* from public.study_group_seminars s join public.teaching_course_groups l
      on l.group_id=s.group_id and l.subject_id=s.subject_id and l.status='accepted'
      join public.teaching_courses c on c.id=l.course_id
    where c.id=p_course_id and s.lesson_date between c.starts_on and c.ends_on
  ), reservations as (select r.* from public.study_group_seminar_reservations r join sessions s on s.id=r.seminar_id)
  select jsonb_build_object(
    'seminars',coalesce((select jsonb_agg(to_jsonb(s) order by s.lesson_date desc,s.starts_at) from sessions s),'[]'::jsonb),
    'questions',coalesce((select jsonb_agg(to_jsonb(q) order by q.position) from public.study_group_seminar_questions q join sessions s on s.id=q.seminar_id),'[]'::jsonb),
    'teams',coalesce((select jsonb_agg(to_jsonb(t) order by t.position) from public.study_group_seminar_teams t join sessions s on s.id=t.seminar_id),'[]'::jsonb),
    'reservations',coalesce((select jsonb_agg(to_jsonb(r)) from reservations r),'[]'::jsonb),
    'profiles',coalesce((select jsonb_object_agg(p.id::text,jsonb_build_object('id',p.id,'full_name',p.full_name,'username',p.username,'avatar_url',p.avatar_url))
      from public.profiles p where p.id in(select user_id from reservations)),'{}'::jsonb));
$$;

create or replace function public.xelay_teaching_group(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_head boolean; begin
  if not public.xelay_teaching_is_member(p_group_id,v_uid) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  v_head:=exists(select 1 from public.study_groups where id=p_group_id and representative_id=v_uid);
  return jsonb_build_object(
    'courses',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('teacher_name',p.full_name,'link_id',g.id,'subject_id',g.subject_id))
      from public.teaching_courses c join public.teaching_course_groups g on g.course_id=c.id and g.group_id=p_group_id and g.status='accepted'
      join public.profiles p on p.id=c.owner_id),'[]'::jsonb),
    'pending_invites',case when v_head then coalesce((select jsonb_agg(to_jsonb(g)||jsonb_build_object('title',c.title,'semester',c.semester,'teacher_name',p.full_name))
      from public.teaching_course_groups g join public.teaching_courses c on c.id=g.course_id join public.profiles p on p.id=c.owner_id
      where g.group_id=p_group_id and g.status in('pending_group','pending_teacher')),'[]'::jsonb) else '[]'::jsonb end,
    'assignments',coalesce((select jsonb_agg(public.xelay_teaching_item_json(i,p_group_id) order by i.created_at desc)
      from public.teaching_items i join public.teaching_item_targets t on t.item_id=i.id and t.group_id=p_group_id
      join public.teaching_course_groups g on g.course_id=i.course_id and g.group_id=p_group_id and g.status='accepted'
      where i.kind='assignment' and i.status='published'),'[]'::jsonb),
    'materials',coalesce((select jsonb_agg(public.xelay_teaching_item_json(i,p_group_id) order by i.material_date desc nulls last,i.created_at desc)
      from public.teaching_items i join public.teaching_item_targets t on t.item_id=i.id and t.group_id=p_group_id
      join public.teaching_course_groups g on g.course_id=i.course_id and g.group_id=p_group_id and g.status='accepted'
      where i.kind='material' and i.status='published'),'[]'::jsonb),
    'grades',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'course_id',s.course_id,'group_id',s.group_id,
      'activity_id',s.activity_id,'entry_id',s.entry_id,'published_score',s.published_score,'published_comment',s.published_comment,
      'published_at',s.published_at,'max_points',a.max_points,'activity_title',a.title,'activity_date',a.activity_date,'category',a.category,
      'course_title',c.title,'grading_rules',c.grading_rules))
      from public.teaching_grades s join public.teaching_entries e on e.id=s.entry_id
      join public.teaching_activities a on a.id=s.activity_id join public.teaching_courses c on c.id=s.course_id
      join public.teaching_course_groups g on g.course_id=s.course_id and g.group_id=p_group_id and g.status='accepted'
      where s.group_id=p_group_id and e.user_id=v_uid and s.published_at is not null),'[]'::jsonb));
end $$;

create or replace function public.xelay_teaching_sync_roster(p_course uuid,p_group uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.teaching_course_groups where course_id=p_course and group_id=p_group and status='accepted') then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  -- Account IDs already accepted into the group establish identity. No name
  -- matching or merging of teacher-created placeholder entries takes place.
  insert into public.teaching_entries(course_id,group_id,user_id,full_name)
  select p_course,p_group,p.id,left(coalesce(nullif(btrim(p.full_name),''),'Учасник'),180) from public.profiles p
  where public.xelay_teaching_is_member(p_group,p.id)
    and not exists(select 1 from public.teaching_entries e where e.course_id=p_course and e.group_id=p_group and e.user_id=p.id)
    and not exists(select 1 from public.teaching_roster_claims q join public.teaching_entries e on e.id=q.entry_id
      where q.user_id=p.id and q.status='pending' and e.course_id=p_course and e.group_id=p_group)
  on conflict(course_id,group_id,user_id) where user_id is not null do nothing;
end $$;

create or replace function public.xelay_teaching_sync_assignment_activity(p_item uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_record public.teaching_items%rowtype;v_course public.teaching_courses%rowtype;v_target record;v_date date; begin
  select * into v_record from public.teaching_items where id=p_item;
  if not found or v_record.kind<>'assignment' then return; end if;
  select * into v_course from public.teaching_courses where id=v_record.course_id;
  if v_record.max_points is null then
    if exists(select 1 from public.teaching_activities a join public.teaching_grades g on g.activity_id=a.id where a.item_id=p_item) then
      raise exception 'TEACHING_ASSESSMENT_HAS_GRADES'; end if;
    if v_record.status='published' then delete from public.teaching_activities where item_id=p_item; end if;
    return;
  end if;
  if exists(select 1 from public.teaching_activities a join public.teaching_grades g on g.activity_id=a.id
    where a.item_id=p_item and(g.draft_score>v_record.max_points or g.published_score>v_record.max_points)) then raise exception 'TEACHING_MAX_BELOW_SCORE'; end if;
  if v_record.status<>'published' then return; end if;
  -- A removed target never loses grade history. Unused columns are disposable.
  delete from public.teaching_activities a where a.item_id=p_item
    and not exists(select 1 from public.teaching_item_targets t where t.item_id=p_item and t.group_id=a.group_id)
    and not exists(select 1 from public.teaching_grades g where g.activity_id=a.id);
  for v_target in select t.* from public.teaching_item_targets t join public.teaching_course_groups l
    on l.group_id=t.group_id and l.course_id=v_record.course_id and l.status='accepted' where t.item_id=p_item loop
    v_date:=coalesce((v_target.due_at at time zone 'Europe/Kyiv')::date,v_record.material_date,
      greatest(v_course.starts_on,least(v_course.ends_on,(now() at time zone 'Europe/Kyiv')::date)));
    if v_date not between v_course.starts_on and v_course.ends_on then raise exception 'TEACHING_INVALID_INPUT'; end if;
    insert into public.teaching_activities(course_id,group_id,item_id,title,category,activity_date,max_points)
      values(v_record.course_id,v_target.group_id,p_item,left(v_record.title,180),v_record.category,v_date,v_record.max_points)
      on conflict(item_id,group_id) where item_id is not null do update set title=excluded.title,category=excluded.category,
        activity_date=excluded.activity_date,max_points=excluded.max_points,updated_at=now(),version=teaching_activities.version+1;
  end loop;
end $$;

create or replace function public.xelay_teaching_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_uid uuid:=public.xelay_teaching_assert_user();v_id uuid;v_course_id uuid;v_group_id uuid;v_user_id uuid;
  v_version integer;v_kind text;v_permission text;v_status text;v_subject uuid;v_item jsonb;v_value jsonb;v_target jsonb;v_score numeric;
  v_course public.teaching_courses%rowtype;v_link public.teaching_course_groups%rowtype;
  v_teacher public.teaching_course_teachers%rowtype;v_verification public.teacher_verification_requests%rowtype;
  v_entry public.teaching_entries%rowtype;v_claim public.teaching_roster_claims%rowtype;
  v_activity public.teaching_activities%rowtype;v_grade public.teaching_grades%rowtype;
  v_record public.teaching_items%rowtype;v_profile public.profiles%rowtype;v_group public.study_groups%rowtype;
  v_permissions text[];v_prior jsonb;v_rules jsonb;v_count integer;v_changed boolean;v_recipient record;
  v_comment text;v_reason text;v_max numeric;v_source public.teaching_items%rowtype;v_starts date;v_ends date;
  v_receipt public.teaching_create_receipts%rowtype;v_creation boolean;v_result jsonb;
begin
  if p_action is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>100000 then
    raise exception 'TEACHING_INVALID_INPUT'; end if;
  v_id:=nullif(p_payload->>'id','')::uuid;
  v_course_id:=nullif(p_payload->>'course_id','')::uuid;
  v_group_id:=nullif(p_payload->>'group_id','')::uuid;
  v_version:=nullif(p_payload->>'version','')::integer;
  v_creation:=p_action in('create_course','copy_course','invite_teacher_from_group') or(p_action in('save_assignment','save_material','save_entry','save_activity') and v_version=0);
  if v_creation and v_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-create:'||v_uid::text||':'||p_action||':'||v_id::text,0));
    select * into v_receipt from public.teaching_create_receipts where user_id=v_uid and action=p_action and request_id=v_id;
    if found then
      if v_receipt.payload is distinct from p_payload then raise exception 'TEACHING_CONFLICT'; end if;
      return v_receipt.result;
    end if;
  end if;

  if p_action='review_teacher' then
    if not public.xelay_is_platform_admin() then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    v_status:=p_payload->>'status';v_reason:=btrim(coalesce(p_payload->>'reason',''));
    if v_status not in('approved','rejected','revoked') or length(v_reason)>2000 then raise exception 'TEACHING_INVALID_INPUT'; end if;
    select * into v_verification from public.teacher_verification_requests where id=(p_payload->>'request_id')::uuid for update;
    if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
    if v_verification.user_id=v_uid then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    if v_status='approved' and not exists(select 1 from public.profiles p where p.id=v_verification.user_id
      and p.university_id=v_verification.university_id and p.academic_unit_id=v_verification.academic_unit_id) then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if v_verification.status=v_status then return jsonb_build_object('id',v_verification.id); end if;
    update public.teacher_verification_requests set status=v_status,review_reason=v_reason,reviewed_by=v_uid,reviewed_at=now(),updated_at=now()
      where id=v_verification.id;
    perform public.xelay_teaching_notify(v_verification.user_id,'teacher-review:'||v_verification.id::text||':'||now()::text,
      case v_status when 'approved' then 'Статус викладача підтверджено. Відкрийте розділ «Викладання».'
        when 'rejected' then 'Заявку на підтвердження викладача розглянуто. Перегляньте відповідь у профілі.'
        else 'Доступ до викладання призупинено. Зверніться до команди Xelay.' end);
    return jsonb_build_object('id',v_verification.id);
  end if;

  if p_action in('create_course','invite_teacher_from_group') then
    v_user_id:=case when p_action='create_course' then v_uid else (p_payload->>'teacher_id')::uuid end;
    if not public.xelay_teaching_is_verified(v_user_id) then raise exception 'TEACHER_VERIFICATION_REQUIRED'; end if;
    select * into v_verification from public.teacher_verification_requests where user_id=v_user_id;
    if p_action='invite_teacher_from_group' then
      select * into v_group from public.study_groups where id=v_group_id for update;
      if not found or v_group.representative_id<>v_uid or v_group.university_id<>v_verification.university_id then
        raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-owner:'||v_user_id::text,0));
    if (select count(*) from public.teaching_courses where owner_id=v_user_id and archived_at is null)>=100 then raise exception 'TEACHING_CAPACITY'; end if;
    v_rules:=coalesce(p_payload->'grading_rules','{"categories":[]}'::jsonb);
    if not public.xelay_teaching_validate_rules(v_rules) then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if p_action='invite_teacher_from_group' and exists(select 1 from public.teaching_course_groups l
      join public.teaching_courses c on c.id=l.course_id where l.group_id=v_group_id and c.owner_id=v_user_id
      and lower(btrim(c.title))=lower(btrim(p_payload->>'title')) and c.semester=btrim(p_payload->>'semester')
      and l.status in('pending_teacher','pending_group','accepted') and c.archived_at is null) then raise exception 'TEACHING_ALREADY_INVITED'; end if;
    insert into public.teaching_courses(id,owner_id,university_id,academic_unit_id,title,semester,starts_on,ends_on,grading_rules)
    values(coalesce(v_id,gen_random_uuid()),v_user_id,v_verification.university_id,v_verification.academic_unit_id,btrim(p_payload->>'title'),btrim(p_payload->>'semester'),
      (p_payload->>'starts_on')::date,(p_payload->>'ends_on')::date,v_rules) returning * into v_course;
    if p_action='invite_teacher_from_group' then
      v_subject:=nullif(p_payload->>'subject_id','')::uuid;
      if v_subject is null then select id into v_subject from public.study_group_seminar_subjects where group_id=v_group_id and lower(btrim(name))=lower(btrim(v_course.title)); end if;
      if v_subject is not null and not exists(select 1 from public.study_group_seminar_subjects where id=v_subject and group_id=v_group_id) then raise exception 'TEACHING_INVALID_INPUT'; end if;
      insert into public.teaching_course_groups(course_id,group_id,subject_id,status,invited_by)
        values(v_course.id,v_group_id,v_subject,'pending_teacher',v_uid) returning id into v_id;
      perform public.xelay_teaching_notify(v_user_id,'teaching-group-invite:'||v_id::text,
        'Група '||v_group.group_name||' запрошує викладати предмет «'||v_course.title||'».',v_course.id,v_group_id);
    end if;
    v_result:=jsonb_build_object('id',v_course.id,'version',1);
    if nullif(p_payload->>'id','') is not null then
      insert into public.teaching_create_receipts(user_id,action,request_id,payload,result) values(v_uid,p_action,(p_payload->>'id')::uuid,p_payload,v_result);
    end if;
    return v_result;
  end if;

  if p_action='copy_course' then
    select * into v_course from public.teaching_courses where id=v_course_id for update;
    if not found or not 'manage'=any(public.xelay_teaching_permissions(v_course_id,v_uid)) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-owner:'||v_uid::text,0));
    if (select count(*) from public.teaching_courses where owner_id=v_uid and archived_at is null)>=100 then raise exception 'TEACHING_CAPACITY'; end if;
    insert into public.teaching_courses(id,owner_id,university_id,academic_unit_id,title,semester,starts_on,ends_on,grading_rules)
      values(coalesce(v_id,gen_random_uuid()),v_uid,v_course.university_id,v_course.academic_unit_id,v_course.title,btrim(p_payload->>'semester'),
        (p_payload->>'starts_on')::date,(p_payload->>'ends_on')::date,v_course.grading_rules) returning id into v_id;
    -- Fresh semester has no accepted groups, roster, grades, claims, or student
    -- publication. Draft assignment/material templates retain immutable bytes.
    -- The teacher selects newly accepted target groups and deadlines separately.
    for v_source in select * from public.teaching_items where course_id=v_course_id loop
      insert into public.teaching_items(course_id,kind,title,body,links,attachments,material_date,max_points,category,status,created_by)
        values(v_id,v_source.kind,v_source.title,v_source.body,v_source.links,v_source.attachments,
          case when v_source.material_date is null then null else (p_payload->>'starts_on')::date+(v_source.material_date-v_course.starts_on) end,
          v_source.max_points,v_source.category,'draft',v_uid);
    end loop;
    v_result:=jsonb_build_object('id',v_id,'version',1);
    if nullif(p_payload->>'id','') is not null then
      insert into public.teaching_create_receipts(user_id,action,request_id,payload,result) values(v_uid,p_action,(p_payload->>'id')::uuid,p_payload,v_result);
    end if;
    return v_result;
  end if;

  if p_action='archive_course' then
    select * into v_course from public.teaching_courses where id=v_course_id for update;
    if not found or not 'manage'=any(public.xelay_teaching_permissions(v_course_id,v_uid)) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    if v_version is distinct from v_course.version then raise exception 'TEACHING_CONFLICT'; end if;
    update public.teaching_courses set archived_at=case when coalesce((p_payload->>'archived')::boolean,true) then now() else null end,
      version=version+1,updated_at=now() where id=v_course_id returning version into v_version;
    return jsonb_build_object('id',v_course_id,'version',v_version);
  end if;

  if p_action='update_course' then
    perform public.xelay_teaching_lock_course(v_course_id,'manage');
    select * into v_course from public.teaching_courses where id=v_course_id;
    if v_version is distinct from v_course.version then raise exception 'TEACHING_CONFLICT'; end if;
    v_rules:=coalesce(p_payload->'grading_rules',v_course.grading_rules);
    if not public.xelay_teaching_validate_rules(v_rules) then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if exists(select 1 from public.teaching_activities a where a.course_id=v_course_id and a.category<>''
      and not exists(select 1 from jsonb_array_elements(v_rules->'categories') k where k->>'id'=a.category))
      or exists(select 1 from public.teaching_items i where i.course_id=v_course_id and i.category<>''
        and not exists(select 1 from jsonb_array_elements(v_rules->'categories') k where k->>'id'=i.category)) then raise exception 'TEACHING_CATEGORY_IN_USE'; end if;
    v_starts:=(p_payload->>'starts_on')::date;v_ends:=(p_payload->>'ends_on')::date;
    if exists(select 1 from public.teaching_activities where course_id=v_course_id and activity_date not between v_starts and v_ends) then
      raise exception 'TEACHING_ACTIVITY_OUTSIDE_SEMESTER'; end if;
    update public.teaching_courses set title=btrim(p_payload->>'title'),semester=btrim(p_payload->>'semester'),
      starts_on=v_starts,ends_on=v_ends,grading_rules=v_rules,
      updated_at=now(),version=version+1 where id=v_course_id returning version into v_version;
    return jsonb_build_object('id',v_course_id,'version',v_version);
  end if;

  if p_action='invite_group' then
    perform public.xelay_teaching_lock_course(v_course_id,'manage');
    select * into v_course from public.teaching_courses where id=v_course_id;
    select * into v_group from public.study_groups where id=v_group_id for update;
    if not found or v_group.university_id<>v_course.university_id then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    v_subject:=nullif(p_payload->>'subject_id','')::uuid;
    if v_subject is null then select id into v_subject from public.study_group_seminar_subjects where group_id=v_group_id and lower(btrim(name))=lower(btrim(v_course.title)); end if;
    if v_subject is not null and not exists(select 1 from public.study_group_seminar_subjects where id=v_subject and group_id=v_group_id) then raise exception 'TEACHING_INVALID_INPUT'; end if;
    select * into v_link from public.teaching_course_groups where course_id=v_course_id and group_id=v_group_id for update;
    if found and v_link.status in('pending_teacher','pending_group','accepted') then raise exception 'TEACHING_ALREADY_INVITED'; end if;
    insert into public.teaching_course_groups(course_id,group_id,subject_id,status,invited_by)
      values(v_course_id,v_group_id,v_subject,'pending_group',v_uid)
      on conflict(course_id,group_id) do update set subject_id=excluded.subject_id,status='pending_group',invited_by=v_uid,accepted_at=null,updated_at=now()
      returning * into v_link;
    perform public.xelay_teaching_notify(v_group.representative_id,'teaching-group-invite:'||v_link.id::text||':'||v_link.updated_at::text,
      'Викладач запрошує групу до предмета «'||v_course.title||'».',v_course_id,v_group_id);
    return jsonb_build_object('id',v_link.id);
  end if;

  if p_action in('respond_group','remove_group') then
    if p_action='respond_group' and jsonb_typeof(p_payload->'accept') is distinct from 'boolean' then raise exception 'TEACHING_INVALID_INPUT'; end if;
    select * into v_link from public.teaching_course_groups where id=(p_payload->>'link_id')::uuid;
    if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
    select * into v_course from public.teaching_courses where id=v_link.course_id for update;
    select * into v_link from public.teaching_course_groups where id=v_link.id for update;
    select * into v_group from public.study_groups where id=v_link.group_id for update;
    if v_course.archived_at is not null then raise exception 'TEACHING_ARCHIVED'; end if;
    if p_action='respond_group' then
      if v_group.university_id is distinct from v_course.university_id
        or(v_link.status='pending_teacher' and(v_course.owner_id<>v_uid or not 'manage'=any(public.xelay_teaching_permissions(v_course.id,v_uid))))
        or (v_link.status='pending_group' and v_group.representative_id<>v_uid)
        or v_link.status not in('pending_teacher','pending_group') then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
      if not 'manage'=any(public.xelay_teaching_permissions(v_course.id,v_course.owner_id)) then raise exception 'TEACHER_VERIFICATION_REQUIRED'; end if;
      v_status:=case when (p_payload->>'accept')::boolean then 'accepted' else 'rejected' end;
    else
      if v_group.representative_id<>v_uid and not 'manage'=any(public.xelay_teaching_permissions(v_course.id,v_uid)) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
      v_status:='removed';
    end if;
    update public.teaching_course_groups set status=v_status,accepted_at=case when v_status='accepted' then now() else null end,updated_at=now() where id=v_link.id;
    if v_status='accepted' then perform public.xelay_teaching_sync_roster(v_course.id,v_link.group_id); end if;
    perform public.xelay_teaching_notify(case when v_uid=v_course.owner_id then v_group.representative_id else v_course.owner_id end,
      'teaching-group-response:'||v_link.id::text||':'||now()::text,'Статус підключення групи до предмета «'||v_course.title||'» оновлено.',v_course.id,v_link.group_id);
    return jsonb_build_object('id',v_link.id);
  end if;

  if p_action='invite_teacher' then
    perform public.xelay_teaching_lock_course(v_course_id,'manage');
    select * into v_course from public.teaching_courses where id=v_course_id;
    v_user_id:=(p_payload->>'user_id')::uuid;
    select * into v_verification from public.teacher_verification_requests where user_id=v_user_id and university_id=v_course.university_id;
    if not found or not public.xelay_teaching_is_verified(v_user_id) or v_user_id=v_course.owner_id then raise exception 'TEACHER_VERIFICATION_REQUIRED'; end if;
    if jsonb_typeof(p_payload->'permissions') is distinct from 'array' then raise exception 'TEACHING_INVALID_INPUT'; end if;
    select array_agg(distinct value) into v_permissions from jsonb_array_elements_text(p_payload->'permissions');
    if v_permissions is null or not v_permissions<@array['materials','assignments','grades']::text[] then raise exception 'TEACHING_INVALID_INPUT'; end if;
    select * into v_teacher from public.teaching_course_teachers where course_id=v_course_id and user_id=v_user_id for update;
    if found and v_teacher.status in('pending','accepted') then raise exception 'TEACHING_ALREADY_INVITED'; end if;
    insert into public.teaching_course_teachers(course_id,user_id,permissions,invited_by)
      values(v_course_id,v_user_id,v_permissions,v_uid) on conflict(course_id,user_id) do update set permissions=excluded.permissions,status='pending',invited_by=v_uid,updated_at=now()
      returning * into v_teacher;
    perform public.xelay_teaching_notify(v_user_id,'teaching-colleague-invite:'||v_teacher.id::text||':'||v_teacher.updated_at::text,
      'Вас запрошують до викладання предмета «'||v_course.title||'».',v_course_id);
    return jsonb_build_object('id',v_teacher.id);
  end if;

  if p_action in('respond_teacher','update_teacher') then
    if p_action='respond_teacher' and jsonb_typeof(p_payload->'accept') is distinct from 'boolean' then raise exception 'TEACHING_INVALID_INPUT'; end if;
    select * into v_teacher from public.teaching_course_teachers where id=(p_payload->>'teacher_link_id')::uuid;
    if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
    select * into v_course from public.teaching_courses where id=v_teacher.course_id for update;
    select * into v_teacher from public.teaching_course_teachers where id=v_teacher.id for update;
    if v_course.archived_at is not null then raise exception 'TEACHING_ARCHIVED'; end if;
    if p_action='respond_teacher' then
      if v_teacher.user_id<>v_uid or v_teacher.status<>'pending' or not public.xelay_teaching_is_verified(v_uid)
        or not exists(select 1 from public.teacher_verification_requests where user_id=v_uid and university_id=v_course.university_id)
        then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
      update public.teaching_course_teachers set status=case when(p_payload->>'accept')::boolean then 'accepted' else 'rejected' end,updated_at=now() where id=v_teacher.id;
    else
      if not 'manage'=any(public.xelay_teaching_permissions(v_course.id,v_uid)) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
      if p_payload ? 'permissions' then
        if jsonb_typeof(p_payload->'permissions')<>'array' then raise exception 'TEACHING_INVALID_INPUT'; end if;
        select array_agg(distinct value) into v_permissions from jsonb_array_elements_text(p_payload->'permissions');
      else v_permissions:=v_teacher.permissions; end if;
      if v_permissions is null or not v_permissions<@array['materials','assignments','grades']::text[] then raise exception 'TEACHING_INVALID_INPUT'; end if;
      if p_payload ? 'status' and p_payload->>'status'<>'removed' then raise exception 'TEACHING_INVALID_INPUT'; end if;
      update public.teaching_course_teachers set permissions=v_permissions,status=case when p_payload->>'status'='removed' then 'removed' else status end,updated_at=now() where id=v_teacher.id;
    end if;
    return jsonb_build_object('id',v_teacher.id);
  end if;

  if p_action in('save_assignment','save_material') then
    v_kind:=case p_action when 'save_assignment' then 'assignment' else 'material' end;
    v_permission:=case v_kind when 'assignment' then 'assignments' else 'materials' end;
    perform public.xelay_teaching_lock_course(v_course_id,v_permission);
    v_prior:='[]'::jsonb;
    if v_id is not null and coalesce(v_version,-1)<>0 then
      select * into v_record from public.teaching_items where id=v_id and course_id=v_course_id and kind=v_kind for update;
      if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
      if v_version is distinct from v_record.version then raise exception 'TEACHING_CONFLICT'; end if;
      v_prior:=v_record.attachments;
    end if;
    select * into v_course from public.teaching_courses where id=v_course_id;
    if p_payload ? 'max_points' and p_payload->'max_points'<>'null'::jsonb
      and jsonb_typeof(p_payload->'max_points') is distinct from 'number' then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if p_payload ? 'category' and jsonb_typeof(p_payload->'category') is distinct from 'string' then raise exception 'TEACHING_INVALID_INPUT'; end if;
    v_max:=case when p_payload ? 'max_points' then nullif(p_payload->>'max_points','')::numeric else v_record.max_points end;
    v_status:=case when p_payload ? 'category' then coalesce(p_payload->>'category','') else coalesce(v_record.category,'') end;
    if v_kind='material' and(v_max is not null or v_status<>'') then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if (v_max is not null and(v_max<=0 or v_max>10000 or scale(v_max)>2))
      or length(v_status)>100 then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if v_max is null then v_status:=''; end if;
    if v_status<>'' and not exists(select 1 from jsonb_array_elements(v_course.grading_rules->'categories') k where k->>'id'=v_status) then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if(v_max is distinct from v_record.max_points or v_status is distinct from coalesce(v_record.category,''))
      and not 'grades'=any(public.xelay_teaching_permissions(v_course_id,v_uid)) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    -- Keep the grading category separate from the publication status variable.
    v_comment:=v_status;
    v_status:=coalesce(p_payload->>'status','draft');
    if v_status not in('draft','published') or jsonb_typeof(p_payload->'targets') is distinct from 'array'
      or jsonb_array_length(p_payload->'targets')>100
      or(v_status='published' and jsonb_array_length(p_payload->'targets')=0) then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if (select count(*) from jsonb_array_elements(p_payload->'targets'))<>(select count(distinct value->>'group_id') from jsonb_array_elements(p_payload->'targets')) then raise exception 'TEACHING_INVALID_INPUT'; end if;
    for v_target in select value from jsonb_array_elements(p_payload->'targets') loop
      if jsonb_typeof(v_target)<>'object' or not exists(select 1 from public.teaching_course_groups l where l.course_id=v_course_id
        and l.group_id=(v_target->>'group_id')::uuid and l.status='accepted') then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    end loop;
    perform public.xelay_teaching_validate_resources(v_course_id,coalesce(p_payload->'links','[]'::jsonb),coalesce(p_payload->'attachments','[]'::jsonb),v_prior);
    if v_id is null or v_version=0 then
      insert into public.teaching_items(id,course_id,kind,title,body,links,attachments,material_date,max_points,category,status,published_at,created_by)
      values(coalesce(v_id,gen_random_uuid()),v_course_id,v_kind,btrim(p_payload->>'title'),coalesce(p_payload->>'body',''),coalesce(p_payload->'links','[]'::jsonb),
        coalesce(p_payload->'attachments','[]'::jsonb),nullif(p_payload->>'material_date','')::date,v_max,v_comment,v_status,
        case when v_status='published' then now() else null end,v_uid) returning * into v_record;
    else
      update public.teaching_items set title=btrim(p_payload->>'title'),body=coalesce(p_payload->>'body',''),links=coalesce(p_payload->'links','[]'::jsonb),
        attachments=coalesce(p_payload->'attachments','[]'::jsonb),material_date=nullif(p_payload->>'material_date','')::date,max_points=v_max,category=v_comment,status=v_status,
        published_at=case when v_status='published' then coalesce(published_at,now()) else published_at end,version=version+1,updated_at=now()
        where id=v_id returning * into v_record;
    end if;
    delete from public.teaching_item_targets where item_id=v_record.id;
    insert into public.teaching_item_targets(item_id,group_id,due_at)
      select v_record.id,(value->>'group_id')::uuid,nullif(value->>'due_at','')::timestamptz from jsonb_array_elements(p_payload->'targets');
    if v_kind='assignment' then perform public.xelay_teaching_sync_assignment_activity(v_record.id); end if;
    if v_status='published' then
      select * into v_course from public.teaching_courses where id=v_course_id;
      for v_recipient in select distinct p.id from public.profiles p join public.teaching_item_targets t on public.xelay_teaching_is_member(t.group_id,p.id)
        where t.item_id=v_record.id order by p.id loop
        perform public.xelay_teaching_notify(v_recipient.id,'teaching-item:'||v_record.id::text||':'||v_record.version::text,
          case when v_kind='assignment' then 'Нове або оновлене завдання' else 'Нові або оновлені матеріали' end||' з предмета «'||v_course.title||'».',v_course_id);
      end loop;
    end if;
    v_result:=jsonb_build_object('id',v_record.id,'version',v_record.version);
    if v_version=0 and nullif(p_payload->>'id','') is not null then
      insert into public.teaching_create_receipts(user_id,action,request_id,payload,result) values(v_uid,p_action,(p_payload->>'id')::uuid,p_payload,v_result);
    end if;
    return v_result;
  end if;

  if p_action in('delete_assignment','delete_material') then
    select * into v_record from public.teaching_items where id=v_id;
    if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
    v_kind:=case p_action when 'delete_assignment' then 'assignment' else 'material' end;
    if v_record.kind<>v_kind then raise exception 'TEACHING_INVALID_INPUT'; end if;
    perform public.xelay_teaching_lock_course(v_record.course_id,case v_kind when 'assignment' then 'assignments' else 'materials' end);
    select * into v_record from public.teaching_items where id=v_id for update;
    if v_version is distinct from v_record.version then raise exception 'TEACHING_CONFLICT'; end if;
    for v_value in select value from jsonb_array_elements(v_record.attachments) order by value->>'storage_path' loop
      perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-file:'||(v_value->>'storage_path'),0));
    end loop;
    if v_kind='assignment' then
      delete from public.teaching_activities a where a.item_id=v_id
        and not exists(select 1 from public.teaching_grades g where g.activity_id=a.id);
    end if;
    delete from public.teaching_items where id=v_id;
    return jsonb_build_object('id',v_id);
  end if;

  if p_action='sync_roster' then
    perform public.xelay_teaching_lock_course(v_course_id,'grades');
    perform public.xelay_teaching_sync_roster(v_course_id,v_group_id);
    return jsonb_build_object('id',v_course_id);
  end if;

  if p_action='save_entry' then
    perform public.xelay_teaching_lock_course(v_course_id,'grades');
    if not exists(select 1 from public.teaching_course_groups where course_id=v_course_id and group_id=v_group_id and status='accepted') then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    if v_id is null or v_version=0 then
      if(select count(*) from public.teaching_entries where course_id=v_course_id and group_id=v_group_id)>=500 then raise exception 'TEACHING_CAPACITY'; end if;
      insert into public.teaching_entries(id,course_id,group_id,full_name) values(coalesce(v_id,gen_random_uuid()),v_course_id,v_group_id,btrim(p_payload->>'full_name')) returning * into v_entry;
    else
      select * into v_entry from public.teaching_entries where id=v_id and course_id=v_course_id and group_id=v_group_id for update;
      if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
      if v_version is distinct from v_entry.version then raise exception 'TEACHING_CONFLICT'; end if;
      update public.teaching_entries set full_name=btrim(p_payload->>'full_name'),active=coalesce((p_payload->>'active')::boolean,active),version=version+1,updated_at=now()
        where id=v_id returning * into v_entry;
    end if;
    v_result:=jsonb_build_object('id',v_entry.id,'version',v_entry.version);
    if v_version=0 and nullif(p_payload->>'id','') is not null then
      insert into public.teaching_create_receipts(user_id,action,request_id,payload,result) values(v_uid,p_action,(p_payload->>'id')::uuid,p_payload,v_result);
    end if;
    return v_result;
  end if;

  if p_action='request_roster_link' then
    select * into v_entry from public.teaching_entries where id=(p_payload->>'entry_id')::uuid;
    if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
    perform public.xelay_teaching_lock_course(v_entry.course_id,'grades');
    select * into v_entry from public.teaching_entries where id=v_entry.id for update;
    v_user_id:=(p_payload->>'user_id')::uuid;
    if v_entry.user_id is not null or not public.xelay_teaching_is_member(v_entry.group_id,v_user_id)
      or not exists(select 1 from public.teaching_course_groups where course_id=v_entry.course_id and group_id=v_entry.group_id and status='accepted') then
      raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    if exists(select 1 from public.teaching_entries e where e.course_id=v_entry.course_id and e.group_id=v_entry.group_id and e.user_id=v_user_id
      and exists(select 1 from public.teaching_grades s where s.entry_id=e.id)) then raise exception 'TEACHING_ACCOUNT_ALREADY_LINKED'; end if;
    if exists(select 1 from public.teaching_roster_claims where entry_id=v_entry.id and status='pending') then raise exception 'TEACHING_ALREADY_INVITED'; end if;
    insert into public.teaching_roster_claims(entry_id,user_id,proposed_by) values(v_entry.id,v_user_id,v_uid) returning id into v_id;
    perform public.xelay_teaching_notify(v_user_id,'teaching-roster-claim:'||v_id::text,
      'Викладач пропонує пов’язати ваш обліковий запис із записом у журналі. Перевірте ім’я та підтвердьте.',v_entry.course_id,v_entry.group_id);
    return jsonb_build_object('id',v_id);
  end if;

  if p_action='respond_roster_link' then
    if jsonb_typeof(p_payload->'accept') is distinct from 'boolean' then raise exception 'TEACHING_INVALID_INPUT'; end if;
    select * into v_claim from public.teaching_roster_claims where id=(p_payload->>'claim_id')::uuid;
    if not found or v_claim.user_id<>v_uid then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    select * into v_entry from public.teaching_entries where id=v_claim.entry_id;
    perform 1 from public.teaching_courses where id=v_entry.course_id for update;
    select * into v_entry from public.teaching_entries where id=v_claim.entry_id for update;
    select * into v_claim from public.teaching_roster_claims where id=v_claim.id for update;
    if v_claim.status<>'pending' or v_entry.user_id is not null or not public.xelay_teaching_is_member(v_entry.group_id,v_uid)
      or not exists(select 1 from public.teaching_course_groups where course_id=v_entry.course_id and group_id=v_entry.group_id and status='accepted') then
      raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    if (p_payload->>'accept')::boolean then
      if exists(select 1 from public.teaching_entries e where e.course_id=v_entry.course_id and e.group_id=v_entry.group_id and e.user_id=v_uid
        and exists(select 1 from public.teaching_grades s where s.entry_id=e.id)) then raise exception 'TEACHING_ACCOUNT_ALREADY_LINKED'; end if;
      -- An automatically created empty account row can be replaced only after
      -- that account confirms the placeholder identity. Graded rows never merge.
      delete from public.teaching_entries e where e.course_id=v_entry.course_id and e.group_id=v_entry.group_id and e.user_id=v_uid
        and not exists(select 1 from public.teaching_grades s where s.entry_id=e.id);
      update public.teaching_entries set user_id=v_uid,version=version+1,updated_at=now() where id=v_entry.id;
      update public.teaching_roster_claims set status='accepted',responded_at=now() where id=v_claim.id;
    else update public.teaching_roster_claims set status='rejected',responded_at=now() where id=v_claim.id; end if;
    return jsonb_build_object('id',v_claim.id);
  end if;

  if p_action='save_activity' then
    perform public.xelay_teaching_lock_course(v_course_id,'grades');
    if not exists(select 1 from public.teaching_course_groups where course_id=v_course_id and group_id=v_group_id and status='accepted') then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    select * into v_course from public.teaching_courses where id=v_course_id;
    v_max:=(p_payload->>'max_points')::numeric;
    if v_max is null or v_max<=0 or v_max>10000 or scale(v_max)>2 then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if coalesce(p_payload->>'category','')<>'' and not exists(select 1 from jsonb_array_elements(v_course.grading_rules->'categories') k
      where k->>'id'=p_payload->>'category') then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if nullif(p_payload->>'seminar_id','') is not null and not exists(select 1 from public.study_group_seminars s
      join public.teaching_course_groups g on g.group_id=s.group_id and g.subject_id=s.subject_id and g.course_id=v_course_id and g.status='accepted'
      where s.id=(p_payload->>'seminar_id')::uuid and s.group_id=v_group_id and s.lesson_date between v_course.starts_on and v_course.ends_on) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    if (p_payload->>'activity_date')::date not between v_course.starts_on and v_course.ends_on then raise exception 'TEACHING_INVALID_INPUT'; end if;
    if v_id is null or v_version=0 then
      insert into public.teaching_activities(id,course_id,group_id,title,category,activity_date,max_points,seminar_id)
      values(coalesce(v_id,gen_random_uuid()),v_course_id,v_group_id,btrim(p_payload->>'title'),coalesce(p_payload->>'category',''),(p_payload->>'activity_date')::date,v_max,nullif(p_payload->>'seminar_id','')::uuid)
      returning * into v_activity;
    else
      select * into v_activity from public.teaching_activities where id=v_id and course_id=v_course_id and group_id=v_group_id for update;
      if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
      if v_activity.item_id is not null then raise exception 'TEACHING_ASSIGNMENT_ACTIVITY_IMMUTABLE'; end if;
      if v_version is distinct from v_activity.version then raise exception 'TEACHING_CONFLICT'; end if;
      if exists(select 1 from public.teaching_grades where activity_id=v_id and (draft_score>v_max or published_score>v_max)) then raise exception 'TEACHING_MAX_BELOW_SCORE'; end if;
      update public.teaching_activities set title=btrim(p_payload->>'title'),category=coalesce(p_payload->>'category',''),activity_date=(p_payload->>'activity_date')::date,
        max_points=v_max,seminar_id=nullif(p_payload->>'seminar_id','')::uuid,version=version+1,updated_at=now() where id=v_id returning * into v_activity;
    end if;
    v_result:=jsonb_build_object('id',v_activity.id,'version',v_activity.version);
    if v_version=0 and nullif(p_payload->>'id','') is not null then
      insert into public.teaching_create_receipts(user_id,action,request_id,payload,result) values(v_uid,p_action,(p_payload->>'id')::uuid,p_payload,v_result);
    end if;
    return v_result;
  end if;

  if p_action='save_grade' then
    select * into v_activity from public.teaching_activities where id=(p_payload->>'activity_id')::uuid;
    if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
    perform public.xelay_teaching_lock_course(v_activity.course_id,'grades');
    select * into v_activity from public.teaching_activities where id=v_activity.id for update;
    select * into v_entry from public.teaching_entries where id=(p_payload->>'entry_id')::uuid and course_id=v_activity.course_id and group_id=v_activity.group_id for update;
    if not found or not v_entry.active or not exists(select 1 from public.teaching_course_groups where course_id=v_activity.course_id
      and group_id=v_activity.group_id and status='accepted') then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    if not(p_payload ? 'score') or(p_payload->'score'<>'null'::jsonb and jsonb_typeof(p_payload->'score')<>'number') then raise exception 'TEACHING_INVALID_INPUT'; end if;
    v_score:=nullif(p_payload->>'score','')::numeric;v_comment:=coalesce(p_payload->>'comment','');v_reason:=btrim(coalesce(p_payload->>'reason',''));
    if(v_score is not null and(v_score<0 or v_score>v_activity.max_points or scale(v_score)>2)) or length(v_comment)>3000 or length(v_reason)>2000 then raise exception 'TEACHING_INVALID_INPUT'; end if;
    select * into v_grade from public.teaching_grades where activity_id=v_activity.id and entry_id=v_entry.id for update;
    if found then
      if v_version is distinct from v_grade.version then raise exception 'TEACHING_CONFLICT'; end if;
      if v_grade.published_at is not null and (v_score is distinct from v_grade.published_score or v_comment is distinct from v_grade.published_comment)
        and length(v_reason)<2 then raise exception 'TEACHING_REVISION_REASON_REQUIRED'; end if;
      if v_score is not distinct from v_grade.draft_score and v_comment is not distinct from v_grade.draft_comment then return jsonb_build_object('id',v_grade.id,'version',v_grade.version); end if;
    elsif v_version is distinct from 0 then raise exception 'TEACHING_CONFLICT'; end if;
    insert into public.teaching_grade_audit(course_id,activity_id,entry_id,actor_id,old_score,new_score,old_comment,new_comment,reason,event)
      values(v_activity.course_id,v_activity.id,v_entry.id,v_uid,v_grade.draft_score,v_score,coalesce(v_grade.draft_comment,''),v_comment,v_reason,'draft');
    insert into public.teaching_grades(course_id,group_id,activity_id,entry_id,draft_score,draft_comment,updated_by)
      values(v_activity.course_id,v_activity.group_id,v_activity.id,v_entry.id,v_score,v_comment,v_uid)
      on conflict(activity_id,entry_id) do update set draft_score=excluded.draft_score,draft_comment=excluded.draft_comment,updated_by=v_uid,updated_at=now(),version=teaching_grades.version+1
      returning * into v_grade;
    return jsonb_build_object('id',v_grade.id,'version',v_grade.version);
  end if;

  if p_action='publish_grades' then
    select * into v_activity from public.teaching_activities where id=(p_payload->>'activity_id')::uuid;
    if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
    perform public.xelay_teaching_lock_course(v_activity.course_id,'grades');
    select * into v_activity from public.teaching_activities where id=v_activity.id for update;
    if not exists(select 1 from public.teaching_course_groups where course_id=v_activity.course_id and group_id=v_activity.group_id and status='accepted') then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
    if jsonb_typeof(p_payload->'expected_versions') is distinct from 'array' or jsonb_array_length(p_payload->'expected_versions') not between 1 and 500
      or (select count(*) from jsonb_array_elements(p_payload->'expected_versions'))<>(select count(distinct value->>'entry_id') from jsonb_array_elements(p_payload->'expected_versions')) then raise exception 'TEACHING_INVALID_INPUT'; end if;
    for v_value in select value from jsonb_array_elements(p_payload->'expected_versions') order by value->>'entry_id' loop
      select * into v_grade from public.teaching_grades where activity_id=v_activity.id and entry_id=(v_value->>'entry_id')::uuid for update;
      if not found or v_grade.version is distinct from(v_value->>'version')::integer then raise exception 'TEACHING_CONFLICT'; end if;
      v_changed:=v_grade.published_at is null or v_grade.draft_score is distinct from v_grade.published_score or v_grade.draft_comment is distinct from v_grade.published_comment;
      if not v_changed then continue; end if;
      insert into public.teaching_grade_audit(course_id,activity_id,entry_id,actor_id,old_score,new_score,old_comment,new_comment,event)
        values(v_grade.course_id,v_grade.activity_id,v_grade.entry_id,v_uid,v_grade.published_score,v_grade.draft_score,v_grade.published_comment,v_grade.draft_comment,'publication');
      update public.teaching_grades set published_score=draft_score,published_comment=draft_comment,published_at=now(),updated_at=now(),updated_by=v_uid,version=version+1
        where id=v_grade.id returning * into v_grade;
      select * into v_entry from public.teaching_entries where id=v_grade.entry_id;
      if v_entry.user_id is not null and public.xelay_teaching_is_member(v_entry.group_id,v_entry.user_id) then
        perform public.xelay_teaching_notify(v_entry.user_id,'teaching-grade:'||v_grade.id::text||':'||v_grade.version::text,
          'Викладач опублікував або оновив ваші бали. Перегляньте розділ «Мої бали».',v_grade.course_id,v_grade.group_id);
      end if;
    end loop;
    return jsonb_build_object('id',v_activity.id);
  end if;

  raise exception 'TEACHING_INVALID_ACTION';
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation or datetime_field_overflow then
  raise exception 'TEACHING_INVALID_INPUT' using errcode='22023';
end $$;


create or replace function public.xelay_teaching_course(p_course_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_permissions text[];v_staff boolean;v_grader boolean;v_course public.teaching_courses%rowtype;
begin
  if not public.xelay_teaching_can_read_course(p_course_id,v_uid) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  select * into v_course from public.teaching_courses where id=p_course_id;
  v_permissions:=public.xelay_teaching_permissions(p_course_id,v_uid);v_staff:=cardinality(v_permissions)>0;v_grader:='grades'=any(v_permissions);
  return jsonb_build_object('course',to_jsonb(v_course)||jsonb_build_object('permissions',v_permissions),
    'teachers',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('full_name',p.full_name)) from public.teaching_course_teachers t
      join public.profiles p on p.id=t.user_id where t.course_id=p_course_id and (v_staff or t.status='accepted')),'[]'::jsonb),
    'groups',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('group_name',g.group_name,'specialty',g.specialty,'representative_id',g.representative_id))
      from public.teaching_course_groups l join public.study_groups g on g.id=l.group_id where l.course_id=p_course_id
        and (v_staff or(l.status='accepted' and public.xelay_teaching_is_member(l.group_id,v_uid)))),'[]'::jsonb),
    'entries',coalesce((select jsonb_agg(to_jsonb(e) order by e.full_name) from public.teaching_entries e where e.course_id=p_course_id
      and (v_grader or(e.user_id=v_uid and exists(select 1 from public.teaching_course_groups l where l.course_id=e.course_id and l.group_id=e.group_id and l.status='accepted')
        and public.xelay_teaching_is_member(e.group_id,v_uid)))),'[]'::jsonb),
    'activities',coalesce((select jsonb_agg(to_jsonb(a) order by a.activity_date,a.title) from public.teaching_activities a where a.course_id=p_course_id
      and (v_grader or exists(select 1 from public.teaching_course_groups l where l.course_id=a.course_id and l.group_id=a.group_id
        and l.status='accepted' and public.xelay_teaching_is_member(a.group_id,v_uid)))),'[]'::jsonb),
    'grades',coalesce((select jsonb_agg(case when v_grader then to_jsonb(s) else jsonb_build_object('id',s.id,'course_id',s.course_id,'group_id',s.group_id,
      'activity_id',s.activity_id,'entry_id',s.entry_id,'published_score',s.published_score,'published_comment',s.published_comment,'published_at',s.published_at,'version',s.version) end)
      from public.teaching_grades s join public.teaching_entries e on e.id=s.entry_id where s.course_id=p_course_id and (v_grader
        or(s.published_at is not null and e.user_id=v_uid and public.xelay_teaching_is_member(e.group_id,v_uid)
          and exists(select 1 from public.teaching_course_groups l where l.course_id=e.course_id and l.group_id=e.group_id and l.status='accepted')))),'[]'::jsonb),
    'audit',case when v_grader then coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('actor_name',p.full_name) order by a.created_at desc)
      from public.teaching_grade_audit a join public.profiles p on p.id=a.actor_id where a.course_id=p_course_id),'[]'::jsonb) else '[]'::jsonb end,
    'assignments',coalesce((select jsonb_agg(public.xelay_teaching_item_json(i) order by i.created_at desc) from public.teaching_items i
      where i.course_id=p_course_id and i.kind='assignment' and public.xelay_teaching_can_read_item(i.id,v_uid)),'[]'::jsonb),
    'materials',coalesce((select jsonb_agg(public.xelay_teaching_item_json(i) order by i.material_date desc nulls last,i.created_at desc) from public.teaching_items i
      where i.course_id=p_course_id and i.kind='material' and public.xelay_teaching_can_read_item(i.id,v_uid)),'[]'::jsonb),
    'roster_claims',coalesce((select jsonb_agg(to_jsonb(q)||jsonb_build_object('full_name',p.full_name)) from public.teaching_roster_claims q
      join public.teaching_entries e on e.id=q.entry_id join public.profiles p on p.id=q.user_id where e.course_id=p_course_id and (v_grader or q.user_id=v_uid)),'[]'::jsonb),
    'members',case when v_grader then coalesce((select jsonb_agg(jsonb_build_object('group_id',g.group_id,'user_id',p.id,'full_name',p.full_name,'username',p.username))
      from public.teaching_course_groups g join public.profiles p on public.xelay_teaching_is_member(g.group_id,p.id)
      where g.course_id=p_course_id and g.status='accepted'),'[]'::jsonb) else '[]'::jsonb end,
    'seminars',case when v_staff then public.xelay_teaching_seminars(p_course_id) else '{}'::jsonb end);
end $$;



-- Preserve student registration, username fallback, and metadata whitelist.
create or replace function public.xelay_create_registration_profile()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_university uuid;
  v_unit uuid;
  v_specialty uuid;
  v_faculty text;
  v_program_name text;
  v_categories text[];
  v_name text;
  v_username text;
  v_teacher boolean := v_meta->>'account_type' = 'teacher';
  v_attempt integer;
  v_constraint text;
  v_error_schema text;
  v_error_table text;
begin
  -- Ignore imports and legacy accounts; this trigger only handles our signup form.
  if v_meta->>'xelay_registration_version' is distinct from '1' then return new; end if;
  v_name := btrim(coalesce(v_meta->>'full_name', ''));
  v_username := nullif(lower(regexp_replace(btrim(coalesce(v_meta->>'username', '')), '^@', '')), '');
  if length(v_name) not between 1 and 120
    or length(btrim(coalesce(v_meta->>'country', ''))) not between 1 and 80
    or length(coalesce(v_meta->>'city', '')) > 120
    or length(coalesce(v_meta->>'bio', '')) > 2000
    or (not coalesce(v_teacher,false) and coalesce(v_meta->>'experience', '') not in (
      'bachelor', 'master', 'postgraduate', 'graduate',
      'Student / Fresh Graduate', '1–3 years', '3–7 years', '7–15 years', '15+ years'
    ))
    or (v_username is not null and v_username !~ '^[[:alnum:]][[:alnum:]_.-]{2,29}$')
  then raise exception 'Invalid registration profile'; end if;

  v_university := nullif(v_meta->>'university_id', '')::uuid;
  v_unit := nullif(v_meta->>'academic_unit_id', '')::uuid;
  if coalesce(v_teacher,false) then
    if length(btrim(coalesce(v_meta->>'teacher_department',''))) not between 2 and 180
      or length(coalesce(v_meta->>'teacher_position',''))>180 then raise exception 'TEACHING_INVALID_INPUT'; end if;
    v_specialty:=null;v_program_name:='';
    select unit.name into v_faculty from public.academic_units unit
      join public.universities university on university.id=unit.university_id
      where unit.id=v_unit and unit.university_id=v_university and unit.is_active and university.is_active;
    if not found then raise exception 'ACADEMIC_SPECIALTY_INVALID' using errcode='23514'; end if;
  else
  v_specialty := nullif(v_meta->>'specialty_id', '')::uuid;
  if v_specialty is null then
    raise exception 'ACADEMIC_SPECIALTY_REQUIRED' using errcode = '23514';
  end if;
  select specialty.name, unit.name into v_program_name, v_faculty
    from public.academic_specialties specialty
    join public.academic_units unit
      on unit.id = specialty.academic_unit_id and unit.university_id = specialty.university_id
    join public.universities university on university.id = specialty.university_id
    where specialty.id = v_specialty
      and specialty.academic_unit_id = v_unit and specialty.university_id = v_university
      and specialty.is_active and unit.is_active and university.is_active;
  if not found then
    raise exception 'ACADEMIC_SPECIALTY_INVALID' using errcode = '23514';
  end if;
  end if;
  if coalesce(v_teacher,false) and v_meta->'categories' is null then v_meta:=v_meta||jsonb_build_object('categories','[]'::jsonb); end if;
  if jsonb_typeof(v_meta->'categories') is distinct from 'array' then
    raise exception 'Invalid registration categories';
  end if;
  if jsonb_array_length(v_meta->'categories') not between (case when coalesce(v_teacher,false) then 0 else 1 end) and 20 then
    raise exception 'Invalid registration categories';
  end if;
  if exists (select 1 from jsonb_array_elements(v_meta->'categories') category
    where jsonb_typeof(category) <> 'string' or length(category #>> '{}') not between 1 and 100)
  then raise exception 'Invalid registration categories'; end if;
  select coalesce(array_agg(value),'{}'::text[]) into v_categories from jsonb_array_elements_text(v_meta->'categories');

  for v_attempt in 1..2 loop
    begin
      insert into public.profiles (
        id, full_name, username, email, country, city, bio, experience, categories,
        university_id, academic_unit_id, specialty_id, specialty, faculty, avatar_url, created_at, account_type
      ) values (
        new.id, v_name, v_username, new.email, btrim(v_meta->>'country'),
        btrim(coalesce(v_meta->>'city', '')), btrim(coalesce(v_meta->>'bio', '')),
        case when coalesce(v_teacher,false) then '' else v_meta->>'experience' end, v_categories, v_university, v_unit, v_specialty, v_program_name,
        v_faculty, '', new.created_at, case when coalesce(v_teacher,false) then 'teacher' else 'student' end
      ) on conflict (id) do update set
        full_name = excluded.full_name, username = excluded.username, email = excluded.email,
        country = excluded.country, city = excluded.city, bio = excluded.bio,
        experience = excluded.experience, categories = excluded.categories,
        university_id = excluded.university_id, academic_unit_id = excluded.academic_unit_id,
        specialty_id = excluded.specialty_id, specialty = excluded.specialty,
        faculty = excluded.faculty, account_type = excluded.account_type;
      exit;
    exception when unique_violation then
      get stacked diagnostics
        v_constraint = constraint_name,
        v_error_schema = schema_name,
        v_error_table = table_name;
      if v_attempt <> 1 or v_username is null
        or v_constraint is distinct from 'profiles_username_lower_unique'
        or v_error_schema is distinct from 'public'
        or v_error_table is distinct from 'profiles'
      then
        raise;
      end if;
      -- The failed insert is rolled back by this exception block. Retry once with
      -- NULL so prepare_profile_username generates the canonical stored handle.
      v_username := null;
    end;
  end loop;
  return new;
end;
$$;

-- Teaching events use the existing preference-aware email outbox. Messages
-- contain only availability notices: no score, private feedback, or attachment.
create or replace function public.xelay_queue_teaching_email()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_preferences public.notification_preferences%rowtype; begin
  if new.type is distinct from 'teaching_update' or new.teaching_event_key is null
    or new.recipient_id::text=coalesce(new.actor_id::text,'') or coalesce(new.is_read,false) then return new; end if;
  if not exists(select 1 from auth.users u where u.id::text=new.recipient_id::text
    and u.email_confirmed_at is not null and nullif(u.email,'') is not null and u.deleted_at is null) then return new; end if;
  select * into v_preferences from public.notification_preferences where user_id::text=new.recipient_id::text;
  if not coalesce(v_preferences.notifications_enabled,true) or not coalesce(v_preferences.email_notifications_enabled,true) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-email-'||new.recipient_id::text,0));
  if (select count(*) from public.notification_email_outbox q where q.recipient_id::text=new.recipient_id::text and q.created_at>now()-interval '1 hour')>=30 then return new; end if;
  insert into public.notification_email_outbox(notification_id,recipient_id,actor_id,notification_type,event_key,available_at)
  values(new.id::text,new.recipient_id::uuid,new.actor_id::uuid,'teaching_update','notification:'||new.id::text,now()) on conflict do nothing;
  return new;
end $$;
drop trigger if exists xelay_teaching_email_queue on public.notifications;
create trigger xelay_teaching_email_queue after insert on public.notifications for each row execute function public.xelay_queue_teaching_email();

-- Revoke the default PUBLIC execute privilege from every internal function,
-- including the registration trigger functions replaced above. Browser callers
-- receive only the explicit RPC facade and boolean Storage policy predicates.
do $$ declare v_function record; begin
  for v_function in select p.oid::regprocedure as signature from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and (p.proname like 'xelay_teaching_%' or p.proname in('xelay_teacher_status','xelay_teacher_request',
        'xelay_verified_teacher_public','xelay_queue_teaching_email','xelay_create_registration_profile','xelay_validate_profile_academic_specialty')) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_function.signature);
  end loop;
end $$;
grant execute on function public.xelay_teacher_status() to authenticated;
grant execute on function public.xelay_teacher_request(text,text,text) to authenticated;
grant execute on function public.xelay_verified_teacher_public(uuid) to anon,authenticated;
grant execute on function public.xelay_teaching_workspace() to authenticated;
grant execute on function public.xelay_teaching_course(uuid) to authenticated;
grant execute on function public.xelay_teaching_group(uuid) to authenticated;
grant execute on function public.xelay_teaching_mutate(text,jsonb) to authenticated;
grant execute on function public.xelay_teaching_can_upload_file(text) to authenticated;
grant execute on function public.xelay_teaching_can_read_file(text) to authenticated;
grant execute on function public.xelay_teaching_can_remove_file(text) to authenticated;
grant execute on function public.xelay_teaching_file_allowed(text,text) to authenticated;
notify pgrst,'reload schema';
commit;
