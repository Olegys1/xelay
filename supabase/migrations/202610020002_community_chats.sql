-- Ordinary chats and broadcast channels. Existing personal conversations are unchanged.
-- Run the complete file as one transaction after 202610020001_university_news_scopes.sql.
begin;

do $$ begin
  if to_regclass('public.news_posts') is null or to_regclass('public.notifications') is null
    or to_regprocedure('public.xelay_can_manage_news(uuid,uuid)') is null then
    raise exception 'Apply the university news migrations before community chats';
  end if;
end $$;

create table if not exists public.chat_spaces (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('group','channel')),
  visibility text not null check (visibility in ('public','private')),
  username text,
  name text not null check (length(btrim(name)) between 1 and 100),
  description text not null default '' check (length(description) <= 2000),
  avatar_path text,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  comments_enabled boolean not null default true,
  join_approval boolean not null default false,
  history_visible boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint chat_spaces_username_check check (
    (visibility = 'private' and username is null)
    or (visibility = 'public' and username ~ '^[a-z][a-z0-9_]{3,31}$')
  )
);
create unique index if not exists chat_spaces_username_unique on public.chat_spaces(lower(username)) where username is not null;
create index if not exists chat_spaces_public_idx on public.chat_spaces(kind, updated_at desc) where visibility = 'public';

create table if not exists public.chat_members (
  space_id uuid not null references public.chat_spaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  status text not null default 'active' check (status in ('active','left','banned')),
  joined_at timestamptz not null default clock_timestamp(),
  visible_from timestamptz not null default '-infinity',
  last_read_at timestamptz not null default clock_timestamp(),
  muted boolean not null default false,
  primary key(space_id,user_id)
);
create index if not exists chat_members_user_idx on public.chat_members(user_id, status, space_id);
create unique index if not exists chat_members_one_owner on public.chat_members(space_id) where role = 'owner';

create table if not exists public.chat_invitations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.chat_spaces(id) on delete cascade,
  invited_by uuid not null references public.profiles(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','revoked')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(space_id,user_id),
  check (invited_by <> user_id)
);
create index if not exists chat_invitations_user_idx on public.chat_invitations(user_id,status);
create index if not exists chat_invitations_inviter_idx on public.chat_invitations(invited_by,created_at desc);

create table if not exists public.chat_invite_links (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.chat_spaces(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid not null references public.profiles(id) on delete cascade,
  expires_at timestamptz,
  max_uses integer check (max_uses between 1 and 10000),
  used_count integer not null default 0 check (used_count >= 0),
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.chat_join_requests (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.chat_spaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  link_id uuid references public.chat_invite_links(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','cancelled')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(space_id,user_id)
);

create table if not exists public.chat_posts (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.chat_spaces(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete restrict,
  body text not null default '' check (length(body) <= 10000),
  parent_post_id uuid,
  reply_to uuid,
  shared_news_post_id uuid references public.news_posts(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  edited_at timestamptz,
  deleted_at timestamptz,
  unique(id,space_id),
  foreign key(parent_post_id,space_id) references public.chat_posts(id,space_id) on delete cascade,
  foreign key(reply_to,space_id) references public.chat_posts(id,space_id) on delete set null (reply_to),
  check (parent_post_id is null or parent_post_id <> id),
  check (reply_to is null or reply_to <> id)
);
create index if not exists chat_posts_stream_idx on public.chat_posts(space_id,parent_post_id,created_at desc,id desc);
create index if not exists chat_posts_sender_created_idx on public.chat_posts(sender_id,created_at desc);
create index if not exists chat_posts_news_idx on public.chat_posts(shared_news_post_id,space_id) where deleted_at is null and shared_news_post_id is not null;

create table if not exists public.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null,
  space_id uuid not null,
  uploaded_by uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 255),
  media_type text not null check (media_type in ('image','video','file')),
  mime_type text not null,
  file_size bigint not null check (file_size between 1 and 26214400),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(post_id,space_id) references public.chat_posts(id,space_id) on delete cascade
);
create index if not exists chat_attachments_post_idx on public.chat_attachments(post_id);

create table if not exists public.chat_reactions (
  space_id uuid not null,
  post_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (length(emoji) between 1 and 32),
  created_at timestamptz not null default clock_timestamp(),
  primary key(post_id,user_id),
  foreign key(post_id,space_id) references public.chat_posts(id,space_id) on delete cascade
);
create table if not exists public.chat_pins (
  space_id uuid not null,
  post_id uuid not null,
  pinned_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key(space_id,post_id),
  foreign key(post_id,space_id) references public.chat_posts(id,space_id) on delete cascade
);

alter table public.notifications add column if not exists chat_space_id uuid references public.chat_spaces(id) on delete cascade;
create index if not exists notifications_chat_space_idx on public.notifications(chat_space_id) where chat_space_id is not null;
create index if not exists chat_join_requests_user_idx on public.chat_join_requests(user_id,status);

-- Security-definer predicates avoid recursive membership policies.
create or replace function public.xelay_chat_is_member(p_space_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.chat_members
    where space_id = p_space_id and user_id = auth.uid() and status = 'active');
$$;
create or replace function public.xelay_chat_is_admin(p_space_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.chat_members
    where space_id = p_space_id and user_id = auth.uid() and status = 'active' and role in ('owner','admin'));
$$;
create or replace function public.xelay_chat_can_view_space(p_space_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.chat_spaces s where s.id = p_space_id and (
    s.visibility = 'public' or public.xelay_chat_is_member(s.id)
    or exists(select 1 from public.chat_invitations i where i.space_id = s.id and i.user_id = auth.uid() and i.status = 'pending')
    or exists(select 1 from public.chat_join_requests r where r.space_id = s.id and r.user_id = auth.uid() and r.status = 'pending')
  ));
$$;
create or replace function public.xelay_chat_can_read_post(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.chat_posts p
    join public.chat_members m on m.space_id = p.space_id and m.user_id = auth.uid() and m.status = 'active'
    where p.id = p_post_id and p.deleted_at is null and p.created_at >= m.visible_from
      and (p.parent_post_id is null or exists(select 1 from public.chat_posts root
        where root.id = p.parent_post_id and root.deleted_at is null and root.created_at >= m.visible_from)));
$$;

-- Every write takes the same space lock before rechecking current roles and membership.
create or replace function public.xelay_chat_lock(p_space_id uuid,p_permission text default 'member')
returns public.chat_spaces language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_role text;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  select * into v_space from public.chat_spaces where id = p_space_id for update;
  if not found then raise exception 'CHAT_NOT_FOUND'; end if;
  select role into v_role from public.chat_members where space_id = p_space_id and user_id = auth.uid() and status = 'active';
  if p_permission = 'owner' and v_space.owner_id <> auth.uid() then raise exception 'CHAT_OWNER_REQUIRED'; end if;
  if p_permission = 'admin' and coalesce(v_role,'') not in ('owner','admin') then raise exception 'CHAT_ADMIN_REQUIRED'; end if;
  if p_permission = 'member' and v_role is null then raise exception 'CHAT_MEMBER_REQUIRED'; end if;
  return v_space;
end $$;

create or replace function public.xelay_chat_space_json(p_space_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(s) || jsonb_build_object('member_count',(select count(*) from public.chat_members m where m.space_id = s.id and m.status = 'active'))
  from public.chat_spaces s where s.id = p_space_id;
$$;
create or replace function public.xelay_chat_post_json(p_post_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(p) || jsonb_build_object(
    'attachments',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at,a.id) from public.chat_attachments a where a.post_id = p.id),'[]'::jsonb),
    'reactions',coalesce((select jsonb_agg(jsonb_build_object('emoji',r.emoji,'user_id',r.user_id)) from public.chat_reactions r where r.post_id = p.id),'[]'::jsonb),
    'comment_count',(select count(*) from public.chat_posts c where c.parent_post_id = p.id and c.deleted_at is null),
    'is_pinned',exists(select 1 from public.chat_pins pin where pin.post_id = p.id))
  from public.chat_posts p where p.id = p_post_id;
$$;

create or replace function public.xelay_chat_notify(p_recipient_id uuid,p_space_id uuid,p_type text,p_message text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_recipient_id = auth.uid() then return; end if;
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,chat_space_id)
    values(p_recipient_id,auth.uid(),coalesce((select nullif(full_name,'') from public.profiles where id = auth.uid()),'Учасник'),
      p_type,p_message,false,p_space_id);
end $$;

-- History visibility is fixed at joining time; returning members do not automatically regain hidden history.
create or replace function public.xelay_chat_activate(p_space_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_status text; v_now timestamptz := clock_timestamp();
begin
  select * into v_space from public.chat_spaces where id = p_space_id;
  select status into v_status from public.chat_members where space_id = p_space_id and user_id = p_user_id;
  if v_status = 'banned' then raise exception 'CHAT_BANNED'; end if;
  if v_status = 'active' then return; end if;
  if (select count(*) from public.chat_members where space_id = p_space_id and status = 'active') >= 10000 then raise exception 'CHAT_MEMBER_LIMIT'; end if;
  insert into public.chat_members(space_id,user_id,role,status,joined_at,visible_from,last_read_at)
    values(p_space_id,p_user_id,'member','active',v_now,case when v_space.kind = 'channel' or v_space.history_visible then '-infinity'::timestamptz else v_now end,v_now)
    on conflict(space_id,user_id) do update set status = 'active',role = 'member',joined_at = excluded.joined_at,
      visible_from = excluded.visible_from,last_read_at = excluded.last_read_at;
  update public.chat_spaces set updated_at = v_now where id = p_space_id;
end $$;

-- Private storage: upload first, then atomically attach an owned object to the post/avatar.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('xelay-chat-media','xelay-chat-media',false,26214400,array[
  'image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime',
  'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip','application/x-zip-compressed','text/plain','text/csv','application/rtf'])
on conflict(id) do update set public = false,file_size_limit = excluded.file_size_limit,allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.xelay_chat_valid_media_path(p_path text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and p_path is not null and length(p_path) <= 500
    and p_path ~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$')
    and p_path !~ '(^|/)\.\.?(/|$)';
$$;
create or replace function public.xelay_chat_validate_avatar(p_path text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_meta jsonb;
begin
  if p_path is null then return; end if;
  if not public.xelay_chat_valid_media_path(p_path) then raise exception 'CHAT_INVALID_MEDIA'; end if;
  select metadata into v_meta from storage.objects where bucket_id = 'xelay-chat-media' and name = p_path for update;
  if not found or coalesce(v_meta->>'mimetype','') not in ('image/jpeg','image/png','image/webp','image/gif')
    or coalesce(v_meta->>'size','') !~ '^[0-9]+$' then raise exception 'CHAT_INVALID_MEDIA'; end if;
  if (v_meta->>'size')::numeric not between 1 and 5242880
    or exists(select 1 from public.chat_attachments where storage_path = p_path) then raise exception 'CHAT_INVALID_MEDIA'; end if;
end $$;

create or replace function public.xelay_chat_create(
  p_kind text,p_visibility text,p_name text,p_username text default null,p_description text default '',
  p_avatar_path text default null,p_comments_enabled boolean default true,p_join_approval boolean default false,p_history_visible boolean default true
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_username text := lower(ltrim(btrim(p_username),'@'));
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if p_kind is null or p_kind not in ('group','channel') or p_visibility is null or p_visibility not in ('public','private')
    or p_name is null or length(btrim(p_name)) not between 1 and 100 or p_description is null or length(p_description) > 2000
    or p_comments_enabled is null or p_join_approval is null or p_history_visible is null then raise exception 'CHAT_INVALID_INPUT'; end if;
  if p_visibility = 'public' and (v_username is null or v_username !~ '^[a-z][a-z0-9_]{3,31}$') then raise exception 'CHAT_INVALID_USERNAME'; end if;
  if p_visibility = 'private' then v_username := null; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-chat-create:' || auth.uid()::text,0));
  if (select count(*) from public.chat_spaces where owner_id = auth.uid()) >= 100 then raise exception 'CHAT_SPACE_LIMIT'; end if;
  perform public.xelay_chat_validate_avatar(p_avatar_path);
  insert into public.chat_spaces(kind,visibility,username,name,description,avatar_path,owner_id,comments_enabled,join_approval,history_visible)
    values(p_kind,p_visibility,v_username,btrim(p_name),p_description,p_avatar_path,auth.uid(),p_comments_enabled,p_join_approval,p_history_visible) returning id into v_id;
  insert into public.chat_members(space_id,user_id,role,visible_from) values(v_id,auth.uid(),'owner','-infinity');
  return v_id;
exception when unique_violation then raise exception 'CHAT_USERNAME_TAKEN';
end $$;

create or replace function public.xelay_chat_invite(p_space_id uuid,p_user_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_id uuid; v_status text;
begin
  v_space := public.xelay_chat_lock(p_space_id,'admin');
  if p_user_id is null or p_user_id = auth.uid() or not exists(select 1 from public.profiles where id = p_user_id) then raise exception 'CHAT_INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-chat-invite:' || auth.uid()::text,0));
  select status into v_status from public.chat_members where space_id = p_space_id and user_id = p_user_id;
  if v_status = 'active' then raise exception 'CHAT_ALREADY_MEMBER'; end if;
  if v_status = 'banned' then raise exception 'CHAT_BANNED'; end if;
  select id into v_id from public.chat_invitations where space_id = p_space_id and user_id = p_user_id and status = 'pending';
  if v_id is not null then return v_id; end if;
  if exists(select 1 from public.chat_invitations where space_id = p_space_id and user_id = p_user_id
    and created_at > clock_timestamp() - interval '1 hour') then raise exception 'CHAT_RATE_LIMIT'; end if;
  if (select count(*) from public.chat_invitations where invited_by = auth.uid() and created_at > clock_timestamp() - interval '1 hour') >= 50 then raise exception 'CHAT_RATE_LIMIT'; end if;
  insert into public.chat_invitations(space_id,user_id,invited_by) values(p_space_id,p_user_id,auth.uid())
    on conflict(space_id,user_id) do update set status = 'pending',invited_by = excluded.invited_by,
      created_at = clock_timestamp(),updated_at = clock_timestamp() returning id into v_id;
  perform public.xelay_chat_notify(p_user_id,p_space_id,'chat_invite','запрошує вас до «' || v_space.name || '»');
  update public.chat_spaces set updated_at = clock_timestamp() where id = p_space_id;
  return v_id;
end $$;

create or replace function public.xelay_chat_invitation(p_invitation_id uuid,p_accept boolean)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_inv public.chat_invitations%rowtype; v_space public.chat_spaces%rowtype;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  select * into v_inv from public.chat_invitations where id = p_invitation_id and user_id = auth.uid();
  if not found then raise exception 'CHAT_INVITATION_NOT_FOUND'; end if;
  v_space := public.xelay_chat_lock(v_inv.space_id,'none');
  select * into v_inv from public.chat_invitations where id = p_invitation_id and user_id = auth.uid();
  if p_accept is null then raise exception 'CHAT_INVALID_INPUT'; end if;
  if v_inv.status <> 'pending' then raise exception 'CHAT_INVITATION_CLOSED'; end if;
  if p_accept then
    perform public.xelay_chat_activate(v_inv.space_id,auth.uid());
    update public.chat_join_requests set status = 'cancelled',updated_at = clock_timestamp()
      where space_id = v_inv.space_id and user_id = auth.uid() and status = 'pending';
  end if;
  update public.chat_invitations set status = case when p_accept then 'accepted' else 'rejected' end,
    updated_at = clock_timestamp() where id = p_invitation_id;
  update public.chat_spaces set updated_at = clock_timestamp() where id = v_inv.space_id;
  return v_inv.space_id;
end $$;

create or replace function public.xelay_chat_request(p_space_id uuid,p_link_id uuid default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_old text;
begin
  select * into v_space from public.chat_spaces where id = p_space_id;
  select status into v_old from public.chat_join_requests where space_id = p_space_id and user_id = auth.uid();
  if v_old = 'pending' then return 'pending'; end if;
  insert into public.chat_join_requests(space_id,user_id,link_id) values(p_space_id,auth.uid(),p_link_id)
    on conflict(space_id,user_id) do update set status = 'pending',link_id = excluded.link_id,
      created_at = clock_timestamp(),updated_at = clock_timestamp();
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,chat_space_id)
    select m.user_id,auth.uid(),coalesce((select nullif(full_name,'') from public.profiles where id = auth.uid()),'Учасник'),
      'chat_join_request','просить приєднатися до «' || v_space.name || '»',false,p_space_id
    from public.chat_members m where m.space_id = p_space_id and m.status = 'active' and m.role in ('owner','admin') and m.user_id <> auth.uid();
  update public.chat_spaces set updated_at = clock_timestamp() where id = p_space_id;
  return 'pending';
end $$;

create or replace function public.xelay_chat_join(p_space_id uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_status text;
begin
  v_space := public.xelay_chat_lock(p_space_id,'none');
  if v_space.visibility <> 'public' then raise exception 'CHAT_INVITE_REQUIRED'; end if;
  select status into v_status from public.chat_members where space_id = p_space_id and user_id = auth.uid();
  if v_status = 'banned' then raise exception 'CHAT_BANNED'; end if;
  if v_status = 'active' then return 'active'; end if;
  if v_space.join_approval then return public.xelay_chat_request(p_space_id); end if;
  perform public.xelay_chat_activate(p_space_id,auth.uid());
  update public.chat_join_requests set status = 'cancelled',updated_at = clock_timestamp() where space_id = p_space_id and user_id = auth.uid() and status = 'pending';
  return 'active';
end $$;

create or replace function public.xelay_chat_leave(p_space_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space public.chat_spaces%rowtype;
begin
  v_space := public.xelay_chat_lock(p_space_id,'member');
  if v_space.owner_id = auth.uid() then raise exception 'CHAT_TRANSFER_REQUIRED'; end if;
  update public.chat_members set status = 'left',role = 'member' where space_id = p_space_id and user_id = auth.uid();
  update public.chat_spaces set updated_at = clock_timestamp() where id = p_space_id;
end $$;

create or replace function public.xelay_chat_delete(p_space_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.xelay_chat_lock(p_space_id,'owner');
  delete from public.chat_spaces where id = p_space_id;
end $$;

create or replace function public.xelay_chat_member(p_space_id uuid,p_user_id uuid,p_action text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_target public.chat_members%rowtype;
begin
  v_space := public.xelay_chat_lock(p_space_id,'admin');
  if p_action is null or p_action not in ('kick','ban','unban','promote','demote','transfer') or p_user_id is null then raise exception 'CHAT_INVALID_INPUT'; end if;
  select * into v_target from public.chat_members where space_id = p_space_id and user_id = p_user_id;
  if not found then raise exception 'CHAT_MEMBER_NOT_FOUND'; end if;
  if p_user_id = v_space.owner_id or p_user_id = auth.uid() then raise exception 'CHAT_PROTECTED_MEMBER'; end if;
  if p_action in ('promote','demote','transfer') and v_space.owner_id <> auth.uid() then raise exception 'CHAT_OWNER_REQUIRED'; end if;
  if v_target.role = 'admin' and v_space.owner_id <> auth.uid() then raise exception 'CHAT_OWNER_REQUIRED'; end if;
  if p_action in ('promote','demote','transfer','kick','ban') and v_target.status <> 'active' then raise exception 'CHAT_MEMBER_NOT_FOUND'; end if;
  if p_action = 'unban' and v_target.status <> 'banned' then raise exception 'CHAT_INVALID_INPUT'; end if;
  if p_action = 'transfer' then
    update public.chat_members set role = 'admin' where space_id = p_space_id and user_id = auth.uid();
    update public.chat_members set role = 'owner' where space_id = p_space_id and user_id = p_user_id;
    update public.chat_spaces set owner_id = p_user_id where id = p_space_id;
  elsif p_action in ('promote','demote') then
    update public.chat_members set role = case when p_action = 'promote' then 'admin' else 'member' end where space_id = p_space_id and user_id = p_user_id;
  else
    update public.chat_members set status = case when p_action = 'ban' then 'banned' else 'left' end,role = 'member' where space_id = p_space_id and user_id = p_user_id;
    update public.chat_invitations set status = 'revoked',updated_at = clock_timestamp() where space_id = p_space_id and user_id = p_user_id and status = 'pending';
    update public.chat_join_requests set status = 'cancelled',updated_at = clock_timestamp() where space_id = p_space_id and user_id = p_user_id and status = 'pending';
  end if;
  update public.chat_spaces set updated_at = clock_timestamp() where id = p_space_id;
end $$;

create or replace function public.xelay_chat_create_link(p_space_id uuid,p_expires_at timestamptz default null,p_max_uses integer default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_token text := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
begin
  perform public.xelay_chat_lock(p_space_id,'admin');
  if p_max_uses is not null and p_max_uses not between 1 and 10000 then raise exception 'CHAT_INVALID_INPUT'; end if;
  if p_expires_at is not null and (not isfinite(p_expires_at) or p_expires_at <= clock_timestamp()) then raise exception 'CHAT_INVALID_INPUT'; end if;
  if (select count(*) from public.chat_invite_links where space_id = p_space_id and revoked_at is null) >= 100 then raise exception 'CHAT_LINK_LIMIT'; end if;
  insert into public.chat_invite_links(space_id,token_hash,created_by,expires_at,max_uses)
    values(p_space_id,encode(sha256(convert_to(v_token,'UTF8')),'hex'),auth.uid(),p_expires_at,p_max_uses) returning id into v_id;
  return jsonb_build_object('id',v_id,'token',v_token,'expires_at',p_expires_at,'max_uses',p_max_uses,'used_count',0);
end $$;

create or replace function public.xelay_chat_revoke_link(p_link_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space_id uuid;
begin
  select space_id into v_space_id from public.chat_invite_links where id = p_link_id;
  if not found then raise exception 'CHAT_LINK_INVALID'; end if;
  perform public.xelay_chat_lock(v_space_id,'admin');
  update public.chat_invite_links set revoked_at = clock_timestamp() where id = p_link_id;
  update public.chat_spaces set updated_at = clock_timestamp() where id = v_space_id;
end $$;

create or replace function public.xelay_chat_link_preview(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_link public.chat_invite_links%rowtype; v_member public.chat_members%rowtype;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'CHAT_LINK_INVALID'; end if;
  select * into v_link from public.chat_invite_links where token_hash = encode(sha256(convert_to(p_token,'UTF8')),'hex');
  if not found then raise exception 'CHAT_LINK_INVALID'; end if;
  select * into v_member from public.chat_members where space_id = v_link.space_id and user_id = auth.uid();
  if coalesce(v_member.status,'') <> 'active' and (v_link.revoked_at is not null
    or (v_link.expires_at is not null and v_link.expires_at <= clock_timestamp())
    or (v_link.max_uses is not null and v_link.used_count >= v_link.max_uses)) then raise exception 'CHAT_LINK_INVALID'; end if;
  -- A secret link grants preview metadata only, never participants or message history.
  return jsonb_build_object('space',public.xelay_chat_space_json(v_link.space_id),
    'my_membership',case when v_member.user_id is null then null else to_jsonb(v_member) end,
    'my_join_request',(select to_jsonb(r) from public.chat_join_requests r where r.space_id = v_link.space_id and r.user_id = auth.uid() and r.status = 'pending'));
end $$;

create or replace function public.xelay_chat_join_link(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_link public.chat_invite_links%rowtype; v_space public.chat_spaces%rowtype; v_status text;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'CHAT_LINK_INVALID'; end if;
  select * into v_link from public.chat_invite_links where token_hash = encode(sha256(convert_to(p_token,'UTF8')),'hex');
  if not found then raise exception 'CHAT_LINK_INVALID'; end if;
  v_space := public.xelay_chat_lock(v_link.space_id,'none');
  select * into v_link from public.chat_invite_links where id = v_link.id;
  select status into v_status from public.chat_members where space_id = v_link.space_id and user_id = auth.uid();
  if v_status = 'banned' then raise exception 'CHAT_BANNED'; end if;
  if v_status = 'active' then return jsonb_build_object('space_id',v_link.space_id,'status','active'); end if;
  if v_link.revoked_at is not null or (v_link.expires_at is not null and v_link.expires_at <= clock_timestamp())
    or (v_link.max_uses is not null and v_link.used_count >= v_link.max_uses) then raise exception 'CHAT_LINK_INVALID'; end if;
  if v_space.join_approval then
    v_status := public.xelay_chat_request(v_link.space_id,v_link.id);
  else
    perform public.xelay_chat_activate(v_link.space_id,auth.uid());
    update public.chat_invite_links set used_count = used_count + 1 where id = v_link.id;
    update public.chat_join_requests set status = 'cancelled',updated_at = clock_timestamp() where space_id = v_link.space_id and user_id = auth.uid() and status = 'pending';
    v_status := 'active';
  end if;
  return jsonb_build_object('space_id',v_link.space_id,'status',v_status);
end $$;

create or replace function public.xelay_chat_join_request(p_request_id uuid,p_accept boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_request public.chat_join_requests%rowtype; v_space public.chat_spaces%rowtype; v_link public.chat_invite_links%rowtype;
begin
  select * into v_request from public.chat_join_requests where id = p_request_id;
  if not found then raise exception 'CHAT_REQUEST_NOT_FOUND'; end if;
  v_space := public.xelay_chat_lock(v_request.space_id,'admin');
  select * into v_request from public.chat_join_requests where id = p_request_id;
  if v_request.status <> 'pending' then raise exception 'CHAT_REQUEST_CLOSED'; end if;
  if p_accept is null then raise exception 'CHAT_INVALID_INPUT'; end if;
  if p_accept then
    if v_request.link_id is not null then
      select * into v_link from public.chat_invite_links where id = v_request.link_id;
      if not found or v_link.revoked_at is not null or (v_link.expires_at is not null and v_link.expires_at <= clock_timestamp())
        or (v_link.max_uses is not null and v_link.used_count >= v_link.max_uses) then raise exception 'CHAT_LINK_INVALID'; end if;
    end if;
    if not exists(select 1 from public.chat_members where space_id = v_request.space_id and user_id = v_request.user_id and status = 'active') then
      perform public.xelay_chat_activate(v_request.space_id,v_request.user_id);
      if v_request.link_id is not null then update public.chat_invite_links set used_count = used_count + 1 where id = v_request.link_id; end if;
    end if;
    perform public.xelay_chat_notify(v_request.user_id,v_request.space_id,'chat_join_approved','схвалив(-ла) ваше приєднання до «' || v_space.name || '»');
  end if;
  update public.chat_join_requests set status = case when p_accept then 'accepted' else 'rejected' end,updated_at = clock_timestamp() where id = p_request_id;
  update public.chat_spaces set updated_at = clock_timestamp() where id = v_request.space_id;
end $$;

create or replace function public.xelay_chat_update(p_space_id uuid,p_changes jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_avatar text; v_owner boolean;
begin
  v_space := public.xelay_chat_lock(p_space_id,'admin'); v_owner := v_space.owner_id = auth.uid();
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb
    or exists(select 1 from jsonb_each(p_changes) e where e.key not in ('visibility','username','name','description','avatar_path','comments_enabled','join_approval','history_visible'))
    then raise exception 'CHAT_INVALID_INPUT'; end if;
  if not v_owner and p_changes ? 'comments_enabled' then raise exception 'CHAT_OWNER_REQUIRED'; end if;
  if exists(select 1 from jsonb_each(p_changes) e where e.key in ('name','description','visibility') and jsonb_typeof(e.value) <> 'string')
    or exists(select 1 from jsonb_each(p_changes) e where e.key in ('username','avatar_path') and jsonb_typeof(e.value) not in ('string','null'))
    or exists(select 1 from jsonb_each(p_changes) e where e.key in ('comments_enabled','join_approval','history_visible') and jsonb_typeof(e.value) <> 'boolean') then raise exception 'CHAT_INVALID_INPUT'; end if;
  if p_changes ? 'name' then v_space.name := btrim(p_changes->>'name'); end if;
  if p_changes ? 'description' then v_space.description := p_changes->>'description'; end if;
  if p_changes ? 'visibility' then v_space.visibility := p_changes->>'visibility'; end if;
  if p_changes ? 'username' then v_space.username := lower(ltrim(btrim(p_changes->>'username'),'@')); end if;
  if p_changes ? 'comments_enabled' then v_space.comments_enabled := (p_changes->>'comments_enabled')::boolean; end if;
  if p_changes ? 'join_approval' then v_space.join_approval := (p_changes->>'join_approval')::boolean; end if;
  if p_changes ? 'history_visible' then v_space.history_visible := (p_changes->>'history_visible')::boolean; end if;
  if v_space.visibility = 'private' then v_space.username := null; end if;
  if v_space.visibility not in ('public','private') or length(v_space.name) not between 1 and 100 or length(v_space.description) > 2000 then raise exception 'CHAT_INVALID_INPUT'; end if;
  if v_space.visibility = 'public' and (v_space.username is null or v_space.username !~ '^[a-z][a-z0-9_]{3,31}$') then raise exception 'CHAT_INVALID_USERNAME'; end if;
  if p_changes ? 'avatar_path' then
    v_avatar := p_changes->>'avatar_path';
    if v_avatar is distinct from v_space.avatar_path then perform public.xelay_chat_validate_avatar(v_avatar); end if;
    v_space.avatar_path := v_avatar;
  end if;
  update public.chat_spaces set name = v_space.name,description = v_space.description,visibility = v_space.visibility,
    username = v_space.username,avatar_path = v_space.avatar_path,comments_enabled = v_space.comments_enabled,
    join_approval = v_space.join_approval,history_visible = v_space.history_visible,updated_at = clock_timestamp() where id = p_space_id;
exception when unique_violation then raise exception 'CHAT_USERNAME_TAKEN';
end $$;

-- A forwarded item must be readable through the sender's original faculty/university permissions.
-- Having received a forwarded item never grants permission to spread it further.
create or replace function public.xelay_chat_can_share_news(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.news_posts n where n.id = p_post_id and n.status = 'published' and (
    public.xelay_can_manage_news(n.university_id,n.academic_unit_id)
    or exists(select 1 from public.profiles p where p.id = auth.uid() and p.university_id = n.university_id
      and (n.academic_unit_id is null or p.academic_unit_id = n.academic_unit_id))));
$$;

create or replace function public.xelay_chat_send(
  p_space_id uuid,p_body text default '',p_parent_post_id uuid default null,p_reply_to uuid default null,
  p_shared_news_post_id uuid default null,p_attachments jsonb default '[]'
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_role text; v_id uuid; v_item jsonb; v_meta jsonb;
  v_bytes numeric; v_total numeric := 0; v_mime text; v_media text; v_path text; v_parent uuid;
begin
  v_space := public.xelay_chat_lock(p_space_id,'member');
  perform pg_advisory_xact_lock(hashtextextended('xelay-chat-send:' || auth.uid()::text,0));
  if (select count(*) from public.chat_posts where sender_id = auth.uid() and created_at > clock_timestamp() - interval '1 minute') >= 30 then raise exception 'CHAT_RATE_LIMIT'; end if;
  select role into v_role from public.chat_members where space_id = p_space_id and user_id = auth.uid();
  if p_body is null or length(p_body) > 10000 or p_attachments is null or jsonb_typeof(p_attachments) <> 'array' then raise exception 'CHAT_INVALID_INPUT'; end if;
  if jsonb_array_length(p_attachments) > 10 then raise exception 'CHAT_ATTACHMENT_LIMIT'; end if;
  if btrim(p_body) = '' and p_shared_news_post_id is null and jsonb_array_length(p_attachments) = 0 then raise exception 'CHAT_EMPTY_POST'; end if;
  if v_space.kind = 'group' and p_parent_post_id is not null then raise exception 'CHAT_INVALID_PARENT'; end if;
  if v_space.kind = 'channel' then
    if p_parent_post_id is null and v_role not in ('owner','admin') then raise exception 'CHAT_ADMIN_REQUIRED'; end if;
    if p_parent_post_id is not null then
      if not v_space.comments_enabled then raise exception 'CHAT_COMMENTS_DISABLED'; end if;
      if not public.xelay_chat_can_read_post(p_parent_post_id) or not exists(select 1 from public.chat_posts
        where id = p_parent_post_id and space_id = p_space_id and parent_post_id is null) then raise exception 'CHAT_INVALID_PARENT'; end if;
    end if;
  end if;
  if p_reply_to is not null then
    select parent_post_id into v_parent from public.chat_posts where id = p_reply_to and space_id = p_space_id and deleted_at is null;
    if not found or v_parent is distinct from p_parent_post_id or not public.xelay_chat_can_read_post(p_reply_to) then raise exception 'CHAT_INVALID_REPLY'; end if;
  end if;
  if p_shared_news_post_id is not null and not public.xelay_chat_can_share_news(p_shared_news_post_id) then raise exception 'CHAT_NEWS_ACCESS_DENIED'; end if;
  -- Validate every attachment before any post row is inserted. These are untrusted client values.
  for v_item in select value from jsonb_array_elements(p_attachments) loop
    if jsonb_typeof(v_item) <> 'object' or exists(select 1 from jsonb_each(v_item) e
      where e.key not in ('storage_path','file_name','media_type','mime_type','file_size'))
      or jsonb_typeof(v_item->'storage_path') is distinct from 'string'
      or jsonb_typeof(v_item->'file_name') is distinct from 'string'
      or jsonb_typeof(v_item->'media_type') is distinct from 'string'
      or jsonb_typeof(v_item->'mime_type') is distinct from 'string'
      or jsonb_typeof(v_item->'file_size') is distinct from 'number' then raise exception 'CHAT_INVALID_MEDIA'; end if;
    if (v_item->>'file_size') !~ '^[0-9]+$' or length(v_item->>'file_size') > 10
      or length(v_item->>'file_name') not between 1 and 255 then raise exception 'CHAT_INVALID_MEDIA'; end if;
    v_path := v_item->>'storage_path'; v_mime := v_item->>'mime_type'; v_media := v_item->>'media_type'; v_bytes := (v_item->>'file_size')::numeric;
    if not public.xelay_chat_valid_media_path(v_path) or v_bytes not between 1 and 26214400 then raise exception 'CHAT_INVALID_MEDIA'; end if;
    if v_mime not in ('image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime',
      'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/zip','application/x-zip-compressed','text/plain','text/csv','application/rtf')
      or v_media <> (case
        when v_mime like 'image/%' then 'image'
        when v_mime like 'video/%' then 'video'
        else 'file'
      end) then
      raise exception 'CHAT_INVALID_MEDIA';
    end if;
    select metadata into v_meta from storage.objects where bucket_id = 'xelay-chat-media' and name = v_path for update;
    if not found or coalesce(v_meta->>'size','') !~ '^[0-9]+$' or (v_meta->>'mimetype') is distinct from v_mime then raise exception 'CHAT_INVALID_MEDIA'; end if;
    if (v_meta->>'size')::numeric <> v_bytes
      or exists(select 1 from public.chat_attachments where storage_path = v_path)
      or exists(select 1 from public.chat_spaces where avatar_path = v_path) then raise exception 'CHAT_INVALID_MEDIA'; end if;
    v_total := v_total + v_bytes;
  end loop;
  if v_total > 104857600 then raise exception 'CHAT_ATTACHMENT_LIMIT'; end if;
  if exists(select 1 from jsonb_array_elements(p_attachments) e group by e->>'storage_path' having count(*) > 1) then raise exception 'CHAT_INVALID_MEDIA'; end if;
  insert into public.chat_posts(space_id,sender_id,body,parent_post_id,reply_to,shared_news_post_id)
    values(p_space_id,auth.uid(),p_body,p_parent_post_id,p_reply_to,p_shared_news_post_id) returning id into v_id;
  insert into public.chat_attachments(post_id,space_id,uploaded_by,storage_path,file_name,media_type,mime_type,file_size)
    select v_id,p_space_id,auth.uid(),e->>'storage_path',e->>'file_name',e->>'media_type',e->>'mime_type',(e->>'file_size')::bigint
    from jsonb_array_elements(p_attachments) e;
  -- Unmuted members receive at most one unread message notice per space. Inbox counts remain exact.
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,chat_space_id)
    select m.user_id,auth.uid(),case when v_space.kind = 'channel' and p_parent_post_id is null then v_space.name
      else coalesce((select nullif(full_name,'') from public.profiles where id = auth.uid()),'Учасник') end,
      case when p_parent_post_id is null then 'chat_message' else 'chat_comment' end,
      case when p_parent_post_id is null then 'Нове повідомлення у «' else 'Новий коментар у «' end || v_space.name || '»',false,p_space_id
    from public.chat_members m where m.space_id = p_space_id and m.status = 'active' and not m.muted and m.user_id <> auth.uid()
      and not exists(select 1 from public.notifications n where n.recipient_id::text = m.user_id::text and n.chat_space_id = p_space_id
        and n.type in ('chat_message','chat_comment') and not coalesce(n.is_read,false));
  update public.chat_spaces set updated_at = clock_timestamp() where id = p_space_id;
  if p_parent_post_id is not null then update public.chat_posts set edited_at = edited_at where id = p_parent_post_id; end if;
  return v_id;
end $$;

create or replace function public.xelay_chat_edit(p_post_id uuid,p_body text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_post public.chat_posts%rowtype; v_space public.chat_spaces%rowtype;
begin
  select * into v_post from public.chat_posts where id = p_post_id;
  if not found then raise exception 'CHAT_POST_NOT_FOUND'; end if;
  v_space := public.xelay_chat_lock(v_post.space_id,'member');
  select * into v_post from public.chat_posts where id = p_post_id;
  if not public.xelay_chat_can_read_post(p_post_id) then raise exception 'CHAT_POST_NOT_FOUND'; end if;
  if v_space.kind = 'channel' and v_post.parent_post_id is null and not public.xelay_chat_is_admin(v_post.space_id) then raise exception 'CHAT_ADMIN_REQUIRED'; end if;
  if v_post.sender_id <> auth.uid() and not (v_space.kind = 'channel' and v_post.parent_post_id is null and public.xelay_chat_is_admin(v_post.space_id)) then raise exception 'CHAT_POST_OWNER_REQUIRED'; end if;
  if v_post.parent_post_id is not null and not v_space.comments_enabled then raise exception 'CHAT_COMMENTS_DISABLED'; end if;
  if p_body is null or length(p_body) > 10000 then raise exception 'CHAT_INVALID_INPUT'; end if;
  if btrim(p_body) = '' and v_post.shared_news_post_id is null and not exists(select 1 from public.chat_attachments where post_id = p_post_id) then raise exception 'CHAT_EMPTY_POST'; end if;
  update public.chat_posts set body = p_body,edited_at = clock_timestamp() where id = p_post_id;
  update public.chat_spaces set updated_at = clock_timestamp() where id = v_post.space_id;
end $$;

create or replace function public.xelay_chat_delete_post(p_post_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_post public.chat_posts%rowtype; v_space public.chat_spaces%rowtype;
begin
  select * into v_post from public.chat_posts where id = p_post_id;
  if not found then raise exception 'CHAT_POST_NOT_FOUND'; end if;
  v_space := public.xelay_chat_lock(v_post.space_id,'member');
  select * into v_post from public.chat_posts where id = p_post_id;
  if v_post.deleted_at is not null then return; end if;
  if not public.xelay_chat_can_read_post(p_post_id) then raise exception 'CHAT_POST_NOT_FOUND'; end if;
  if v_space.kind = 'channel' and v_post.parent_post_id is null and not public.xelay_chat_is_admin(v_post.space_id) then raise exception 'CHAT_ADMIN_REQUIRED'; end if;
  if v_post.sender_id <> auth.uid() and not public.xelay_chat_is_admin(v_post.space_id) then raise exception 'CHAT_POST_OWNER_REQUIRED'; end if;
  delete from public.chat_attachments where post_id = p_post_id or post_id in (select id from public.chat_posts where parent_post_id = p_post_id);
  delete from public.chat_reactions where post_id = p_post_id or post_id in (select id from public.chat_posts where parent_post_id = p_post_id);
  delete from public.chat_pins where post_id = p_post_id;
  update public.chat_posts set deleted_at = clock_timestamp(),body = '',shared_news_post_id = null
    where id = p_post_id or parent_post_id = p_post_id;
  update public.chat_spaces set updated_at = clock_timestamp() where id = v_post.space_id;
end $$;

create or replace function public.xelay_chat_react(p_post_id uuid,p_emoji text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space_id uuid; v_existing text;
begin
  select space_id into v_space_id from public.chat_posts where id = p_post_id;
  if not found then raise exception 'CHAT_POST_NOT_FOUND'; end if;
  perform public.xelay_chat_lock(v_space_id,'member');
  if not public.xelay_chat_can_read_post(p_post_id) then raise exception 'CHAT_POST_NOT_FOUND'; end if;
  if p_emoji is null or p_emoji not in ('👍','❤️','🔥','👏','😂','🎉','😮','😢','🤔','👎','💯','🙏') then raise exception 'CHAT_INVALID_REACTION'; end if;
  select emoji into v_existing from public.chat_reactions where post_id = p_post_id and user_id = auth.uid();
  if v_existing = p_emoji then delete from public.chat_reactions where post_id = p_post_id and user_id = auth.uid();
  else insert into public.chat_reactions(space_id,post_id,user_id,emoji) values(v_space_id,p_post_id,auth.uid(),p_emoji)
    on conflict(post_id,user_id) do update set emoji = excluded.emoji,created_at = clock_timestamp(); end if;
  update public.chat_spaces set updated_at = clock_timestamp() where id = v_space_id;
  update public.chat_posts set edited_at = edited_at where id = p_post_id;
end $$;

create or replace function public.xelay_chat_pin(p_post_id uuid,p_pin boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space_id uuid;
begin
  select space_id into v_space_id from public.chat_posts where id = p_post_id;
  if not found then raise exception 'CHAT_POST_NOT_FOUND'; end if;
  perform public.xelay_chat_lock(v_space_id,'admin');
  if p_pin is null then raise exception 'CHAT_INVALID_INPUT'; end if;
  if not public.xelay_chat_can_read_post(p_post_id) or exists(select 1 from public.chat_posts where id = p_post_id and parent_post_id is not null) then raise exception 'CHAT_POST_NOT_FOUND'; end if;
  if p_pin then
    if (select count(*) from public.chat_pins where space_id = v_space_id) >= 10 and not exists(select 1 from public.chat_pins where post_id = p_post_id) then raise exception 'CHAT_PIN_LIMIT'; end if;
    insert into public.chat_pins(space_id,post_id,pinned_by) values(v_space_id,p_post_id,auth.uid()) on conflict do nothing;
  else delete from public.chat_pins where post_id = p_post_id; end if;
  update public.chat_spaces set updated_at = clock_timestamp() where id = v_space_id;
end $$;

create or replace function public.xelay_chat_read(p_space_id uuid,p_through timestamptz default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_through timestamptz;
begin
  perform public.xelay_chat_lock(p_space_id,'member');
  if p_through is null then
    select max(created_at) into v_through from public.chat_posts where space_id = p_space_id and deleted_at is null;
  else
    if not isfinite(p_through) then raise exception 'CHAT_INVALID_INPUT'; end if;
    select max(created_at) into v_through from public.chat_posts where space_id = p_space_id and deleted_at is null and created_at <= least(p_through,clock_timestamp());
  end if;
  if v_through is not null then update public.chat_members set last_read_at = greatest(last_read_at,v_through)
    where space_id = p_space_id and user_id = auth.uid(); end if;
  update public.notifications set is_read = true where recipient_id::text = auth.uid()::text and chat_space_id = p_space_id and type in ('chat_message','chat_comment') and not coalesce(is_read,false)
    and (p_through is null or created_at <= least(p_through,clock_timestamp()));
end $$;

create or replace function public.xelay_chat_mute(p_space_id uuid,p_muted boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.xelay_chat_lock(p_space_id,'member');
  if p_muted is null then raise exception 'CHAT_INVALID_INPUT'; end if;
  update public.chat_members set muted = p_muted where space_id = p_space_id and user_id = auth.uid();
end $$;

create or replace function public.xelay_chat_revoke_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space_id uuid;
begin
  select space_id into v_space_id from public.chat_invitations where id = p_invitation_id;
  if not found then raise exception 'CHAT_INVITATION_NOT_FOUND'; end if;
  perform public.xelay_chat_lock(v_space_id,'admin');
  update public.chat_invitations set status = 'revoked',updated_at = clock_timestamp() where id = p_invitation_id and status = 'pending';
  update public.chat_spaces set updated_at = clock_timestamp() where id = v_space_id;
end $$;

create or replace function public.xelay_chat_cancel_request(p_space_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.xelay_chat_lock(p_space_id,'none');
  update public.chat_join_requests set status = 'cancelled',updated_at = clock_timestamp()
    where space_id = p_space_id and user_id = auth.uid() and status = 'pending';
  update public.chat_spaces set updated_at = clock_timestamp() where id = p_space_id;
end $$;

create or replace function public.xelay_chat_search(p_query text,p_kind text default null,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_query text := lower(ltrim(btrim(p_query),'@'));
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if p_kind is not null and p_kind not in ('group','channel') then raise exception 'CHAT_INVALID_INPUT'; end if;
  if v_query is null or length(v_query) < 2 then return '[]'::jsonb; end if;
  if length(v_query) > 80 or p_limit is null or p_limit not between 1 and 20 then raise exception 'CHAT_INVALID_INPUT'; end if;
  return coalesce((select jsonb_agg(public.xelay_chat_space_json(s.id) order by
      case when lower(s.username) = v_query then 0 when starts_with(lower(s.username),v_query) then 1
        when starts_with(lower(s.name),v_query) then 2 else 3 end,s.name,s.id)
    from (select * from public.chat_spaces where visibility = 'public' and (p_kind is null or kind = p_kind)
      and (strpos(lower(name),v_query) > 0 or strpos(lower(username),v_query) > 0)
      order by case when lower(username) = v_query then 0 when starts_with(lower(username),v_query) then 1
        when starts_with(lower(name),v_query) then 2 else 3 end,name,id limit p_limit) s),'[]'::jsonb);
end $$;

create or replace function public.xelay_chat_inbox()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  return jsonb_build_object(
    'spaces',coalesce((select jsonb_agg(public.xelay_chat_space_json(s.id) || jsonb_build_object(
      'my_role',m.role,'my_muted',m.muted,
      'unread_count',(select count(*) from public.chat_posts p where p.space_id = s.id and p.deleted_at is null and p.parent_post_id is null
        and p.sender_id <> auth.uid() and p.created_at > m.last_read_at and p.created_at >= m.visible_from
        and (p.parent_post_id is null or exists(select 1 from public.chat_posts root where root.id = p.parent_post_id and root.deleted_at is null and root.created_at >= m.visible_from))),
      'last_post',(select public.xelay_chat_post_json(p.id) from public.chat_posts p where p.space_id = s.id
        and p.deleted_at is null and p.parent_post_id is null and p.created_at >= m.visible_from
        and (p.parent_post_id is null or exists(select 1 from public.chat_posts root where root.id = p.parent_post_id and root.deleted_at is null and root.created_at >= m.visible_from))
        order by p.created_at desc,p.id desc limit 1)
    ) order by s.updated_at desc,s.id) from public.chat_spaces s join public.chat_members m on m.space_id = s.id
      where m.user_id = auth.uid() and m.status = 'active'),'[]'::jsonb),
    'invitations',coalesce((select jsonb_agg(to_jsonb(i) || jsonb_build_object('space',public.xelay_chat_space_json(i.space_id)) order by i.created_at desc)
      from public.chat_invitations i where i.user_id = auth.uid() and i.status = 'pending'),'[]'::jsonb),
    'join_requests',coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('space',public.xelay_chat_space_json(r.space_id)) order by r.created_at desc)
      from public.chat_join_requests r where r.user_id = auth.uid() and r.status = 'pending'),'[]'::jsonb)
  );
end $$;

create or replace function public.xelay_chat_unread_count()
returns bigint language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return 0; end if;
  return (select count(*) from public.chat_posts p join public.chat_members m on m.space_id = p.space_id
    where m.user_id = auth.uid() and m.status = 'active' and not m.muted
      and p.deleted_at is null and p.parent_post_id is null and p.sender_id <> auth.uid() and p.created_at > m.last_read_at and p.created_at >= m.visible_from
      and (p.parent_post_id is null or exists(select 1 from public.chat_posts root where root.id = p.parent_post_id and root.deleted_at is null and root.created_at >= m.visible_from)));
end $$;

create or replace function public.xelay_chat_get(p_space_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_member public.chat_members%rowtype; v_admin boolean;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if not public.xelay_chat_can_view_space(p_space_id) then raise exception 'CHAT_NOT_FOUND'; end if;
  select * into v_space from public.chat_spaces where id = p_space_id;
  select * into v_member from public.chat_members where space_id = p_space_id and user_id = auth.uid();
  v_admin := public.xelay_chat_is_admin(p_space_id);
  return jsonb_build_object(
    'space',public.xelay_chat_space_json(p_space_id),
    'my_membership',case when v_member.user_id is null then null else to_jsonb(v_member) end,
    'members',case when v_member.status = 'active' then coalesce((select jsonb_agg(
      case when m.user_id = auth.uid() then to_jsonb(m) else to_jsonb(m) - 'last_read_at' - 'visible_from' - 'muted' end
      order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,m.joined_at,m.user_id)
      from public.chat_members m where m.space_id = p_space_id
        and (v_admin or (m.status = 'active' and (v_space.kind = 'group' or m.role in ('owner','admin'))))),'[]'::jsonb) else '[]'::jsonb end,
    'invitations',coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at desc) from public.chat_invitations i
      where i.space_id = p_space_id and i.status = 'pending' and (v_admin or i.user_id = auth.uid())),'[]'::jsonb),
    'join_requests',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from public.chat_join_requests r
      where r.space_id = p_space_id and r.status = 'pending' and (v_admin or r.user_id = auth.uid())),'[]'::jsonb),
    'invite_links',case when v_admin then coalesce((select jsonb_agg(to_jsonb(l) - 'token_hash' order by l.created_at desc)
      from public.chat_invite_links l where l.space_id = p_space_id),'[]'::jsonb) else '[]'::jsonb end,
    'pins',case when v_member.status = 'active' then coalesce((select jsonb_agg(public.xelay_chat_post_json(p.post_id) order by p.created_at desc)
      from public.chat_pins p where p.space_id = p_space_id and public.xelay_chat_can_read_post(p.post_id)),'[]'::jsonb) else '[]'::jsonb end
  );
end $$;

create or replace function public.xelay_chat_posts(p_space_id uuid,p_parent_post_id uuid default null,p_before timestamptz default null,p_limit integer default 40)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_member public.chat_members%rowtype;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  select * into v_member from public.chat_members where space_id = p_space_id and user_id = auth.uid() and status = 'active';
  if not found then raise exception 'CHAT_MEMBER_REQUIRED'; end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_before is not null and not isfinite(p_before)) then raise exception 'CHAT_INVALID_INPUT'; end if;
  if p_parent_post_id is not null and (not public.xelay_chat_can_read_post(p_parent_post_id)
    or not exists(select 1 from public.chat_posts where id = p_parent_post_id and space_id = p_space_id and parent_post_id is null)) then raise exception 'CHAT_POST_NOT_FOUND'; end if;
  return coalesce((select jsonb_agg(public.xelay_chat_post_json(p.id) order by p.created_at desc,p.id desc)
    from (select id,created_at from public.chat_posts where space_id = p_space_id and parent_post_id is not distinct from p_parent_post_id
      and deleted_at is null and created_at >= v_member.visible_from and (p_before is null or created_at < p_before)
      order by created_at desc,id desc limit p_limit) p),'[]'::jsonb);
end $$;

create or replace function public.xelay_chat_posts_by_ids(p_space_id uuid,p_post_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if not public.xelay_chat_is_member(p_space_id) then raise exception 'CHAT_MEMBER_REQUIRED'; end if;
  if p_post_ids is null or cardinality(p_post_ids) > 400 then raise exception 'CHAT_INVALID_INPUT'; end if;
  return coalesce((select jsonb_agg(public.xelay_chat_post_json(p.id) order by p.created_at desc,p.id desc)
    from public.chat_posts p where p.space_id = p_space_id and p.id = any(p_post_ids)
      and public.xelay_chat_can_read_post(p.id)),'[]'::jsonb);
end $$;

-- Preserve original profile/editor and personal-chat access, then add active space recipients.
create or replace function public.xelay_can_read_news(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.news_posts n where n.id = p_post_id and n.status = 'published' and (
    public.xelay_can_manage_news(n.university_id,n.academic_unit_id)
    or exists(select 1 from public.profiles p where p.id = auth.uid() and p.university_id = n.university_id
      and (n.academic_unit_id is null or p.academic_unit_id = n.academic_unit_id))
    or exists(select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
      where m.shared_post_id = n.id and m.recipient_id = auth.uid() and m.deleted_at is null
        and ((c.user_one_id = m.sender_id and c.user_two_id = m.recipient_id) or (c.user_two_id = m.sender_id and c.user_one_id = m.recipient_id)))
    or exists(select 1 from public.chat_posts p where p.shared_news_post_id = n.id and public.xelay_chat_can_read_post(p.id))
  ));
$$;

-- Users can remove only their own unreferenced uploads; linked media cannot disappear from a post.
create or replace function public.xelay_chat_can_read_media(p_path text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and (
    exists(select 1 from public.chat_attachments a where a.storage_path = p_path and public.xelay_chat_can_read_post(a.post_id))
    or exists(select 1 from public.chat_spaces s where s.avatar_path = p_path and public.xelay_chat_can_view_space(s.id))
    or ((storage.foldername(p_path))[1] = auth.uid()::text
      and not exists(select 1 from public.chat_attachments where storage_path = p_path)
      and not exists(select 1 from public.chat_spaces where avatar_path = p_path))
  );
$$;
create or replace function public.xelay_chat_can_remove_media(p_path text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and (storage.foldername(p_path))[1] = auth.uid()::text
    and not exists(select 1 from public.chat_attachments where storage_path = p_path)
    and not exists(select 1 from public.chat_spaces where avatar_path = p_path);
$$;
create or replace function public.xelay_chat_unused_media()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('storage_path',o.name)) from (
    select name from storage.objects where bucket_id = 'xelay-chat-media' and (storage.foldername(name))[1] = auth.uid()::text
      and created_at < clock_timestamp() - interval '1 hour' and public.xelay_chat_can_remove_media(name)
      order by created_at limit 100) o),'[]'::jsonb);
end $$;
create or replace function public.xelay_chat_guard_media_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.bucket_id = 'xelay-chat-media' and (exists(select 1 from public.chat_attachments where storage_path = old.name)
    or exists(select 1 from public.chat_spaces where avatar_path = old.name)) then raise exception 'CHAT_MEDIA_IN_USE'; end if;
  return old;
end $$;
drop trigger if exists xelay_chat_guard_media_delete on storage.objects;
create trigger xelay_chat_guard_media_delete before delete on storage.objects for each row execute function public.xelay_chat_guard_media_delete();

alter table public.chat_spaces enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_invitations enable row level security;
alter table public.chat_invite_links enable row level security;
alter table public.chat_join_requests enable row level security;
alter table public.chat_posts enable row level security;
alter table public.chat_attachments enable row level security;
alter table public.chat_reactions enable row level security;
alter table public.chat_pins enable row level security;

drop policy if exists "Visible chat metadata" on public.chat_spaces;
create policy "Visible chat metadata" on public.chat_spaces for select to authenticated using(public.xelay_chat_can_view_space(id));
drop policy if exists "Own membership or moderation" on public.chat_members;
create policy "Own membership or moderation" on public.chat_members for select to authenticated using(user_id = auth.uid() or public.xelay_chat_is_admin(space_id));
drop policy if exists "Own chat invitation or moderation" on public.chat_invitations;
create policy "Own chat invitation or moderation" on public.chat_invitations for select to authenticated using(user_id = auth.uid() or public.xelay_chat_is_admin(space_id));
drop policy if exists "Chat moderators see hashed links" on public.chat_invite_links;
create policy "Chat moderators see hashed links" on public.chat_invite_links for select to authenticated using(public.xelay_chat_is_admin(space_id));
drop policy if exists "Own join request or moderation" on public.chat_join_requests;
create policy "Own join request or moderation" on public.chat_join_requests for select to authenticated using(user_id = auth.uid() or public.xelay_chat_is_admin(space_id));
drop policy if exists "Active members read visible chat posts" on public.chat_posts;
create policy "Active members read visible chat posts" on public.chat_posts for select to authenticated using(public.xelay_chat_can_read_post(id));
drop policy if exists "Active members read post attachments" on public.chat_attachments;
create policy "Active members read post attachments" on public.chat_attachments for select to authenticated using(public.xelay_chat_can_read_post(post_id));
drop policy if exists "Active members read post reactions" on public.chat_reactions;
create policy "Active members read post reactions" on public.chat_reactions for select to authenticated using(public.xelay_chat_can_read_post(post_id));
drop policy if exists "Active members read chat pins" on public.chat_pins;
create policy "Active members read chat pins" on public.chat_pins for select to authenticated using(public.xelay_chat_can_read_post(post_id));

revoke all on public.chat_spaces,public.chat_members,public.chat_invitations,public.chat_invite_links,public.chat_join_requests,
  public.chat_posts,public.chat_attachments,public.chat_reactions,public.chat_pins from public,anon,authenticated,service_role;
grant select on public.chat_spaces,public.chat_members,public.chat_invitations,public.chat_invite_links,public.chat_join_requests,
  public.chat_posts,public.chat_attachments,public.chat_reactions,public.chat_pins to authenticated;

drop policy if exists "Upload owned chat media" on storage.objects;
create policy "Upload owned chat media" on storage.objects for insert to authenticated
  with check(bucket_id = 'xelay-chat-media' and public.xelay_chat_valid_media_path(name));
drop policy if exists "Read accessible chat media" on storage.objects;
create policy "Read accessible chat media" on storage.objects for select to authenticated
  using(bucket_id = 'xelay-chat-media' and public.xelay_chat_can_read_media(name));
drop policy if exists "Remove owned unreferenced chat media" on storage.objects;
create policy "Remove owned unreferenced chat media" on storage.objects for delete to authenticated
  using(bucket_id = 'xelay-chat-media' and public.xelay_chat_can_remove_media(name));

-- Restrictive guards preserve privacy even if an older project contains a broad storage policy.
drop policy if exists "Chat media upload guard" on storage.objects;
create policy "Chat media upload guard" on storage.objects as restrictive for insert to authenticated
  with check(bucket_id <> 'xelay-chat-media' or public.xelay_chat_valid_media_path(name));
drop policy if exists "Chat media read guard" on storage.objects;
create policy "Chat media read guard" on storage.objects as restrictive for select to authenticated
  using(bucket_id <> 'xelay-chat-media' or public.xelay_chat_can_read_media(name));
drop policy if exists "Chat media delete guard" on storage.objects;
create policy "Chat media delete guard" on storage.objects as restrictive for delete to authenticated
  using(bucket_id <> 'xelay-chat-media' or public.xelay_chat_can_remove_media(name));
drop policy if exists "Chat media overwrite guard" on storage.objects;
create policy "Chat media overwrite guard" on storage.objects as restrictive for update to authenticated
  using(bucket_id <> 'xelay-chat-media') with check(bucket_id <> 'xelay-chat-media');

-- Revoke every new helper first, then allow only deliberate client RPCs and boolean RLS predicates.
-- In particular, *_json / activate / request / notify / lock must never be callable by a client.
do $$ declare v_function record;
begin
  for v_function in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and starts_with(p.proname,'xelay_chat_') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_function.signature);
  end loop;
  for v_function in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'xelay_chat_is_member','xelay_chat_is_admin','xelay_chat_can_view_space','xelay_chat_can_read_post',
      'xelay_chat_valid_media_path','xelay_chat_can_read_media','xelay_chat_can_remove_media',
      'xelay_chat_create','xelay_chat_update','xelay_chat_invite','xelay_chat_invitation','xelay_chat_revoke_invitation',
      'xelay_chat_join','xelay_chat_leave','xelay_chat_delete','xelay_chat_member','xelay_chat_cancel_request',
      'xelay_chat_create_link','xelay_chat_revoke_link','xelay_chat_link_preview','xelay_chat_join_link','xelay_chat_join_request',
      'xelay_chat_send','xelay_chat_edit','xelay_chat_delete_post','xelay_chat_react','xelay_chat_pin','xelay_chat_read','xelay_chat_mute',
      'xelay_chat_search','xelay_chat_inbox','xelay_chat_unread_count','xelay_chat_get','xelay_chat_posts','xelay_chat_posts_by_ids','xelay_chat_unused_media'
    ) loop
    execute format('grant execute on function %s to authenticated',v_function.signature);
  end loop;
end $$;
revoke all on function public.xelay_can_read_news(uuid) from public,anon;
grant execute on function public.xelay_can_read_news(uuid) to authenticated;

-- Header touches consolidate membership reads. The composite membership key is intentionally
-- not published: an unfiltered DELETE could otherwise disclose private membership associations.
-- No replica identity FULL: deleted rows never broadcast message bodies.
do $$ declare v_table text;
begin
  if exists(select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables) then
    foreach v_table in array array['chat_spaces','chat_invitations','chat_join_requests','chat_posts'] loop
      if not exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table) then
        execute format('alter publication supabase_realtime add table public.%I',v_table);
      end if;
    end loop;
  end if;
end $$;

commit;
