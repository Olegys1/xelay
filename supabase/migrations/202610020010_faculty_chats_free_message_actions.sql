-- Automatic ownerless faculty groups and free personal message actions.
-- Apply the complete file after community chats and participant billing.
begin;

do $$ begin
  if to_regclass('public.chat_spaces') is null
    or to_regclass('public.conversation_pins') is null
    or to_regclass('public.direct_message_pins') is null
    or to_regclass('public.academic_units') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null
    or to_regprocedure('public.xelay_chat_posts_by_ids(uuid,uuid[])') is null then
    raise exception 'Apply community chat, university and participant billing migrations first';
  end if;
end $$;

alter table public.chat_spaces
  add column if not exists system_kind text,
  add column if not exists university_id uuid references public.universities(id) on delete restrict,
  add column if not exists academic_unit_id uuid;
alter table public.chat_spaces alter column owner_id drop not null;
alter table public.chat_spaces add constraint chat_spaces_faculty_scope_fkey
  foreign key(academic_unit_id,university_id) references public.academic_units(id,university_id) on delete restrict;
alter table public.chat_spaces add constraint chat_spaces_system_identity_check check (
  (system_kind is null and owner_id is not null and university_id is null and academic_unit_id is null)
  or (system_kind is not null and system_kind = 'faculty' and owner_id is null and university_id is not null and academic_unit_id is not null
    and kind = 'group' and visibility = 'private' and username is null
    and not join_approval and history_visible and comments_enabled)
);
create unique index chat_spaces_faculty_unique on public.chat_spaces(university_id,academic_unit_id)
  where system_kind = 'faculty';
comment on column public.chat_spaces.system_kind is 'NULL for user-owned spaces; faculty for catalog-scoped system groups, moderated only by platform administrators.';

-- This internal predicate checks the CURRENT profile and enabled catalog rows on
-- every content read/write. Stale membership rows never grant old-faculty access.
create or replace function public.xelay_chat_faculty_eligible(p_space_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select exists(select 1 from public.chat_spaces s
    join public.profiles p on p.id = p_user_id and p.university_id = s.university_id and p.academic_unit_id = s.academic_unit_id
    join public.universities u on u.id = s.university_id and u.is_active
    join public.academic_units a on a.id = s.academic_unit_id and a.university_id = s.university_id and a.is_active
    where s.id = p_space_id and s.system_kind = 'faculty');
$$;

create or replace function public.xelay_chat_is_member(p_space_id uuid)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.chat_members m
    join public.chat_spaces s on s.id = m.space_id
    where m.space_id = p_space_id and m.user_id = auth.uid() and m.status = 'active'
      and (s.system_kind is null or public.xelay_chat_faculty_eligible(s.id,auth.uid())));
$$;
create or replace function public.xelay_chat_is_admin(p_space_id uuid)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.chat_spaces s where s.id = p_space_id and (
    (s.system_kind = 'faculty' and public.xelay_is_platform_admin())
    or (s.system_kind is null and exists(select 1 from public.chat_members m where m.space_id = s.id
      and m.user_id = auth.uid() and m.status = 'active' and m.role in ('owner','admin')))));
$$;
create or replace function public.xelay_chat_can_view_space(p_space_id uuid)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.chat_spaces s where s.id = p_space_id and (
    (s.system_kind = 'faculty' and (public.xelay_chat_faculty_eligible(s.id,auth.uid()) or public.xelay_is_platform_admin()))
    or (s.system_kind is null and (s.visibility = 'public' or public.xelay_chat_is_member(s.id)
      or exists(select 1 from public.chat_invitations i where i.space_id = s.id and i.user_id = auth.uid() and i.status = 'pending')
      or exists(select 1 from public.chat_join_requests r where r.space_id = s.id and r.user_id = auth.uid() and r.status = 'pending')))));
$$;
create or replace function public.xelay_chat_can_read_post(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.chat_posts p
    join public.chat_spaces s on s.id = p.space_id
    left join public.chat_members m on m.space_id = s.id and m.user_id = auth.uid() and m.status = 'active'
    where p.id = p_post_id and p.deleted_at is null
      and ((s.system_kind = 'faculty' and public.xelay_is_platform_admin())
        or (m.user_id is not null and (s.system_kind is null or public.xelay_chat_faculty_eligible(s.id,auth.uid()))
          and p.created_at >= m.visible_from))
      and (p.parent_post_id is null or exists(select 1 from public.chat_posts root
        where root.id = p.parent_post_id and root.deleted_at is null
          and ((s.system_kind = 'faculty' and public.xelay_is_platform_admin()) or root.created_at >= m.visible_from))));
$$;

-- Existing RPCs all acquire this lock. Ordinary owners keep their old rights;
-- faculty groups can never acquire an owner through NULL comparison loopholes.
create or replace function public.xelay_chat_lock(p_space_id uuid,p_permission text default 'member')
returns public.chat_spaces language plpgsql volatile security definer set search_path = public,pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_role text; v_admin boolean;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if p_permission is null or p_permission not in ('none','member','admin','owner') then raise exception 'CHAT_INVALID_INPUT'; end if;
  select * into v_space from public.chat_spaces where id = p_space_id for update;
  if not found then raise exception 'CHAT_NOT_FOUND'; end if;
  if v_space.system_kind = 'faculty' then
    v_admin := public.xelay_is_platform_admin();
    if p_permission = 'owner' then raise exception 'CHAT_SYSTEM_MANAGED'; end if;
    if not v_admin and not public.xelay_chat_faculty_eligible(p_space_id,auth.uid()) then raise exception 'CHAT_FACULTY_SCOPE_REQUIRED'; end if;
    if p_permission = 'admin' and not v_admin then raise exception 'CHAT_ADMIN_REQUIRED'; end if;
    if p_permission = 'member' and not v_admin and not public.xelay_chat_is_member(p_space_id) then raise exception 'CHAT_MEMBER_REQUIRED'; end if;
  else
    select role into v_role from public.chat_members where space_id = p_space_id and user_id = auth.uid() and status = 'active';
    if p_permission = 'owner' and v_space.owner_id is distinct from auth.uid() then raise exception 'CHAT_OWNER_REQUIRED'; end if;
    if p_permission = 'admin' and coalesce(v_role,'') not in ('owner','admin') then raise exception 'CHAT_ADMIN_REQUIRED'; end if;
    if p_permission = 'member' and v_role is null then raise exception 'CHAT_MEMBER_REQUIRED'; end if;
  end if;
  return v_space;
end $$;

-- Defense in depth for all present/future RPCs. No client has direct writes.
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
    if old.system_kind = 'faculty' and (new.name is distinct from old.name or new.description is distinct from old.description
      or new.avatar_path is distinct from old.avatar_path) and not public.xelay_is_platform_admin() then raise exception 'CHAT_ADMIN_REQUIRED'; end if;
  end if;
  return new;
end $$;
create trigger xelay_chat_guard_system_space before insert or update or delete on public.chat_spaces
  for each row execute function public.xelay_chat_guard_system_space();

create or replace function public.xelay_chat_guard_system_member()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if exists(select 1 from public.chat_spaces where id = new.space_id and system_kind = 'faculty') then
    if new.role <> 'member' then raise exception 'CHAT_SYSTEM_MANAGED'; end if;
    if new.status = 'active' and not public.xelay_chat_faculty_eligible(new.space_id,new.user_id) then raise exception 'CHAT_FACULTY_SCOPE_REQUIRED'; end if;
  end if;
  return new;
end $$;
create trigger xelay_chat_guard_system_member before insert or update on public.chat_members
  for each row execute function public.xelay_chat_guard_system_member();

create or replace function public.xelay_chat_guard_system_invitation()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if exists(select 1 from public.chat_spaces where id = new.space_id and system_kind = 'faculty') then
    raise exception 'CHAT_SYSTEM_MANAGED';
  end if;
  return new;
end $$;
create trigger xelay_chat_guard_system_invitation before insert or update on public.chat_invitations
  for each row execute function public.xelay_chat_guard_system_invitation();
create trigger xelay_chat_guard_system_link before insert or update on public.chat_invite_links
  for each row execute function public.xelay_chat_guard_system_invitation();
create trigger xelay_chat_guard_system_request before insert or update on public.chat_join_requests
  for each row execute function public.xelay_chat_guard_system_invitation();

create or replace function public.xelay_chat_faculty_name(p_unit_id uuid)
returns text language sql stable security definer set search_path = public,pg_temp as $$
  select case a.slug
    when 'economics' then 'Студент економічного'
    when 'geography' then 'Студент географічного'
    when 'history' then 'Студент історичного'
    when 'mechanics-mathematics' then 'Студент механіко-математичного'
    when 'information-technology' then 'Студент інформаційних технологій'
    when 'computer-science-cybernetics' then 'Студент комп’ютерних наук та кібернетики'
    when 'psychology' then 'Студент психології'
    when 'radio-physics-electronics' then 'Студент радіофізики, електроніки та комп’ютерних систем'
    when 'sociology' then 'Студент соціології'
    when 'physics' then 'Студент фізичного'
    when 'philosophy' then 'Студент філософського'
    when 'chemistry' then 'Студент хімічного'
    when 'military-institute' then 'Студент військового інституту'
    when 'continuing-education' then 'Студент післядипломної освіти'
    when 'state-guard-management' then 'Студент інституту управління державної охорони'
    when 'high-technologies' then 'Студент високих технологій'
    when 'geology' then 'Студент геології'
    when 'journalism' then 'Студент журналістики'
    when 'international-relations' then 'Студент міжнародних відносин'
    when 'law' then 'Студент права'
    when 'philology' then 'Студент філології'
    when 'public-administration' then 'Студент публічного управління та державної служби'
    when 'biology-medicine' then 'Студент біології та медицини'
    else left('Студенти — ' || a.name,100) end
  from public.academic_units a where a.id = p_unit_id;
$$;

create or replace function public.xelay_chat_ensure_faculty(p_user_id uuid,p_rejoin boolean default false)
returns uuid language plpgsql security definer set search_path = public,pg_temp as $$
declare v_profile public.profiles%rowtype; v_id uuid; v_old_id uuid; v_status text; v_now timestamptz := clock_timestamp();
begin
  -- All profile changes and explicit rejoining serialize through the profile row,
  -- then the enrollment lock. Serializing the rare scope transition prevents
  -- two simultaneous faculty swaps from taking old/new space locks in reverse.
  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-faculty-enrollment',0));
  for v_old_id in select s.id from public.chat_spaces s join public.chat_members m on m.space_id = s.id
    where m.user_id = p_user_id and m.status = 'active' and s.system_kind = 'faculty'
      and not public.xelay_chat_faculty_eligible(s.id,p_user_id) order by s.id loop
    perform 1 from public.chat_spaces where id = v_old_id for update;
    update public.chat_members set status = 'left',role = 'member' where space_id = v_old_id and user_id = p_user_id and status = 'active';
    update public.chat_spaces set updated_at = v_now where id = v_old_id;
  end loop;
  if v_profile.university_id is null or v_profile.academic_unit_id is null
    or not exists(select 1 from public.academic_units a join public.universities u on u.id = a.university_id
      where a.id = v_profile.academic_unit_id and a.university_id = v_profile.university_id and a.is_active and u.is_active) then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-faculty:' || v_profile.university_id::text || ':' || v_profile.academic_unit_id::text,0));
  insert into public.chat_spaces(kind,visibility,name,description,owner_id,system_kind,university_id,academic_unit_id)
    values('group','private',public.xelay_chat_faculty_name(v_profile.academic_unit_id),
      'Спільний чат студентів підрозділу. Спілкуйтеся, діліться матеріалами та підтримуйте одне одного.',
      null,'faculty',v_profile.university_id,v_profile.academic_unit_id)
    on conflict(university_id,academic_unit_id) where system_kind = 'faculty' do nothing;
  select id into v_id from public.chat_spaces where system_kind = 'faculty'
    and university_id = v_profile.university_id and academic_unit_id = v_profile.academic_unit_id for update;
  select status into v_status from public.chat_members where space_id = v_id and user_id = p_user_id;
  if v_status is null then
    insert into public.chat_members(space_id,user_id,role,status,visible_from) values(v_id,p_user_id,'member','active','-infinity');
    update public.chat_spaces set updated_at = v_now where id = v_id;
  elsif p_rejoin then
    if v_status = 'banned' then raise exception 'CHAT_BANNED'; end if;
    if v_status = 'left' then
      update public.chat_members set status = 'active',role = 'member',joined_at = v_now,visible_from = '-infinity',last_read_at = v_now
        where space_id = v_id and user_id = p_user_id;
      update public.chat_spaces set updated_at = v_now where id = v_id;
    end if;
  end if;
  -- Neither automatic enrollment nor explicit rejoin changes mute preferences.
  return v_id;
end $$;

create or replace function public.xelay_chat_sync_faculty_profile()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  perform public.xelay_chat_ensure_faculty(new.id,false);
  return new;
end $$;
create trigger xelay_chat_sync_faculty_profile after insert or update of university_id,academic_unit_id on public.profiles
  for each row execute function public.xelay_chat_sync_faculty_profile();

-- Enrollment covers all profile types and all currently enabled units.
do $$ declare v_user_id uuid;
begin
  for v_user_id in select id from public.profiles order by id loop
    perform public.xelay_chat_ensure_faculty(v_user_id,false);
  end loop;
end $$;

create or replace function public.xelay_chat_faculty(p_rejoin boolean default false)
returns jsonb language plpgsql security definer set search_path = public,pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if p_rejoin is null then raise exception 'CHAT_INVALID_INPUT'; end if;
  v_id := public.xelay_chat_ensure_faculty(auth.uid(),p_rejoin);
  if v_id is null then return jsonb_build_object('space',null,'my_membership',null); end if;
  return jsonb_build_object('space',public.xelay_chat_space_json(v_id),
    'my_membership',(select to_jsonb(m) from public.chat_members m where m.space_id = v_id and m.user_id = auth.uid()));
end $$;

create or replace function public.xelay_chat_activate(p_space_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_status text; v_now timestamptz := clock_timestamp();
begin
  select * into v_space from public.chat_spaces where id = p_space_id;
  if not found then raise exception 'CHAT_NOT_FOUND'; end if;
  if v_space.system_kind = 'faculty' and not public.xelay_chat_faculty_eligible(p_space_id,p_user_id) then raise exception 'CHAT_FACULTY_SCOPE_REQUIRED'; end if;
  select status into v_status from public.chat_members where space_id = p_space_id and user_id = p_user_id;
  if v_status = 'banned' then raise exception 'CHAT_BANNED'; end if;
  if v_status = 'active' then return; end if;
  if v_space.system_kind is null and (select count(*) from public.chat_members where space_id = p_space_id and status = 'active') >= 10000 then raise exception 'CHAT_MEMBER_LIMIT'; end if;
  insert into public.chat_members(space_id,user_id,role,status,joined_at,visible_from,last_read_at)
    values(p_space_id,p_user_id,'member','active',v_now,case when v_space.kind = 'channel' or v_space.history_visible then '-infinity'::timestamptz else v_now end,v_now)
    on conflict(space_id,user_id) do update set status = 'active',role = 'member',joined_at = excluded.joined_at,
      visible_from = excluded.visible_from,last_read_at = excluded.last_read_at;
  update public.chat_spaces set updated_at = v_now where id = p_space_id;
end $$;

create or replace function public.xelay_chat_member(p_space_id uuid,p_user_id uuid,p_action text)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_target public.chat_members%rowtype;
begin
  v_space := public.xelay_chat_lock(p_space_id,'admin');
  if p_action is null or p_action not in ('kick','ban','unban','promote','demote','transfer') or p_user_id is null then raise exception 'CHAT_INVALID_INPUT'; end if;
  if v_space.system_kind = 'faculty' and p_action in ('promote','demote','transfer') then raise exception 'CHAT_SYSTEM_MANAGED'; end if;
  select * into v_target from public.chat_members where space_id = p_space_id and user_id = p_user_id;
  if not found then raise exception 'CHAT_MEMBER_NOT_FOUND'; end if;
  if p_user_id = v_space.owner_id or p_user_id = auth.uid() then raise exception 'CHAT_PROTECTED_MEMBER'; end if;
  if v_space.system_kind is null then
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
    -- Unban returns to left, so only that person can explicitly rejoin.
    update public.chat_members set status = case when p_action = 'ban' then 'banned' else 'left' end,role = 'member'
      where space_id = p_space_id and user_id = p_user_id;
    update public.chat_invitations set status = 'revoked',updated_at = clock_timestamp() where space_id = p_space_id and user_id = p_user_id and status = 'pending';
    update public.chat_join_requests set status = 'cancelled',updated_at = clock_timestamp() where space_id = p_space_id and user_id = p_user_id and status = 'pending';
  end if;
  update public.chat_spaces set updated_at = clock_timestamp() where id = p_space_id;
end $$;

create or replace function public.xelay_chat_update(p_space_id uuid,p_changes jsonb)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_avatar text; v_owner boolean;
begin
  v_space := public.xelay_chat_lock(p_space_id,'admin');
  v_owner := v_space.owner_id is not distinct from auth.uid();
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb
    or exists(select 1 from jsonb_each(p_changes) e where e.key not in ('visibility','username','name','description','avatar_path','comments_enabled','join_approval','history_visible')) then raise exception 'CHAT_INVALID_INPUT'; end if;
  if v_space.system_kind = 'faculty' and exists(select 1 from jsonb_each(p_changes) e
    where e.key not in ('name','description','avatar_path')) then raise exception 'CHAT_SYSTEM_MANAGED'; end if;
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

create or replace function public.xelay_chat_join(p_space_id uuid)
returns text language plpgsql security definer set search_path = public,pg_temp as $$
declare v_space public.chat_spaces%rowtype; v_status text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  -- Faculty joining uses the same profile->space ordering as enrollment.
  if exists(select 1 from public.chat_spaces where id = p_space_id and system_kind = 'faculty') then
    if not public.xelay_chat_faculty_eligible(p_space_id,auth.uid()) then raise exception 'CHAT_FACULTY_SCOPE_REQUIRED'; end if;
    v_id := public.xelay_chat_ensure_faculty(auth.uid(),true);
    if v_id is distinct from p_space_id then raise exception 'CHAT_FACULTY_SCOPE_REQUIRED'; end if;
    return 'active';
  end if;
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

-- Personal pins are independent of shared moderator pins. Nobody gets global
-- moderation rights merely by being allowed to pin messages for themselves.
create table public.chat_personal_pins (
  space_id uuid not null,
  post_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key(user_id,post_id),
  foreign key(post_id,space_id) references public.chat_posts(id,space_id) on delete cascade
);
create index chat_personal_pins_user_space_idx on public.chat_personal_pins(user_id,space_id,created_at desc);
alter table public.chat_personal_pins enable row level security;
revoke all on public.chat_personal_pins from public,anon,authenticated,service_role;
grant select on public.chat_personal_pins to authenticated;
create policy "Own readable personal chat pins" on public.chat_personal_pins for select to authenticated
  using(user_id = auth.uid() and public.xelay_chat_can_read_post(post_id));

create or replace function public.xelay_chat_pin_for_me(p_post_id uuid,p_pin boolean)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
declare v_space_id uuid;
begin
  select space_id into v_space_id from public.chat_posts where id = p_post_id;
  if not found then raise exception 'CHAT_POST_NOT_FOUND'; end if;
  perform public.xelay_chat_lock(v_space_id,'member');
  if p_pin is null then raise exception 'CHAT_INVALID_INPUT'; end if;
  if not public.xelay_chat_can_read_post(p_post_id) then raise exception 'CHAT_POST_NOT_FOUND'; end if;
  if p_pin then
    if (select count(*) from public.chat_personal_pins pin where pin.user_id = auth.uid() and pin.space_id = v_space_id
      and public.xelay_chat_can_read_post(pin.post_id)) >= 20
      and not exists(select 1 from public.chat_personal_pins where user_id = auth.uid() and post_id = p_post_id) then raise exception 'CHAT_PERSONAL_PIN_LIMIT'; end if;
    insert into public.chat_personal_pins(space_id,post_id,user_id) values(v_space_id,p_post_id,auth.uid()) on conflict do nothing;
  else delete from public.chat_personal_pins where post_id = p_post_id and user_id = auth.uid(); end if;
end $$;

create or replace function public.xelay_chat_cleanup_personal_pins()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if new.deleted_at is not null then delete from public.chat_personal_pins where post_id = new.id; end if;
  return new;
end $$;
create trigger xelay_chat_cleanup_personal_pins after update of deleted_at on public.chat_posts
  for each row execute function public.xelay_chat_cleanup_personal_pins();

create or replace function public.xelay_chat_space_json(p_space_id uuid)
returns jsonb language sql stable security definer set search_path = public,pg_temp as $$
  select to_jsonb(s) || jsonb_build_object('member_count',(select count(*) from public.chat_members m where m.space_id = s.id
    and m.status = 'active' and (s.system_kind is null or public.xelay_chat_faculty_eligible(s.id,m.user_id))))
  from public.chat_spaces s where s.id = p_space_id;
$$;
create or replace function public.xelay_chat_post_json(p_post_id uuid)
returns jsonb language sql stable security definer set search_path = public,pg_temp as $$
  select to_jsonb(p) || jsonb_build_object(
    'attachments',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at,a.id) from public.chat_attachments a where a.post_id = p.id),'[]'::jsonb),
    'reactions',coalesce((select jsonb_agg(jsonb_build_object('emoji',r.emoji,'user_id',r.user_id)) from public.chat_reactions r where r.post_id = p.id),'[]'::jsonb),
    'comment_count',(select count(*) from public.chat_posts c where c.parent_post_id = p.id and c.deleted_at is null),
    'is_pinned',exists(select 1 from public.chat_pins pin where pin.post_id = p.id),
    'is_pinned_for_me',exists(select 1 from public.chat_personal_pins pin where pin.post_id = p.id and pin.user_id = auth.uid()))
  from public.chat_posts p where p.id = p_post_id;
$$;

-- Direct conversation/message pins retain ownership, membership, identity and
-- quota validation while no longer depending on an active subscription.
create or replace function public.xelay_validate_premium_pin()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
declare v_count integer;
begin
  if auth.uid() is null or new.user_id is distinct from auth.uid() then raise exception 'Pin owner permission required' using errcode = '42501'; end if;
  perform 1 from public.conversations c where c.id = new.conversation_id and auth.uid() in(c.user_one_id,c.user_two_id) for share;
  if not found then raise exception 'Conversation permission required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:pin:' || new.user_id::text,0));
  if tg_table_name = 'conversation_pins' then
    select count(*) into v_count from public.conversation_pins where user_id = new.user_id;
    if v_count >= 10 and not exists(select 1 from public.conversation_pins where user_id = new.user_id and conversation_id = new.conversation_id) then raise exception 'PIN_LIMIT_REACHED'; end if;
  else
    perform 1 from public.messages m where m.id = new.message_id and m.conversation_id = new.conversation_id and m.deleted_at is null for share;
    if not found then raise exception 'Message not found in this conversation'; end if;
    select count(*) into v_count from public.direct_message_pins where user_id = new.user_id and conversation_id = new.conversation_id;
    if v_count >= 20 and not exists(select 1 from public.direct_message_pins where user_id = new.user_id and message_id = new.message_id) then raise exception 'MESSAGE_PIN_LIMIT_REACHED'; end if;
  end if;
  return new;
end $$;
drop policy if exists "Participant adds conversation pins" on public.conversation_pins;
create policy "Participant adds conversation pins" on public.conversation_pins for insert to authenticated
  with check(user_id = auth.uid() and exists(select 1 from public.conversations c where c.id = conversation_id and auth.uid() in(c.user_one_id,c.user_two_id)));
drop policy if exists "Participant adds message pins" on public.direct_message_pins;
create policy "Participant adds message pins" on public.direct_message_pins for insert to authenticated
  with check(user_id = auth.uid() and exists(select 1 from public.conversations c where c.id = conversation_id and auth.uid() in(c.user_one_id,c.user_two_id)));

create or replace function public.xelay_validate_premium_reaction()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if auth.uid() is null or new.user_id is distinct from auth.uid() then raise exception 'Reaction owner permission required' using errcode = '42501'; end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.message_id is distinct from old.message_id or new.user_id is distinct from old.user_id then
      raise exception 'Reaction identity cannot be changed' using errcode = '42501';
    end if;
    new.created_at := old.created_at;
  end if;
  if new.emoji is null or new.emoji not in ('👍','❤️','😂','😮','🙌','🔥','🥰','🎉','🤩','💯','👏','🤝','🫶','🤔','😢','😎','⚡','📚') then
    raise exception 'Invalid message reaction';
  end if;
  perform 1 from public.messages m join public.conversations c on c.id = m.conversation_id
    where m.id = new.message_id and m.deleted_at is null and auth.uid() in(c.user_one_id,c.user_two_id) for share of m;
  if not found then raise exception 'Conversation permission required' using errcode = '42501'; end if;
  return new;
end $$;

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
    'members',case when v_content then coalesce((select jsonb_agg(
      case when m.user_id = auth.uid() then to_jsonb(m) else to_jsonb(m) - 'last_read_at' - 'visible_from' - 'muted' end
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

create or replace function public.xelay_chat_posts(p_space_id uuid,p_parent_post_id uuid default null,p_before timestamptz default null,p_limit integer default 40)
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if not public.xelay_chat_is_member(p_space_id) and not public.xelay_chat_is_admin(p_space_id) then raise exception 'CHAT_MEMBER_REQUIRED'; end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_before is not null and not isfinite(p_before)) then raise exception 'CHAT_INVALID_INPUT'; end if;
  if p_parent_post_id is not null and (not public.xelay_chat_can_read_post(p_parent_post_id)
    or not exists(select 1 from public.chat_posts where id = p_parent_post_id and space_id = p_space_id and parent_post_id is null)) then raise exception 'CHAT_POST_NOT_FOUND'; end if;
  return coalesce((select jsonb_agg(public.xelay_chat_post_json(p.id) order by p.created_at desc,p.id desc)
    from (select id,created_at from public.chat_posts where space_id = p_space_id and parent_post_id is not distinct from p_parent_post_id
      and public.xelay_chat_can_read_post(id) and (p_before is null or created_at < p_before)
      order by created_at desc,id desc limit p_limit) p),'[]'::jsonb);
end $$;
create or replace function public.xelay_chat_posts_by_ids(p_space_id uuid,p_post_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if not public.xelay_chat_is_member(p_space_id) and not public.xelay_chat_is_admin(p_space_id) then raise exception 'CHAT_MEMBER_REQUIRED'; end if;
  if p_post_ids is null or cardinality(p_post_ids) > 400 then raise exception 'CHAT_INVALID_INPUT'; end if;
  return coalesce((select jsonb_agg(public.xelay_chat_post_json(p.id) order by p.created_at desc,p.id desc)
    from public.chat_posts p where p.space_id = p_space_id and p.id = any(p_post_ids)
      and public.xelay_chat_can_read_post(p.id)),'[]'::jsonb);
end $$;

create or replace function public.xelay_chat_inbox()
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  return jsonb_build_object(
    'spaces',coalesce((select jsonb_agg(public.xelay_chat_space_json(s.id) || jsonb_build_object(
      'my_role',m.role,'my_muted',m.muted,'is_admin',public.xelay_chat_is_admin(s.id),
      'unread_count',(select count(*) from public.chat_posts p where p.space_id = s.id and p.parent_post_id is null
        and p.sender_id <> auth.uid() and p.created_at > m.last_read_at and public.xelay_chat_can_read_post(p.id)),
      'last_post',(select public.xelay_chat_post_json(p.id) from public.chat_posts p where p.space_id = s.id and p.parent_post_id is null
        and public.xelay_chat_can_read_post(p.id) order by p.created_at desc,p.id desc limit 1)
    ) order by s.updated_at desc,s.id) from public.chat_spaces s join public.chat_members m on m.space_id = s.id
      where m.user_id = auth.uid() and public.xelay_chat_is_member(s.id)),'[]'::jsonb),
    'invitations',coalesce((select jsonb_agg(to_jsonb(i) || jsonb_build_object('space',public.xelay_chat_space_json(i.space_id)) order by i.created_at desc)
      from public.chat_invitations i where i.user_id = auth.uid() and i.status = 'pending' and public.xelay_chat_can_view_space(i.space_id)),'[]'::jsonb),
    'join_requests',coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('space',public.xelay_chat_space_json(r.space_id)) order by r.created_at desc)
      from public.chat_join_requests r where r.user_id = auth.uid() and r.status = 'pending' and public.xelay_chat_can_view_space(r.space_id)),'[]'::jsonb)
  );
end $$;
create or replace function public.xelay_chat_unread_count()
returns bigint language plpgsql stable security definer set search_path = public,pg_temp as $$
begin
  if auth.uid() is null then return 0; end if;
  return (select count(*) from public.chat_posts p join public.chat_members m on m.space_id = p.space_id
    where m.user_id = auth.uid() and public.xelay_chat_is_member(p.space_id) and not m.muted
      and p.parent_post_id is null and p.sender_id <> auth.uid() and p.created_at > m.last_read_at and public.xelay_chat_can_read_post(p.id));
end $$;

-- Public search keeps its existing behavior and may also find the caller's
-- private faculty group. Other faculties are never exposed through discovery.
create or replace function public.xelay_chat_search(p_query text,p_kind text default null,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp as $$
declare v_query text := lower(ltrim(btrim(p_query),'@'));
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if p_kind is not null and p_kind not in ('group','channel') then raise exception 'CHAT_INVALID_INPUT'; end if;
  if v_query is null or length(v_query) < 2 then return '[]'::jsonb; end if;
  if length(v_query) > 80 or p_limit is null or p_limit not between 1 and 20 then raise exception 'CHAT_INVALID_INPUT'; end if;
  return coalesce((select jsonb_agg(public.xelay_chat_space_json(s.id) order by
    case when lower(s.username) = v_query then 0 when starts_with(lower(s.username),v_query) then 1
      when starts_with(lower(s.name),v_query) then 2 else 3 end,s.name,s.id)
    from (select * from public.chat_spaces where (visibility = 'public'
        or (system_kind = 'faculty' and public.xelay_chat_faculty_eligible(id,auth.uid())))
      and (p_kind is null or kind = p_kind) and (strpos(lower(name),v_query) > 0 or strpos(lower(username),v_query) > 0)
      order by case when lower(username) = v_query then 0 when starts_with(lower(username),v_query) then 1
        when starts_with(lower(name),v_query) then 2 else 3 end,name,id limit p_limit) s),'[]'::jsonb);
end $$;

-- Faculty content also protects server-side mutations against any future caller
-- that might forget to use the common lock helper.
create or replace function public.xelay_chat_guard_faculty_post()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.space_id is distinct from old.space_id
    or new.sender_id is distinct from old.sender_id or new.parent_post_id is distinct from old.parent_post_id) then
    raise exception 'CHAT_POST_IDENTITY_IMMUTABLE';
  end if;
  -- Deleting a news article must be able to run its FK ON DELETE SET NULL in
  -- chats belonging to other faculties. This permits only that exact change,
  -- without changing text/attachments/author or granting any chat access.
  if tg_op = 'UPDATE' and old.shared_news_post_id is not null and new.shared_news_post_id is null
    and (to_jsonb(new) - 'shared_news_post_id') is not distinct from (to_jsonb(old) - 'shared_news_post_id') then return new; end if;
  if exists(select 1 from public.chat_spaces where id = new.space_id and system_kind = 'faculty') then
    perform public.xelay_chat_lock(new.space_id,'member');
  end if;
  return new;
end $$;
create trigger xelay_chat_guard_faculty_post before insert or update on public.chat_posts
  for each row execute function public.xelay_chat_guard_faculty_post();

-- Notification recipients obey catalog and current faculty eligibility too.
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
      and (v_space.system_kind is null or public.xelay_chat_faculty_eligible(p_space_id,m.user_id))
      and not exists(select 1 from public.notifications n where n.recipient_id::text = m.user_id::text and n.chat_space_id = p_space_id
        and n.type in ('chat_message','chat_comment') and not coalesce(n.is_read,false));
  update public.chat_spaces set updated_at = clock_timestamp() where id = p_space_id;
  if p_parent_post_id is not null then update public.chat_posts set edited_at = edited_at where id = p_parent_post_id; end if;
  return v_id;
end $$;

-- All helpers remain private, including enrollment with an arbitrary user ID.
-- Replacing functions retains old grants, so reset the complete chat namespace.
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
      'xelay_chat_send','xelay_chat_edit','xelay_chat_delete_post','xelay_chat_react','xelay_chat_pin','xelay_chat_pin_for_me',
      'xelay_chat_read','xelay_chat_mute','xelay_chat_faculty',
      'xelay_chat_search','xelay_chat_inbox','xelay_chat_unread_count','xelay_chat_get','xelay_chat_posts','xelay_chat_posts_by_ids','xelay_chat_unused_media'
    ) loop
    execute format('grant execute on function %s to authenticated',v_function.signature);
  end loop;
end $$;
revoke all on function public.xelay_validate_premium_pin(),public.xelay_validate_premium_reaction() from public,anon,authenticated,service_role;

-- Personal membership/pin associations are deliberately not published. Existing
-- space/post events cause clients to refresh; no replica identity FULL is used.
commit;
