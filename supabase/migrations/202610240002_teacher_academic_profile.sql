-- Prepared for local review only. No production migration is implied.
-- Contact values never enter profiles, public auth metadata or broad selects.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $prerequisites$
begin
  if to_regprocedure('public.xelay_teaching_mutate(text,jsonb)') is null
    or to_regprocedure('public.xelay_teaching_lock_course(uuid,text)') is null
    or to_regprocedure('public.xelay_publish_due_teaching_items()') is null
    or to_regclass('public.teacher_academic_profiles') is not null then
    raise exception 'TEACHER_ACADEMIC_PROFILE_PREREQUISITE_OR_SCHEMA_DRIFT';
  end if;
end $prerequisites$;

create table public.teacher_academic_profiles(
  user_id uuid primary key references public.profiles(id) on delete cascade,
  position_code text not null default '' check(position_code in('','assistant','lecturer','senior_lecturer','associate_professor','professor','other')),
  position_other text not null default '' check(length(position_other)<=120 and(position_code<>'other' or length(btrim(position_other))>0)),
  is_postgraduate boolean not null default false,
  requested_valid_until date check(requested_valid_until is null or isfinite(requested_valid_until)),
  approved_valid_until date check(approved_valid_until is null or isfinite(approved_valid_until)),
  access_period_pending boolean not null default false,
  period_reviewed_by uuid references public.profiles(id) on delete set null,
  period_reviewed_at timestamptz,
  contact_email text not null default '' check(length(contact_email)<=254 and(contact_email='' or contact_email~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  contact_phone text not null default '' check(length(contact_phone)<=40 and(contact_phone='' or(contact_phone~'^\+?[0-9 ().-]{6,40}$' and length(regexp_replace(contact_phone,'[^0-9]','','g'))>=6))),
  contact_telegram text not null default '' check(contact_telegram='' or contact_telegram~'^[A-Za-z][A-Za-z0-9_]{4,31}$'),
  email_visible_to_groups boolean not null default false,
  email_visible_public boolean not null default false,
  phone_visible_to_groups boolean not null default false,
  phone_visible_public boolean not null default false,
  telegram_visible_to_groups boolean not null default false,
  telegram_visible_public boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
create table public.teacher_academic_period_audit(
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  previous_valid_until date,
  approved_valid_until date,
  requested_valid_until date,
  reviewed_at timestamptz not null default clock_timestamp()
);
alter table public.teacher_academic_profiles enable row level security;
alter table public.teacher_academic_period_audit enable row level security;
revoke all on public.teacher_academic_profiles,public.teacher_academic_period_audit from public,anon,authenticated,service_role;

create function public.xelay_teacher_position_label(p_code text,p_other text default '')
returns text language sql immutable set search_path='' as $$
  select case p_code when 'assistant' then 'Асистент' when 'lecturer' then 'Викладач'
    when 'senior_lecturer' then 'Старший викладач' when 'associate_professor' then 'Доцент'
    when 'professor' then 'Професор' when 'other' then p_other else '' end;
$$;
revoke all on function public.xelay_teacher_position_label(text,text) from public,anon,authenticated,service_role;

-- Verification remains a historical identity check. A separate current access
-- gate protects new teaching writes while preserving the existing read paths.
create function public.xelay_teaching_has_current_access(p_teacher_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_teaching_is_verified(p_teacher_id) and not exists(
    select 1 from public.teacher_academic_profiles a where a.user_id=p_teacher_id
      and a.approved_valid_until<(current_timestamp at time zone 'Europe/Kyiv')::date);
$$;
revoke all on function public.xelay_teaching_has_current_access(uuid) from public,anon,authenticated,service_role;

create function public.xelay_private_teacher_academic_json(p_user_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('user_id',p_user_id,'position_code',coalesce(a.position_code,''),
    'position_other',coalesce(a.position_other,''),'is_postgraduate',coalesce(a.is_postgraduate,false),
    'requested_valid_until',a.requested_valid_until,'approved_valid_until',a.approved_valid_until,
    'access_period_pending',coalesce(a.access_period_pending,false),
    'access_expired',coalesce(a.approved_valid_until<(current_timestamp at time zone 'Europe/Kyiv')::date,false),
    'contact_email',coalesce(a.contact_email,''),'contact_phone',coalesce(a.contact_phone,''),
    'contact_telegram',coalesce(a.contact_telegram,''),'email_visible_to_groups',coalesce(a.email_visible_to_groups,false),
    'email_visible_public',coalesce(a.email_visible_public,false),'phone_visible_to_groups',coalesce(a.phone_visible_to_groups,false),
    'phone_visible_public',coalesce(a.phone_visible_public,false),'telegram_visible_to_groups',coalesce(a.telegram_visible_to_groups,false),
    'telegram_visible_public',coalesce(a.telegram_visible_public,false),'updated_at',a.updated_at)
  from(select 1) seed left join public.teacher_academic_profiles a on a.user_id=p_user_id;
$$;
revoke all on function public.xelay_private_teacher_academic_json(uuid) from public,anon,authenticated,service_role;

create function public.xelay_teacher_academic_profile()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();
begin return public.xelay_private_teacher_academic_json(v_uid); end $$;
revoke all on function public.xelay_teacher_academic_profile() from public,anon,authenticated,service_role;
grant execute on function public.xelay_teacher_academic_profile() to authenticated;

create function public.xelay_teacher_academic_profile_save(p_profile jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_old public.teacher_academic_profiles%rowtype;
  v_requested date;v_code text;v_other text;v_key text;v_period_changed boolean;v_admin record;
begin
  if jsonb_typeof(p_profile) is distinct from 'object' or octet_length(p_profile::text)>6000
    or exists(select 1 from jsonb_object_keys(p_profile) as keys(key) where key not in('expected_user_id','position_code','position_other','is_postgraduate',
      'requested_valid_until','contact_email','contact_phone','contact_telegram','email_visible_to_groups','email_visible_public',
      'phone_visible_to_groups','phone_visible_public','telegram_visible_to_groups','telegram_visible_public','expected_updated_at'))
    or p_profile->>'expected_user_id' is distinct from v_uid::text
    or not exists(select 1 from public.profiles p where p.id=v_uid and(p.account_type='teacher'
      or exists(select 1 from public.teacher_verification_requests r where r.user_id=v_uid))) then
    raise exception 'TEACHER_ACADEMIC_INVALID_INPUT' using errcode='22023'; end if;
  foreach v_key in array array['is_postgraduate','email_visible_to_groups','email_visible_public','phone_visible_to_groups',
    'phone_visible_public','telegram_visible_to_groups','telegram_visible_public'] loop
    if jsonb_typeof(p_profile->v_key) is distinct from 'boolean' then raise exception 'TEACHER_ACADEMIC_INVALID_INPUT' using errcode='22023'; end if;
  end loop;
  v_code:=coalesce(p_profile->>'position_code','');v_other:=btrim(coalesce(p_profile->>'position_other',''));
  v_requested:=nullif(p_profile->>'requested_valid_until','')::date;
  perform pg_advisory_xact_lock(hashtextextended('xelay:teacher-academic:'||v_uid::text,0));
  select * into v_old from public.teacher_academic_profiles where user_id=v_uid for update;
  if v_requested is not null and(not isfinite(v_requested) or(v_requested<(current_timestamp at time zone 'Europe/Kyiv')::date
    and v_requested is distinct from v_old.requested_valid_until)) then
    raise exception 'TEACHER_ACADEMIC_INVALID_DATE' using errcode='22023'; end if;
  if v_old.updated_at is distinct from nullif(p_profile->>'expected_updated_at','')::timestamptz then
    raise exception 'TEACHER_ACADEMIC_CONFLICT' using errcode='40001'; end if;
  v_period_changed:=v_requested is distinct from v_old.requested_valid_until;
  insert into public.teacher_academic_profiles(user_id,position_code,position_other,is_postgraduate,requested_valid_until,access_period_pending,
    contact_email,contact_phone,contact_telegram,email_visible_to_groups,email_visible_public,phone_visible_to_groups,phone_visible_public,
    telegram_visible_to_groups,telegram_visible_public)
  values(v_uid,v_code,v_other,(p_profile->>'is_postgraduate')::boolean,v_requested,v_period_changed,
    btrim(coalesce(p_profile->>'contact_email','')),btrim(coalesce(p_profile->>'contact_phone','')),ltrim(btrim(coalesce(p_profile->>'contact_telegram','')),'@'),
    (p_profile->>'email_visible_to_groups')::boolean and btrim(coalesce(p_profile->>'contact_email',''))<>'',
    (p_profile->>'email_visible_public')::boolean and btrim(coalesce(p_profile->>'contact_email',''))<>'',
    (p_profile->>'phone_visible_to_groups')::boolean and btrim(coalesce(p_profile->>'contact_phone',''))<>'',
    (p_profile->>'phone_visible_public')::boolean and btrim(coalesce(p_profile->>'contact_phone',''))<>'',
    (p_profile->>'telegram_visible_to_groups')::boolean and btrim(coalesce(p_profile->>'contact_telegram',''))<>'',
    (p_profile->>'telegram_visible_public')::boolean and btrim(coalesce(p_profile->>'contact_telegram',''))<>'')
  on conflict(user_id) do update set position_code=excluded.position_code,position_other=excluded.position_other,
    is_postgraduate=excluded.is_postgraduate,requested_valid_until=excluded.requested_valid_until,
    access_period_pending=case when v_period_changed then true else teacher_academic_profiles.access_period_pending end,
    contact_email=excluded.contact_email,contact_phone=excluded.contact_phone,contact_telegram=excluded.contact_telegram,
    email_visible_to_groups=excluded.email_visible_to_groups,email_visible_public=excluded.email_visible_public,
    phone_visible_to_groups=excluded.phone_visible_to_groups,phone_visible_public=excluded.phone_visible_public,
    telegram_visible_to_groups=excluded.telegram_visible_to_groups,telegram_visible_public=excluded.telegram_visible_public,updated_at=clock_timestamp();
  if v_period_changed and public.xelay_teaching_is_verified(v_uid) then
    for v_admin in select distinct user_id from public.user_roles where role='ADMIN' loop
      perform public.xelay_teaching_notify(v_admin.user_id,'teacher-period-request:'||v_uid::text||':'||to_char(clock_timestamp() at time zone 'Europe/Kyiv','YYYY-MM-DD'),
        'Викладач просить погодити зміну строку викладання. Перегляньте заявку в адмінпанелі.');
    end loop;
  end if;
  return public.xelay_private_teacher_academic_json(v_uid);
end $$;
revoke all on function public.xelay_teacher_academic_profile_save(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teacher_academic_profile_save(jsonb) to authenticated;

create function public.xelay_teacher_request_with_academic_profile(p_department text,p_position text,p_note text,p_profile jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform public.xelay_teaching_assert_user();
  v_result:=public.xelay_teacher_request(p_department,p_position,p_note);
  perform public.xelay_teacher_academic_profile_save(p_profile);
  return v_result;
end $$;
revoke all on function public.xelay_teacher_request_with_academic_profile(text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teacher_request_with_academic_profile(text,text,text,jsonb) to authenticated;

create function public.xelay_teacher_academic_period_review(p_teacher_id uuid,p_approved_valid_until date,p_expected_updated_at timestamptz default null,p_expected_admin_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_old public.teacher_academic_profiles%rowtype;
begin
  if p_expected_admin_id is distinct from v_uid or not public.xelay_is_platform_admin() or p_teacher_id=v_uid then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  if not exists(select 1 from public.teacher_verification_requests where user_id=p_teacher_id)
    or(p_approved_valid_until is not null and(not isfinite(p_approved_valid_until)
      or p_approved_valid_until<(current_timestamp at time zone 'Europe/Kyiv')::date)) then
    raise exception 'TEACHER_ACADEMIC_INVALID_DATE' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:teacher-academic:'||p_teacher_id::text,0));
  select * into v_old from public.teacher_academic_profiles where user_id=p_teacher_id for update;
  if v_old.updated_at is distinct from p_expected_updated_at then
    raise exception 'TEACHER_ACADEMIC_CONFLICT' using errcode='40001'; end if;
  insert into public.teacher_academic_profiles(user_id,approved_valid_until,period_reviewed_by,period_reviewed_at)
  values(p_teacher_id,p_approved_valid_until,v_uid,clock_timestamp())
  on conflict(user_id) do update set approved_valid_until=excluded.approved_valid_until,access_period_pending=false,
    period_reviewed_by=v_uid,period_reviewed_at=clock_timestamp(),updated_at=clock_timestamp();
  insert into public.teacher_academic_period_audit(teacher_id,actor_id,previous_valid_until,approved_valid_until,requested_valid_until)
  values(p_teacher_id,v_uid,v_old.approved_valid_until,p_approved_valid_until,v_old.requested_valid_until);
  perform public.xelay_teaching_notify(p_teacher_id,'teacher-period-review:'||p_teacher_id::text||':'||clock_timestamp()::text,
    case when p_approved_valid_until is null then 'Строк викладання погоджено без обмеження дати.'
      else 'Строк викладання погоджено до '||to_char(p_approved_valid_until,'DD.MM.YYYY')||'.' end);
  -- Admins receive status/period data, never private contact values.
  return public.xelay_private_teacher_academic_json(p_teacher_id)-array['contact_email','contact_phone','contact_telegram',
    'email_visible_to_groups','email_visible_public','phone_visible_to_groups','phone_visible_public','telegram_visible_to_groups','telegram_visible_public'];
end $$;
revoke all on function public.xelay_teacher_academic_period_review(uuid,date,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teacher_academic_period_review(uuid,date,timestamptz,uuid) to authenticated;

create function public.xelay_teacher_review_with_period(p_request_id uuid,p_status text,p_reason text,p_approved_valid_until date default null,p_expected_updated_at timestamptz default null,p_expected_admin_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_teacher uuid;v_result jsonb;
begin
  if p_expected_admin_id is distinct from v_uid or not public.xelay_is_platform_admin() then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  select user_id into v_teacher from public.teacher_verification_requests where id=p_request_id for update;
  if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
  v_result:=public.xelay_teaching_mutate('review_teacher',jsonb_build_object('request_id',p_request_id,'status',p_status,'reason',p_reason));
  if p_status='approved' then perform public.xelay_teacher_academic_period_review(v_teacher,p_approved_valid_until,p_expected_updated_at,v_uid); end if;
  return v_result;
end $$;
revoke all on function public.xelay_teacher_review_with_period(uuid,text,text,date,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teacher_review_with_period(uuid,text,text,date,timestamptz,uuid) to authenticated;

create function public.xelay_teacher_contacts(p_teacher_id uuid,p_group_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_group_allowed boolean:=false;v_profile public.teacher_academic_profiles%rowtype;v_position text;
begin
  if not public.xelay_teaching_has_current_access(p_teacher_id) then return jsonb_build_object('user_id',p_teacher_id,'verified',false,
    'position_code','','position','','is_postgraduate',false,'contact_email',null,'contact_phone',null,'contact_telegram',null); end if;
  if p_group_id is not null then
    perform public.xelay_teaching_assert_user();
    v_group_allowed:=public.xelay_teaching_is_member(p_group_id,auth.uid()) and exists(
      select 1 from public.teaching_course_groups g join public.teaching_courses c on c.id=g.course_id
      where g.group_id=p_group_id and g.status='accepted' and c.archived_at is null
        and(c.owner_id=p_teacher_id or exists(select 1 from public.teaching_course_teachers t
          where t.course_id=c.id and t.user_id=p_teacher_id and t.status='accepted'))
        and cardinality(public.xelay_teaching_permissions(c.id,p_teacher_id))>0);
    if not v_group_allowed then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  end if;
  select * into v_profile from public.teacher_academic_profiles where user_id=p_teacher_id;
  v_position:=public.xelay_teacher_position_label(v_profile.position_code,v_profile.position_other);
  if coalesce(v_position,'')='' then select r.position into v_position from public.teacher_verification_requests r where r.user_id=p_teacher_id; end if;
  return jsonb_build_object('user_id',p_teacher_id,'verified',true,'position_code',coalesce(v_profile.position_code,''),
    'position',coalesce(v_position,''),'is_postgraduate',coalesce(v_profile.is_postgraduate,false),
    'contact_email',case when v_profile.email_visible_public or(v_group_allowed and v_profile.email_visible_to_groups) then nullif(v_profile.contact_email,'') end,
    'contact_phone',case when v_profile.phone_visible_public or(v_group_allowed and v_profile.phone_visible_to_groups) then nullif(v_profile.contact_phone,'') end,
    'contact_telegram',case when v_profile.telegram_visible_public or(v_group_allowed and v_profile.telegram_visible_to_groups) then nullif(v_profile.contact_telegram,'') end);
end $$;
revoke all on function public.xelay_teacher_contacts(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teacher_contacts(uuid,uuid) to anon,authenticated;

create or replace function public.xelay_teacher_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_request jsonb;
begin
  if v_uid is null then raise exception 'TEACHING_AUTH_REQUIRED' using errcode='42501'; end if;
  select to_jsonb(r) into v_request from public.teacher_verification_requests r where r.user_id=v_uid;
  return jsonb_build_object('status',coalesce(v_request->>'status','none'),'request',v_request,
    'verified',public.xelay_teaching_is_verified(v_uid),'has_current_access',public.xelay_teaching_has_current_access(v_uid),
    'academic_profile',public.xelay_private_teacher_academic_json(v_uid),
    'scope_changed',coalesce(v_request->>'status' in('pending','approved') and not exists(select 1 from public.profiles p
      where p.id=v_uid and p.university_id=(v_request->>'university_id')::uuid and p.academic_unit_id=(v_request->>'academic_unit_id')::uuid),false),
    'requests',case when public.xelay_is_platform_admin() then coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object(
      'academic_profile',public.xelay_private_teacher_academic_json(r.user_id)-array['contact_email','contact_phone','contact_telegram',
        'email_visible_to_groups','email_visible_public','phone_visible_to_groups','phone_visible_public','telegram_visible_to_groups','telegram_visible_public'])
      order by r.created_at desc) from public.teacher_verification_requests r),'[]'::jsonb) else '[]'::jsonb end);
end $$;

create function public.xelay_private_assert_teacher_current_access(p_teacher_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  -- Share lock serializes expiry changes with new writes and scheduler checks.
  perform 1 from public.teacher_academic_profiles where user_id=p_teacher_id for share;
  if not public.xelay_teaching_has_current_access(p_teacher_id) then
    raise exception 'TEACHING_ACCESS_EXPIRED_OR_UNVERIFIED' using errcode='42501'; end if;
end $$;
revoke all on function public.xelay_private_assert_teacher_current_access(uuid) from public,anon,authenticated,service_role;

create or replace function public.xelay_teaching_lock_course(p_course_id uuid,p_permission text)
returns void language plpgsql security definer set search_path='' as $$
declare v_course public.teaching_courses%rowtype;
begin
  select * into v_course from public.teaching_courses where id=p_course_id for update;
  if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
  perform public.xelay_private_assert_teacher_current_access(auth.uid());
  if not p_permission=any(public.xelay_teaching_permissions(p_course_id,auth.uid())) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  if v_course.archived_at is not null then raise exception 'TEACHING_ARCHIVED'; end if;
end $$;

create or replace function public.xelay_teaching_can_upload_file(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and public.xelay_teaching_has_current_access(auth.uid())
    and public.xelay_teaching_file_course(p_name) is not null and split_part(p_name,'/',2)=auth.uid()::text
    and exists(select 1 from public.teaching_courses c where c.id=public.xelay_teaching_file_course(p_name) and c.archived_at is null
      and public.xelay_teaching_permissions(c.id,auth.uid())&&array['materials','assignments']::text[]);
$$;

-- Exact, fail-closed patches preserve all prior mutation/version/RLS contracts.
create function pg_temp.xelay_teacher_academic_patch(p_signature text,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text;v_count integer;
begin
  v_definition:=replace(pg_get_functiondef(to_regprocedure(p_signature)),chr(13),'');
  p_old:=replace(p_old,chr(13),'');p_new:=replace(p_new,chr(13),'');
  v_count:=(length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old);
  if v_count<>1 then raise exception 'Teacher academic patch anchor mismatch: % (%)',p_signature,v_count; end if;
  execute replace(v_definition,p_old,p_new);
end $$;
select pg_temp.xelay_teacher_academic_patch('public.xelay_teaching_mutate(text,jsonb)',
$old$  if p_action is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>100000 then$old$,
$new$  -- teacher_academic_current_access_contract
  if p_action in('create_course','copy_course','archive_course','update_course','invite_group','invite_teacher','update_teacher',
    'save_assignment','save_material','delete_assignment','sync_roster','save_entry','save_activity','save_grade',
    'publish_grades','cancel_scheduled_publication','set_submission_extension') then
    perform public.xelay_private_assert_teacher_current_access(v_uid);
  end if;
  if p_action='invite_teacher_from_group' then
    perform public.xelay_private_assert_teacher_current_access((p_payload->>'teacher_id')::uuid);
  end if;
  if p_action='respond_teacher' and p_payload->'accept'='true'::jsonb then
    perform public.xelay_private_assert_teacher_current_access(v_uid);
  end if;
  if p_action is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>100000 then$new$);
select pg_temp.xelay_teacher_academic_patch('public.xelay_teaching_mutate(text,jsonb)',
$old$if not 'manage'=any(public.xelay_teaching_permissions(v_course.id,v_course.owner_id)) then raise exception 'TEACHER_VERIFICATION_REQUIRED'; end if;$old$,
$new$perform public.xelay_private_assert_teacher_current_access(v_course.owner_id);
      if not 'manage'=any(public.xelay_teaching_permissions(v_course.id,v_course.owner_id)) then raise exception 'TEACHER_VERIFICATION_REQUIRED'; end if;$new$);
select pg_temp.xelay_teacher_academic_patch('public.xelay_publish_due_teaching_items()',
$old$      if not v_permission=any(public.xelay_teaching_permissions(v_item.course_id,v_actor))$old$,
$new$      perform public.xelay_private_assert_teacher_current_access(v_actor);
      perform public.xelay_private_assert_teacher_current_access(v_item.created_by);
      if not v_permission=any(public.xelay_teaching_permissions(v_item.course_id,v_actor))$new$);
select pg_temp.xelay_teacher_academic_patch('public.xelay_teaching_calendar_assign(uuid,uuid,uuid,text,boolean)',
$old$  -- Same lock as subject membership and semester/permission mutations.$old$,
$new$  if p_assigned then perform public.xelay_private_assert_teacher_current_access(v_uid); end if;
  -- Same lock as subject membership and semester/permission mutations.$new$);

comment on table public.teacher_academic_profiles is 'Private academic classification, independently approved teaching expiry and opt-in contact disclosures. No client table grants.';
comment on function public.xelay_teaching_has_current_access(uuid) is 'Current verified teaching authority for new actions; no fixed expiry for postgraduate status. Approved date is inclusive in Kyiv.';
commit;
