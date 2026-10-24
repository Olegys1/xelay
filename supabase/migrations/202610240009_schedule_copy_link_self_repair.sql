-- Reviewed repair of old empty weekend copies by an existing schedule editor.
-- The real user remains the recorded actor; group ownership is unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $prerequisites$
begin
  if to_regprocedure('public.xelay_private_schedule_copy_link_guard()') is null
    or to_regprocedure('public.xelay_lock_study_group_permission(uuid,text,boolean)') is null
    or to_regprocedure('public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date)') is null
    or to_regprocedure('public.xelay_repair_my_schedule_copy_links(uuid,boolean,text,uuid)') is not null then
    raise exception 'SCHEDULE_COPY_LINK_REPAIR_PREREQUISITE_OR_SCHEMA_DRIFT';
  end if;
end $prerequisites$;

create temporary table xelay_schedule_copy_self_repair_baseline on commit drop as
select jsonb_build_object(
  'schedule_count',(select count(*) from public.study_group_schedule),
  'schedule_hash',(select md5(string_agg(to_jsonb(s)::text,E'\n' order by s.id)) from public.study_group_schedule s),
  'schedule_access',(select jsonb_build_object('rls',c.relrowsecurity,'acl',c.relacl::text)
    from pg_class c where c.oid='public.study_group_schedule'::regclass),
  'schedule_policies',(select jsonb_agg(jsonb_build_object('name',p.polname,'roles',p.polroles,
    'cmd',p.polcmd,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))
    order by p.polname) from pg_policy p where p.polrelid='public.study_group_schedule'::regclass),
  'delegated_guard',pg_get_functiondef('public.xelay_validate_study_group_delegated_content()'::regprocedure),
  'member_policy',pg_get_functiondef('public.xelay_can_view_seminars(uuid)'::regprocedure)
) data;
alter table xelay_schedule_copy_self_repair_baseline enable row level security;

create function public.xelay_repair_my_schedule_copy_links(
  p_group_id uuid,p_preview boolean default true,p_signature text default null,p_expected_user_id uuid default null
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_uid uuid:=auth.uid();
  v_today date:=(clock_timestamp() at time zone 'Europe/Kyiv')::date;
  v_snapshot jsonb;v_pairs jsonb;v_signature text;v_pair jsonb;
  v_count integer;v_changed integer;v_repaired integer:=0;
begin
  if v_uid is null or p_expected_user_id is distinct from v_uid then
    raise exception 'SCHEDULE_COPY_LINK_REPAIR_ACTOR_CHANGED' using errcode='42501';
  end if;
  if p_group_id is null or p_preview is null or(not p_preview and(p_signature is null or p_signature!~'^[a-f0-9]{64}$')) then
    raise exception 'SCHEDULE_COPY_LINK_REPAIR_INVALID' using errcode='22023';
  end if;
  -- Reuse existing group authorization and its advisory lock. All source and
  -- target rows are then locked in stable order before planning or applying.
  perform public.xelay_lock_study_group_permission(p_group_id,'schedule',true);
  perform s.id from public.study_group_schedule s where s.group_id=p_group_id order by s.id for update;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]'::jsonb) into v_snapshot
    from public.study_group_schedule s where s.group_id=p_group_id;

  with targets as (
    select t.* from public.study_group_schedule t
    where t.group_id=p_group_id and t.valid_from=t.valid_until and t.valid_from>=v_today
      and t.weekday in(6,7) and t.weekday=extract(isodow from t.valid_from)::smallint
      and not(t.valid_from=any(t.excluded_dates))
      and t.copied_from_schedule_id is null and not t.inherit_source_links
      and nullif(btrim(t.online_url),'') is null and nullif(btrim(t.online_url_secondary),'') is null
      and nullif(btrim(t.online_url_label),'') is null and nullif(btrim(t.online_url_secondary_label),'') is null
  ), candidates as (
    select t.id target_id,s.id source_id,t.subject,t.lesson_type,t.valid_from target_date,
      t.starts_at,t.ends_at,
      (t.valid_from-(extract(isodow from t.valid_from)::integer-1)+(s.weekday::integer-1)) source_date,
      count(*) over(partition by t.id) candidate_count
    from targets t join public.study_group_schedule s on s.group_id=t.group_id and s.id<>t.id
      and s.valid_from<s.valid_until and s.copied_from_schedule_id is null and s.weekday between 1 and 5
      and t.valid_from between s.valid_from and s.valid_until
      and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(t.subject)
      and s.lesson_type=t.lesson_type
      and public.xelay_academic_subject_key(s.teacher_name)=public.xelay_academic_subject_key(t.teacher_name)
      and public.xelay_academic_subject_key(s.location)=public.xelay_academic_subject_key(t.location)
      and s.starts_at=t.starts_at and s.ends_at=t.ends_at
      and(nullif(btrim(s.online_url),'') is not null or nullif(btrim(s.online_url_secondary),'') is not null)
      and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,
        t.valid_from-(extract(isodow from t.valid_from)::integer-1)+(s.weekday::integer-1))
      and not((t.valid_from-(extract(isodow from t.valid_from)::integer-1)+(s.weekday::integer-1))=any(s.excluded_dates))
  )
  select coalesce(jsonb_agg(jsonb_build_object('source_id',source_id,'target_id',target_id,
    'subject',subject,'lesson_type',lesson_type,'source_date',source_date,'target_date',target_date,
    'starts_at',starts_at,'ends_at',ends_at) order by target_date,starts_at,target_id),'[]'::jsonb)
    into v_pairs from candidates where candidate_count=1;
  v_count:=jsonb_array_length(v_pairs);
  if v_count>100 then raise exception 'SCHEDULE_COPY_LINK_REPAIR_TOO_LARGE' using errcode='22023';end if;
  -- Includes the actor and every current group row, including link values.
  -- A source edit, new ambiguous candidate or account switch invalidates it.
  v_signature:=encode(sha256(convert_to(jsonb_build_object('contract',1,'actor',v_uid,
    'group_id',p_group_id,'schedule',v_snapshot,'pairs',v_pairs)::text,'UTF8')),'hex');
  if not p_preview then
    if p_signature is distinct from v_signature then
      raise exception 'SCHEDULE_COPY_LINK_REPAIR_CONFLICT' using errcode='40001';
    end if;
    for v_pair in select value from jsonb_array_elements(v_pairs) loop
      update public.study_group_schedule t
        set copied_from_schedule_id=(v_pair->>'source_id')::uuid,inherit_source_links=true
        where t.id=(v_pair->>'target_id')::uuid and t.group_id=p_group_id
          and t.copied_from_schedule_id is null and not t.inherit_source_links
          and nullif(btrim(t.online_url),'') is null and nullif(btrim(t.online_url_secondary),'') is null
          and nullif(btrim(t.online_url_label),'') is null and nullif(btrim(t.online_url_secondary_label),'') is null;
      get diagnostics v_changed=row_count;
      if v_changed<>1 then raise exception 'SCHEDULE_COPY_LINK_REPAIR_CONFLICT' using errcode='40001';end if;
      v_repaired:=v_repaired+v_changed;
    end loop;
  end if;
  return jsonb_build_object('count',v_count,'signature',v_signature,'pairs',v_pairs,'repaired',v_repaired);
end $$;
revoke all on function public.xelay_repair_my_schedule_copy_links(uuid,boolean,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_repair_my_schedule_copy_links(uuid,boolean,text,uuid) to authenticated;

do $unchanged$
declare v_before jsonb;v_after jsonb;v_routine regprocedure;
begin
  select data into v_before from xelay_schedule_copy_self_repair_baseline;
  select jsonb_build_object(
    'schedule_count',(select count(*) from public.study_group_schedule),
    'schedule_hash',(select md5(string_agg(to_jsonb(s)::text,E'\n' order by s.id)) from public.study_group_schedule s),
    'schedule_access',(select jsonb_build_object('rls',c.relrowsecurity,'acl',c.relacl::text)
      from pg_class c where c.oid='public.study_group_schedule'::regclass),
    'schedule_policies',(select jsonb_agg(jsonb_build_object('name',p.polname,'roles',p.polroles,
      'cmd',p.polcmd,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))
      order by p.polname) from pg_policy p where p.polrelid='public.study_group_schedule'::regclass),
    'delegated_guard',pg_get_functiondef('public.xelay_validate_study_group_delegated_content()'::regprocedure),
    'member_policy',pg_get_functiondef('public.xelay_can_view_seminars(uuid)'::regprocedure)
  ) into v_after;
  if v_before is distinct from v_after then raise exception 'SCHEDULE_COPY_LINK_REPAIR_UNEXPECTED_DATA_OR_ACCESS_CHANGE';end if;
  v_routine:='public.xelay_repair_my_schedule_copy_links(uuid,boolean,text,uuid)'::regprocedure;
  if not has_function_privilege('authenticated',v_routine,'execute')
    or has_function_privilege('anon',v_routine,'execute')
    or has_function_privilege('service_role',v_routine,'execute')
    or exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=v_routine and a.grantee=0 and a.privilege_type='EXECUTE') then
    raise exception 'SCHEDULE_COPY_LINK_SELF_REPAIR_ACL_CONTRACT';
  end if;
end $unchanged$;
notify pgrst,'reload schema';
select jsonb_build_object('release','schedule-copy-link-self-repair-20261024','receipt',gen_random_uuid(),
  'applied_at',clock_timestamp(),'existing_data_unchanged',true,'rls_and_existing_guards_unchanged',true,
  'automatic_backfill',false,'existing_schedule_editor_required',true) as schedule_copy_link_self_repair_release;
commit;
