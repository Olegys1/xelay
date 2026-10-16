-- Read-only, paginated admin overview of the existing academic-group roster.
-- Existing RLS policies/grants and all group/member/content rows stay unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('auth.mfa_factors') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null then
    raise exception 'Apply the existing academic-group and admin MFA migrations first';
  end if;
end $$;

create or replace function public.xelay_admin_study_groups(
  p_query text default '',p_sort text default 'name',p_limit integer default 20,p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_query text := lower(btrim(coalesce(p_query,''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'));
  v_result jsonb;
begin
  if v_user_id is null or not coalesce(public.xelay_is_platform_admin(),false)
    or not exists(select 1 from public.profiles p where p.id=v_user_id)
    or not exists(select 1 from auth.users u where u.id=v_user_id and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=clock_timestamp()))
    or coalesce(auth.jwt()->>'aal','')<>'aal2'
    or not exists(select 1 from public.user_roles r where r.user_id=v_user_id and r.role='ADMIN')
    or not exists(select 1 from auth.mfa_factors f where f.user_id=v_user_id and f.status='verified') then
    raise exception 'ADMIN_MFA_REQUIRED' using errcode='42501';
  end if;
  if char_length(v_query)>120 or v_query ~ U&'[\0001-\001F\007F]' or p_sort is null or p_sort not in('name','members_desc','members_asc')
    or p_limit is null or p_limit not between 1 and 50 or p_offset is null or p_offset<0 then
    raise exception 'ADMIN_STUDY_GROUP_INPUT_INVALID' using errcode='22023';
  end if;
  with matched as materialized (
    select g.id,g.group_name,g.specialty,g.cohort_start_year,g.study_level,g.university_id,
      u.name as university_name,g.academic_unit_id,a.name as unit_name,g.representative_id,
      jsonb_build_object('id',p.id,'full_name',p.full_name,'username',p.username) as representative,g.created_at
    from public.study_groups g
    join public.universities u on u.id=g.university_id
    join public.academic_units a on a.id=g.academic_unit_id and a.university_id=g.university_id
    join public.profiles p on p.id=g.representative_id
    where v_query='' or strpos(lower(g.group_name),v_query)>0 or strpos(lower(g.specialty),v_query)>0
      or strpos(lower(coalesce(p.full_name,'')),v_query)>0 or strpos(lower(coalesce(p.username,'')),v_query)>0
      or strpos(lower('@'||p.username),v_query)>0
      or strpos(lower(u.name),v_query)>0 or strpos(lower(a.name),v_query)>0
  ), counted as (
    select g.id,g.group_name,g.specialty,g.cohort_start_year,g.study_level,g.university_id,
      g.university_name,g.academic_unit_id,g.unit_name,g.representative,g.created_at,
      1+count(distinct m.user_id) filter(where m.status='accepted') as accepted_count,
      count(distinct m.user_id) filter(where m.status='pending') as pending_count,
      count(distinct m.user_id) filter(where m.status in('rejected','removed')) as inactive_count
    from matched g left join public.study_group_members m on m.group_id=g.id and m.user_id<>g.representative_id
    group by g.id,g.group_name,g.specialty,g.cohort_start_year,g.study_level,g.university_id,
      g.university_name,g.academic_unit_id,g.unit_name,g.representative,g.created_at
  ), page as (
    select c.* from counted c
    order by case when p_sort='members_desc' then c.accepted_count end desc,
      case when p_sort='members_asc' then c.accepted_count end asc,lower(c.group_name),
      lower(c.university_name),lower(c.unit_name),c.cohort_start_year nulls last,c.study_level nulls last,c.id
    limit p_limit offset p_offset
  )
  select jsonb_build_object('total',(select count(*) from matched),'items',
    coalesce((select jsonb_agg(to_jsonb(p) order by
      case when p_sort='members_desc' then p.accepted_count end desc,
      case when p_sort='members_asc' then p.accepted_count end asc,lower(p.group_name),
      lower(p.university_name),lower(p.unit_name),p.cohort_start_year nulls last,p.study_level nulls last,p.id) from page p),'[]'::jsonb))
  into v_result;
  return v_result;
end $$;

create or replace function public.xelay_admin_study_group_members(
  p_group_id uuid,p_status text default 'accepted',p_query text default '',p_limit integer default 50,p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_query text := lower(btrim(coalesce(p_query,''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'));
  v_group jsonb;
  v_result jsonb;
begin
  if v_user_id is null or not coalesce(public.xelay_is_platform_admin(),false)
    or not exists(select 1 from public.profiles p where p.id=v_user_id)
    or not exists(select 1 from auth.users u where u.id=v_user_id and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=clock_timestamp()))
    or coalesce(auth.jwt()->>'aal','')<>'aal2'
    or not exists(select 1 from public.user_roles r where r.user_id=v_user_id and r.role='ADMIN')
    or not exists(select 1 from auth.mfa_factors f where f.user_id=v_user_id and f.status='verified') then
    raise exception 'ADMIN_MFA_REQUIRED' using errcode='42501';
  end if;
  if p_group_id is null or char_length(v_query)>120 or v_query ~ U&'[\0001-\001F\007F]' or p_status is null or p_status not in('accepted','pending','inactive')
    or p_limit is null or p_limit not between 1 and 50 or p_offset is null or p_offset<0 then
    raise exception 'ADMIN_STUDY_GROUP_INPUT_INVALID' using errcode='22023';
  end if;
  select jsonb_build_object('id',g.id,'group_name',g.group_name,'specialty',g.specialty,
    'cohort_start_year',g.cohort_start_year,'study_level',g.study_level,
    'university_id',g.university_id,'university_name',u.name,'academic_unit_id',g.academic_unit_id,'unit_name',a.name,
    'representative',jsonb_build_object('id',p.id,'full_name',p.full_name,'username',p.username),
    'accepted_count',1+count(distinct m.user_id) filter(where m.status='accepted'),
    'pending_count',count(distinct m.user_id) filter(where m.status='pending'),
    'inactive_count',count(distinct m.user_id) filter(where m.status in('rejected','removed')),'created_at',g.created_at)
  into v_group
  from public.study_groups g join public.universities u on u.id=g.university_id
  join public.academic_units a on a.id=g.academic_unit_id and a.university_id=g.university_id
  join public.profiles p on p.id=g.representative_id
  left join public.study_group_members m on m.group_id=g.id and m.user_id<>g.representative_id
  where g.id=p_group_id
  group by g.id,u.name,a.name,p.id;
  if not found then raise exception 'ADMIN_STUDY_GROUP_NOT_FOUND' using errcode='P0002'; end if;

  with roster as (
    -- A representative belongs to their group independently of a legacy
    -- missing/stale membership row. Never count them in another status too.
    select p.id as user_id,p.full_name,p.username,'accepted'::text as status,true as is_representative,
      m.created_at as invited_at,m.accepted_at
    from public.study_groups g join public.profiles p on p.id=g.representative_id
    left join public.study_group_members m on m.group_id=g.id and m.user_id=g.representative_id
    where g.id=p_group_id
    union all
    select p.id,p.full_name,p.username,m.status,false,m.created_at,m.accepted_at
    from public.study_group_members m join public.profiles p on p.id=m.user_id
    join public.study_groups g on g.id=m.group_id
    where m.group_id=p_group_id and m.user_id<>g.representative_id
  ), matched as materialized (
    select r.* from roster r where
      ((p_status='inactive' and r.status in('rejected','removed')) or r.status=p_status)
      and (v_query='' or strpos(lower(coalesce(r.full_name,'')),v_query)>0 or strpos(lower(coalesce(r.username,'')),v_query)>0
        or strpos(lower('@'||r.username),v_query)>0)
  ), page as (
    select r.* from matched r order by r.is_representative desc,
      lower(coalesce(nullif(btrim(r.full_name),''),r.username,'')),lower(coalesce(r.username,'')),r.user_id
    limit p_limit offset p_offset
  )
  select jsonb_build_object('group',v_group,'total',(select count(*) from matched),'items',
    coalesce((select jsonb_agg(to_jsonb(p) order by p.is_representative desc,
      lower(coalesce(nullif(btrim(p.full_name),''),p.username,'')),lower(coalesce(p.username,'')),p.user_id) from page p),'[]'::jsonb))
  into v_result;
  return v_result;
end $$;

revoke all on function public.xelay_admin_study_groups(text,text,integer,integer) from public,anon,authenticated,service_role;
revoke all on function public.xelay_admin_study_group_members(uuid,text,text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.xelay_admin_study_groups(text,text,integer,integer) to authenticated;
grant execute on function public.xelay_admin_study_group_members(uuid,text,text,integer,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
