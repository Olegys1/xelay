-- Separate private shared organizers. Personal organizer tables are untouched.
-- All application access is through the authenticated RPCs below.
-- Спільний органайзер Xelay: до 5 людей, включно з власником.
-- Запрошення за ніком; активна підписка кожного та явне прийняття.
-- Спільні завдання бачить лише прийнята команда; особисті плани не змінюються.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$
begin
  if to_regclass('public.profiles') is null
    or to_regprocedure('public.xelay_has_participant_access(uuid)') is null
    or not exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='profiles' and column_name='username') then
    raise exception 'Apply profile usernames and participant billing before shared organizers';
  end if;
end;
$$;

create table if not exists public.shared_organizer_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check(char_length(name) between 1 and 100 and name=btrim(name)),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  archived_at timestamptz
);
create index if not exists shared_organizer_workspaces_owner_idx
  on public.shared_organizer_workspaces(owner_id,created_at) where archived_at is null;

create table if not exists public.shared_organizer_members (
  workspace_id uuid not null references public.shared_organizer_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check(role in ('owner','member')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,user_id)
);
create unique index if not exists shared_organizer_members_one_owner_idx
  on public.shared_organizer_members(workspace_id) where role='owner';
create index if not exists shared_organizer_members_user_idx
  on public.shared_organizer_members(user_id,workspace_id);

create table if not exists public.shared_organizer_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.shared_organizer_workspaces(id) on delete cascade,
  inviter_id uuid not null references auth.users(id) on delete cascade,
  invitee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','accepted','declined','cancelled','expired')),
  expires_at timestamptz not null check(isfinite(expires_at)),
  created_at timestamptz not null default clock_timestamp(),
  responded_at timestamptz,
  check(inviter_id<>invitee_id),
  check(expires_at>created_at)
);
-- Expired pending rows are settled under the workspace lock before re-inviting.
create unique index if not exists shared_organizer_invitation_pending_unique_idx
  on public.shared_organizer_invitations(workspace_id,invitee_id) where status='pending';
create index if not exists shared_organizer_invitations_incoming_idx
  on public.shared_organizer_invitations(invitee_id,expires_at,workspace_id) where status='pending';

create table if not exists public.shared_organizer_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.shared_organizer_workspaces(id) on delete cascade,
  -- Historical attribution survives another member deleting their account.
  created_by uuid not null,
  updated_by uuid not null,
  -- Membership deletion clears assignments under the workspace lock. Avoid
  -- an auth FK that could lock tasks before the shared workspace during delete.
  assignee_id uuid,
  title text not null check(char_length(title) between 1 and 200 and title=btrim(title)),
  notes text not null default '' check(char_length(notes)<=10000),
  subject text not null default '' check(char_length(subject)<=120 and subject=btrim(subject)),
  due_at timestamptz,
  due_date date,
  completed boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(due_at is null or (isfinite(due_at)
    and due_at>=timestamptz '0001-01-01 00:00:00+00'
    and due_at<timestamptz '10000-01-01 00:00:00+00')),
  check(due_date is null or (isfinite(due_date)
    and due_date between date '0001-01-01' and date '9999-12-31')),
  check(due_at is null or due_date is null)
);
create index if not exists shared_organizer_tasks_workspace_idx
  on public.shared_organizer_tasks(workspace_id,completed,created_at,id);
create index if not exists shared_organizer_tasks_assignee_idx
  on public.shared_organizer_tasks(workspace_id,assignee_id) where assignee_id is not null;

-- Durable successful-operation counters cannot be reset by archiving a
-- workspace or cancelling an invitation. The date is a Kyiv calendar day.
create table if not exists public.shared_organizer_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  created_count integer not null default 0 check(created_count between 0 and 10),
  invited_count integer not null default 0 check(invited_count between 0 and 50),
  primary key(user_id,usage_date)
);

alter table public.shared_organizer_workspaces enable row level security;
alter table public.shared_organizer_members enable row level security;
alter table public.shared_organizer_invitations enable row level security;
alter table public.shared_organizer_tasks enable row level security;
alter table public.shared_organizer_daily_usage enable row level security;
-- No table policies or direct privileges: even reads must use a scoped RPC.
revoke all on public.shared_organizer_workspaces,public.shared_organizer_members,
  public.shared_organizer_invitations,public.shared_organizer_tasks,
  public.shared_organizer_daily_usage from public,anon,authenticated,service_role;

create or replace function public.xelay_private_shared_organizer_actor()
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_actor uuid:=auth.uid();
begin
  if v_actor is null then
    raise exception 'SHARED_ORGANIZER_AUTH_REQUIRED' using errcode='42501';
  end if;
  if not public.xelay_has_participant_access(v_actor) then
    raise exception 'SHARED_ORGANIZER_PARTICIPANT_REQUIRED' using errcode='42501';
  end if;
  return v_actor;
end;
$$;

create or replace function public.xelay_private_lock_shared_organizer(
  p_workspace_id uuid,p_owner_only boolean default false
)
returns public.shared_organizer_workspaces language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_actor uuid; v_workspace public.shared_organizer_workspaces%rowtype;
begin
  v_actor:=public.xelay_private_shared_organizer_actor();
  -- Never lock a member, invitation or task first. This one row serializes
  -- every operation in the workspace, including invite acceptance/removal.
  select * into v_workspace from public.shared_organizer_workspaces
    where id=p_workspace_id for update;
  if not found or v_workspace.archived_at is not null then
    raise exception 'SHARED_ORGANIZER_WORKSPACE_UNAVAILABLE' using errcode='42501';
  end if;
  perform public.xelay_private_shared_organizer_actor();
  if not exists(select 1 from public.shared_organizer_members
    where workspace_id=v_workspace.id and user_id=v_actor) then
    raise exception 'SHARED_ORGANIZER_NOT_MEMBER' using errcode='42501';
  end if;
  if p_owner_only and v_workspace.owner_id<>v_actor then
    raise exception 'SHARED_ORGANIZER_OWNER_REQUIRED' using errcode='42501';
  end if;
  return v_workspace;
end;
$$;

create or replace function public.xelay_private_shared_organizer_workspace_json(
  p_workspace public.shared_organizer_workspaces
)
returns jsonb language sql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object('id',(p_workspace).id,'name',(p_workspace).name,
    'owner_id',(p_workspace).owner_id,'created_at',(p_workspace).created_at,
    'updated_at',(p_workspace).updated_at,'member_count',
    (select count(*) from public.shared_organizer_members m where m.workspace_id=(p_workspace).id));
$$;

create or replace function public.xelay_private_shared_organizer_invitation_json(
  p_invitation public.shared_organizer_invitations
)
returns jsonb language sql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object('id',(p_invitation).id,'workspace_id',(p_invitation).workspace_id,
    'workspace_name',w.name,'inviter_name',left(coalesce(nullif(btrim(inviter.full_name),''),'Учасник'),500),
    'invitee_id',(p_invitation).invitee_id,
    'invitee_name',left(coalesce(nullif(btrim(invitee.full_name),''),'Учасник'),500),
    'invitee_username',left(coalesce(nullif(btrim(invitee.username),''),'Учасник'),100),
    'expires_at',(p_invitation).expires_at,'created_at',(p_invitation).created_at)
  from public.shared_organizer_workspaces w
    left join public.profiles inviter on inviter.id=(p_invitation).inviter_id
    left join public.profiles invitee on invitee.id=(p_invitation).invitee_id
  where w.id=(p_invitation).workspace_id;
$$;

create or replace function public.xelay_private_shared_organizer_charge(
  p_actor uuid,p_creation boolean
)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_changed integer;
begin
  insert into public.shared_organizer_daily_usage(user_id,usage_date,created_count,invited_count)
    values(p_actor,(clock_timestamp() at time zone 'Europe/Kyiv')::date,
      case when p_creation then 1 else 0 end,case when p_creation then 0 else 1 end)
    on conflict(user_id,usage_date) do update
      set created_count=shared_organizer_daily_usage.created_count+excluded.created_count,
        invited_count=shared_organizer_daily_usage.invited_count+excluded.invited_count
      where shared_organizer_daily_usage.created_count+excluded.created_count<=10
        and shared_organizer_daily_usage.invited_count+excluded.invited_count<=50;
  get diagnostics v_changed=row_count;
  if v_changed=0 then
    if p_creation then
      raise exception 'SHARED_ORGANIZER_CREATE_RATE_LIMIT' using errcode='54000';
    else
      raise exception 'SHARED_ORGANIZER_INVITE_RATE_LIMIT' using errcode='54000';
    end if;
  end if;
end;
$$;

create or replace function public.xelay_private_guard_shared_organizer_workspace()
returns trigger language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_actor uuid:=public.xelay_private_shared_organizer_actor();
begin
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id
      or new.created_at is distinct from old.created_at then
      raise exception 'SHARED_ORGANIZER_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    if old.archived_at is not null then
      raise exception 'SHARED_ORGANIZER_WORKSPACE_UNAVAILABLE' using errcode='42501';
    end if;
    new.updated_at:=greatest(clock_timestamp(),old.updated_at+interval '1 microsecond');
    if new.archived_at is not null then new.archived_at:=new.updated_at; end if;
  else
    new.created_at:=clock_timestamp(); new.updated_at:=new.created_at; new.archived_at:=null;
  end if;
  if new.owner_id<>v_actor then
    raise exception 'SHARED_ORGANIZER_OWNER_REQUIRED' using errcode='42501';
  end if;
  new.name:=btrim(new.name);
  if new.name is null or char_length(new.name) not between 1 and 100 then
    raise exception 'SHARED_ORGANIZER_INVALID_NAME' using errcode='22023';
  end if;
  return new;
end;
$$;
drop trigger if exists shared_organizer_workspace_guard on public.shared_organizer_workspaces;
create trigger shared_organizer_workspace_guard before insert or update
  on public.shared_organizer_workspaces for each row
  execute function public.xelay_private_guard_shared_organizer_workspace();

create or replace function public.xelay_private_guard_shared_organizer_member()
returns trigger language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_actor uuid; v_workspace public.shared_organizer_workspaces%rowtype;
begin
  select * into v_workspace from public.shared_organizer_workspaces
    where id=case when tg_op='DELETE' then old.workspace_id else new.workspace_id end for update;
  if tg_op='DELETE' then
    -- Workspace/account deletion cascades preserve the same lock order. A
    -- deleted account's attribution remains; only its assignments are cleared.
    if not found then return old; end if;
    if not exists(select 1 from auth.users where id=old.user_id) then
      update public.shared_organizer_tasks set assignee_id=null
        where workspace_id=old.workspace_id and assignee_id=old.user_id;
      return old;
    end if;
    v_actor:=public.xelay_private_shared_organizer_actor();
    if old.role='owner' or old.user_id=v_workspace.owner_id then
      raise exception 'SHARED_ORGANIZER_OWNER_CANNOT_LEAVE' using errcode='42501';
    end if;
    if v_workspace.archived_at is not null then
      raise exception 'SHARED_ORGANIZER_WORKSPACE_UNAVAILABLE' using errcode='42501';
    end if;
    if v_actor<>v_workspace.owner_id and v_actor<>old.user_id then
      raise exception 'SHARED_ORGANIZER_OWNER_REQUIRED' using errcode='42501';
    end if;
    return old;
  end if;
  if not found or v_workspace.archived_at is not null then
    raise exception 'SHARED_ORGANIZER_WORKSPACE_UNAVAILABLE' using errcode='42501';
  end if;
  if tg_op='UPDATE' then
    raise exception 'SHARED_ORGANIZER_IDENTITY_IMMUTABLE' using errcode='42501';
  end if;
  v_actor:=public.xelay_private_shared_organizer_actor();
  if new.role='owner' then
    if new.user_id<>v_workspace.owner_id or new.user_id<>v_actor then
      raise exception 'SHARED_ORGANIZER_OWNER_REQUIRED' using errcode='42501';
    end if;
  elsif new.role='member' then
    if new.user_id<>v_actor or new.user_id=v_workspace.owner_id
      or not exists(select 1 from public.shared_organizer_invitations
        where workspace_id=new.workspace_id and invitee_id=v_actor
          and status='pending' and expires_at>clock_timestamp()) then
      raise exception 'SHARED_ORGANIZER_INVITATION_UNAVAILABLE' using errcode='42501';
    end if;
  else
    raise exception 'SHARED_ORGANIZER_IDENTITY_IMMUTABLE' using errcode='42501';
  end if;
  if (select count(*) from public.shared_organizer_members where workspace_id=new.workspace_id)>=5 then
    raise exception 'SHARED_ORGANIZER_WORKSPACE_FULL' using errcode='54000';
  end if;
  new.created_at:=clock_timestamp();
  return new;
end;
$$;
drop trigger if exists shared_organizer_member_guard on public.shared_organizer_members;
create trigger shared_organizer_member_guard before insert or update or delete
  on public.shared_organizer_members for each row
  execute function public.xelay_private_guard_shared_organizer_member();

create or replace function public.xelay_private_guard_shared_organizer_invitation()
returns trigger language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_actor uuid; v_workspace public.shared_organizer_workspaces%rowtype;
begin
  select * into v_workspace from public.shared_organizer_workspaces
    where id=case when tg_op='DELETE' then old.workspace_id else new.workspace_id end for update;
  -- A trusted account/workspace deletion may delete its invitation history.
  -- Application roles have no direct DELETE privilege or DELETE RPC.
  if tg_op='DELETE' then return old; end if;
  if not found or v_workspace.archived_at is not null then
    raise exception 'SHARED_ORGANIZER_WORKSPACE_UNAVAILABLE' using errcode='42501';
  end if;
  v_actor:=public.xelay_private_shared_organizer_actor();
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.inviter_id is distinct from old.inviter_id or new.invitee_id is distinct from old.invitee_id
      or new.created_at is distinct from old.created_at or new.expires_at is distinct from old.expires_at
      or old.status<>'pending' then
      raise exception 'SHARED_ORGANIZER_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    if not ((v_actor=v_workspace.owner_id and new.status in ('cancelled','expired'))
      or (v_actor=old.invitee_id and new.status in ('accepted','declined'))) then
      raise exception 'SHARED_ORGANIZER_INVITATION_UNAVAILABLE' using errcode='42501';
    end if;
    new.responded_at:=clock_timestamp();
  else
    if v_actor<>v_workspace.owner_id or new.inviter_id<>v_actor or new.status<>'pending' then
      raise exception 'SHARED_ORGANIZER_OWNER_REQUIRED' using errcode='42501';
    end if;
    if not public.xelay_has_participant_access(new.invitee_id) then
      raise exception 'SHARED_ORGANIZER_INVITEE_PARTICIPANT_REQUIRED' using errcode='42501';
    end if;
    new.created_at:=clock_timestamp(); new.expires_at:=new.created_at+interval '7 days'; new.responded_at:=null;
    if (select count(*) from public.shared_organizer_members where workspace_id=new.workspace_id)
      +(select count(*) from public.shared_organizer_invitations
        where workspace_id=new.workspace_id and status='pending' and expires_at>new.created_at)>=5 then
      raise exception 'SHARED_ORGANIZER_WORKSPACE_FULL' using errcode='54000';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists shared_organizer_invitation_guard on public.shared_organizer_invitations;
create trigger shared_organizer_invitation_guard before insert or update or delete
  on public.shared_organizer_invitations for each row
  execute function public.xelay_private_guard_shared_organizer_invitation();

create or replace function public.xelay_private_guard_shared_organizer_task()
returns trigger language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_actor uuid; v_workspace public.shared_organizer_workspaces%rowtype;
begin
  if tg_op='DELETE' then
    perform id from public.shared_organizer_workspaces where id=old.workspace_id for update;
    -- Owner-account deletion already removed the workspace before cascading
    -- its tasks; the normal task-delete RPC always has an active workspace.
    if not found then return old; end if;
    perform public.xelay_private_lock_shared_organizer(old.workspace_id);
    return old;
  end if;
  -- Account-deletion membership cleanup only clears the deleted user's assignment.
  -- It keeps content/audit identities intact and still locks/bump-versions the
  -- surviving shared task. Ordinary application writes take the actor path.
  if tg_op='UPDATE' and old.assignee_id is not null and new.assignee_id is null
    and (to_jsonb(new)-'assignee_id') is not distinct from (to_jsonb(old)-'assignee_id')
    and not exists(select 1 from auth.users where id=old.assignee_id) then
    perform id from public.shared_organizer_workspaces where id=old.workspace_id for update;
    new.updated_at:=greatest(clock_timestamp(),old.updated_at+interval '1 microsecond');
    return new;
  end if;
  v_actor:=public.xelay_private_shared_organizer_actor();
  v_workspace:=public.xelay_private_lock_shared_organizer(new.workspace_id);
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'SHARED_ORGANIZER_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    new.updated_at:=greatest(clock_timestamp(),old.updated_at+interval '1 microsecond');
  else
    new.created_by:=v_actor; new.created_at:=clock_timestamp(); new.updated_at:=new.created_at;
  end if;
  new.updated_by:=v_actor;
  new.title:=btrim(new.title); new.notes:=coalesce(new.notes,''); new.subject:=btrim(coalesce(new.subject,''));
  if new.title is null or char_length(new.title) not between 1 and 200
    or char_length(new.notes)>10000 or char_length(new.subject)>120 or new.completed is null then
    raise exception 'SHARED_ORGANIZER_INVALID_TASK' using errcode='22023';
  end if;
  if (new.due_at is not null and (not isfinite(new.due_at)
      or new.due_at<timestamptz '0001-01-01 00:00:00+00'
      or new.due_at>=timestamptz '10000-01-01 00:00:00+00'))
    or (new.due_date is not null and (not isfinite(new.due_date)
      or new.due_date<date '0001-01-01' or new.due_date>date '9999-12-31'))
    or (new.due_at is not null and new.due_date is not null) then
    raise exception 'SHARED_ORGANIZER_INVALID_DEADLINE' using errcode='22023';
  end if;
  if new.assignee_id is not null and not exists(select 1 from public.shared_organizer_members
    where workspace_id=new.workspace_id and user_id=new.assignee_id) then
    raise exception 'SHARED_ORGANIZER_ASSIGNEE_UNAVAILABLE' using errcode='22023';
  end if;
  if new.assignee_id is not null and (tg_op='INSERT' or new.assignee_id is distinct from old.assignee_id)
    and not public.xelay_has_participant_access(new.assignee_id) then
    raise exception 'SHARED_ORGANIZER_ASSIGNEE_UNAVAILABLE' using errcode='22023';
  end if;
  return new;
end;
$$;
drop trigger if exists shared_organizer_task_guard on public.shared_organizer_tasks;
create trigger shared_organizer_task_guard before insert or update or delete
  on public.shared_organizer_tasks for each row
  execute function public.xelay_private_guard_shared_organizer_task();

create or replace function public.xelay_shared_organizer_overview()
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp set timezone='UTC' as $$
declare v_actor uuid; v_workspaces jsonb; v_invitations jsonb;
  v_workspace_id uuid; v_locked_ids uuid[]:='{}'::uuid[];
begin
  v_actor:=public.xelay_private_shared_organizer_actor();
  -- Sorted locks also cover the invitation inbox, so a pending invitation
  -- grants only its own metadata and can never authorize a task read.
  for v_workspace_id in select w.id from public.shared_organizer_workspaces w
    where w.archived_at is null and (exists(select 1 from public.shared_organizer_members m
      where m.workspace_id=w.id and m.user_id=v_actor)
      or exists(select 1 from public.shared_organizer_invitations i
        where i.workspace_id=w.id and i.invitee_id=v_actor and i.status='pending'
          and i.expires_at>clock_timestamp()))
    order by w.id for update of w
  loop
    v_locked_ids:=array_append(v_locked_ids,v_workspace_id);
  end loop;
  perform public.xelay_private_shared_organizer_actor();
  select coalesce(jsonb_agg(public.xelay_private_shared_organizer_workspace_json(w)
    order by w.created_at,w.id),'[]'::jsonb) into v_workspaces
    from public.shared_organizer_workspaces w where w.archived_at is null and w.id=any(v_locked_ids)
      and exists(select 1 from public.shared_organizer_members m
        where m.workspace_id=w.id and m.user_id=v_actor);
  select coalesce(jsonb_agg(public.xelay_private_shared_organizer_invitation_json(i)
    order by i.created_at,i.id),'[]'::jsonb) into v_invitations
    from public.shared_organizer_invitations i join public.shared_organizer_workspaces w on w.id=i.workspace_id
    where i.invitee_id=v_actor and i.status='pending' and i.expires_at>clock_timestamp()
      and w.archived_at is null and w.id=any(v_locked_ids);
  return jsonb_build_object('workspaces',v_workspaces,'invitations',v_invitations);
end;
$$;

create or replace function public.xelay_shared_organizer_workspace(
  p_workspace_id uuid,p_offset integer default 0,p_limit integer default 100
)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp set timezone='UTC' as $$
declare v_actor uuid; v_workspace public.shared_organizer_workspaces%rowtype;
  v_members jsonb; v_invitations jsonb:='[]'::jsonb; v_tasks jsonb; v_total integer;
begin
  v_actor:=public.xelay_private_shared_organizer_actor();
  if p_offset is null or p_offset<0 or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'SHARED_ORGANIZER_INVALID_PAGE' using errcode='22023';
  end if;
  v_workspace:=public.xelay_private_lock_shared_organizer(p_workspace_id);
  select coalesce(jsonb_agg(jsonb_build_object('workspace_id',m.workspace_id,'user_id',m.user_id,
    'role',m.role,'full_name',left(coalesce(nullif(btrim(p.full_name),''),'Учасник'),500),
    'username',left(p.username,100),
    'avatar_url',case when char_length(p.avatar_url)<=4096 then p.avatar_url else null end,
    'is_premium',public.xelay_has_participant_access(m.user_id))
    order by case when m.role='owner' then 0 else 1 end,m.created_at,m.user_id),'[]'::jsonb)
    into v_members from public.shared_organizer_members m left join public.profiles p on p.id=m.user_id
    where m.workspace_id=p_workspace_id;
  if v_workspace.owner_id=v_actor then
    select coalesce(jsonb_agg(public.xelay_private_shared_organizer_invitation_json(i)
      order by i.created_at,i.id),'[]'::jsonb) into v_invitations
      from public.shared_organizer_invitations i where i.workspace_id=p_workspace_id
        and i.status='pending' and i.expires_at>clock_timestamp();
  end if;
  select count(*)::integer into v_total from public.shared_organizer_tasks where workspace_id=p_workspace_id;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.completed,
    coalesce(t.due_at,(t.due_date+time '23:59:59') at time zone 'Europe/Kyiv') nulls last,t.created_at,t.id),'[]'::jsonb)
    into v_tasks from (select * from public.shared_organizer_tasks where workspace_id=p_workspace_id
      order by completed,coalesce(due_at,(due_date+time '23:59:59') at time zone 'Europe/Kyiv') nulls last,
        created_at,id offset p_offset limit p_limit) t;
  return jsonb_build_object('workspace',public.xelay_private_shared_organizer_workspace_json(v_workspace),
    'members',v_members,'invitations',v_invitations,'tasks',v_tasks,'total',v_total);
end;
$$;

create or replace function public.xelay_create_shared_organizer(p_name text)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_actor uuid; v_id uuid; v_name text:=btrim(p_name);
begin
  v_actor:=public.xelay_private_shared_organizer_actor();
  if v_name is null or char_length(v_name) not between 1 and 100 then
    raise exception 'SHARED_ORGANIZER_INVALID_NAME' using errcode='22023';
  end if;
  -- An actor-wide creation lock bounds simultaneous creates across workspaces.
  perform pg_advisory_xact_lock(hashtextextended('xelay:shared-organizer-owner:'||v_actor::text,0));
  perform public.xelay_private_shared_organizer_actor();
  if (select count(*) from public.shared_organizer_workspaces where owner_id=v_actor and archived_at is null)>=10 then
    raise exception 'SHARED_ORGANIZER_OWNED_WORKSPACE_LIMIT' using errcode='54000';
  end if;
  perform public.xelay_private_shared_organizer_charge(v_actor,true);
  insert into public.shared_organizer_workspaces(owner_id,name) values(v_actor,v_name) returning id into v_id;
  perform id from public.shared_organizer_workspaces where id=v_id for update;
  insert into public.shared_organizer_members(workspace_id,user_id,role) values(v_id,v_actor,'owner');
  return v_id;
end;
$$;

create or replace function public.xelay_rename_shared_organizer(
  p_workspace_id uuid,p_name text,p_expected_updated_at timestamptz
)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_workspace public.shared_organizer_workspaces%rowtype; v_name text:=btrim(p_name);
begin
  v_workspace:=public.xelay_private_lock_shared_organizer(p_workspace_id,true);
  if p_expected_updated_at is null or p_expected_updated_at is distinct from v_workspace.updated_at then
    raise exception 'SHARED_ORGANIZER_CONFLICT' using errcode='40001';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 100 then
    raise exception 'SHARED_ORGANIZER_INVALID_NAME' using errcode='22023';
  end if;
  update public.shared_organizer_workspaces set name=v_name where id=p_workspace_id;
end;
$$;

create or replace function public.xelay_invite_shared_organizer(p_workspace_id uuid,p_username text)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_actor uuid; v_workspace public.shared_organizer_workspaces%rowtype;
  v_username text:=lower(regexp_replace(btrim(p_username),'^@',''));
  v_invitee uuid; v_id uuid; v_now timestamptz;
begin
  v_actor:=public.xelay_private_shared_organizer_actor();
  v_workspace:=public.xelay_private_lock_shared_organizer(p_workspace_id,true);
  if v_username is null or v_username !~ '^[[:alnum:]][[:alnum:]_.-]{2,29}$' then
    raise exception 'SHARED_ORGANIZER_INVALID_USERNAME' using errcode='22023';
  end if;
  -- Exact, case-normalized username equality only. Never query by email.
  select id into v_invitee from public.profiles where lower(username)=v_username;
  if not found then raise exception 'SHARED_ORGANIZER_USER_NOT_FOUND' using errcode='22023'; end if;
  if v_invitee=v_actor then raise exception 'SHARED_ORGANIZER_SELF_INVITE' using errcode='22023'; end if;
  if not public.xelay_has_participant_access(v_invitee) then
    raise exception 'SHARED_ORGANIZER_INVITEE_PARTICIPANT_REQUIRED' using errcode='42501';
  end if;
  if exists(select 1 from public.shared_organizer_members where workspace_id=p_workspace_id and user_id=v_invitee) then
    raise exception 'SHARED_ORGANIZER_ALREADY_MEMBER' using errcode='22023';
  end if;
  -- Serialize inbox quota checks across distinct owners/workspaces.
  perform pg_advisory_xact_lock(hashtextextended('xelay:shared-organizer-inbox:'||v_invitee::text,0));
  v_now:=clock_timestamp();
  perform public.xelay_private_shared_organizer_actor();
  if not public.xelay_has_participant_access(v_invitee) then
    raise exception 'SHARED_ORGANIZER_INVITEE_PARTICIPANT_REQUIRED' using errcode='42501';
  end if;
  update public.shared_organizer_invitations set status='expired',responded_at=v_now
    where workspace_id=p_workspace_id and status='pending' and expires_at<=v_now;
  if exists(select 1 from public.shared_organizer_invitations
    where workspace_id=p_workspace_id and invitee_id=v_invitee and status='pending') then
    raise exception 'SHARED_ORGANIZER_INVITATION_PENDING' using errcode='22023';
  end if;
  if (select count(*) from public.shared_organizer_members where workspace_id=p_workspace_id)
    +(select count(*) from public.shared_organizer_invitations
      where workspace_id=p_workspace_id and status='pending' and expires_at>v_now)>=5 then
    raise exception 'SHARED_ORGANIZER_WORKSPACE_FULL' using errcode='54000';
  end if;
  if (select count(*) from public.shared_organizer_invitations i
    join public.shared_organizer_workspaces w on w.id=i.workspace_id
    where i.invitee_id=v_invitee and i.status='pending' and i.expires_at>v_now and w.archived_at is null)>=20 then
    raise exception 'SHARED_ORGANIZER_INVITEE_INVITATION_LIMIT' using errcode='54000';
  end if;
  perform public.xelay_private_shared_organizer_charge(v_actor,false);
  insert into public.shared_organizer_invitations(workspace_id,inviter_id,invitee_id,created_at,expires_at)
    values(p_workspace_id,v_actor,v_invitee,v_now,v_now+interval '7 days') returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.xelay_respond_shared_organizer_invite(p_invitation_id uuid,p_accept boolean)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_actor uuid; v_workspace_id uuid; v_workspace public.shared_organizer_workspaces%rowtype;
  v_invitation public.shared_organizer_invitations%rowtype; v_now timestamptz;
begin
  v_actor:=public.xelay_private_shared_organizer_actor();
  if p_accept is null then raise exception 'SHARED_ORGANIZER_INVALID_INVITATION' using errcode='22023'; end if;
  select workspace_id into v_workspace_id from public.shared_organizer_invitations
    where id=p_invitation_id and invitee_id=v_actor;
  if not found then raise exception 'SHARED_ORGANIZER_INVITATION_UNAVAILABLE' using errcode='42501'; end if;
  select * into v_workspace from public.shared_organizer_workspaces where id=v_workspace_id for update;
  if not found or v_workspace.archived_at is not null then
    raise exception 'SHARED_ORGANIZER_INVITATION_UNAVAILABLE' using errcode='42501';
  end if;
  perform public.xelay_private_shared_organizer_actor();
  select * into v_invitation from public.shared_organizer_invitations
    where id=p_invitation_id and workspace_id=v_workspace_id and invitee_id=v_actor;
  if not found or v_invitation.status<>'pending' then
    raise exception 'SHARED_ORGANIZER_INVITATION_UNAVAILABLE' using errcode='42501';
  end if;
  v_now:=clock_timestamp();
  if v_invitation.expires_at<=v_now then
    raise exception 'SHARED_ORGANIZER_INVITATION_EXPIRED' using errcode='22023';
  end if;
  if p_accept then
    if exists(select 1 from public.shared_organizer_members where workspace_id=v_workspace_id and user_id=v_actor) then
      raise exception 'SHARED_ORGANIZER_ALREADY_MEMBER' using errcode='22023';
    end if;
    -- The accepting invite already occupies one reserved seat. Convert it
    -- atomically rather than counting it as an additional sixth seat.
    if (select count(*) from public.shared_organizer_members where workspace_id=v_workspace_id)
      +(select count(*) from public.shared_organizer_invitations
        where workspace_id=v_workspace_id and status='pending' and expires_at>v_now)>5 then
      raise exception 'SHARED_ORGANIZER_WORKSPACE_FULL' using errcode='54000';
    end if;
    insert into public.shared_organizer_members(workspace_id,user_id,role) values(v_workspace_id,v_actor,'member');
    update public.shared_organizer_invitations set status='accepted',responded_at=v_now where id=p_invitation_id;
    return v_workspace_id;
  end if;
  update public.shared_organizer_invitations set status='declined',responded_at=v_now where id=p_invitation_id;
  return null;
end;
$$;

create or replace function public.xelay_cancel_shared_organizer_invite(p_invitation_id uuid)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_workspace_id uuid; v_workspace public.shared_organizer_workspaces%rowtype;
  v_invitation public.shared_organizer_invitations%rowtype;
begin
  perform public.xelay_private_shared_organizer_actor();
  select workspace_id into v_workspace_id from public.shared_organizer_invitations where id=p_invitation_id;
  if not found then raise exception 'SHARED_ORGANIZER_INVITATION_UNAVAILABLE' using errcode='42501'; end if;
  v_workspace:=public.xelay_private_lock_shared_organizer(v_workspace_id,true);
  select * into v_invitation from public.shared_organizer_invitations
    where id=p_invitation_id and workspace_id=v_workspace_id;
  if not found or v_invitation.status<>'pending' then
    raise exception 'SHARED_ORGANIZER_INVITATION_UNAVAILABLE' using errcode='42501';
  end if;
  -- Normally a pending invitee has no assigned tasks, but keep cancellation
  -- safe for retained/imported data as well. The task trigger bumps its version.
  update public.shared_organizer_tasks set assignee_id=null
    where workspace_id=v_workspace_id and assignee_id=v_invitation.invitee_id;
  update public.shared_organizer_invitations set status='cancelled',responded_at=clock_timestamp()
    where id=p_invitation_id;
end;
$$;

create or replace function public.xelay_remove_shared_organizer_member(p_workspace_id uuid,p_user_id uuid)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_actor uuid; v_workspace public.shared_organizer_workspaces%rowtype;
begin
  v_actor:=public.xelay_private_shared_organizer_actor();
  v_workspace:=public.xelay_private_lock_shared_organizer(p_workspace_id);
  if p_user_id=v_workspace.owner_id then
    raise exception 'SHARED_ORGANIZER_OWNER_CANNOT_LEAVE' using errcode='42501';
  end if;
  if v_actor<>v_workspace.owner_id and p_user_id is distinct from v_actor then
    raise exception 'SHARED_ORGANIZER_OWNER_REQUIRED' using errcode='42501';
  end if;
  if p_user_id is null or not exists(select 1 from public.shared_organizer_members
    where workspace_id=p_workspace_id and user_id=p_user_id and role='member') then
    raise exception 'SHARED_ORGANIZER_MEMBER_UNAVAILABLE' using errcode='22023';
  end if;
  -- Unassign before deleting the caller's own membership, so the same task
  -- auditing/access trigger remains valid for a non-owner leaving the group.
  update public.shared_organizer_tasks set assignee_id=null
    where workspace_id=p_workspace_id and assignee_id=p_user_id;
  delete from public.shared_organizer_members where workspace_id=p_workspace_id and user_id=p_user_id;
  update public.shared_organizer_invitations set status='cancelled',responded_at=clock_timestamp()
    where workspace_id=p_workspace_id and invitee_id=p_user_id and status='pending';
end;
$$;

create or replace function public.xelay_save_shared_organizer_task(
  p_workspace_id uuid,p_task_id uuid,p_expected_updated_at timestamptz,
  p_title text,p_notes text,p_subject text,p_due_date date,p_due_at timestamptz,
  p_assignee_id uuid,p_completed boolean
)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp set timezone='UTC' as $$
declare v_actor uuid; v_workspace public.shared_organizer_workspaces%rowtype;
  v_task public.shared_organizer_tasks%rowtype;
begin
  v_actor:=public.xelay_private_shared_organizer_actor();
  v_workspace:=public.xelay_private_lock_shared_organizer(p_workspace_id);
  if p_task_id is null then
    if p_expected_updated_at is not null then
      raise exception 'SHARED_ORGANIZER_CONFLICT' using errcode='40001';
    end if;
    if (select count(*) from public.shared_organizer_tasks where workspace_id=p_workspace_id)>=1000 then
      raise exception 'SHARED_ORGANIZER_TASK_LIMIT' using errcode='54000';
    end if;
    insert into public.shared_organizer_tasks(workspace_id,created_by,updated_by,title,notes,subject,
      due_date,due_at,assignee_id,completed)
      values(p_workspace_id,v_actor,v_actor,p_title,p_notes,p_subject,p_due_date,p_due_at,p_assignee_id,p_completed)
      returning * into v_task;
  else
    select * into v_task from public.shared_organizer_tasks where id=p_task_id and workspace_id=p_workspace_id;
    if not found then raise exception 'SHARED_ORGANIZER_TASK_UNAVAILABLE' using errcode='22023'; end if;
    if p_expected_updated_at is null or p_expected_updated_at is distinct from v_task.updated_at then
      raise exception 'SHARED_ORGANIZER_CONFLICT' using errcode='40001';
    end if;
    update public.shared_organizer_tasks set title=p_title,notes=p_notes,subject=p_subject,
      due_date=p_due_date,due_at=p_due_at,assignee_id=p_assignee_id,completed=p_completed
      where id=p_task_id and workspace_id=p_workspace_id returning * into v_task;
  end if;
  return to_jsonb(v_task);
end;
$$;

create or replace function public.xelay_delete_shared_organizer_task(
  p_workspace_id uuid,p_task_id uuid,p_expected_updated_at timestamptz
)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_workspace public.shared_organizer_workspaces%rowtype; v_updated_at timestamptz;
begin
  v_workspace:=public.xelay_private_lock_shared_organizer(p_workspace_id);
  select updated_at into v_updated_at from public.shared_organizer_tasks
    where id=p_task_id and workspace_id=p_workspace_id;
  if not found then raise exception 'SHARED_ORGANIZER_TASK_UNAVAILABLE' using errcode='22023'; end if;
  if p_expected_updated_at is null or p_expected_updated_at is distinct from v_updated_at then
    raise exception 'SHARED_ORGANIZER_CONFLICT' using errcode='40001';
  end if;
  delete from public.shared_organizer_tasks where id=p_task_id and workspace_id=p_workspace_id;
end;
$$;

create or replace function public.xelay_archive_shared_organizer(p_workspace_id uuid,p_expected_updated_at timestamptz)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_workspace public.shared_organizer_workspaces%rowtype;
begin
  v_workspace:=public.xelay_private_lock_shared_organizer(p_workspace_id,true);
  if p_expected_updated_at is null or p_expected_updated_at is distinct from v_workspace.updated_at then
    raise exception 'SHARED_ORGANIZER_CONFLICT' using errcode='40001';
  end if;
  update public.shared_organizer_invitations set status='cancelled',responded_at=clock_timestamp()
    where workspace_id=p_workspace_id and status='pending';
  update public.shared_organizer_workspaces set archived_at=clock_timestamp() where id=p_workspace_id;
end;
$$;

revoke all on function
  public.xelay_private_shared_organizer_actor(),
  public.xelay_private_lock_shared_organizer(uuid,boolean),
  public.xelay_private_shared_organizer_workspace_json(public.shared_organizer_workspaces),
  public.xelay_private_shared_organizer_invitation_json(public.shared_organizer_invitations),
  public.xelay_private_shared_organizer_charge(uuid,boolean),
  public.xelay_private_guard_shared_organizer_workspace(),
  public.xelay_private_guard_shared_organizer_member(),
  public.xelay_private_guard_shared_organizer_invitation(),
  public.xelay_private_guard_shared_organizer_task(),
  public.xelay_shared_organizer_overview(),
  public.xelay_shared_organizer_workspace(uuid,integer,integer),
  public.xelay_create_shared_organizer(text),
  public.xelay_rename_shared_organizer(uuid,text,timestamptz),
  public.xelay_invite_shared_organizer(uuid,text),
  public.xelay_respond_shared_organizer_invite(uuid,boolean),
  public.xelay_cancel_shared_organizer_invite(uuid),
  public.xelay_remove_shared_organizer_member(uuid,uuid),
  public.xelay_save_shared_organizer_task(uuid,uuid,timestamptz,text,text,text,date,timestamptz,uuid,boolean),
  public.xelay_delete_shared_organizer_task(uuid,uuid,timestamptz),
  public.xelay_archive_shared_organizer(uuid,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function
  public.xelay_shared_organizer_overview(),
  public.xelay_shared_organizer_workspace(uuid,integer,integer),
  public.xelay_create_shared_organizer(text),
  public.xelay_rename_shared_organizer(uuid,text,timestamptz),
  public.xelay_invite_shared_organizer(uuid,text),
  public.xelay_respond_shared_organizer_invite(uuid,boolean),
  public.xelay_cancel_shared_organizer_invite(uuid),
  public.xelay_remove_shared_organizer_member(uuid,uuid),
  public.xelay_save_shared_organizer_task(uuid,uuid,timestamptz,text,text,text,date,timestamptz,uuid,boolean),
  public.xelay_delete_shared_organizer_task(uuid,uuid,timestamptz),
  public.xelay_archive_shared_organizer(uuid,timestamptz)
  to authenticated;

comment on table public.shared_organizer_workspaces is
  'Private shared organizers independent of academic groups/personal tasks. Archive retains all data but all authenticated RPCs hide it. Ownership is immutable.';
comment on table public.shared_organizer_members is
  'At most five accepted members plus unexpired pending invitation reservations per workspace, including the owner. Expiration blocks only the acting user and never deletes membership.';
comment on table public.shared_organizer_tasks is
  'Plain-text shared tasks. All active accepted members may edit/delete; server controls creator/updater and monotonic timestamps; RPC edits/deletes require the exact observed updated_at.';
comment on function public.xelay_shared_organizer_workspace(uuid,integer,integer) is
  'Locks the workspace, checks active actor/membership, returns only safe profile metadata and at most 100 tasks; pending invitation metadata is owner-only.';

notify pgrst,'reload schema';
commit;
