begin;

-- Personal display preferences share the order version and never alter grades.
alter table public.teaching_journal_preferences add column if not exists view_settings jsonb not null
  default '{"layout":"combined","show_lectures":true,"section":"all"}'::jsonb;
alter table public.teaching_journal_preferences add constraint teaching_journal_view_settings_valid check (
  jsonb_typeof(view_settings)='object'
  and view_settings ?& ARRAY['layout','show_lectures','section']
  and view_settings->>'layout' in ('combined','separate')
  and jsonb_typeof(view_settings->'show_lectures')='boolean'
  and view_settings->>'section' in ('all','lectures','seminars')
  and (view_settings->>'layout'<>'combined' or view_settings->>'section'='all')
  and (view_settings->>'layout'<>'separate' or view_settings->>'section' in ('lectures','seminars'))
  and (view_settings->>'show_lectures'<>'false' or view_settings->>'section'<>'lectures')
  and view_settings-ARRAY['layout','show_lectures','section']='{}'::jsonb
);

create or replace function public.xelay_teaching_journal_preferences(p_course_id uuid,p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_result jsonb;
begin
  if not 'grades'=any(public.xelay_teaching_group_permissions(p_course_id,p_group_id,v_uid)) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  select jsonb_build_object('activity_ids',activity_ids,'version',version,'view_settings',view_settings) into v_result
    from public.teaching_journal_preferences where user_id=v_uid and course_id=p_course_id and group_id=p_group_id;
  return coalesce(v_result,'{"activity_ids":[],"version":0,"view_settings":{"layout":"combined","show_lectures":true,"section":"all"}}'::jsonb);
end $$;

create function public.xelay_teaching_save_journal_view(p_course_id uuid,p_group_id uuid,p_settings jsonb,p_version integer,p_expected_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_previous public.teaching_journal_preferences%rowtype;
begin
  if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED';end if;
  if not public.xelay_teaching_is_verified(v_uid) or not public.xelay_teaching_has_current_access(v_uid)
    or not 'grades'=any(public.xelay_teaching_group_permissions(p_course_id,p_group_id,v_uid)) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  if p_settings is null or jsonb_typeof(p_settings) is distinct from 'object'
    or p_settings->>'layout' is null or p_settings->>'layout' not in ('combined','separate')
    or jsonb_typeof(p_settings->'show_lectures') is distinct from 'boolean'
    or p_settings->>'section' is null or p_settings->>'section' not in ('all','lectures','seminars')
    or (p_settings->>'layout'='combined' and p_settings->>'section'<>'all')
    or (p_settings->>'layout'='separate' and p_settings->>'section'='all')
    or (p_settings->>'show_lectures'='false' and p_settings->>'section'='lectures')
    or p_settings-ARRAY['layout','show_lectures','section']<>'{}'::jsonb then raise exception 'TEACHING_INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:journal-order:'||v_uid::text||':'||p_course_id::text||':'||p_group_id::text,0));
  select * into v_previous from public.teaching_journal_preferences where user_id=v_uid and course_id=p_course_id and group_id=p_group_id for update;
  if coalesce(v_previous.version,0) is distinct from p_version then raise exception 'TEACHING_CONFLICT';end if;
  if v_previous.view_settings is not distinct from p_settings then return public.xelay_teaching_journal_preferences(p_course_id,p_group_id);end if;
  insert into public.teaching_journal_preferences(user_id,course_id,group_id,view_settings) values(v_uid,p_course_id,p_group_id,p_settings)
    on conflict(user_id,course_id,group_id) do update set view_settings=excluded.view_settings,version=teaching_journal_preferences.version+1,updated_at=now();
  return public.xelay_teaching_journal_preferences(p_course_id,p_group_id);
end $$;

revoke all on function public.xelay_teaching_journal_preferences(uuid,uuid),public.xelay_teaching_save_journal_view(uuid,uuid,jsonb,integer,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_journal_preferences(uuid,uuid),public.xelay_teaching_save_journal_view(uuid,uuid,jsonb,integer,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
