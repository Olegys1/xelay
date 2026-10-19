-- Server-only cost limits for drafting seminars from pasted questions.
-- No pasted text, generated draft, model response, credential or token is stored.
-- Existing seminar content/membership/role grants remain unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$ begin
  if to_regclass('public.profiles') is null
    or to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_group_deputy_requests') is null
    or to_regprocedure('public.xelay_study_group_permissions(uuid)') is null
    or to_regprocedure('public.xelay_group_write_access(uuid)') is null then
    raise exception 'SEMINAR_AI_PREREQUISITES_MISSING'
      using hint='Apply existing study-group seminar/deputy permission migrations first. No changes were made.';
  end if;
end $preflight$;

create table if not exists public.seminar_ai_draft_usage (
  day date not null check(isfinite(day)),
  scope text not null check(scope in('actor','group','global')),
  scope_id uuid not null,
  attempts integer not null default 0 check(attempts between 0 and 100),
  primary key(day,scope,scope_id),
  constraint seminar_ai_draft_global_scope check(
    (scope='global')=(scope_id='00000000-0000-0000-0000-000000000000'::uuid))
);
alter table public.seminar_ai_draft_usage enable row level security;
revoke all on table public.seminar_ai_draft_usage from public,anon,authenticated,service_role;

create or replace function public.xelay_seminar_ai_draft_allowed(p_user_id uuid,p_group_id uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SEMINAR_AI_SERVICE_REQUIRED' using errcode='42501';
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
        where d.group_id=g.id and d.user_id=p_user_id and d.status='approved' and 'seminars'=any(d.permissions))))
    and public.xelay_group_write_access(p_group_id);
end $$;

create or replace function public.xelay_reserve_seminar_ai_draft(p_user_id uuid,p_group_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare
  v_day date;
  v_actor integer;
  v_group integer;
  v_global integer;
  v_global_id constant uuid:='00000000-0000-0000-0000-000000000000';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SEMINAR_AI_SERVICE_REQUIRED' using errcode='42501';
  end if;
  if p_user_id is null or p_group_id is null or p_user_id=v_global_id or p_group_id=v_global_id then
    raise exception 'SEMINAR_AI_PERMISSION_REQUIRED' using errcode='42501';
  end if;
  -- Serialize against the existing representative/deputy/content changes.
  -- An administrator role alone never substitutes for appointment in this group.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:seminars:'||p_group_id::text,0));
  if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
    where u.id=p_user_id and u.email_confirmed_at is not null and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=clock_timestamp())) then
    raise exception 'SEMINAR_AI_AUTH_REQUIRED' using errcode='42501';
  end if;
  if not public.xelay_seminar_ai_draft_allowed(p_user_id,p_group_id) then
    raise exception 'SEMINAR_AI_PERMISSION_REQUIRED' using errcode='42501';
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
  if v_actor>=3 then raise exception 'SEMINAR_AI_ACTOR_LIMIT' using errcode='54000'; end if;
  if v_group>=10 then raise exception 'SEMINAR_AI_GROUP_LIMIT' using errcode='54000'; end if;
  if v_global>=100 then raise exception 'SEMINAR_AI_GLOBAL_LIMIT' using errcode='54000'; end if;
  update public.seminar_ai_draft_usage set attempts=attempts+1 where day=v_day and (
    (scope='actor' and scope_id=p_user_id) or (scope='group' and scope_id=p_group_id)
    or (scope='global' and scope_id=v_global_id));
  delete from public.seminar_ai_draft_usage where day<=v_day-90;
  return true;
end $$;

revoke all on function public.xelay_seminar_ai_draft_allowed(uuid,uuid),public.xelay_reserve_seminar_ai_draft(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_seminar_ai_draft_allowed(uuid,uuid),public.xelay_reserve_seminar_ai_draft(uuid,uuid)
  to service_role;
comment on table public.seminar_ai_draft_usage is
  'Server-only seminar draft attempt counters. Europe/Kyiv calendar day limits: actor 3, group 10, global 100. Retains counter IDs up to 90 days; no source/generated text and no client access.';
comment on function public.xelay_seminar_ai_draft_allowed(uuid,uuid) is
  'Service-only readiness and authorization. Server first verifies bearer and caller-JWT seminars permission; this helper independently checks confirmed active account and actual representative or accepted approved seminars deputy.';
comment on function public.xelay_reserve_seminar_ai_draft(uuid,uuid) is
  'Service-only atomic cost reservation before inference. Existing group permission lock and durable global quota lock prevent concurrent overspend. Failed provider calls remain counted. No seminar content is created or changed.';
notify pgrst,'reload schema';
commit;
