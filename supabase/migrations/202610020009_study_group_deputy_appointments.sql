-- Representatives appoint deputies directly; member applications are retired.
-- Apply after 202610020008. Existing approved appointments and all content,
-- membership, billing and resource permissions retain their existing contracts.
begin;

do $$
begin
  if to_regclass('public.study_group_deputy_requests') is null
    or to_regprocedure('public.xelay_normalize_study_group_permissions(text[])') is null
    or to_regprocedure('public.xelay_lock_study_group_deputy_reviewer(uuid)') is null
    or to_regprocedure('public.xelay_update_study_group_deputy_permissions(uuid,text[])') is null
    or to_regprocedure('public.xelay_revoke_study_group_deputy(uuid)') is null then
    raise exception 'Apply 202610020008_study_group_deputies before direct deputy appointments';
  end if;
end;
$$;

-- No new pending application may be created, including by an old RPC already
-- in flight when this migration commits. Historic terminal rows remain valid.
create or replace function public.xelay_guard_study_group_deputy_appointments()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.status='pending' then
    raise exception 'DEPUTY_APPLICATIONS_DISABLED' using errcode='42501';
  end if;
  return new;
end;
$$;
drop trigger if exists study_group_deputy_appointment_guard on public.study_group_deputy_requests;
create trigger study_group_deputy_appointment_guard before insert or update on public.study_group_deputy_requests
  for each row execute function public.xelay_guard_study_group_deputy_appointments();

-- Keep the established trigger name/table and NotificationPanel routing, but
-- describe an appointment rather than approval of a member application.
create or replace function public.xelay_notify_study_group_deputy_request()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_rep uuid; v_name text; v_type text; v_message text; v_actor_id uuid; v_actor_name text;
begin
  select g.representative_id,g.group_name into v_rep,v_name from public.study_groups g where g.id=new.group_id;
  if v_rep is null or not exists (select 1 from public.profiles where id=new.user_id) then return new; end if;
  if new.status='approved' then
    if tg_op='INSERT' then
      v_type := 'group_deputy_assigned';
      v_message := 'призначив(-ла) вас заступником старости у групі «' || v_name || '».';
    elsif old.status<>'approved' then
      v_type := 'group_deputy_assigned';
      v_message := 'призначив(-ла) вас заступником старости у групі «' || v_name || '».';
    elsif new.permissions is distinct from old.permissions then
      v_type := 'group_deputy_permissions';
      v_message := 'змінив(-ла) ваші права заступника у групі «' || v_name || '».';
    else return new;
    end if;
  elsif tg_op='UPDATE' then
    if new.status='revoked' and old.status<>'revoked' then
      v_type := 'group_deputy_revoked';
      v_message := 'скасував(-ла) ваші повноваження заступника у групі «' || v_name || '».';
    else return new;
    end if;
  else return new;
  end if;
  v_actor_id := coalesce(auth.uid(),new.reviewed_by,v_rep);
  select full_name into v_actor_name from public.profiles where id=v_actor_id;
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,study_group_id)
    values(new.user_id,v_actor_id,coalesce(nullif(v_actor_name,''),'Староста'),v_type,v_message,false,new.group_id);
  return new;
end;
$$;

-- Cancelling outstanding applications is silent. Only existing approved rows
-- continue to supply effective deputy permissions after the model change.
update public.study_group_deputy_requests
  set status='cancelled',permissions='{}'::text[],reviewed_by=null,reviewed_at=now(),updated_at=now()
  where status='pending';

create or replace function public.xelay_assign_study_group_deputy(
  p_group_id uuid,p_user_id uuid,p_permissions text[] default '{}'::text[]
)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_rep uuid; v_member_id uuid; v_existing public.study_group_deputy_requests%rowtype;
  v_permissions text[]; v_id uuid;
begin
  if auth.uid() is null then raise exception 'DEPUTY_AUTH_REQUIRED' using errcode='42501'; end if;
  if p_group_id is null then raise exception 'DEPUTY_GROUP_NOT_FOUND'; end if;
  -- Lock order matches content, role updates and membership removal in 008.
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || p_group_id::text,0));
  select representative_id into v_rep from public.study_groups where id=p_group_id for update;
  if not found then raise exception 'DEPUTY_GROUP_NOT_FOUND'; end if;
  perform public.xelay_lock_study_group_deputy_reviewer(p_group_id);
  if p_user_id=auth.uid() or p_user_id=v_rep then
    raise exception 'DEPUTY_CANNOT_ASSIGN_REPRESENTATIVE' using errcode='42501';
  end if;
  select id into v_member_id from public.study_group_members
    where group_id=p_group_id and user_id=p_user_id and status='accepted' for share;
  if not found then raise exception 'DEPUTY_MEMBER_REQUIRED' using errcode='42501'; end if;
  v_permissions := public.xelay_normalize_study_group_permissions(p_permissions);
  select * into v_existing from public.study_group_deputy_requests
    where group_id=p_group_id and user_id=p_user_id for update;
  if found and v_existing.status='approved' then raise exception 'DEPUTY_ALREADY_ACTIVE'; end if;
  -- No group-license gate: appointing a trusted member is administrative work.
  -- His or her content actions still obey the unchanged license enforcement.
  insert into public.study_group_deputy_requests(
    group_id,user_id,status,permissions,message,reviewed_by,reviewed_at
  ) values(p_group_id,p_user_id,'approved',v_permissions,null,auth.uid(),now())
    on conflict(group_id,user_id) do update set status='approved',permissions=excluded.permissions,
      message=null,created_at=now(),reviewed_by=excluded.reviewed_by,reviewed_at=now(),updated_at=now()
    returning id into v_id;
  return v_id;
end;
$$;

-- Both revoke EXECUTE and replace the legacy bodies: a stale application client
-- cannot restore the retired flow even if a grant is accidentally reintroduced.
create or replace function public.xelay_submit_study_group_deputy_request(p_group_id uuid,p_message text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  raise exception 'DEPUTY_APPLICATIONS_DISABLED' using errcode='42501';
end;
$$;
create or replace function public.xelay_cancel_study_group_deputy_request(p_request_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  raise exception 'DEPUTY_APPLICATIONS_DISABLED' using errcode='42501';
end;
$$;
create or replace function public.xelay_review_study_group_deputy_request(
  p_request_id uuid,p_approve boolean,p_permissions text[] default '{}'::text[]
)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  raise exception 'DEPUTY_APPLICATIONS_DISABLED' using errcode='42501';
end;
$$;

revoke all on function public.xelay_assign_study_group_deputy(uuid,uuid,text[]),
  public.xelay_guard_study_group_deputy_appointments(),
  public.xelay_notify_study_group_deputy_request(),
  public.xelay_submit_study_group_deputy_request(uuid,text),
  public.xelay_cancel_study_group_deputy_request(uuid),
  public.xelay_review_study_group_deputy_request(uuid,boolean,text[])
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_assign_study_group_deputy(uuid,uuid,text[]) to authenticated;

comment on table public.study_group_deputy_requests is
  'One current deputy appointment per group/user. Actual representatives directly appoint accepted members with personal permissions; pending member applications are disabled. Existing approved rows retain access, and the role list redacts historic private messages.';
comment on function public.xelay_assign_study_group_deputy(uuid,uuid,text[]) is
  'Directly appoint an accepted member as a deputy; actual representative only. Returns current appointment row ID; existing approved appointments are edited with xelay_update_study_group_deputy_permissions.';

commit;
