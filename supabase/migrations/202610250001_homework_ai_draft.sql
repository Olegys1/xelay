-- Server-only homework drafts share the existing seminar AI cost budget.
-- No pasted text, generated draft, model response, credential or token is stored.
-- No homework content, membership, role or client write grants are changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$ begin
  if to_regclass('public.profiles') is null
    or to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_group_deputy_requests') is null
    or to_regprocedure('public.xelay_study_group_permissions(uuid)') is null
    or to_regprocedure('public.xelay_group_write_access(uuid)') is null
    or to_regclass('public.seminar_ai_draft_usage') is null
    or to_regprocedure('public.xelay_seminar_ai_draft_allowed(uuid,uuid)') is null
    or to_regprocedure('public.xelay_reserve_seminar_ai_draft(uuid,uuid)') is null then
    raise exception 'HOMEWORK_AI_PREREQUISITES_MISSING'
      using hint='Apply the existing study-group/deputy and seminar AI budget migrations first. No changes were made.';
  end if;
end $preflight$;

-- Reuse the same table and global lock as seminars; no additional budget pool.

create or replace function public.xelay_homework_ai_draft_allowed(p_user_id uuid,p_group_id uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'HOMEWORK_AI_SERVICE_REQUIRED' using errcode='42501';
  end if;
  return p_user_id is not null and p_group_id is not null
    and p_user_id<>'00000000-0000-0000-0000-000000000000'::uuid
    and p_group_id<>'00000000-0000-0000-0000-000000000000'::uuid
    and exists(select 1 from auth.users u join public.profiles p on p.id=u.id
      where u.id=p_user_id and u.email_confirmed_at is not null and u.deleted_at is null
        and (u.banned_until is null or u.banned_until<=now()))
    and exists(select 1 from public.study_groups g where g.id=p_group_id and (
      g.representative_id=p_user_id or exists(select 1 from public.study_group_deputy_requests d
        join public.study_group_members m on m.group_id=d.group_id and m.user_id=d.user_id and m.status='accepted'
        where d.group_id=g.id and d.user_id=p_user_id and d.status='approved' and 'homework'=any(d.permissions))))
    and public.xelay_group_write_access(p_group_id);
end $$;

create or replace function public.xelay_reserve_homework_ai_draft(p_user_id uuid,p_group_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare
  v_day date;
  v_actor integer;
  v_group integer;
  v_global integer;
  v_global_id constant uuid:='00000000-0000-0000-0000-000000000000';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'HOMEWORK_AI_SERVICE_REQUIRED' using errcode='42501';
  end if;
  if p_user_id is null or p_group_id is null or p_user_id=v_global_id or p_group_id=v_global_id then
    raise exception 'HOMEWORK_AI_PERMISSION_REQUIRED' using errcode='42501';
  end if;
  -- Serialize against the existing representative/deputy/content changes.
  -- An administrator role alone never substitutes for appointment in this group.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:seminars:'||p_group_id::text,0));
  if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
    where u.id=p_user_id and u.email_confirmed_at is not null and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=clock_timestamp())) then
    raise exception 'HOMEWORK_AI_AUTH_REQUIRED' using errcode='42501';
  end if;
  if not public.xelay_homework_ai_draft_allowed(p_user_id,p_group_id) then
    raise exception 'HOMEWORK_AI_PERMISSION_REQUIRED' using errcode='42501';
  end if;
  -- One durable transaction lock covers all three budgets, even across server
  -- instances and simultaneous duplicate requests. Nothing is reserved partially.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:seminar-ai-draft:quota',0));
  v_day:=(clock_timestamp() at time zone 'Europe/Kyiv')::date;
  insert into public.seminar_ai_draft_usage(day,scope,scope_id) values
    (v_day,'actor',p_user_id),(v_day,'group',p_group_id),(v_day,'global',v_global_id)
    on conflict(day,scope,scope_id) do nothing;
  select attempts into v_actor from public.seminar_ai_draft_usage where day=v_day and scope='actor' and scope_id=p_user_id;
  select attempts into v_group from public.seminar_ai_draft_usage where day=v_day and scope='group' and scope_id=p_group_id;
  select attempts into v_global from public.seminar_ai_draft_usage where day=v_day and scope='global' and scope_id=v_global_id;
  if v_actor>=3 then raise exception 'HOMEWORK_AI_ACTOR_LIMIT' using errcode='54000'; end if;
  if v_group>=10 then raise exception 'HOMEWORK_AI_GROUP_LIMIT' using errcode='54000'; end if;
  if v_global>=100 then raise exception 'HOMEWORK_AI_GLOBAL_LIMIT' using errcode='54000'; end if;
  update public.seminar_ai_draft_usage set attempts=attempts+1 where day=v_day and (
    (scope='actor' and scope_id=p_user_id) or (scope='group' and scope_id=p_group_id)
    or (scope='global' and scope_id=v_global_id));
  delete from public.seminar_ai_draft_usage where day<=v_day-90;
  return true;
end $$;

revoke all on function public.xelay_homework_ai_draft_allowed(uuid,uuid),public.xelay_reserve_homework_ai_draft(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_homework_ai_draft_allowed(uuid,uuid),public.xelay_reserve_homework_ai_draft(uuid,uuid)
  to service_role;
comment on table public.seminar_ai_draft_usage is
  'Server-only shared seminar/homework draft attempt counters. Europe/Kyiv calendar day limits: actor 3, group 10, global 100. Retains counter IDs up to 90 days; no source/generated text and no client access.';
comment on function public.xelay_homework_ai_draft_allowed(uuid,uuid) is
  'Service-only readiness and authorization. Server first verifies bearer and caller-JWT homework permission; this helper independently checks confirmed active account and actual representative or accepted approved homework deputy.';
comment on function public.xelay_reserve_homework_ai_draft(uuid,uuid) is
  'Service-only atomic cost reservation before inference. The same group permission and global quota locks used by seminars prevent combined concurrent overspend. Failed provider calls remain counted. No homework content is created or changed.';
notify pgrst,'reload schema';
commit;
