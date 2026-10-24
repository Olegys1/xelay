-- Increase shared-organizer capacity to 35 accepted members plus reserved
-- pending invitations, including the owner. No memberships are created here.
-- Existing owner control, consent, subscription gates, locks and RPC ACL stay.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $prerequisites$
begin
  if to_regclass('public.shared_organizer_workspaces') is null
    or to_regclass('public.shared_organizer_members') is null
    or to_regclass('public.shared_organizer_invitations') is null
    or to_regclass('public.shared_organizer_tasks') is null
    or to_regclass('public.shared_organizer_daily_usage') is null
    or to_regprocedure('public.xelay_private_guard_shared_organizer_member()') is null
    or to_regprocedure('public.xelay_private_guard_shared_organizer_invitation()') is null
    or to_regprocedure('public.xelay_invite_shared_organizer(uuid,text)') is null
    or to_regprocedure('public.xelay_respond_shared_organizer_invite(uuid,boolean)') is null then
    raise exception 'SHARED_ORGANIZER_35_PREREQUISITE_MISSING';
  end if;
end $prerequisites$;

-- Stabilize the data/ACL receipt while replacing the four existing bodies.
lock table public.shared_organizer_workspaces,public.shared_organizer_members,
  public.shared_organizer_invitations,public.shared_organizer_tasks,
  public.shared_organizer_daily_usage in share row exclusive mode;

create temporary view xelay_shared_35_current_state as
select jsonb_build_object(
  'data',(select jsonb_object_agg(x.name,x.hash order by x.name) from (
    select 'workspaces' name,md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by t.id),'')) hash from public.shared_organizer_workspaces t
    union all select 'members',md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by t.workspace_id,t.user_id),'')) from public.shared_organizer_members t
    union all select 'invitations',md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by t.id),'')) from public.shared_organizer_invitations t
    union all select 'tasks',md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by t.id),'')) from public.shared_organizer_tasks t
    union all select 'usage',md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by t.user_id,t.usage_date),'')) from public.shared_organizer_daily_usage t
  ) x),
  'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity,
    'force_rls',c.relforcerowsecurity,'owner',c.relowner,'acl',c.relacl::text) order by c.relname)
    from pg_class c where c.oid in('public.shared_organizer_workspaces'::regclass,
      'public.shared_organizer_members'::regclass,'public.shared_organizer_invitations'::regclass,
      'public.shared_organizer_tasks'::regclass,'public.shared_organizer_daily_usage'::regclass)),
  'policies',(select jsonb_agg(jsonb_build_object('table',p.polrelid::regclass::text,'name',p.polname,
    'roles',p.polroles,'cmd',p.polcmd,'using',pg_get_expr(p.polqual,p.polrelid),
    'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polrelid,p.polname)
    from pg_policy p where p.polrelid in('public.shared_organizer_workspaces'::regclass,
      'public.shared_organizer_members'::regclass,'public.shared_organizer_invitations'::regclass,
      'public.shared_organizer_tasks'::regclass,'public.shared_organizer_daily_usage'::regclass)),
  'functions',(select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'acl',p.proacl::text,
    'owner',p.proowner,'security_definer',p.prosecdef,'config',p.proconfig,
    'source',case when p.oid not in('public.xelay_private_guard_shared_organizer_member()'::regprocedure,
      'public.xelay_private_guard_shared_organizer_invitation()'::regprocedure,
      'public.xelay_invite_shared_organizer(uuid,text)'::regprocedure,
      'public.xelay_respond_shared_organizer_invite(uuid,boolean)'::regprocedure)
      then md5(pg_get_functiondef(p.oid)) end) order by p.oid)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like '%shared_organizer%' and p.prokind='f'),
  'triggers',(select jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,
    'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) order by t.tgrelid,t.tgname)
    from pg_trigger t where not t.tgisinternal and t.tgrelid in('public.shared_organizer_workspaces'::regclass,
      'public.shared_organizer_members'::regclass,'public.shared_organizer_invitations'::regclass,
      'public.shared_organizer_tasks'::regclass,'public.shared_organizer_daily_usage'::regclass))
) data;
create temporary table xelay_shared_35_baseline on commit drop as select data from xelay_shared_35_current_state;
alter table xelay_shared_35_baseline enable row level security;

do $capacity$
declare
  v_patch record;v_routine regprocedure;v_source text;v_replacement text;v_expected text;
begin
  for v_patch in select * from (values
    ('public.xelay_private_guard_shared_organizer_member()','>=5 then','>=35 then'),
    ('public.xelay_private_guard_shared_organizer_invitation()','>=5 then','>=35 then'),
    ('public.xelay_invite_shared_organizer(uuid,text)','>=5 then','>=35 then'),
    ('public.xelay_respond_shared_organizer_invite(uuid,boolean)','>5 then','>35 then')
  ) x(signature,old_anchor,new_anchor) loop
    v_routine:=v_patch.signature::regprocedure;
    v_source:=pg_get_functiondef(v_routine);
    if (length(v_source)-length(replace(v_source,v_patch.old_anchor,'')))/length(v_patch.old_anchor)<>1
      or position('SHARED_ORGANIZER_WORKSPACE_FULL' in v_source)=0
      or position('public.xelay_private_shared_organizer_actor()' in v_source)=0 then
      raise exception 'SHARED_ORGANIZER_35_SOURCE_DRIFT: %',v_patch.signature;
    end if;
    v_replacement:=replace(v_source,v_patch.old_anchor,v_patch.new_anchor);
    -- Acceptance converts its reserved seat rather than adding a new one.
    v_replacement:=replace(v_replacement,'additional sixth seat','additional seat');
    execute v_replacement;
    v_expected:=pg_get_functiondef(v_routine);
    if v_expected is distinct from v_replacement then
      raise exception 'SHARED_ORGANIZER_35_UNEXPECTED_FUNCTION_CHANGE: %',v_patch.signature;
    end if;
  end loop;
end $capacity$;

-- The durable quota remains 50 successful invitations per Kyiv day. It already
-- permits inviting 34 peers and still cannot be reset by cancelling invites.
-- The per-recipient inbox quota (20) is unrelated to workspace size and stays.
comment on table public.shared_organizer_members is
  'At most 35 accepted members plus unexpired pending invitation reservations per workspace, including the owner. Expiration blocks only the acting user and never deletes membership.';

do $unchanged$
declare v_before jsonb;v_after jsonb;
begin
  select data into v_before from xelay_shared_35_baseline;
  select data into v_after from xelay_shared_35_current_state;
  if v_before is distinct from v_after then
    raise exception 'SHARED_ORGANIZER_35_UNEXPECTED_DATA_OR_ACCESS_CHANGE';
  end if;
end $unchanged$;
drop view xelay_shared_35_current_state;
notify pgrst,'reload schema';
select jsonb_build_object('release','shared-organizer-35-20261024','receipt',gen_random_uuid(),
  'prepared_capacity',35,'includes_owner',true,'pending_invitations_reserve_seats',true,
  'applied_at',clock_timestamp(),'existing_data_unchanged',true,'rls_and_rpc_access_unchanged',true,
  'invitation_daily_quota',50,'explicit_acceptance_required',true) as shared_organizer_35_release;
commit;
