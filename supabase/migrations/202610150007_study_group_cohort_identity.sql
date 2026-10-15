-- Distinguish recurring academic group names by immutable degree/cohort.
-- Existing ownership, memberships, academic content, RLS and grants stay intact.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if to_regclass('public.class_representative_requests') is null
    or to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regprocedure('public.xelay_create_study_group(uuid)') is null
    or not exists(select 1 from pg_catalog.pg_attribute
      where attrelid=to_regclass('public.profiles') and not attisdropped
        and attname in('study_year','study_year_academic_year','experience','university_id','academic_unit_id','specialty')
      group by attrelid having count(*)=6) then
    raise exception 'STUDY_GROUP_COHORT_PREREQUISITES_MISSING';
  end if;
end;
$preflight$;

-- The migration is atomic; block concurrent creation while replacing identity.
lock table public.class_representative_requests, public.study_groups in share row exclusive mode;
alter table public.class_representative_requests
  add column if not exists cohort_start_year integer,
  add column if not exists study_level text;
alter table public.study_groups
  add column if not exists cohort_start_year integer,
  add column if not exists study_level text;

-- Retrying the migration may fill newly recoverable legacy snapshots. Guards
-- are restored in this same transaction before concurrent writes can resume.
drop trigger if exists class_rep_request_cohort_snapshot on public.class_representative_requests;
drop trigger if exists study_group_cohort_snapshot_immutable on public.study_groups;

create or replace function public.xelay_private_profile_group_cohort(
  p_user_id uuid, p_university_id uuid, p_academic_unit_id uuid, p_specialty text
)
returns table(cohort_start_year integer, study_level text)
language sql stable security definer set search_path = ''
as $profile_cohort$
  select (p.study_year_academic_year::integer-p.study_year::integer+1), p.experience::text
  from public.profiles p
  where p.id=p_user_id and p.university_id=p_university_id
    and p.academic_unit_id=p_academic_unit_id
    and lower(btrim(coalesce(p.specialty,'')))=lower(btrim(coalesce(p_specialty,'')))
    and p.experience in('bachelor','master','postgraduate')
    and p.study_year between 1 and 6
    and p.study_year_academic_year::integer-p.study_year::integer+1 between 1900 and 2200;
$profile_cohort$;
revoke all on function public.xelay_private_profile_group_cohort(uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;

-- Use the profile's recorded academic anchor, never the wall-clock year: an
-- annual progression or a temporarily delayed job cannot shift the cohort.
with resolved as (
  select r.id, c.cohort_start_year, c.study_level
  from public.class_representative_requests r
  cross join lateral public.xelay_private_profile_group_cohort(
    r.user_id,r.university_id,r.academic_unit_id,r.specialty) c
  where r.cohort_start_year is null and r.study_level is null
)
update public.class_representative_requests r
  set cohort_start_year=c.cohort_start_year, study_level=c.study_level
  from resolved c where r.id=c.id;

update public.study_groups g
  set cohort_start_year=r.cohort_start_year, study_level=r.study_level
  from public.class_representative_requests r
  where r.id=g.representative_request_id
    and g.cohort_start_year is null and g.study_level is null
    and r.cohort_start_year is not null and r.study_level is not null
    and r.user_id=g.representative_id and r.university_id=g.university_id
    and r.academic_unit_id=g.academic_unit_id
    and lower(btrim(r.specialty))=lower(btrim(g.specialty));

-- If the representative has no recorded course, accepted members may supply
-- evidence. Every known degree and every known anchored course must agree;
-- incomplete profiles cannot vote for a contradictory cohort. Pending members
-- and members from a different academic identity are not evidence.
with evidence as (
  select g.id,
    case when p.experience in('bachelor','master','postgraduate') then p.experience end as known_level,
    case when p.study_year between 1 and 6
      and p.study_year_academic_year::integer-p.study_year::integer+1 between 1900 and 2200
      then p.study_year_academic_year::integer-p.study_year::integer+1 end as known_cohort
  from public.study_groups g
  join public.study_group_members m on m.group_id=g.id and m.status='accepted'
  join public.profiles p on p.id=m.user_id
    and p.university_id=g.university_id and p.academic_unit_id=g.academic_unit_id
    and lower(btrim(coalesce(p.specialty,'')))=lower(btrim(g.specialty))
  where g.cohort_start_year is null and g.study_level is null
), consensus as (
  select id, min(known_cohort) as cohort_start_year, min(known_level) as study_level
  from evidence group by id
  having count(*) filter(where known_level is not null and known_cohort is not null)>0
    and count(distinct known_level)=1 and count(distinct known_cohort)=1
)
update public.study_groups g
  set cohort_start_year=c.cohort_start_year, study_level=c.study_level
  from consensus c where g.id=c.id;

update public.class_representative_requests r
  set cohort_start_year=g.cohort_start_year, study_level=g.study_level
  from public.study_groups g
  where g.representative_request_id=r.id
    and r.cohort_start_year is null and r.study_level is null
    and g.cohort_start_year is not null and g.study_level is not null;

do $constraints$
begin
  if not exists(select 1 from pg_catalog.pg_constraint
    where conrelid='public.class_representative_requests'::regclass
      and conname='class_rep_request_cohort_pair_check') then
    alter table public.class_representative_requests add constraint class_rep_request_cohort_pair_check check(
      (cohort_start_year is null and study_level is null)
      or (cohort_start_year is not null and study_level is not null
        and cohort_start_year between 1900 and 2200
        and study_level in('bachelor','master','postgraduate')));
  end if;
  if not exists(select 1 from pg_catalog.pg_constraint
    where conrelid='public.study_groups'::regclass
      and conname='study_group_cohort_pair_check') then
    alter table public.study_groups add constraint study_group_cohort_pair_check check(
      (cohort_start_year is null and study_level is null)
      or (cohort_start_year is not null and study_level is not null
        and cohort_start_year between 1900 and 2200
        and study_level in('bachelor','master','postgraduate')));
  end if;
end;
$constraints$;

create unique index if not exists study_groups_academic_cohort_unique_idx
  on public.study_groups(university_id,academic_unit_id,lower(btrim(specialty)),
    lower(btrim(group_name)),coalesce(cohort_start_year,0),coalesce(study_level,''));
drop index if exists public.study_groups_academic_identity_unique_idx;

create or replace function public.xelay_guard_class_rep_cohort_snapshot()
returns trigger language plpgsql security definer set search_path = ''
as $request_snapshot$
declare
  v_cohort integer;
  v_level text;
begin
  if tg_op='UPDATE'
    and new.cohort_start_year is not distinct from old.cohort_start_year
    and new.study_level is not distinct from old.study_level then
    return new;
  end if;
  select c.cohort_start_year,c.study_level into v_cohort,v_level
    from public.xelay_private_profile_group_cohort(
      new.user_id,new.university_id,new.academic_unit_id,new.specialty) c;
  if tg_op='INSERT' then
    -- This also protects the existing direct INSERT policy: submitted snapshot
    -- fields are always overwritten with the request owner's actual profile.
    new.cohort_start_year:=v_cohort;
    new.study_level:=v_level;
    return new;
  end if;
  -- A legacy missing snapshot can be repaired once, by its owner, from a
  -- complete matching profile. No other request field changes in that write.
  if old.cohort_start_year is not null or old.study_level is not null
    or auth.uid() is null or new.user_id is distinct from auth.uid()
    or v_cohort is null or v_level is null
    or new.cohort_start_year is distinct from v_cohort
    or new.study_level is distinct from v_level
    or (to_jsonb(new)-'cohort_start_year'-'study_level')
      is distinct from (to_jsonb(old)-'cohort_start_year'-'study_level') then
    raise exception 'GROUP_COHORT_SNAPSHOT_IMMUTABLE' using errcode='42501';
  end if;
  return new;
end;
$request_snapshot$;
revoke all on function public.xelay_guard_class_rep_cohort_snapshot()
  from public, anon, authenticated, service_role;
create trigger class_rep_request_cohort_snapshot before insert or update
  on public.class_representative_requests for each row
  execute function public.xelay_guard_class_rep_cohort_snapshot();

create or replace function public.xelay_guard_study_group_cohort_snapshot()
returns trigger language plpgsql security definer set search_path = ''
as $group_snapshot$
begin
  if new.cohort_start_year is distinct from old.cohort_start_year
    or new.study_level is distinct from old.study_level then
    raise exception 'GROUP_COHORT_SNAPSHOT_IMMUTABLE' using errcode='42501';
  end if;
  return new;
end;
$group_snapshot$;
revoke all on function public.xelay_guard_study_group_cohort_snapshot()
  from public, anon, authenticated, service_role;
create trigger study_group_cohort_snapshot_immutable before update
  on public.study_groups for each row
  execute function public.xelay_guard_study_group_cohort_snapshot();

-- Preserve this RPC's existing signature, owner and EXECUTE grants.
create or replace function public.xelay_create_study_group(p_request_id uuid)
returns uuid language plpgsql security definer set search_path = ''
as $create_group$
declare
  v_request public.class_representative_requests%rowtype;
  v_existing public.study_groups%rowtype;
  v_group_id uuid;
  v_cohort integer;
  v_level text;
  v_has_base_collision boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_request from public.class_representative_requests
    where id=p_request_id and user_id=auth.uid() and status='approved' for update;
  if not found then raise exception 'Approved class representative request not found'; end if;

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

  -- Serialize requests sharing the old base identity, including unknown legacy
  -- cohorts. The unique index alone cannot block known-versus-unknown overlap.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'xelay-study-group-identity:'||v_request.university_id::text||':'||v_request.academic_unit_id::text
      ||':'||lower(btrim(v_request.specialty))||':'||lower(btrim(v_request.group_name)),0));
  select exists(select 1 from public.study_groups g
    where g.university_id=v_request.university_id and g.academic_unit_id=v_request.academic_unit_id
      and lower(btrim(g.specialty))=lower(btrim(v_request.specialty))
      and lower(btrim(g.group_name))=lower(btrim(v_request.group_name))) into v_has_base_collision;

  if v_has_base_collision then
    if v_request.cohort_start_year is null or v_request.study_level is null then
      raise exception 'GROUP_COHORT_REQUIRED' using errcode='P0001';
    end if;
    if exists(select 1 from public.study_groups g
      where g.university_id=v_request.university_id and g.academic_unit_id=v_request.academic_unit_id
        and lower(btrim(g.specialty))=lower(btrim(v_request.specialty))
        and lower(btrim(g.group_name))=lower(btrim(v_request.group_name))
        and (g.cohort_start_year is null or g.study_level is null)) then
      raise exception 'GROUP_IDENTITY_NEEDS_REVIEW' using errcode='P0001';
    end if;
    select * into v_existing from public.study_groups g
      where g.university_id=v_request.university_id and g.academic_unit_id=v_request.academic_unit_id
        and lower(btrim(g.specialty))=lower(btrim(v_request.specialty))
        and lower(btrim(g.group_name))=lower(btrim(v_request.group_name))
        and g.cohort_start_year=v_request.cohort_start_year and g.study_level=v_request.study_level;
    if found then
      if v_existing.representative_id=auth.uid() then return v_existing.id; end if;
      raise exception 'GROUP_ALREADY_EXISTS' using errcode='P0001';
    end if;
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

commit;
