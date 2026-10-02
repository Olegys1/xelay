-- Participant publications and scoped faculty chat administrators.
-- Apply the complete file after 202610020010_faculty_chats_free_message_actions.sql.
begin;

do $$ begin
  if to_regprocedure('public.xelay_chat_faculty(boolean)') is null
    or to_regprocedure('public.xelay_chat_pin_for_me(uuid,boolean)') is null
    or to_regprocedure('public.xelay_has_participant_access(uuid)') is null
    or to_regclass('public.messages') is null then
    raise exception 'Apply faculty chat and participant billing migrations first';
  end if;
end $$;

create or replace function public.xelay_chat_user_is_platform_admin(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select exists(select 1 from public.user_roles r where r.user_id = p_user_id and r.role = 'ADMIN'
    and r.university_id is null and r.academic_unit_id is null);
$$;

create or replace function public.xelay_chat_is_admin(p_space_id uuid)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.chat_spaces s where s.id = p_space_id and (
    (s.system_kind = 'faculty' and public.xelay_is_platform_admin())
    or exists(select 1 from public.chat_members m where m.space_id = s.id and m.user_id = auth.uid()
      and m.status = 'active' and m.role in ('owner','admin')
      and (s.system_kind is null or public.xelay_chat_faculty_eligible(s.id,auth.uid())))));
$$;

create or replace function public.xelay_chat_lock(p_space_id uuid,p_permission text default 'member')
returns public.chat_spaces language plpgsql volatile security definer set search_path = public,pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_role text; v_platform boolean;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if p_permission is null or p_permission not in ('none','member','admin','owner') then raise exception 'CHAT_INVALID_INPUT'; end if;
  select * into v_space from public.chat_spaces where id = p_space_id for update;
  if not found then raise exception 'CHAT_NOT_FOUND'; end if;
  if v_space.system_kind = 'faculty' then
    v_platform := public.xelay_is_platform_admin();
    if p_permission = 'owner' then raise exception 'CHAT_SYSTEM_MANAGED'; end if;
    if not v_platform and not public.xelay_chat_faculty_eligible(p_space_id,auth.uid()) then raise exception 'CHAT_FACULTY_SCOPE_REQUIRED'; end if;
    if p_permission = 'admin' and not public.xelay_chat_is_admin(p_space_id) then raise exception 'CHAT_ADMIN_REQUIRED'; end if;
    if p_permission = 'member' and not v_platform and not public.xelay_chat_is_member(p_space_id) then raise exception 'CHAT_MEMBER_REQUIRED'; end if;
  else
    select role into v_role from public.chat_members where space_id = p_space_id and user_id = auth.uid() and status = 'active';
    if p_permission = 'owner' and v_space.owner_id is distinct from auth.uid() then raise exception 'CHAT_OWNER_REQUIRED'; end if;
    if p_permission = 'admin' and coalesce(v_role,'') not in ('owner','admin') then raise exception 'CHAT_ADMIN_REQUIRED'; end if;
    if p_permission = 'member' and v_role is null then raise exception 'CHAT_MEMBER_REQUIRED'; end if;
  end if;
  return v_space;
end $$;

create or replace function public.xelay_chat_guard_system_member()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if exists(select 1 from public.chat_spaces where id = new.space_id and system_kind = 'faculty') then
    if new.role not in ('member','admin') then raise exception 'CHAT_SYSTEM_MANAGED'; end if;
    if new.status <> 'active' and new.role <> 'member' then raise exception 'CHAT_SYSTEM_MANAGED'; end if;
    if new.status = 'active' and not public.xelay_chat_faculty_eligible(new.space_id,new.user_id) then raise exception 'CHAT_FACULTY_SCOPE_REQUIRED'; end if;
  end if;
  return new;
end $$;

create or replace function public.xelay_chat_guard_system_space()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.system_kind is not null then raise exception 'CHAT_SYSTEM_MANAGED'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if new.system_kind is distinct from old.system_kind or new.university_id is distinct from old.university_id
      or new.academic_unit_id is distinct from old.academic_unit_id then raise exception 'CHAT_SYSTEM_MANAGED'; end if;
    if old.system_kind = 'faculty' and (new.owner_id is distinct from old.owner_id or new.kind is distinct from old.kind
      or new.visibility is distinct from old.visibility or new.username is distinct from old.username
      or new.join_approval is distinct from old.join_approval or new.history_visible is distinct from old.history_visible
      or new.comments_enabled is distinct from old.comments_enabled) then raise exception 'CHAT_SYSTEM_MANAGED'; end if;
    if old.system_kind = 'faculty' and new.name is distinct from old.name and not public.xelay_is_platform_admin() then raise exception 'CHAT_SYSTEM_MANAGED'; end if;
    if old.system_kind = 'faculty' and (new.description is distinct from old.description or new.avatar_path is distinct from old.avatar_path)
      and not public.xelay_chat_is_admin(old.id) then raise exception 'CHAT_ADMIN_REQUIRED'; end if;
  end if;
  return new;
end $$;

create or replace function public.xelay_chat_member(p_space_id uuid,p_user_id uuid,p_action text)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_target public.chat_members%rowtype;
begin
  v_space := public.xelay_chat_lock(p_space_id,'admin');
  if p_action is null or p_action not in ('kick','ban','unban','promote','demote','transfer') or p_user_id is null then raise exception 'CHAT_INVALID_INPUT'; end if;
  if v_space.system_kind = 'faculty' and p_action = 'transfer' then raise exception 'CHAT_SYSTEM_MANAGED'; end if;
  select * into v_target from public.chat_members where space_id = p_space_id and user_id = p_user_id;
  if not found then raise exception 'CHAT_MEMBER_NOT_FOUND'; end if;
  if p_user_id = v_space.owner_id or p_user_id = auth.uid() then raise exception 'CHAT_PROTECTED_MEMBER'; end if;
  if v_space.system_kind = 'faculty' then
    if public.xelay_chat_user_is_platform_admin(p_user_id) then raise exception 'CHAT_PROTECTED_PLATFORM_ADMIN'; end if;
    if p_action in ('promote','demote') and not public.xelay_chat_faculty_eligible(p_space_id,p_user_id) then raise exception 'CHAT_FACULTY_SCOPE_REQUIRED'; end if;
  else
    if p_action in ('promote','demote','transfer') and v_space.owner_id is distinct from auth.uid() then raise exception 'CHAT_OWNER_REQUIRED'; end if;
    if v_target.role = 'admin' and v_space.owner_id is distinct from auth.uid() then raise exception 'CHAT_OWNER_REQUIRED'; end if;
  end if;
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

-- Profile scope changes already turn old active memberships into left/member in
-- the 010 enrollment trigger. The new predicate therefore cannot revive roles.
comment on column public.chat_spaces.system_kind is 'NULL for user-owned chats; faculty for ownerless scope-fixed groups managed by platform and current-faculty chat administrators.';

-- These exact usernames were explicitly approved by the operator. Missing,
-- changed-faculty, disabled, left or banned profiles are skipped, never guessed.
do $$ declare v_username text; v_profile public.profiles%rowtype; v_space_id uuid; v_count integer; v_status text;
begin
  foreach v_username in array array['oleh_plietnikov','mmv04'] loop
    select count(*) into v_count from public.profiles where lower(username) = v_username;
    if v_count <> 1 then raise notice 'Faculty admin seed skipped: @% has % exact matches',v_username,v_count; continue; end if;
    select * into v_profile from public.profiles where lower(username) = v_username for update;
    if not exists(select 1 from public.academic_units a join public.universities u on u.id = a.university_id
      where a.id = v_profile.academic_unit_id and a.university_id = v_profile.university_id and a.slug = 'economics' and a.is_active and u.is_active) then
      raise notice 'Faculty admin seed skipped: @% has no current active economics scope',v_username; continue;
    end if;
    v_space_id := public.xelay_chat_ensure_faculty(v_profile.id,false);
    select status into v_status from public.chat_members where space_id = v_space_id and user_id = v_profile.id;
    if v_space_id is null or v_status is distinct from 'active' then
      raise notice 'Faculty admin seed skipped: @% has no active faculty membership',v_username; continue;
    end if;
    if not public.xelay_chat_user_is_platform_admin(v_profile.id) then
      update public.chat_members set role = 'admin' where space_id = v_space_id and user_id = v_profile.id and status = 'active';
      update public.chat_spaces set updated_at = clock_timestamp() where id = v_space_id;
    end if;
  end loop;
end $$;

create table public.chat_publications (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('poll','article')),
  author_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid unique references public.chat_posts(id) on delete cascade,
  message_id uuid unique references public.messages(id) on delete cascade,
  content jsonb not null check(jsonb_typeof(content) = 'object'),
  closed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(num_nonnulls(post_id,message_id) = 1),
  check(kind = 'poll' or closed_at is null)
);
create unique index chat_publications_cover_unique on public.chat_publications((content->>'cover_path'))
  where kind = 'article' and content->>'cover_path' is not null;
create table public.chat_poll_votes (
  publication_id uuid not null references public.chat_publications(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  option_id integer not null check(option_id between 1 and 10),
  created_at timestamptz not null default clock_timestamp(),
  primary key(publication_id,user_id,option_id)
);
create index chat_poll_votes_poll_option_idx on public.chat_poll_votes(publication_id,option_id);
alter table public.chat_publications enable row level security;
alter table public.chat_poll_votes enable row level security;
revoke all on public.chat_publications,public.chat_poll_votes from public,anon,authenticated,service_role;
grant select on public.chat_publications to authenticated;

create or replace function public.xelay_chat_can_read_publication(p_publication_id uuid)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.chat_publications pub where pub.id = p_publication_id and (
    (pub.post_id is not null and public.xelay_chat_can_read_post(pub.post_id))
    or (pub.message_id is not null and exists(select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
      where m.id = pub.message_id and m.deleted_at is null and auth.uid() in(m.sender_id,m.recipient_id)
        and ((c.user_one_id = m.sender_id and c.user_two_id = m.recipient_id) or (c.user_two_id = m.sender_id and c.user_one_id = m.recipient_id))))));
$$;
create policy "Readers see attached chat publications" on public.chat_publications for select to authenticated
  using(public.xelay_chat_can_read_publication(id));

create or replace function public.xelay_chat_can_moderate_publication(p_publication_id uuid)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.chat_publications pub where pub.id = p_publication_id
    and public.xelay_chat_can_read_publication(pub.id) and (pub.author_id = auth.uid()
      or exists(select 1 from public.chat_posts p where p.id = pub.post_id and public.xelay_chat_is_admin(p.space_id))));
$$;

create or replace function public.xelay_chat_poll_json(p_poll_id uuid)
returns jsonb language sql stable security definer set search_path = public,pg_temp as $$
  select jsonb_build_object('id',pub.id,'updated_at',pub.updated_at,'question',pub.content->>'question',
    'options',coalesce((select jsonb_agg(jsonb_build_object('id',opt.id::integer,'text',opt.text,
      'votes',(select count(*) from public.chat_poll_votes vote where vote.publication_id = pub.id and vote.option_id = opt.id)) order by opt.id)
      from jsonb_array_elements_text(pub.content->'options') with ordinality opt(text,id)),'[]'::jsonb),
    'anonymous',(pub.content->>'anonymous')::boolean,'allows_multiple',(pub.content->>'allows_multiple')::boolean,
    'closes_at',pub.content->>'closes_at','closed_at',pub.closed_at,
    'is_closed',pub.closed_at is not null or coalesce((pub.content->>'closes_at')::timestamptz <= clock_timestamp(),false),
    'total_voters',(select count(distinct vote.user_id) from public.chat_poll_votes vote where vote.publication_id = pub.id),
    'my_votes',coalesce((select jsonb_agg(vote.option_id order by vote.option_id) from public.chat_poll_votes vote
      where vote.publication_id = pub.id and vote.user_id = auth.uid()),'[]'::jsonb),
    'can_close',public.xelay_chat_can_moderate_publication(pub.id) and pub.closed_at is null
      and coalesce((pub.content->>'closes_at')::timestamptz > clock_timestamp(),true))
  from public.chat_publications pub where pub.id = p_poll_id and pub.kind = 'poll';
$$;
create or replace function public.xelay_chat_can_edit_article(p_article_id uuid)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.chat_publications pub where pub.id = p_article_id and pub.kind = 'article'
    and pub.author_id = auth.uid() and public.xelay_has_participant_access(auth.uid()) and public.xelay_chat_can_read_publication(pub.id)
    and (pub.message_id is not null or exists(select 1 from public.chat_posts p join public.chat_spaces s on s.id = p.space_id
      where p.id = pub.post_id and (s.kind = 'group'
        or (p.parent_post_id is null and public.xelay_chat_is_admin(s.id))
        or (p.parent_post_id is not null and s.comments_enabled)))));
$$;
create or replace function public.xelay_chat_article_json(p_article_id uuid)
returns jsonb language sql stable security definer set search_path = public,pg_temp as $$
  select jsonb_build_object('id',pub.id,'title',pub.content->>'title','body',pub.content->>'body',
    'excerpt',left(regexp_replace(pub.content->>'body','[[:space:]]+',' ','g'),240),
    'cover_path',pub.content->>'cover_path','updated_at',pub.updated_at,
    'can_edit',public.xelay_chat_can_edit_article(pub.id))
  from public.chat_publications pub where pub.id = p_article_id and pub.kind = 'article';
$$;
create or replace function public.xelay_chat_publication_json(p_publication_id uuid)
returns jsonb language sql stable security definer set search_path = public,pg_temp as $$
  select jsonb_build_object('id',pub.id,'kind',pub.kind,'post_id',pub.post_id,'message_id',pub.message_id,'updated_at',pub.updated_at)
    || case when pub.kind = 'poll' then jsonb_build_object('poll',public.xelay_chat_poll_json(pub.id))
      else jsonb_build_object('article',public.xelay_chat_article_json(pub.id)) end
  from public.chat_publications pub where pub.id = p_publication_id;
$$;

create or replace function public.xelay_chat_publications(p_post_ids uuid[] default '{}'::uuid[],p_message_ids uuid[] default '{}'::uuid[])
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if p_post_ids is null or p_message_ids is null or cardinality(p_post_ids) + cardinality(p_message_ids) > 400 then raise exception 'CHAT_INVALID_INPUT'; end if;
  return coalesce((select jsonb_agg(public.xelay_chat_publication_json(pub.id) order by pub.created_at,pub.id)
    from public.chat_publications pub where (pub.post_id = any(p_post_ids) or pub.message_id = any(p_message_ids))
      and public.xelay_chat_can_read_publication(pub.id)),'[]'::jsonb);
end $$;

-- Every publication mutation locks its containing chat/conversation and message
-- before the publication. Soft deletion follows the same ordering and cannot
-- race a vote/edit into an inaccessible or already removed publication.
create or replace function public.xelay_chat_lock_publication(p_publication_id uuid,p_kind text)
returns public.chat_publications language plpgsql volatile security definer set search_path = public,pg_temp as $$
declare v_pub public.chat_publications%rowtype; v_post public.chat_posts%rowtype; v_message public.messages%rowtype;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  select * into v_pub from public.chat_publications where id = p_publication_id and kind = p_kind;
  if not found then raise exception 'CHAT_PUBLICATION_NOT_FOUND'; end if;
  if v_pub.post_id is not null then
    select * into v_post from public.chat_posts where id = v_pub.post_id;
    if not found then raise exception 'CHAT_PUBLICATION_NOT_FOUND'; end if;
    perform public.xelay_chat_lock(v_post.space_id,'member');
    perform 1 from public.chat_posts where id = v_pub.post_id for update;
  else
    select * into v_message from public.messages where id = v_pub.message_id;
    if not found then raise exception 'CHAT_PUBLICATION_NOT_FOUND'; end if;
    perform 1 from public.conversations c where c.id = v_message.conversation_id and auth.uid() in(c.user_one_id,c.user_two_id) for update;
    if not found then raise exception 'CHAT_PUBLICATION_NOT_FOUND'; end if;
    perform 1 from public.messages where id = v_pub.message_id for update;
  end if;
  select * into v_pub from public.chat_publications where id = p_publication_id and kind = p_kind for update;
  if not found or not public.xelay_chat_can_read_publication(p_publication_id) then raise exception 'CHAT_PUBLICATION_NOT_FOUND'; end if;
  return v_pub;
end $$;

create or replace function public.xelay_chat_publication_summary(p_kind text,p_content jsonb)
returns text language sql immutable set search_path = public,pg_temp as $$
  select case when p_kind = 'poll' then 'Опитування: ' || (p_content->>'question')
    else 'Стаття: ' || (p_content->>'title') end;
$$;

create or replace function public.xelay_chat_validate_avatar(p_path text)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
declare v_meta jsonb;
begin
  if p_path is null then return; end if;
  if not public.xelay_chat_valid_media_path(p_path) then raise exception 'CHAT_INVALID_MEDIA'; end if;
  select metadata into v_meta from storage.objects where bucket_id = 'xelay-chat-media' and name = p_path for update;
  if not found or coalesce(v_meta->>'mimetype','') not in ('image/jpeg','image/png','image/webp','image/gif')
    or coalesce(v_meta->>'size','') !~ '^[0-9]+$' then raise exception 'CHAT_INVALID_MEDIA'; end if;
  if (v_meta->>'size')::numeric not between 1 and 5242880
    or exists(select 1 from public.chat_attachments where storage_path = p_path)
    or exists(select 1 from public.chat_publications where kind = 'article' and content->>'cover_path' = p_path) then raise exception 'CHAT_INVALID_MEDIA'; end if;
end $$;

create or replace function public.xelay_chat_publish(
  p_kind text,p_content jsonb,p_space_id uuid default null,p_conversation_id uuid default null,
  p_parent_post_id uuid default null,p_reply_to uuid default null
)
returns jsonb language plpgsql security definer set search_path = public,pg_temp as $$
declare v_id uuid; v_post_id uuid; v_message_id uuid; v_conversation public.conversations%rowtype;
  v_content jsonb; v_closes_at timestamptz; v_cover text; v_body text; v_recipient uuid; v_space public.chat_spaces%rowtype;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if not public.xelay_has_participant_access(auth.uid()) then raise exception 'PARTICIPANT_REQUIRED' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('poll','article') or p_content is null or jsonb_typeof(p_content) <> 'object'
    or num_nonnulls(p_space_id,p_conversation_id) <> 1 then raise exception 'CHAT_PUBLICATION_INVALID_INPUT'; end if;
  if p_kind = 'poll' then
    if exists(select 1 from jsonb_each(p_content) e where e.key not in ('question','options','anonymous','allows_multiple','closes_at'))
      or jsonb_typeof(p_content->'question') is distinct from 'string'
      or jsonb_typeof(p_content->'options') is distinct from 'array'
      or jsonb_typeof(p_content->'anonymous') is distinct from 'boolean'
      or jsonb_typeof(p_content->'allows_multiple') is distinct from 'boolean'
      or (p_content ? 'closes_at' and jsonb_typeof(p_content->'closes_at') not in ('null','string')) then raise exception 'CHAT_PUBLICATION_INVALID_INPUT'; end if;
    if length(btrim(p_content->>'question')) not between 1 and 500 or jsonb_array_length(p_content->'options') not between 2 and 10 then
      raise exception 'CHAT_PUBLICATION_INVALID_INPUT';
    end if;
    if exists(select 1 from jsonb_array_elements(p_content->'options') opt where jsonb_typeof(opt) <> 'string' or length(btrim(opt#>>'{}')) not between 1 and 200)
      or (select count(distinct lower(btrim(opt))) from jsonb_array_elements_text(p_content->'options') opt) <> jsonb_array_length(p_content->'options') then
      raise exception 'CHAT_PUBLICATION_INVALID_INPUT';
    end if;
    if p_content->>'closes_at' is not null then
      begin v_closes_at := (p_content->>'closes_at')::timestamptz;
      exception when others then raise exception 'CHAT_PUBLICATION_INVALID_INPUT'; end;
      if not isfinite(v_closes_at) or v_closes_at <= clock_timestamp() then raise exception 'CHAT_PUBLICATION_INVALID_INPUT'; end if;
    end if;
    v_content := jsonb_build_object('question',btrim(p_content->>'question'),
      'options',(select jsonb_agg(btrim(opt) order by ord) from jsonb_array_elements_text(p_content->'options') with ordinality options(opt,ord)),
      'anonymous',(p_content->>'anonymous')::boolean,'allows_multiple',(p_content->>'allows_multiple')::boolean,'closes_at',v_closes_at);
  else
    if exists(select 1 from jsonb_each(p_content) e where e.key not in ('title','body','cover_path'))
      or jsonb_typeof(p_content->'title') is distinct from 'string' or jsonb_typeof(p_content->'body') is distinct from 'string'
      or length(btrim(p_content->>'title')) not between 1 and 200 or btrim(p_content->>'body') = '' or length(p_content->>'body') > 50000
      or (p_content ? 'cover_path' and jsonb_typeof(p_content->'cover_path') not in ('null','string')) then raise exception 'CHAT_PUBLICATION_INVALID_INPUT'; end if;
    v_cover := p_content->>'cover_path';
    v_content := jsonb_build_object('title',btrim(p_content->>'title'),'body',p_content->>'body','cover_path',v_cover);
  end if;
  -- Validate scope/role and acquire the existing message-send lock before media.
  if p_space_id is not null then
    v_space := public.xelay_chat_lock(p_space_id,'member');
    if v_space.kind = 'channel' and p_parent_post_id is null and not public.xelay_chat_is_admin(p_space_id) then raise exception 'CHAT_ADMIN_REQUIRED'; end if;
    -- Match ordinary send ordering: space -> sender lock -> storage object.
    perform pg_advisory_xact_lock(hashtextextended('xelay-chat-send:' || auth.uid()::text,0));
  else
    if p_parent_post_id is not null then raise exception 'CHAT_INVALID_PARENT'; end if;
    select * into v_conversation from public.conversations c where c.id = p_conversation_id and auth.uid() in(c.user_one_id,c.user_two_id) for update;
    if not found then raise exception 'CHAT_MEMBER_REQUIRED'; end if;
    v_recipient := case when v_conversation.user_one_id = auth.uid() then v_conversation.user_two_id else v_conversation.user_one_id end;
    if p_reply_to is not null and not exists(select 1 from public.messages m where m.id = p_reply_to
      and m.conversation_id = p_conversation_id and m.deleted_at is null) then raise exception 'CHAT_INVALID_REPLY'; end if;
    perform pg_advisory_xact_lock(hashtextextended('xelay-publication-send:' || auth.uid()::text,0));
  end if;
  if v_cover is not null then
    perform public.xelay_chat_validate_avatar(v_cover);
    if exists(select 1 from public.chat_spaces where avatar_path = v_cover) then raise exception 'CHAT_INVALID_MEDIA'; end if;
  end if;
  v_body := public.xelay_chat_publication_summary(p_kind,v_content);
  if p_space_id is not null then
    v_post_id := public.xelay_chat_send(p_space_id,v_body,p_parent_post_id,p_reply_to,null,'[]'::jsonb);
  else
    if (select count(*) from public.messages where sender_id = auth.uid() and created_at > clock_timestamp() - interval '1 minute') >= 30 then raise exception 'CHAT_RATE_LIMIT'; end if;
    insert into public.messages(conversation_id,sender_id,recipient_id,body,reply_to_message_id)
      values(p_conversation_id,auth.uid(),v_recipient,v_body,p_reply_to) returning id into v_message_id;
  end if;
  insert into public.chat_publications(kind,author_id,post_id,message_id,content)
    values(p_kind,auth.uid(),v_post_id,v_message_id,v_content) returning id into v_id;
  return public.xelay_chat_publication_json(v_id);
end $$;

create or replace function public.xelay_chat_poll_vote(p_poll_id uuid,p_option_ids integer[])
returns jsonb language plpgsql security definer set search_path = public,pg_temp as $$
declare v_pub public.chat_publications%rowtype; v_options integer[];
begin
  v_pub := public.xelay_chat_lock_publication(p_poll_id,'poll');
  if v_pub.closed_at is not null or (v_pub.content->>'closes_at')::timestamptz <= clock_timestamp() then raise exception 'CHAT_POLL_CLOSED'; end if;
  if p_option_ids is null or cardinality(p_option_ids) > 10 or array_position(p_option_ids,null) is not null
    or exists(select 1 from unnest(p_option_ids) opt where opt < 1 or opt > jsonb_array_length(v_pub.content->'options')) then raise exception 'CHAT_POLL_INVALID_OPTIONS'; end if;
  select coalesce(array_agg(distinct opt order by opt),'{}'::integer[]) into v_options from unnest(p_option_ids) opt;
  if not (v_pub.content->>'allows_multiple')::boolean and cardinality(v_options) > 1 then raise exception 'CHAT_POLL_SINGLE_OPTION'; end if;
  delete from public.chat_poll_votes where publication_id = p_poll_id and user_id = auth.uid();
  insert into public.chat_poll_votes(publication_id,user_id,option_id) select p_poll_id,auth.uid(),opt from unnest(v_options) opt;
  update public.chat_publications set updated_at = clock_timestamp() where id = p_poll_id;
  return public.xelay_chat_poll_json(p_poll_id);
end $$;

create or replace function public.xelay_chat_poll_close(p_poll_id uuid)
returns jsonb language plpgsql security definer set search_path = public,pg_temp as $$
declare v_pub public.chat_publications%rowtype;
begin
  v_pub := public.xelay_chat_lock_publication(p_poll_id,'poll');
  if not public.xelay_chat_can_moderate_publication(p_poll_id) then raise exception 'CHAT_PUBLICATION_AUTHOR_REQUIRED'; end if;
  if v_pub.closed_at is null then update public.chat_publications set closed_at = clock_timestamp(),updated_at = clock_timestamp() where id = p_poll_id; end if;
  return public.xelay_chat_poll_json(p_poll_id);
end $$;

create or replace function public.xelay_chat_poll_voters(p_poll_id uuid,p_option_id integer,p_offset integer default 0,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp as $$
declare v_pub public.chat_publications%rowtype;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  select * into v_pub from public.chat_publications where id = p_poll_id and kind = 'poll';
  if not found or not public.xelay_chat_can_read_publication(p_poll_id) then raise exception 'CHAT_PUBLICATION_NOT_FOUND'; end if;
  if (v_pub.content->>'anonymous')::boolean then raise exception 'CHAT_POLL_ANONYMOUS'; end if;
  if p_option_id is null or p_option_id not between 1 and jsonb_array_length(v_pub.content->'options') or p_offset is null or p_offset < 0
    or p_limit is null or p_limit not between 1 and 100 then raise exception 'CHAT_PUBLICATION_INVALID_INPUT'; end if;
  return jsonb_build_object('user_ids',coalesce((select jsonb_agg(v.user_id order by v.created_at,v.user_id) from (
    select user_id,created_at from public.chat_poll_votes where publication_id = p_poll_id and option_id = p_option_id
      order by created_at,user_id offset p_offset limit p_limit) v),'[]'::jsonb),
    'total',(select count(*) from public.chat_poll_votes where publication_id = p_poll_id and option_id = p_option_id));
end $$;

create or replace function public.xelay_chat_article_edit(p_article_id uuid,p_title text,p_body text,p_cover_path text default null)
returns jsonb language plpgsql security definer set search_path = public,pg_temp as $$
declare v_pub public.chat_publications%rowtype; v_content jsonb;
begin
  v_pub := public.xelay_chat_lock_publication(p_article_id,'article');
  if v_pub.author_id <> auth.uid() then raise exception 'CHAT_PUBLICATION_AUTHOR_REQUIRED'; end if;
  if not public.xelay_has_participant_access(auth.uid()) then raise exception 'PARTICIPANT_REQUIRED' using errcode = '42501'; end if;
  if not public.xelay_chat_can_edit_article(p_article_id) then raise exception 'CHAT_PUBLICATION_EDIT_FORBIDDEN'; end if;
  if p_title is null or p_body is null or length(btrim(p_title)) not between 1 and 200 or btrim(p_body) = '' or length(p_body) > 50000 then raise exception 'CHAT_PUBLICATION_INVALID_INPUT'; end if;
  if p_cover_path is distinct from (v_pub.content->>'cover_path') and p_cover_path is not null then
    perform public.xelay_chat_validate_avatar(p_cover_path);
    if exists(select 1 from public.chat_spaces where avatar_path = p_cover_path) then raise exception 'CHAT_INVALID_MEDIA'; end if;
  end if;
  v_content := jsonb_build_object('title',btrim(p_title),'body',p_body,'cover_path',p_cover_path);
  update public.chat_publications set content = v_content,updated_at = clock_timestamp() where id = p_article_id;
  if v_pub.post_id is not null then
    update public.chat_posts set body = public.xelay_chat_publication_summary('article',v_content),edited_at = clock_timestamp() where id = v_pub.post_id;
  else
    update public.messages set body = public.xelay_chat_publication_summary('article',v_content) where id = v_pub.message_id;
  end if;
  return public.xelay_chat_article_json(p_article_id);
end $$;

-- Existing text editing cannot replace the labels of structured publications.
-- Article editing updates the publication first, then the canonical summary;
-- free ordinary deletion still replaces the message with an empty tombstone.
create or replace function public.xelay_chat_guard_publication_message()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
declare v_pub public.chat_publications%rowtype;
begin
  if new.deleted_at is null and new.body is distinct from old.body then
    if tg_table_name = 'chat_posts' then select * into v_pub from public.chat_publications where post_id = new.id;
    else select * into v_pub from public.chat_publications where message_id = new.id; end if;
    if found and new.body is distinct from public.xelay_chat_publication_summary(v_pub.kind,v_pub.content) then
      raise exception 'CHAT_PUBLICATION_EDIT_REQUIRED';
    end if;
  end if;
  return new;
end $$;
create trigger xelay_chat_guard_publication_post before update of body on public.chat_posts
  for each row execute function public.xelay_chat_guard_publication_message();
create trigger xelay_chat_guard_publication_direct before update of body on public.messages
  for each row execute function public.xelay_chat_guard_publication_message();

create or replace function public.xelay_chat_cleanup_publication()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if new.deleted_at is not null then
    if tg_table_name = 'chat_posts' then delete from public.chat_publications where post_id = new.id;
    else delete from public.chat_publications where message_id = new.id; end if;
  end if;
  return new;
end $$;
create trigger xelay_chat_cleanup_publication_post after update of deleted_at on public.chat_posts
  for each row execute function public.xelay_chat_cleanup_publication();
create trigger xelay_chat_cleanup_publication_direct after update of deleted_at on public.messages
  for each row execute function public.xelay_chat_cleanup_publication();

create or replace function public.xelay_chat_guard_publication_identity()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.kind is distinct from old.kind or new.author_id is distinct from old.author_id
      or new.post_id is distinct from old.post_id or new.message_id is distinct from old.message_id then raise exception 'CHAT_PUBLICATION_IDENTITY_IMMUTABLE'; end if;
    if old.kind = 'poll' and new.content is distinct from old.content then raise exception 'CHAT_POLL_OPTIONS_IMMUTABLE'; end if;
    new.created_at := old.created_at;
    new.updated_at := greatest(old.updated_at + interval '1 microsecond',clock_timestamp());
  else
    if auth.uid() is null or new.author_id is distinct from auth.uid() or not public.xelay_has_participant_access(auth.uid()) then
      raise exception 'PARTICIPANT_REQUIRED' using errcode = '42501';
    end if;
    if new.post_id is not null and not exists(select 1 from public.chat_posts where id = new.post_id and sender_id = new.author_id and deleted_at is null)
      or new.message_id is not null and not exists(select 1 from public.messages where id = new.message_id and sender_id = new.author_id and deleted_at is null) then
      raise exception 'CHAT_PUBLICATION_AUTHOR_REQUIRED';
    end if;
  end if;
  return new;
end $$;
create trigger xelay_chat_guard_publication_identity before insert or update on public.chat_publications
  for each row execute function public.xelay_chat_guard_publication_identity();

create or replace function public.xelay_chat_post_json(p_post_id uuid)
returns jsonb language sql stable security definer set search_path = public,pg_temp as $$
  select to_jsonb(p) || jsonb_build_object(
    'attachments',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at,a.id) from public.chat_attachments a where a.post_id = p.id),'[]'::jsonb),
    'reactions',coalesce((select jsonb_agg(jsonb_build_object('emoji',r.emoji,'user_id',r.user_id)) from public.chat_reactions r where r.post_id = p.id),'[]'::jsonb),
    'comment_count',(select count(*) from public.chat_posts c where c.parent_post_id = p.id and c.deleted_at is null),
    'is_pinned',exists(select 1 from public.chat_pins pin where pin.post_id = p.id),
    'is_pinned_for_me',exists(select 1 from public.chat_personal_pins pin where pin.post_id = p.id and pin.user_id = auth.uid()),
    'publication',(select public.xelay_chat_publication_json(pub.id) from public.chat_publications pub where pub.post_id = p.id))
  from public.chat_posts p where p.id = p_post_id;
$$;

-- Covers share the existing private bucket, but every read follows the actual
-- direct/community publication permissions. Temporary owned files remain
-- removable without a subscription after a failed/abandoned compose attempt.
create or replace function public.xelay_chat_can_read_media(p_path text)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select auth.uid() is not null and (
    exists(select 1 from public.chat_attachments a where a.storage_path = p_path and public.xelay_chat_can_read_post(a.post_id))
    or exists(select 1 from public.chat_spaces s where s.avatar_path = p_path and public.xelay_chat_can_view_space(s.id))
    or exists(select 1 from public.chat_publications pub where pub.kind = 'article' and pub.content->>'cover_path' = p_path
      and public.xelay_chat_can_read_publication(pub.id))
    or ((storage.foldername(p_path))[1] = auth.uid()::text
      and not exists(select 1 from public.chat_attachments where storage_path = p_path)
      and not exists(select 1 from public.chat_spaces where avatar_path = p_path)
      and not exists(select 1 from public.chat_publications where kind = 'article' and content->>'cover_path' = p_path))
  );
$$;
create or replace function public.xelay_chat_can_remove_media(p_path text)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select auth.uid() is not null and (storage.foldername(p_path))[1] = auth.uid()::text
    and not exists(select 1 from public.chat_attachments where storage_path = p_path)
    and not exists(select 1 from public.chat_spaces where avatar_path = p_path)
    and not exists(select 1 from public.chat_publications where kind = 'article' and content->>'cover_path' = p_path);
$$;
create or replace function public.xelay_chat_guard_media_delete()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if old.bucket_id = 'xelay-chat-media' and (exists(select 1 from public.chat_attachments where storage_path = old.name)
    or exists(select 1 from public.chat_spaces where avatar_path = old.name)
    or exists(select 1 from public.chat_publications where kind = 'article' and content->>'cover_path' = old.name)) then raise exception 'CHAT_MEDIA_IN_USE'; end if;
  return old;
end $$;
create or replace function public.xelay_chat_guard_publication_cover_attachment()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if exists(select 1 from public.chat_publications where kind = 'article' and content->>'cover_path' = new.storage_path) then raise exception 'CHAT_INVALID_MEDIA'; end if;
  return new;
end $$;
create trigger xelay_chat_guard_publication_cover_attachment before insert or update on public.chat_attachments
  for each row execute function public.xelay_chat_guard_publication_cover_attachment();

create or replace function public.xelay_chat_get(p_space_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_member public.chat_members%rowtype; v_admin boolean; v_content boolean;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if not public.xelay_chat_can_view_space(p_space_id) then raise exception 'CHAT_NOT_FOUND'; end if;
  select * into v_space from public.chat_spaces where id = p_space_id;
  select * into v_member from public.chat_members where space_id = p_space_id and user_id = auth.uid();
  v_admin := public.xelay_chat_is_admin(p_space_id);
  v_content := public.xelay_chat_is_member(p_space_id) or (v_space.system_kind = 'faculty' and v_admin);
  return jsonb_build_object(
    'space',public.xelay_chat_space_json(p_space_id),
    'my_membership',case when v_member.user_id is null then null else to_jsonb(v_member) end,
    'is_admin',v_admin,
    'can_manage_admins',case when v_space.system_kind = 'faculty' then v_admin else v_space.owner_id = auth.uid() end,
    'members',case when v_content then coalesce((select jsonb_agg(
      (case when m.user_id = auth.uid() then to_jsonb(m) else to_jsonb(m) - 'last_read_at' - 'visible_from' - 'muted' end)
        || jsonb_build_object('is_platform_admin',v_space.system_kind is not distinct from 'faculty' and public.xelay_chat_user_is_platform_admin(m.user_id))
      order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,m.joined_at,m.user_id)
      from public.chat_members m where m.space_id = p_space_id and (v_admin
        or (m.status = 'active' and (v_space.kind = 'group' or m.role in ('owner','admin'))
          and (v_space.system_kind is null or public.xelay_chat_faculty_eligible(p_space_id,m.user_id))))),'[]'::jsonb) else '[]'::jsonb end,
    'invitations',coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at desc) from public.chat_invitations i
      where i.space_id = p_space_id and i.status = 'pending' and (v_admin or i.user_id = auth.uid())),'[]'::jsonb),
    'join_requests',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from public.chat_join_requests r
      where r.space_id = p_space_id and r.status = 'pending' and (v_admin or r.user_id = auth.uid())),'[]'::jsonb),
    'invite_links',case when v_admin then coalesce((select jsonb_agg(to_jsonb(l) - 'token_hash' order by l.created_at desc)
      from public.chat_invite_links l where l.space_id = p_space_id),'[]'::jsonb) else '[]'::jsonb end,
    'pins',case when v_content then coalesce((select jsonb_agg(public.xelay_chat_post_json(p.post_id) order by p.created_at desc)
      from public.chat_pins p where p.space_id = p_space_id and public.xelay_chat_can_read_post(p.post_id)),'[]'::jsonb) else '[]'::jsonb end,
    'personal_pins',case when v_content then coalesce((select jsonb_agg(public.xelay_chat_post_json(p.post_id) order by p.created_at desc)
      from public.chat_personal_pins p where p.space_id = p_space_id and p.user_id = auth.uid()
        and public.xelay_chat_can_read_post(p.post_id)),'[]'::jsonb) else '[]'::jsonb end
  );
end $$;

-- Only attached publications are published, never vote/user associations.
-- Updates contain content and timestamps; clients refetch aggregate/my-vote data.
do $$ begin
  if exists(select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables)
    and not exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'chat_publications') then
    alter publication supabase_realtime add table public.chat_publications;
  end if;
end $$;

do $$ declare v_function record;
begin
  for v_function in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and starts_with(p.proname,'xelay_chat_') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_function.signature);
  end loop;
  for v_function in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'xelay_chat_is_member','xelay_chat_is_admin','xelay_chat_can_view_space','xelay_chat_can_read_post',
      'xelay_chat_valid_media_path','xelay_chat_can_read_media','xelay_chat_can_remove_media','xelay_chat_can_read_publication',
      'xelay_chat_create','xelay_chat_update','xelay_chat_invite','xelay_chat_invitation','xelay_chat_revoke_invitation',
      'xelay_chat_join','xelay_chat_leave','xelay_chat_delete','xelay_chat_member','xelay_chat_cancel_request',
      'xelay_chat_create_link','xelay_chat_revoke_link','xelay_chat_link_preview','xelay_chat_join_link','xelay_chat_join_request',
      'xelay_chat_send','xelay_chat_edit','xelay_chat_delete_post','xelay_chat_react','xelay_chat_pin','xelay_chat_pin_for_me',
      'xelay_chat_read','xelay_chat_mute','xelay_chat_faculty',
      'xelay_chat_search','xelay_chat_inbox','xelay_chat_unread_count','xelay_chat_get','xelay_chat_posts','xelay_chat_posts_by_ids','xelay_chat_unused_media',
      'xelay_chat_publications','xelay_chat_publish','xelay_chat_poll_vote','xelay_chat_poll_close','xelay_chat_poll_voters','xelay_chat_article_edit'
    ) loop
    execute format('grant execute on function %s to authenticated',v_function.signature);
  end loop;
end $$;

commit;
