-- Bounded, private operator review for genuinely ambiguous legacy identities.
-- No automatic joining, ownership transfer, approval or content reassignment.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if to_regclass('public.study_group_course_confirmations') is null
    or to_regclass('public.study_group_cohort_collision_resolutions') is null
    or to_regclass('auth.mfa_factors') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null then
    raise exception 'GROUP_IDENTITY_REVIEW_PREREQUISITES_MISSING';end if;
  if to_regclass('public.study_group_identity_reviews') is not null then
    raise exception 'GROUP_IDENTITY_REVIEW_ALREADY_INSTALLED';end if;
end $$;

create table public.study_group_identity_reviews(
  id uuid primary key,
  actor_id uuid not null,
  request_id uuid references public.class_representative_requests(id) on delete cascade,
  group_id uuid references public.study_groups(id) on delete cascade,
  course integer not null check(course between 1 and 6),
  academic_year integer not null check(academic_year between 1900 and 2199),
  cohort_start_year integer not null check(cohort_start_year between 1900 and 2200),
  study_level text not null check(study_level in('bachelor','master','postgraduate')),
  message text not null default '' check(char_length(message)<=1000),
  snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
  status text not null default 'pending' check(status in('pending','resolved','closed')),
  resolution_action text,
  resolution_reason text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check((request_id is null)<>(group_id is null)),
  check(cohort_start_year=academic_year-course+1),
  check((status='pending' and resolution_action is null and reviewed_at is null and reviewed_by is null)
    or(status<>'pending' and resolution_action in('close','confirm_identity','distinct') and reviewed_at is not null
      and reviewed_by is not null and char_length(btrim(resolution_reason)) between 10 and 1000))
);
create unique index study_group_identity_one_pending_request_idx on public.study_group_identity_reviews(actor_id,request_id)
  where status='pending' and request_id is not null;
create unique index study_group_identity_one_pending_group_idx on public.study_group_identity_reviews(actor_id,group_id)
  where status='pending' and group_id is not null;
create index study_group_identity_review_queue_idx on public.study_group_identity_reviews(status,created_at,id);
alter table public.study_group_identity_reviews enable row level security;
revoke all on public.study_group_identity_reviews from public,anon,authenticated,service_role;
comment on table public.study_group_identity_reviews is
  'Closed applicant-scoped identity-review cases. Snapshots contain only academic identity/ownership evidence, never approval contacts. An admin with verified MFA must explicitly resolve a collision or explain closure; no silent role or membership changes.';

create function public.xelay_private_group_identity_admin()
returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null or not public.xelay_private_representative_account_active(v_user)
    or not coalesce(public.xelay_is_platform_admin(),false) or coalesce(auth.jwt()->>'aal','')<>'aal2'
    or not exists(select 1 from public.user_roles r where r.user_id=v_user and r.role='ADMIN')
    or not exists(select 1 from auth.mfa_factors f where f.user_id=v_user and f.status='verified') then
    raise exception 'ADMIN_MFA_REQUIRED' using errcode='42501';end if;
  return v_user;
end;
$$;
revoke all on function public.xelay_private_group_identity_admin() from public,anon,authenticated,service_role;

create function public.xelay_request_study_group_identity_review(
  p_request_id uuid,p_group_id uuid,p_course integer,p_study_level text,p_academic_year integer,p_message text,p_command_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_request public.class_representative_requests%rowtype;v_group public.study_groups%rowtype;
  v_case public.study_group_identity_reviews%rowtype;v_snapshot jsonb;v_collisions jsonb;v_message text:=btrim(coalesce(p_message,''));
begin
  if v_user is null or not public.xelay_private_representative_account_active(v_user) then
    raise exception 'GROUP_COURSE_AUTH_REQUIRED' using errcode='42501';end if;
  if(p_request_id is null)=(p_group_id is null) or p_command_id is null or p_course is null or p_course not between 1 and 6
    or p_study_level is null or p_study_level not in('bachelor','master','postgraduate')
    or p_academic_year is null or p_academic_year is distinct from public.xelay_current_academic_year()::integer
    or char_length(v_message)>1000 or v_message ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]' then
    raise exception 'GROUP_COURSE_INVALID_INPUT' using errcode='22023';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:group-identity-review:'||v_user::text,0));
  select * into v_case from public.study_group_identity_reviews where id=p_command_id;
  if found then
    if v_case.actor_id<>v_user or v_case.request_id is distinct from p_request_id or v_case.group_id is distinct from p_group_id
      or v_case.course<>p_course or v_case.study_level<>p_study_level or v_case.academic_year<>p_academic_year
      or v_case.message<>v_message then raise exception 'GROUP_COURSE_REQUEST_REUSED' using errcode='22023';end if;
    return jsonb_build_object('id',v_case.id,'status',v_case.status,'reused',true);
  end if;
  if p_request_id is not null then
    select * into v_request from public.class_representative_requests where id=p_request_id and user_id=v_user and status='approved' for share;
    if not found then raise exception 'GROUP_REVIEW_FORBIDDEN' using errcode='42501';end if;
    if exists(select 1 from public.study_groups g where g.representative_request_id=p_request_id) then
      raise exception 'GROUP_REVIEW_ALREADY_BOUND' using errcode='PT409';end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'representative_id',g.representative_id,
      'representative_request_id',g.representative_request_id,'cohort_start_year',g.cohort_start_year,'study_level',g.study_level)
      order by g.id),'[]'::jsonb) into v_collisions from public.study_groups g
      where g.university_id=v_request.university_id and g.academic_unit_id=v_request.academic_unit_id
        and lower(btrim(g.specialty))=lower(btrim(v_request.specialty)) and lower(btrim(g.group_name))=lower(btrim(v_request.group_name));
    if jsonb_array_length(v_collisions)>50 then raise exception 'GROUP_REVIEW_CAPACITY' using errcode='22023';end if;
    if v_collisions='[]'::jsonb and(v_request.cohort_start_year is null
      or(v_request.cohort_start_year=p_academic_year-p_course+1 and v_request.study_level=p_study_level)) then
      raise exception 'GROUP_REVIEW_NOT_REQUIRED' using errcode='22023';end if;
    v_snapshot:=jsonb_build_object('kind','creation','university_id',v_request.university_id,'academic_unit_id',v_request.academic_unit_id,
      'specialty',v_request.specialty,'group_name',v_request.group_name,'request_user_id',v_request.user_id,
      'request_cohort_start_year',v_request.cohort_start_year,'request_study_level',v_request.study_level,'collisions',v_collisions);
  else
    select * into v_group from public.study_groups where id=p_group_id and representative_id=v_user for share;
    if not found then raise exception 'GROUP_REVIEW_FORBIDDEN' using errcode='42501';end if;
    v_snapshot:=jsonb_build_object('kind','group','university_id',v_group.university_id,'academic_unit_id',v_group.academic_unit_id,
      'specialty',v_group.specialty,'group_name',v_group.group_name,'representative_id',v_group.representative_id,
      'representative_request_id',v_group.representative_request_id,'cohort_start_year',v_group.cohort_start_year,'study_level',v_group.study_level,
      'collisions',jsonb_build_array(jsonb_build_object('id',v_group.id,'representative_id',v_group.representative_id,
        'representative_request_id',v_group.representative_request_id,'cohort_start_year',v_group.cohort_start_year,'study_level',v_group.study_level)));
  end if;
  select * into v_case from public.study_group_identity_reviews where actor_id=v_user and status='pending'
    and request_id is not distinct from p_request_id and group_id is not distinct from p_group_id;
  if found then
    if v_case.course<>p_course or v_case.study_level<>p_study_level or v_case.academic_year<>p_academic_year then
      raise exception 'GROUP_REVIEW_PENDING' using errcode='PT409';end if;
    return jsonb_build_object('id',v_case.id,'status',v_case.status,'reused',true);
  end if;
  if(select count(*) from public.study_group_identity_reviews where actor_id=v_user and status='pending')>=10 then
    raise exception 'GROUP_REVIEW_CAPACITY' using errcode='22023';end if;
  insert into public.study_group_identity_reviews(id,actor_id,request_id,group_id,course,academic_year,cohort_start_year,study_level,message,snapshot)
    values(p_command_id,v_user,p_request_id,p_group_id,p_course,p_academic_year,p_academic_year-p_course+1,p_study_level,v_message,v_snapshot)
    returning * into v_case;
  return jsonb_build_object('id',v_case.id,'status',v_case.status,'reused',false);
end;
$$;

create function public.xelay_my_study_group_identity_reviews()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_result jsonb;
begin
  if v_user is null or not public.xelay_private_representative_account_active(v_user) then
    raise exception 'GROUP_COURSE_AUTH_REQUIRED' using errcode='42501';end if;
  select coalesce(jsonb_agg(to_jsonb(r)order by r.created_at desc,r.id),'[]'::jsonb) into v_result from(
    select id,status,request_id,group_id,course,academic_year,cohort_start_year,study_level,resolution_action,resolution_reason,created_at,reviewed_at
      from public.study_group_identity_reviews where actor_id=v_user order by created_at desc,id limit 20)r;
  return v_result;
end;
$$;

create function public.xelay_admin_study_group_identity_reviews(p_status text default 'pending',p_limit integer default 20,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform public.xelay_private_group_identity_admin();
  if p_status is null or p_status not in('pending','resolved','closed','all') or p_limit is null or p_limit not between 1 and 50
    or p_offset is null or p_offset not between 0 and 100000 then raise exception 'GROUP_COURSE_INVALID_INPUT' using errcode='22023';end if;
  with matched as materialized(select r.* from public.study_group_identity_reviews r where p_status='all' or r.status=p_status),
  page as(select r.* from matched r order by r.created_at,r.id limit p_limit offset p_offset)
  select jsonb_build_object('total',(select count(*) from matched),'items',coalesce((select jsonb_agg(
    jsonb_build_object('id',r.id,'status',r.status,'kind',r.snapshot->>'kind','request_id',r.request_id,'group_id',r.group_id,
      'course',r.course,'academic_year',r.academic_year,'cohort_start_year',r.cohort_start_year,'study_level',r.study_level,
      'message',r.message,'resolution_action',r.resolution_action,'resolution_reason',r.resolution_reason,
      'created_at',r.created_at,'reviewed_at',r.reviewed_at,'group_name',r.snapshot->>'group_name','specialty',r.snapshot->>'specialty',
      'university_name',u.name,'academic_unit_name',a.name,'applicant',jsonb_build_object('id',p.id,'full_name',p.full_name,'username',p.username),
      'collision_groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'group_name',g.group_name,'representative_name',o.full_name,
        'cohort_start_year',g.cohort_start_year,'study_level',g.study_level,
        'snapshot_unchanged',e.value->>'representative_id'=g.representative_id::text
          and e.value->>'representative_request_id'=g.representative_request_id::text
          and e.value->'cohort_start_year' is not distinct from coalesce(to_jsonb(g.cohort_start_year),'null'::jsonb)
          and e.value->'study_level' is not distinct from coalesce(to_jsonb(g.study_level),'null'::jsonb))order by g.group_name,g.id)
        from jsonb_array_elements(r.snapshot->'collisions')e(value) join public.study_groups g on g.id=(e.value->>'id')::uuid
        left join public.profiles o on o.id=g.representative_id),'[]'::jsonb))order by r.created_at,r.id)
    from page r left join public.profiles p on p.id=r.actor_id left join public.universities u on u.id=(r.snapshot->>'university_id')::uuid
      left join public.academic_units a on a.id=(r.snapshot->>'academic_unit_id')::uuid),'[]'::jsonb)) into v_result;
  return v_result;
end;
$$;

create function public.xelay_admin_resolve_study_group_identity_review(
  p_review_id uuid,p_action text,p_reason text,p_existing_group_id uuid default null,
  p_course integer default null,p_study_level text default null,p_academic_year integer default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=public.xelay_private_group_identity_admin();v_case public.study_group_identity_reviews%rowtype;
  v_group public.study_groups%rowtype;v_request public.class_representative_requests%rowtype;v_evidence jsonb;
  v_reason text:=btrim(coalesce(p_reason,''));v_cohort integer;v_confirm uuid;v_prior public.class_representative_requests%rowtype;
  v_prior_resolution public.study_group_cohort_collision_resolutions%rowtype;
begin
  if p_review_id is null or p_action is null or p_action not in('close','confirm_identity','distinct')
    or char_length(v_reason) not between 10 and 1000 or v_reason ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]' then
    raise exception 'GROUP_COURSE_INVALID_INPUT' using errcode='22023';end if;
  select * into v_case from public.study_group_identity_reviews where id=p_review_id for update;
  if not found then raise exception 'GROUP_REVIEW_NOT_FOUND' using errcode='22023';end if;
  if v_case.status<>'pending' then raise exception 'GROUP_REVIEW_STALE' using errcode='PT409';end if;
  if p_action='close' then
    update public.study_group_identity_reviews set status='closed',resolution_action='close',resolution_reason=v_reason,reviewed_by=v_user,
      reviewed_at=clock_timestamp() where id=v_case.id;
    return jsonb_build_object('id',v_case.id,'status','closed','action','close','group_id',v_case.group_id);
  end if;
  if v_case.actor_id=v_user then raise exception 'GROUP_REVIEW_SELF_REVIEW' using errcode='42501';end if;
  if p_existing_group_id is null then raise exception 'GROUP_COURSE_INVALID_INPUT' using errcode='22023';end if;
  select e.value into v_evidence from jsonb_array_elements(v_case.snapshot->'collisions')e(value) where e.value->>'id'=p_existing_group_id::text;
  if v_evidence is null then raise exception 'GROUP_REVIEW_FORBIDDEN' using errcode='42501';end if;
  -- Creation holds its approval row before the base-identity lock too.
  if v_case.request_id is not null then
    perform r.id from public.class_representative_requests r where r.id=v_case.request_id for share;
  end if;
  -- Resolve the exact captured academic scope; no arbitrary group can be selected.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay-study-group-identity:'||(v_case.snapshot->>'university_id')||':'||(v_case.snapshot->>'academic_unit_id')
    ||':'||lower(btrim(v_case.snapshot->>'specialty'))||':'||lower(btrim(v_case.snapshot->>'group_name')),0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:seminars:'||p_existing_group_id::text,0));
  select * into v_group from public.study_groups where id=p_existing_group_id for update;
  if not found or v_group.university_id::text<>v_case.snapshot->>'university_id'
    or v_group.academic_unit_id::text<>v_case.snapshot->>'academic_unit_id'
    or lower(btrim(v_group.specialty))<>lower(btrim(v_case.snapshot->>'specialty'))
    or lower(btrim(v_group.group_name))<>lower(btrim(v_case.snapshot->>'group_name'))
    or v_group.representative_id::text<>v_evidence->>'representative_id'
    or v_group.representative_request_id::text<>v_evidence->>'representative_request_id'
    or coalesce(to_jsonb(v_group.cohort_start_year),'null'::jsonb) is distinct from v_evidence->'cohort_start_year'
    or coalesce(to_jsonb(v_group.study_level),'null'::jsonb) is distinct from v_evidence->'study_level' then
    raise exception 'GROUP_REVIEW_STALE' using errcode='PT409';end if;
  if v_case.request_id is not null then
    select * into v_request from public.class_representative_requests where id=v_case.request_id;
    if not found or v_request.status<>'approved' or v_request.user_id<>v_case.actor_id
      or v_request.university_id<>v_group.university_id or v_request.academic_unit_id<>v_group.academic_unit_id
      or lower(btrim(v_request.specialty))<>lower(btrim(v_group.specialty))
      or lower(btrim(v_request.group_name))<>lower(btrim(v_group.group_name))
      or coalesce(to_jsonb(v_request.cohort_start_year),'null'::jsonb) is distinct from v_case.snapshot->'request_cohort_start_year'
      or coalesce(to_jsonb(v_request.study_level),'null'::jsonb) is distinct from v_case.snapshot->'request_study_level'
      or exists(select 1 from public.study_groups g where g.representative_request_id=v_request.id) then
      raise exception 'GROUP_REVIEW_STALE' using errcode='PT409';end if;
  elsif v_group.representative_id<>v_case.actor_id then raise exception 'GROUP_REVIEW_STALE' using errcode='PT409';end if;
  if p_action='distinct' then
    if v_case.request_id is null or v_group.cohort_start_year is not null or v_group.study_level is not null
      or(v_request.cohort_start_year is not null and(v_request.cohort_start_year<>v_case.cohort_start_year or v_request.study_level<>v_case.study_level)) then
      raise exception 'GROUP_REVIEW_STALE' using errcode='PT409';end if;
    select * into v_prior_resolution from public.study_group_cohort_collision_resolutions
      where request_id=v_request.id and existing_group_id=v_group.id;
    if found then raise exception 'GROUP_REVIEW_STALE' using errcode='PT409';end if;
    insert into public.study_group_cohort_collision_resolutions(request_id,existing_group_id,request_user_id,existing_representative_id,
      existing_representative_request_id,university_id,academic_unit_id,specialty,group_name,new_cohort_start_year,new_study_level,
      existing_cohort_start_year,existing_study_level,reason)
      values(v_request.id,v_group.id,v_request.user_id,v_group.representative_id,v_group.representative_request_id,v_group.university_id,
        v_group.academic_unit_id,v_group.specialty,v_group.group_name,v_case.cohort_start_year,v_case.study_level,null,null,v_reason);
  else
    if p_course is null or p_course not between 1 and 6 or p_study_level is null or p_study_level not in('bachelor','master','postgraduate')
      or p_academic_year is null or p_academic_year is distinct from public.xelay_current_academic_year()::integer then
      raise exception 'GROUP_COURSE_INVALID_INPUT' using errcode='22023';end if;
    v_cohort:=p_academic_year-p_course+1;
    if v_group.cohort_start_year is not null then raise exception 'GROUP_COURSE_IDENTITY_MISMATCH' using errcode='PT409';end if;
    select * into v_prior from public.class_representative_requests where id=v_group.representative_request_id;
    if v_prior.cohort_start_year is not null and(v_prior.cohort_start_year<>v_cohort or v_prior.study_level<>p_study_level) then
      raise exception 'GROUP_COURSE_APPROVAL_MISMATCH' using errcode='PT409';end if;
    v_confirm:=gen_random_uuid();
    insert into public.study_group_course_confirmations(request_id,group_id,actor_id,representative_id,academic_year,course,cohort_start_year,
      study_level,previous_cohort_start_year,previous_study_level,repair_pending,source)
      values(v_confirm,v_group.id,v_user,v_group.representative_id,p_academic_year,p_course,v_cohort,p_study_level,null,null,true,'administrator');
    update public.study_groups set cohort_start_year=v_cohort,study_level=p_study_level where id=v_group.id;
    update public.study_group_course_confirmations set repair_pending=false where request_id=v_confirm;
  end if;
  update public.study_group_identity_reviews set status='resolved',resolution_action=p_action,resolution_reason=v_reason,
    reviewed_by=v_user,reviewed_at=clock_timestamp() where id=v_case.id;
  return jsonb_build_object('id',v_case.id,'status','resolved','action',p_action,'group_id',v_group.id);
exception when unique_violation then raise exception 'GROUP_ALREADY_EXISTS' using errcode='PT409';
end;
$$;

revoke all on function public.xelay_request_study_group_identity_review(uuid,uuid,integer,text,integer,text,uuid),
  public.xelay_my_study_group_identity_reviews(),public.xelay_admin_study_group_identity_reviews(text,integer,integer),
  public.xelay_admin_resolve_study_group_identity_review(uuid,text,text,uuid,integer,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.xelay_request_study_group_identity_review(uuid,uuid,integer,text,integer,text,uuid),
  public.xelay_my_study_group_identity_reviews(),public.xelay_admin_study_group_identity_reviews(text,integer,integer),
  public.xelay_admin_resolve_study_group_identity_review(uuid,text,text,uuid,integer,text,integer) to authenticated;
notify pgrst,'reload schema';
commit;
