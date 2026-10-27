-- Prepared locally. Department metadata never grants a verified teacher role.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.teacher_academic_profiles add column department text not null default '' check(length(department)<=180);
update public.teacher_academic_profiles a set department=r.department
from public.teacher_verification_requests r join public.profiles p on p.id=r.user_id
where a.user_id=r.user_id and r.university_id=p.university_id and r.academic_unit_id=p.academic_unit_id;

create or replace function public.xelay_private_teacher_academic_json(p_user_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('user_id',p_user_id,
    'department',coalesce(nullif(a.department,''),r.department,''),
    'department_options',coalesce((select jsonb_agg(jsonb_build_object('slug',d.slug,'name',d.name,'source_url',d.source_url) order by d.name)
      from public.academic_departments d where d.university_id=p.university_id and d.academic_unit_id=p.academic_unit_id and d.is_active),'[]'::jsonb),
    'position_code',coalesce(a.position_code,''),'position_other',coalesce(a.position_other,''),'is_postgraduate',coalesce(a.is_postgraduate,false),
    'requested_valid_until',a.requested_valid_until,'approved_valid_until',a.approved_valid_until,
    'access_period_pending',coalesce(a.access_period_pending,false),
    'access_expired',coalesce(a.approved_valid_until<(current_timestamp at time zone 'Europe/Kyiv')::date,false),
    'contact_email',coalesce(a.contact_email,''),'contact_phone',coalesce(a.contact_phone,''),'contact_telegram',coalesce(a.contact_telegram,''),
    'email_visible_to_groups',coalesce(a.email_visible_to_groups,false),'email_visible_public',coalesce(a.email_visible_public,false),
    'phone_visible_to_groups',coalesce(a.phone_visible_to_groups,false),'phone_visible_public',coalesce(a.phone_visible_public,false),
    'telegram_visible_to_groups',coalesce(a.telegram_visible_to_groups,false),'telegram_visible_public',coalesce(a.telegram_visible_public,false),'updated_at',a.updated_at)
  from(select 1) seed left join public.profiles p on p.id=p_user_id
  left join public.teacher_academic_profiles a on a.user_id=p_user_id
  left join public.teacher_verification_requests r on r.user_id=p_user_id and r.university_id=p.university_id and r.academic_unit_id=p.academic_unit_id;
$$;
revoke all on function public.xelay_private_teacher_academic_json(uuid) from public,anon,authenticated,service_role;

do $$
declare v_body text;v_old text;v_new text;
begin
  select replace(pg_get_functiondef('public.xelay_teacher_academic_profile_save(jsonb)'::regprocedure),chr(13),'') into v_body;
  v_old:='v_requested date;v_code text;v_other text;v_key text;';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'DEPARTMENT_PROFILE_VARIABLE_DRIFT'; end if;
  v_body:=replace(v_body,v_old,'v_requested date;v_code text;v_other text;v_key text;v_department text;v_scope record;');
  v_old:='key not in(''expected_user_id'',''position_code''';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'DEPARTMENT_PROFILE_KEYS_DRIFT'; end if;
  v_body:=replace(v_body,v_old,'key not in(''expected_user_id'',''department'',''position_code''');
  v_old:='v_period_changed:=v_requested is distinct from v_old.requested_valid_until;';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'DEPARTMENT_PROFILE_VALIDATE_DRIFT'; end if;
  v_new:=$patch$select p.university_id,p.academic_unit_id into v_scope from public.profiles p where p.id=v_uid;
  if p_profile ? 'department' and jsonb_typeof(p_profile->'department') is distinct from 'string' then
    raise exception 'TEACHER_DEPARTMENT_INVALID' using errcode='22023'; end if;
  v_department:=btrim(coalesce(p_profile->>'department',v_old.department,''));
  if v_department<>'' then
    perform public.xelay_private_validate_department(v_department,v_scope.university_id,v_scope.academic_unit_id,v_old.department);
  end if;
  $patch$;
  v_body:=replace(v_body,v_old,v_new||v_old);
  v_old:='teacher_academic_profiles(user_id,position_code,position_other,is_postgraduate';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'DEPARTMENT_PROFILE_INSERT_DRIFT'; end if;
  v_body:=replace(v_body,v_old,'teacher_academic_profiles(user_id,department,position_code,position_other,is_postgraduate');
  v_old:='values(v_uid,v_code,v_other,';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'DEPARTMENT_PROFILE_VALUES_DRIFT'; end if;
  v_body:=replace(v_body,v_old,'values(v_uid,v_department,v_code,v_other,');
  v_old:='on conflict(user_id) do update set position_code=excluded.position_code';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'DEPARTMENT_PROFILE_UPDATE_DRIFT'; end if;
  execute replace(v_body,v_old,'on conflict(user_id) do update set department=excluded.department,position_code=excluded.position_code');

  select replace(pg_get_functiondef('public.xelay_teacher_request(text,text,text,text,text)'::regprocedure),chr(13),'') into v_body;
  v_old:='select * into v_profile from public.profiles where id=v_uid;';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'DEPARTMENT_REQUEST_SCOPE_DRIFT'; end if;
  execute replace(v_body,v_old,v_old||E'\n  perform public.xelay_private_validate_department(p_department,v_profile.university_id,v_profile.academic_unit_id);');

  select replace(pg_get_functiondef('public.xelay_teacher_contacts(uuid,uuid)'::regprocedure),chr(13),'') into v_body;
  v_old:='''position'',coalesce(v_position,''''),''is_postgraduate''';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'DEPARTMENT_CONTACT_PROJECTION_DRIFT'; end if;
  execute replace(v_body,v_old,'''department'',coalesce(v_profile.department,''''),''position'',coalesce(v_position,''''),''is_postgraduate''');
end $$;

-- Existing execute grants, current-access guards, request contact validation,
-- user checks, expected revision, role approval and contact visibility remain.
notify pgrst,'reload schema';
commit;
