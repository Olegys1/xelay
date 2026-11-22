begin;
set local lock_timeout='5s';
-- Admin-created workstations are not self-registration or consent receipts.
-- app_metadata is writable only by Auth Admin, never by signUp user_metadata.
create function dean_private.provisioned_identity(p_email text,p_meta jsonb) returns boolean
language sql stable security definer set search_path='' as $$
 select public.xelay_security_is_trusted_backend()
 and p_email ~ '^dean-[a-f0-9]{10}@dean[.]xelay[.]ink$'
 and p_meta->'dean_service'='true'::jsonb
 and exists(select 1 from public.user_roles r join auth.users u on u.id=r.user_id
   where r.user_id::text=p_meta->>'created_by' and r.role='ADMIN'
     and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now()))
$$;
revoke all on function dean_private.provisioned_identity(text,jsonb) from public,anon,authenticated,service_role;
do $patch$
declare body text;
begin
 body:=replace(pg_get_functiondef('public.xelay_require_signup_privacy_consent()'::regprocedure),chr(13),'');
 if position(E'begin\n' in body)=0 then raise exception 'DEAN_SIGNUP_GUARD_DRIFT'; end if;
 body:=regexp_replace(body,E'begin\n',E'begin\n  if dean_private.provisioned_identity(new.email,new.raw_app_meta_data) then return new; end if;\n');
 execute body;
end $patch$;
create function dean_private.create_service_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if dean_private.provisioned_identity(new.email,new.raw_app_meta_data) then
  insert into public.profiles(id,full_name,username,email)
   values(new.id,left(new.raw_user_meta_data->>'full_name',120),split_part(new.email,'@',1),new.email);
 end if;
 return new;
end $$;
revoke all on function dean_private.create_service_profile() from public,anon,authenticated,service_role;
create trigger xelay_dean_service_profile after insert on auth.users for each row execute function dean_private.create_service_profile();
create table dean_private.staff (
 user_id uuid primary key references public.profiles(id), label text not null,
 login text not null unique, enabled boolean not null default true,
 created_by uuid not null references public.profiles(id), created_at timestamptz not null default now()
);
create table dean_private.draft_readers (
 draft_id uuid references dean_private.drafts(id), user_id uuid references public.profiles(id),
 primary key(draft_id,user_id)
);
create table dean_private.jobs (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id),
 session_id text not null, draft_id uuid not null references dean_private.drafts(id), revision integer not null,
 settings jsonb not null, target jsonb, result jsonb,
 state text not null default 'running' check(state in ('running','done','failed')),
 created_at timestamptz not null default now(), finished_at timestamptz,
 applied_draft uuid references dean_private.drafts(id), applied_option integer
);
create index on dean_private.jobs(owner_id,created_at desc);
alter table dean_private.staff enable row level security;
alter table dean_private.draft_readers enable row level security;
alter table dean_private.jobs enable row level security;
revoke all on dean_private.staff,dean_private.draft_readers,dean_private.jobs from public,anon,authenticated;
create function dean_private.staff_enabled(p_user uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from dean_private.staff where user_id=p_user and enabled)
$$;
create function dean_private.online(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d dean_private.drafts; j dean_private.jobs; n dean_private.drafts; result jsonb; candidate jsonb; who uuid;
begin
 if not dean_private.session_valid() then raise exception 'DEAN_MFA_REQUIRED' using errcode='42501'; end if;
 if not dean_private.is_admin() and not dean_private.staff_enabled(auth.uid()) and not exists(select 1 from dean_private.access where user_id=auth.uid()) then raise exception 'DEAN_ACCESS_DENIED' using errcode='42501'; end if;
 if p_action='staff_list' then
  if not dean_private.is_admin() then raise exception 'DEAN_ADMIN_REQUIRED'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(s) order by created_at),'[]') from dean_private.staff s);
 elsif p_action='staff_register' then
  if not dean_private.is_admin() then raise exception 'DEAN_ADMIN_REQUIRED'; end if;
  who:=(p_payload->>'userId')::uuid;
  if not exists(select 1 from auth.users where id=who and raw_app_meta_data->>'dean_service'='true' and raw_app_meta_data->>'created_by'=auth.uid()::text and email=p_payload->>'login') then raise exception 'DEAN_STAFF_INVALID'; end if;
  if length(p_payload->>'label') not between 1 and 120 then raise exception 'DEAN_INPUT_INVALID'; end if;
  insert into dean_private.staff(user_id,label,login,created_by) values(who,p_payload->>'label',p_payload->>'login',auth.uid());
  if p_payload->>'draftId' is not null then
   insert into dean_private.draft_readers values((p_payload->>'draftId')::uuid,who);
  end if;
  insert into dean_private.audit(actor,action)values(auth.uid(),'staff_created');
  return jsonb_build_object('ok',true);
 elsif p_action='staff_disable' then
  if not dean_private.is_admin() then raise exception 'DEAN_ADMIN_REQUIRED'; end if;
  update dean_private.staff set enabled=false where user_id=(p_payload->>'userId')::uuid;
  delete from dean_private.access where user_id=(p_payload->>'userId')::uuid;
  insert into dean_private.audit(actor,action)values(auth.uid(),'staff_disabled');
  return jsonb_build_object('ok',true);
 elsif p_action='jobs' then
  return (select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc),'[]') from (
   select id,draft_id,revision,case when state='running' and created_at<now()-interval '4 minutes' then 'interrupted' else state end state,
    created_at,finished_at,applied_draft from dean_private.jobs where owner_id=auth.uid() order by created_at desc limit 12) x);
 elsif p_action='begin' then
  perform pg_advisory_xact_lock(22112026,2);
  select * into d from dean_private.drafts where id=(p_payload->>'draftId')::uuid for update;
  if d.id is null or not (d.owner_id=auth.uid() or dean_private.is_admin() or exists(select 1 from dean_private.draft_readers where draft_id=d.id and user_id=auth.uid())) then raise exception 'DEAN_DRAFT_DENIED'; end if;
  if d.revision is distinct from (p_payload->>'revision')::integer then raise exception 'DEAN_STALE_VERSION'; end if;
  if exists(select 1 from dean_private.jobs where owner_id=auth.uid() and ((state='running' and created_at>now()-interval '4 minutes') or created_at>now()-interval '30 seconds')) then raise exception 'DEAN_CALC_BUSY'; end if;
  if (select count(*) from dean_private.jobs where state='running' and created_at>now()-interval '4 minutes')>=2 then raise exception 'DEAN_CALC_BUSY'; end if;
  if (select count(*) from dean_private.jobs where owner_id=auth.uid() and created_at>now()-interval '24 hours')>=40 then raise exception 'DEAN_CALC_LIMIT'; end if;
  if jsonb_typeof(p_payload->'settings') is distinct from 'object' or octet_length(p_payload::text)>50000 then raise exception 'DEAN_INPUT_INVALID'; end if;
  insert into dean_private.jobs(owner_id,session_id,draft_id,revision,settings,target) values(auth.uid(),auth.jwt()->>'session_id',d.id,d.revision,p_payload->'settings',p_payload->'target') returning * into j;
  return jsonb_build_object('job',j.id,'document',d.document,'settings',j.settings,'target',j.target);
 end if;
 select * into j from dean_private.jobs where id=(p_payload->>'id')::uuid and owner_id=auth.uid() for update;
 if j.id is null then raise exception 'DEAN_JOB_DENIED'; end if;
 if p_action='result' then return to_jsonb(j); end if;
 if p_action<>'apply' or j.state<>'done' then raise exception 'DEAN_RESULT_REQUIRED'; end if;
 if j.applied_draft is not null then
  if j.applied_option is distinct from (p_payload->>'option')::int then raise exception 'DEAN_OPTION_ALREADY_APPLIED'; end if;
  return dean_private.workspace('load',jsonb_build_object('id',j.applied_draft));
 end if;
 select * into d from dean_private.drafts where id=j.draft_id for update;
 if d.revision<>j.revision then raise exception 'DEAN_STALE_VERSION'; end if;
 candidate:=j.result->'options'->((p_payload->>'option')::int);
 if candidate is null or candidate->'report'->>'passed' is distinct from 'true' then raise exception 'DEAN_RESULT_REQUIRED'; end if;
 -- Worker results cannot change the original hours, memberships, or teaching assignments.
 if jsonb_array_length(candidate->'events')<>jsonb_array_length(d.document->'source'->'events') or exists(
  select 1 from jsonb_array_elements(d.document->'source'->'events') with ordinality a(e,i)
  full join jsonb_array_elements(candidate->'events') with ordinality b(e,i) using(i)
  where (a.e-'day'-'period') is distinct from (b.e-'day'-'period')
 ) then raise exception 'DEAN_SOURCE_CHANGED'; end if;
 result:=jsonb_set(d.document,'{source,events}',candidate->'events');
 result:=jsonb_set(result,'{rows}','[]'); result:=jsonb_set(result,'{settings}',j.settings);
 insert into dean_private.drafts(owner_id,title,document)values(auth.uid(),left(d.title,130)||' · новий варіант',result) returning * into n;
 insert into dean_private.history values(n.id,n.revision,n.document,auth.uid(),now());
 update dean_private.jobs set applied_draft=n.id,applied_option=(p_payload->>'option')::int where id=j.id;
 insert into dean_private.audit(actor,action,draft_id,revision)values(auth.uid(),'calculation_applied',n.id,n.revision);
 return to_jsonb(n);
end $$;
create function dean_private.finish_job(p_id uuid,p_result jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare j dean_private.jobs;
begin
 if auth.role()<>'service_role' then raise exception 'DEAN_WORKER_REQUIRED'; end if;
 select * into j from dean_private.jobs where id=p_id for update;
 if j.id is null or j.state<>'running' or j.created_at<now()-interval '4 minutes' then return false; end if;
 if octet_length(p_result::text)>8000000 then raise exception 'DEAN_RESULT_SIZE'; end if;
 if not exists(select 1 from auth.sessions s join auth.users u on u.id=s.user_id where s.id::text=j.session_id and u.id=j.owner_id and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now()) and (s.not_after is null or s.not_after>now())) then return false; end if;
 if exists(select 1 from dean_private.staff where user_id=j.owner_id and not enabled) then return false; end if;
 update dean_private.jobs set state=case when p_result->>'ok'='true' then 'done' else 'failed' end,result=p_result,finished_at=now() where id=j.id;
 return true;
end $$;
create function public.xelay_dean_online(p_action text,p_payload jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$select dean_private.online(p_action,p_payload)$$;
create function public.xelay_dean_finish_job(p_id uuid,p_result jsonb) returns boolean language sql security invoker set search_path='' as $$select dean_private.finish_job(p_id,p_result)$$;
revoke all on function dean_private.staff_enabled(uuid),dean_private.online(text,jsonb),dean_private.finish_job(uuid,jsonb),public.xelay_dean_online(text,jsonb),public.xelay_dean_finish_job(uuid,jsonb) from public,anon,authenticated;
grant execute on function dean_private.online(text,jsonb),public.xelay_dean_online(text,jsonb) to authenticated;
grant usage on schema dean_private to service_role;
grant execute on function dean_private.finish_job(uuid,jsonb),public.xelay_dean_finish_job(uuid,jsonb) to service_role;
create or replace function dean_private.workspace(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v dean_private.drafts; result jsonb; ident uuid; report jsonb; r jsonb;
begin
 if not dean_private.session_valid() then raise exception 'DEAN_MFA_REQUIRED' using errcode='42501'; end if;
 if exists(select 1 from dean_private.staff where user_id=auth.uid() and not enabled) or (not dean_private.is_admin() and not dean_private.staff_enabled(auth.uid()) and not exists(select 1 from dean_private.access where user_id=auth.uid())) then raise exception 'DEAN_ACCESS_DENIED' using errcode='42501'; end if;
 if p_action='catalog' then
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.group_name,'members',
    (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name,'username',p.username) order by p.full_name),'[]') from public.study_group_members m join public.profiles p on p.id=m.user_id where m.group_id=g.id and m.status='accepted')) order by g.group_name),'[]') into result
    from public.study_groups g where dean_private.can_group(g.id);
  return jsonb_build_object('groups',result,'admin',dean_private.is_admin());
 elsif p_action='list' then
  select coalesce(jsonb_agg(to_jsonb(x) order by updated_at desc),'[]') into result from
   (select id,title,revision,approved_revision,published_revision,updated_at from dean_private.drafts where owner_id=auth.uid() or dean_private.is_admin() or exists(select 1 from dean_private.draft_readers dr where dr.draft_id=dean_private.drafts.id and dr.user_id=auth.uid()) order by updated_at desc limit 100) x;
  return result;
 elsif p_action='grant' then
  if not dean_private.is_admin() then raise exception 'DEAN_ADMIN_REQUIRED' using errcode='42501'; end if;
  if p_payload->>'enabled'='true' then
   insert into dean_private.access(user_id,group_id,granted_by) values((p_payload->>'userId')::uuid,(p_payload->>'groupId')::uuid,auth.uid()) on conflict do nothing;
  elsif p_payload->>'enabled'='false' then delete from dean_private.access where user_id=(p_payload->>'userId')::uuid and group_id=(p_payload->>'groupId')::uuid;
  else raise exception 'DEAN_INPUT_INVALID'; end if;
  insert into dean_private.audit(actor,action)values(auth.uid(),'access:'||(p_payload->>'enabled'));
  return jsonb_build_object('ok',true);
 elsif p_action='create' then
  if octet_length(p_payload::text)>8000000 or jsonb_typeof(p_payload->'document') is distinct from 'object' then raise exception 'DEAN_INPUT_INVALID'; end if;
  insert into dean_private.drafts(owner_id,title,document)values(auth.uid(),p_payload->>'title',p_payload->'document')returning * into v;
  insert into dean_private.history values(v.id,v.revision,v.document,auth.uid(),now());
  insert into dean_private.audit(actor,action,draft_id,revision)values(auth.uid(),'create',v.id,v.revision);
  return to_jsonb(v);
 end if;
 ident:=(p_payload->>'id')::uuid;
 select * into v from dean_private.drafts where id=ident for update;
 if v.id is null or (v.owner_id<>auth.uid() and not dean_private.is_admin() and not (p_action='load' and exists(select 1 from dean_private.draft_readers where draft_id=v.id and user_id=auth.uid()))) then raise exception 'DEAN_DRAFT_DENIED' using errcode='42501'; end if;
 if p_action='load' then return to_jsonb(v); end if;
 if (p_payload->>'revision')::int is distinct from v.revision then raise exception 'DEAN_STALE_VERSION'; end if;
 if p_action='save' then
  if v.published_revision is not null then raise exception 'DEAN_PUBLISHED_IMMUTABLE'; end if;
  if jsonb_typeof(p_payload->'document') is distinct from 'object' then raise exception 'DEAN_INPUT_INVALID'; end if;
  update dean_private.drafts set document=p_payload->'document',revision=revision+1,approved_revision=null,approved_by=null,updated_at=now() where id=v.id returning * into v;
  insert into dean_private.history values(v.id,v.revision,v.document,auth.uid(),now());
 elsif p_action in('review','approve','publish') then
  -- Serializes dean publications. Existing schedules are protected against concurrent edits too.
  perform pg_advisory_xact_lock(22112026,1);
  if p_action='publish' then
   lock table public.study_group_schedule in share mode;
   lock table public.study_group_members in share mode;
   lock table dean_private.access in share mode;
  end if;
  if p_action='publish' and v.published_revision=v.revision then return to_jsonb(v); end if;
  report:=dean_private.validate_rows(v.document,v.id);
  if p_action='review' then return report; end if;
  if p_action='approve' then
   if not dean_private.is_admin() or p_payload->>'confirmation' is distinct from ('РџР†Р”РўР’Р•Р Р”Р–РЈР® '||v.revision) then raise exception 'DEAN_CONFIRMATION_REQUIRED'; end if;
   update dean_private.drafts set approved_revision=revision,approved_by=auth.uid() where id=v.id returning * into v;
  else
   if v.approved_revision is distinct from v.revision or v.approved_by is null then raise exception 'DEAN_APPROVAL_REQUIRED'; end if;
   for r in select value from jsonb_array_elements(v.document->'rows') loop
    insert into dean_private.lessons(draft_id,group_id,user_ids,source_id,subject,teacher_name,teacher_ids,lesson_type,lesson_date,period,created_by)
    values(v.id,(r->>'groupId')::uuid,array(select value::uuid from jsonb_array_elements_text(r->'userIds')),r->>'sourceId',r->>'subject',coalesce(r->>'teacher',''),array(select jsonb_array_elements_text(r->'teacherIds')),
    case r->>'activity' when 'practice' then 'practical' else r->>'activity' end,(r->>'date')::date,(r->>'period')::int,auth.uid());
   end loop;
   update dean_private.drafts set published_revision=revision where id=v.id returning * into v;
  end if;
 else raise exception 'DEAN_ACTION_INVALID'; end if;
 insert into dean_private.audit(actor,action,draft_id,revision)values(auth.uid(),p_action,v.id,v.revision);
 return to_jsonb(v);
end $$;


commit;
