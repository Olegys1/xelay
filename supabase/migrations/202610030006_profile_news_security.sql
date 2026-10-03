-- Server-owned profile fields, immutable news attribution, and closed legacy profiles.
-- Apply after the academic-specialty and scoped-news migrations. Safe to retry.
begin;

do $$
begin
  if to_regclass('public.profiles') is null
    or to_regclass('auth.users') is null
    or to_regclass('public.news_posts') is null
    or to_regprocedure('public.xelay_can_manage_news(uuid,uuid)') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null
    or not exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='profiles' and column_name='trust_score') then
    raise exception 'Apply profile, academic-specialty, and scoped-news migrations before profile/news security';
  end if;
end;
$$;

-- Inspect the actual database role rather than an editable profile, JWT user
-- metadata, or an administrator helper. A SECURITY DEFINER call made by a
-- client remains a client call; current_user inside that call is insufficient.
create or replace function public.xelay_security_is_trusted_backend()
returns boolean language sql stable security invoker set search_path = ''
as $$
  select coalesce(current_setting('role',true),'none')='service_role'
    or (coalesce(current_setting('role',true),'none') in
        ('none','postgres','supabase_admin','supabase_auth_admin')
      and session_user in ('postgres','supabase_admin','supabase_auth_admin','service_role'));
$$;
revoke all on function public.xelay_security_is_trusted_backend()
  from public,anon,authenticated,service_role;

create or replace function public.xelay_guard_profile_server_fields()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_trusted boolean := public.xelay_security_is_trusted_backend();
  v_email text;
  v_created_at timestamptz;
  v_auth_exists boolean;
begin
  if not v_trusted and (auth.uid() is null or new.id is distinct from auth.uid()) then
    raise exception 'PROFILE_OWNER_REQUIRED' using errcode='42501';
  end if;
  if tg_op='UPDATE' then
    if new.id is distinct from old.id then
      raise exception 'PROFILE_ID_IMMUTABLE' using errcode='42501';
    end if;
    if not v_trusted then
      -- Older clients send the unchanged score (including a displayed zero
      -- for legacy NULLs). Accept that payload without permitting a new score.
      if coalesce(new.rating,0) is distinct from coalesce(old.rating,0)
        or coalesce(new.trust_score,0) is distinct from coalesce(old.trust_score,0) then
        raise exception 'PROFILE_SCORES_SERVER_OWNED' using errcode='42501';
      end if;
      new.rating := old.rating;
      new.trust_score := old.trust_score;
      new.created_at := old.created_at;
    end if;
  elsif not v_trusted then
    new.rating := 0;
    new.trust_score := 0;
  end if;

  select u.email,u.created_at into v_email,v_created_at
    from auth.users u where u.id=new.id;
  v_auth_exists := found;
  if not v_trusted and not v_auth_exists then
    raise exception 'PROFILE_AUTH_ACCOUNT_REQUIRED' using errcode='42501';
  end if;
  -- Never use a caller-supplied email as a lookup or uniqueness probe. Auth is
  -- the source of truth; its confirmed email-change flow updates this cache.
  new.email := v_email;
  if tg_op='INSERT' and not v_trusted then
    new.created_at := coalesce(v_created_at,clock_timestamp());
  end if;
  return new;
end;
$$;
revoke all on function public.xelay_guard_profile_server_fields()
  from public,anon,authenticated,service_role;
drop trigger if exists xelay_profile_server_fields_guard on public.profiles;
create trigger xelay_profile_server_fields_guard before insert or update on public.profiles
  for each row execute function public.xelay_guard_profile_server_fields();

-- Auth owns email uniqueness. A second UNIQUE constraint on a writable cache
-- is unnecessary and formerly exposed account existence through error 23505.
alter table public.profiles drop constraint if exists profiles_email_key;

create or replace function public.xelay_sync_profile_auth_email()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  update public.profiles set email=new.email
    where id=new.id and email is distinct from new.email;
  return new;
end;
$$;
revoke all on function public.xelay_sync_profile_auth_email()
  from public,anon,authenticated,service_role;
drop trigger if exists xelay_profile_auth_email_sync on auth.users;
create trigger xelay_profile_auth_email_sync after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function public.xelay_sync_profile_auth_email();

update public.profiles p set email=u.email
  from auth.users u where u.id=p.id and p.email is distinct from u.email;
update public.profiles p set email=null
  where p.email is not null and not exists (select 1 from auth.users u where u.id=p.id);

-- Table REVOKE does not remove pre-existing column grants. Remove both before
-- restoring the profile operations needed by current and legacy clients.
revoke all on table public.profiles from public,anon,authenticated;
do $$
declare v_columns text;
begin
  select string_agg(quote_ident(attname),',' order by attnum) into v_columns
    from pg_attribute where attrelid='public.profiles'::regclass and attnum>0 and not attisdropped;
  execute format('revoke all privileges (%s) on table public.profiles from public,anon,authenticated',v_columns);
end;
$$;
grant select,insert,update on table public.profiles to authenticated;
alter table public.profiles enable row level security;
drop policy if exists "Profile private read guard" on public.profiles;
create policy "Profile private read guard" on public.profiles as restrictive
  for select to anon,authenticated using (id=auth.uid());
drop policy if exists "Profile owner insert guard" on public.profiles;
create policy "Profile owner insert guard" on public.profiles as restrictive
  for insert to anon,authenticated with check (id=auth.uid());
drop policy if exists "Profile owner update guard" on public.profiles;
create policy "Profile owner update guard" on public.profiles as restrictive
  for update to anon,authenticated using (id=auth.uid()) with check (id=auth.uid());

-- This legacy RPC has no event identity or anti-replay contract. Keep it only
-- for trusted maintenance; clients cannot manufacture ratings for any user.
create or replace function public.increment_profile_rating(profile_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.xelay_security_is_trusted_backend() then
    raise exception 'PROFILE_RATING_SERVER_ONLY' using errcode='42501';
  end if;
  update public.profiles set rating=coalesce(rating,0)+1 where id=profile_id;
end;
$$;
revoke all on function public.increment_profile_rating(uuid) from public,anon,authenticated;
grant execute on function public.increment_profile_rating(uuid) to service_role;

-- Also close any legacy overload, not only the observed UUID signature. Badge
-- helpers remain available to trusted backend jobs and have a fixed path.
do $$
declare v_function record;
begin
  for v_function in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in
      ('increment_profile_rating','check_expert_badge','check_user_badges','award_pioneer_badge')
  loop
    execute format('revoke all on function %s from public,anon,authenticated',v_function.oid::regprocedure);
    execute format('alter function %s set search_path to public,pg_temp',v_function.oid::regprocedure);
  end loop;
end;
$$;

-- The application uses profiles and the public-profile RPC, not xelay_users.
-- Retain the legacy table for owner/backend recovery without a client endpoint.
do $$
declare v_policy record; v_columns text;
begin
  if to_regclass('public.xelay_users') is not null then
    execute 'alter table public.xelay_users enable row level security';
    execute 'revoke all on table public.xelay_users from public,anon,authenticated';
    select string_agg(quote_ident(attname),',' order by attnum) into v_columns
      from pg_attribute where attrelid='public.xelay_users'::regclass and attnum>0 and not attisdropped;
    execute format('revoke all privileges (%s) on table public.xelay_users from public,anon,authenticated',v_columns);
    for v_policy in select policyname from pg_policies where schemaname='public' and tablename='xelay_users' loop
      execute format('drop policy %I on public.xelay_users',v_policy.policyname);
    end loop;
    execute 'create policy "Legacy profiles remain closed" on public.xelay_users as restrictive for all to anon,authenticated using (false) with check (false)';
  end if;
end;
$$;

create or replace function public.xelay_guard_news_identity()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_trusted boolean := public.xelay_security_is_trusted_backend();
begin
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.published_by is distinct from old.published_by then
      raise exception 'NEWS_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    new.created_at := old.created_at;
  end if;
  if not v_trusted then
    if auth.uid() is null then raise exception 'NEWS_EDITOR_REQUIRED' using errcode='42501'; end if;
    if tg_op in ('UPDATE','DELETE')
      and not public.xelay_can_manage_news(old.university_id,old.academic_unit_id) then
      raise exception 'NEWS_EDITOR_REQUIRED' using errcode='42501';
    end if;
    if tg_op in ('INSERT','UPDATE')
      and not public.xelay_can_manage_news(new.university_id,new.academic_unit_id) then
      raise exception 'NEWS_EDITOR_REQUIRED' using errcode='42501';
    end if;
    if tg_op='INSERT' then
      if new.published_by is distinct from auth.uid() then
        raise exception 'NEWS_PUBLISHER_REQUIRED' using errcode='42501';
      end if;
      new.created_at := clock_timestamp();
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.xelay_guard_news_identity() from public,anon,authenticated,service_role;
drop trigger if exists xelay_news_identity_guard on public.news_posts;
create trigger xelay_news_identity_guard before insert or update or delete on public.news_posts
  for each row execute function public.xelay_guard_news_identity();

-- Record editor actions without copying news bodies, images, or private email.
create table if not exists public.news_editor_audit_log (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null,
  actor_id uuid,
  publisher_id uuid not null,
  action text not null check (action in ('insert','update','delete')),
  old_university_id uuid,
  old_academic_unit_id uuid,
  new_university_id uuid,
  new_academic_unit_id uuid,
  changed_columns text[] not null default '{}',
  occurred_at timestamptz not null default clock_timestamp()
);
create index if not exists news_editor_audit_post_idx on public.news_editor_audit_log(post_id,occurred_at desc);
alter table public.news_editor_audit_log enable row level security;
revoke all on public.news_editor_audit_log from public,anon,authenticated;
grant select on public.news_editor_audit_log to authenticated;
drop policy if exists "Platform administrators read news audit" on public.news_editor_audit_log;
create policy "Platform administrators read news audit" on public.news_editor_audit_log
  for select to authenticated using (public.xelay_is_platform_admin());

create or replace function public.xelay_audit_news_editor_action()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_changed text[] := '{}';
begin
  if tg_op='UPDATE' then
    select coalesce(array_agg(e.key order by e.key),'{}'::text[]) into v_changed
      from jsonb_each(to_jsonb(new)) e
      where e.key<>'updated_at' and e.value is distinct from (to_jsonb(old)->e.key);
  end if;
  insert into public.news_editor_audit_log(
    post_id,actor_id,publisher_id,action,old_university_id,old_academic_unit_id,
    new_university_id,new_academic_unit_id,changed_columns
  ) values (
    case when tg_op='DELETE' then old.id else new.id end,auth.uid(),
    case when tg_op='DELETE' then old.published_by else new.published_by end,lower(tg_op),
    case when tg_op<>'INSERT' then old.university_id end,
    case when tg_op<>'INSERT' then old.academic_unit_id end,
    case when tg_op<>'DELETE' then new.university_id end,
    case when tg_op<>'DELETE' then new.academic_unit_id end,v_changed
  );
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.xelay_audit_news_editor_action() from public,anon,authenticated,service_role;
drop trigger if exists xelay_news_editor_audit on public.news_posts;
create trigger xelay_news_editor_audit after insert or update or delete on public.news_posts
  for each row execute function public.xelay_audit_news_editor_action();

-- Future faculty-admin appointments already use xelay_chat_set_faculty_admin
-- with an explicit immutable user UUID. Do not repeat the old username seed;
-- this migration deliberately makes no inferred grants from mutable usernames.
commit;
