-- An explicit operator-reviewed distinction can resolve one request versus one
-- legacy group whose cohort is unknown. It never assigns the old group a cohort,
-- transfers ownership, joins members or changes existing academic content.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('public.study_groups') is null
    or to_regclass('public.class_representative_requests') is null
    or to_regprocedure('public.xelay_create_study_group(uuid)') is null
    or to_regprocedure('public.xelay_private_profile_group_cohort(uuid,uuid,uuid,text)') is null
    or to_regclass('public.study_groups_academic_cohort_unique_idx') is null then
    raise exception 'Apply study group cohort identity 202610150007 before collision resolution';
  end if;
end;
$$;

create table if not exists public.study_group_cohort_collision_resolutions (
  request_id uuid not null references public.class_representative_requests(id) on delete cascade,
  existing_group_id uuid not null references public.study_groups(id) on delete cascade,
  request_user_id uuid not null,
  existing_representative_id uuid not null,
  existing_representative_request_id uuid not null,
  university_id uuid not null,
  academic_unit_id uuid not null,
  specialty text not null,
  group_name text not null,
  new_cohort_start_year integer not null check (new_cohort_start_year between 1900 and 2200),
  new_study_level text not null check (new_study_level in('bachelor','master','postgraduate')),
  existing_cohort_start_year integer,
  existing_study_level text,
  confirmed_at timestamptz not null default clock_timestamp(),
  reason text not null check (length(btrim(reason)) between 10 and 1000),
  primary key(request_id,existing_group_id),
  constraint study_group_cohort_resolution_legacy_unknown_check check (
    existing_cohort_start_year is null and existing_study_level is null)
);

comment on table public.study_group_cohort_collision_resolutions is
  'Private, explicit operator evidence that one approved known-cohort request is distinct from one still-unresolved legacy group. All captured identities must continue to match. No client grants, callable review RPC or automatic joins.';
alter table public.study_group_cohort_collision_resolutions enable row level security;
revoke all on table public.study_group_cohort_collision_resolutions
  from public,anon,authenticated,service_role;

-- Preserve the existing RPC's signature, owner, execute ACL and request scope.
create or replace function public.xelay_create_study_group(p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $create_group$
declare
  v_request public.class_representative_requests%rowtype;
  v_existing public.study_groups%rowtype;
  v_group_id uuid;
  v_cohort integer;
  v_level text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_request from public.class_representative_requests
    where id=p_request_id and user_id=auth.uid() and status='approved' for update;
  if not found then raise exception 'Approved class representative request not found'; end if;

  -- A legacy group remains accessible through its original approved request,
  -- including when its original cohort has not yet been established.
  select id into v_group_id from public.study_groups where representative_request_id=p_request_id;
  if found then return v_group_id; end if;

  if v_request.cohort_start_year is null then
    select c.cohort_start_year,c.study_level into v_cohort,v_level
      from public.xelay_private_profile_group_cohort(
        v_request.user_id,v_request.university_id,v_request.academic_unit_id,v_request.specialty) c;
    if v_cohort is not null and v_level is not null then
      update public.class_representative_requests
        set cohort_start_year=v_cohort,study_level=v_level where id=p_request_id
        returning * into v_request;
    end if;
  end if;
  -- Every newly created group needs a stable academic identity. This prevents
  -- new unique-name groups from becoming the next unresolved legacy collision.
  if v_request.cohort_start_year is null or v_request.study_level is null then
    raise exception 'GROUP_COHORT_REQUIRED' using errcode='P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'xelay-study-group-identity:'||v_request.university_id::text||':'||v_request.academic_unit_id::text
      ||':'||lower(btrim(v_request.specialty))||':'||lower(btrim(v_request.group_name)),0));

  -- An explicit legacy distinction never overrides an established same-cohort
  -- identity, and it never grants access to another representative's group.
  select * into v_existing from public.study_groups g
    where g.university_id=v_request.university_id and g.academic_unit_id=v_request.academic_unit_id
      and lower(btrim(g.specialty))=lower(btrim(v_request.specialty))
      and lower(btrim(g.group_name))=lower(btrim(v_request.group_name))
      and g.cohort_start_year=v_request.cohort_start_year and g.study_level=v_request.study_level;
  if found then
    if v_existing.representative_id=auth.uid() then return v_existing.id; end if;
    raise exception 'GROUP_ALREADY_EXISTS' using errcode='P0001';
  end if;

  -- Each unresolved collision must have its own matching reviewed record.
  -- Changed request ownership, scope, degree/cohort, old ownership or original
  -- request makes the exception stale; a review for another applicant cannot
  -- be reused. Known cohort snapshots are neither written nor reinterpreted.
  if exists(select 1 from public.study_groups g
    where g.university_id=v_request.university_id and g.academic_unit_id=v_request.academic_unit_id
      and lower(btrim(g.specialty))=lower(btrim(v_request.specialty))
      and lower(btrim(g.group_name))=lower(btrim(v_request.group_name))
      and (g.cohort_start_year is null or g.study_level is null)
      and not exists(select 1 from public.study_group_cohort_collision_resolutions r
        where r.request_id=v_request.id and r.existing_group_id=g.id
          and r.request_user_id=v_request.user_id
          and r.existing_representative_id=g.representative_id
          and r.existing_representative_request_id=g.representative_request_id
          and r.university_id=v_request.university_id and r.university_id=g.university_id
          and r.academic_unit_id=v_request.academic_unit_id and r.academic_unit_id=g.academic_unit_id
          and lower(btrim(r.specialty))=lower(btrim(v_request.specialty))
          and lower(btrim(r.specialty))=lower(btrim(g.specialty))
          and lower(btrim(r.group_name))=lower(btrim(v_request.group_name))
          and lower(btrim(r.group_name))=lower(btrim(g.group_name))
          and r.new_cohort_start_year=v_request.cohort_start_year
          and r.new_study_level=v_request.study_level
          and r.existing_cohort_start_year is not distinct from g.cohort_start_year
          and r.existing_study_level is not distinct from g.study_level)) then
    raise exception 'GROUP_IDENTITY_NEEDS_REVIEW' using errcode='P0001';
  end if;

  insert into public.study_groups(
    representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name,
    cohort_start_year,study_level)
  values(v_request.id,auth.uid(),v_request.university_id,v_request.academic_unit_id,
    v_request.specialty,v_request.group_name,v_request.cohort_start_year,v_request.study_level)
  returning id into v_group_id;
  insert into public.study_group_members(group_id,user_id,invited_by,status,accepted_at)
    values(v_group_id,auth.uid(),auth.uid(),'accepted',now());
  return v_group_id;
end;
$create_group$;

notify pgrst,'reload schema';
commit;
