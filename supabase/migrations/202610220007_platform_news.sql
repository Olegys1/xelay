-- An independent, authenticated global feed. NULL,NULL is platform scope;
-- university/faculty data and their existing editorial permissions stay scoped.
-- Apply as one transaction after 202610220006 and inspect the catalog preflight.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$
begin
  if to_regclass('public.news_publication_receipts') is null
    or to_regclass('public.editor_access_requests') is null
    or to_regclass('public.user_roles') is null
    or to_regprocedure('public.xelay_chat_can_share_news(uuid)') is null
    or to_regprocedure('public.xelay_queue_notification_email()') is null
    or to_regprocedure('public.xelay_update_news_post(uuid,jsonb)') is null
    or to_regprocedure('public.xelay_delete_news_post(uuid)') is null then
    raise exception 'Apply scoped news, media and notification migrations first';
  end if;
  -- The inspected live helper currently checks the base ADMIN role. Preserve
  -- it verbatim; require MFA specifically for the new global administration.
  if md5(replace(pg_get_functiondef('public.xelay_is_platform_admin()'::regprocedure),chr(13),''))
      <>'18fd129b140eff49cc61e1b308165c05'
    or to_regprocedure('public.xelay_is_platform_news_admin()') is not null
    or to_regprocedure('public.xelay_platform_news_is_trusted_backend()') is not null then
    raise exception 'Inspected administrator helper changed; re-run the security catalog preflight';
  end if;
end $$;

lock table public.news_posts,public.editor_access_requests,public.user_roles in share row exclusive mode;

alter table public.news_posts alter column university_id drop not null;
alter table public.editor_access_requests alter column university_id drop not null;
alter table public.news_publication_receipts alter column university_id drop not null;
alter table public.news_posts add constraint news_posts_platform_scope_check
  check(university_id is not null or academic_unit_id is null);
alter table public.editor_access_requests add constraint editor_requests_platform_scope_check
  check(university_id is not null or academic_unit_id is null);
alter table public.news_publication_receipts add constraint news_receipts_platform_scope_check
  check(university_id is not null or academic_unit_id is null);

-- Preserve the installed checks verbatim, extending them only with the new
-- role. A second check makes its NULL,NULL shape mandatory independently.
do $$
declare v_name text; v_check text;
begin
  foreach v_name in array array['user_roles_role_check','user_roles_scope_check'] loop
    select pg_get_constraintdef(c.oid) into v_check from pg_constraint c
      where c.conrelid='public.user_roles'::regclass and c.conname=v_name and c.contype='c';
    if v_check is null or left(v_check,7)<>'CHECK (' or right(v_check,1)<>')'
      or position('PLATFORM_EDITOR' in v_check)>0 then
      raise exception 'Unexpected existing role constraint: %',v_name;
    end if;
    execute format('alter table public.user_roles drop constraint %I',v_name);
    execute format('alter table public.user_roles add constraint %I check ((%s) or (role=''PLATFORM_EDITOR'' and university_id is null and academic_unit_id is null))',
      v_name,substr(v_check,8,length(v_check)-8));
  end loop;
end $$;
alter table public.user_roles add constraint user_roles_platform_scope_check
  check(role<>'PLATFORM_EDITOR' or (university_id is null and academic_unit_id is null));

-- SQL NULL equality must not allow duplicate pending platform applications.
drop index public.editor_access_requests_one_pending_idx;
create unique index editor_access_requests_one_pending_idx on public.editor_access_requests (
  user_id,coalesce(university_id,'00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(academic_unit_id,'00000000-0000-0000-0000-000000000000'::uuid)
) where status='pending';
create index news_posts_platform_feed_idx on public.news_posts(status,is_pinned desc,published_at desc,id)
  where university_id is null and academic_unit_id is null;

-- Do not depend on local-only general hardening migrations. A client call
-- remains a client call inside SECURITY DEFINER: current_user is its owner,
-- while the connection's requested role and original session user remain.
create function public.xelay_platform_news_is_trusted_backend()
returns boolean language sql stable security invoker set search_path='' as $$
  select coalesce(current_setting('role',true),'none')='service_role'
    or (coalesce(current_setting('role',true),'none') in ('none','postgres','supabase_admin','supabase_auth_admin')
      and session_user in ('postgres','supabase_admin','supabase_auth_admin','service_role'));
$$;
revoke all on function public.xelay_platform_news_is_trusted_backend() from public,anon,authenticated,service_role;

-- Read-only self-capability, also used by RLS. This exposes no MFA factor data
-- or other users. Academic administration continues to use its installed helper.
create function public.xelay_is_platform_news_admin()
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and public.xelay_is_platform_admin()
    and coalesce(auth.jwt()->>'aal','')='aal2'
    and exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified')
    and exists(select 1 from auth.users u where u.id=auth.uid() and u.deleted_at is null
      and coalesce(u.banned_until,'-infinity'::timestamptz)<=now());
$$;
revoke all on function public.xelay_is_platform_news_admin() from public,anon,authenticated,service_role;
grant execute on function public.xelay_is_platform_news_admin() to authenticated;

-- A SECURITY DEFINER role-grant endpoint also remains a client-origin call.
-- Protect the new role even if an older generic administrator endpoint exists;
-- never rely on RLS alone for grants made by a table owner's function.
create function public.xelay_guard_platform_news_editor_role()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_platform boolean;
begin
  v_platform:=case when tg_op='INSERT' then new.role='PLATFORM_EDITOR'
    when tg_op='DELETE' then old.role='PLATFORM_EDITOR'
    else new.role='PLATFORM_EDITOR' or old.role='PLATFORM_EDITOR' end;
  -- An actual parent-profile deletion may cascade role cleanup. At that point
  -- no profile remains to retain this role; this cannot create/transfer access.
  if tg_op='DELETE' and not exists(select 1 from public.profiles where id=old.user_id) then return old; end if;
  if v_platform and not public.xelay_platform_news_is_trusted_backend()
    and not public.xelay_is_platform_news_admin() then
    raise exception 'PLATFORM_NEWS_ADMIN_MFA_REQUIRED' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.xelay_guard_platform_news_editor_role() from public,anon,authenticated,service_role;
create trigger xelay_platform_news_editor_role_guard before insert or update of user_id,role,university_id,academic_unit_id or delete
  on public.user_roles for each row execute function public.xelay_guard_platform_news_editor_role();

-- The inspected live deployment has media/publication guards but no general
-- immutable-attribution trigger. Protect only new global rows and crossings of
-- the global boundary; do not rewrite legacy university/faculty behavior.
create function public.xelay_guard_platform_news_identity()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_global boolean; v_trusted boolean:=public.xelay_platform_news_is_trusted_backend();
begin
  v_global:=case when tg_op='INSERT' then new.university_id is null and new.academic_unit_id is null
    when tg_op='DELETE' then old.university_id is null and old.academic_unit_id is null
    else (new.university_id is null and new.academic_unit_id is null)
      or (old.university_id is null and old.academic_unit_id is null) end;
  if not v_global then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.published_by is distinct from old.published_by then
      raise exception 'NEWS_PLATFORM_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    if new.university_id is distinct from old.university_id or new.academic_unit_id is distinct from old.academic_unit_id then
      raise exception 'NEWS_PLATFORM_SCOPE_IMMUTABLE' using errcode='42501';
    end if;
    new.created_at:=old.created_at;
  end if;
  if not v_trusted then
    if auth.uid() is null or not public.xelay_can_manage_news(null::uuid,null::uuid) then
      raise exception 'NEWS_PLATFORM_EDITOR_REQUIRED' using errcode='42501';
    end if;
    if tg_op='INSERT' then
      if new.published_by is distinct from auth.uid() then
        raise exception 'NEWS_PLATFORM_PUBLISHER_REQUIRED' using errcode='42501';
      end if;
      new.created_at:=clock_timestamp();
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  new.updated_at:=clock_timestamp();
  return new;
end $$;
revoke all on function public.xelay_guard_platform_news_identity() from public,anon,authenticated,service_role;
create trigger xelay_platform_news_identity_guard before insert or update or delete on public.news_posts
  for each row execute function public.xelay_guard_platform_news_identity();

-- Existing permissive owner/admin reads remain required. This extra guard
-- restricts only other people's platform applications to verified MFA admins.
create policy "Platform editor applications require verified admin MFA" on public.editor_access_requests
  as restrictive for select to authenticated using (
    university_id is not null or user_id=auth.uid() or public.xelay_is_platform_news_admin()
  );

-- Patch only inspected anchors in installed definitions, preserving unrelated
-- live hardening, SECURITY DEFINER settings, ownership and function ACLs.
-- Both the installed function and the literal may have clipboard CRLFs.
create function pg_temp.xelay_platform_news_patch(p_signature text,p_old text,p_new text)
returns void language plpgsql as $$
declare v_oid regprocedure; v_definition text; v_old text; v_new text; v_count integer;
begin
  v_oid:=to_regprocedure(p_signature);
  if v_oid is null then raise exception 'Platform news prerequisite function missing: %',p_signature; end if;
  v_definition:=replace(pg_get_functiondef(v_oid),chr(13),'');
  v_old:=replace(p_old,chr(13),''); v_new:=replace(p_new,chr(13),'');
  if v_old='' then raise exception 'Empty platform-news patch anchor'; end if;
  v_count:=(length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old);
  if v_count<>1 then raise exception 'Platform news anchor mismatch for % (matches: %)',p_signature,v_count; end if;
  execute replace(v_definition,v_old,v_new);
end $$;

select pg_temp.xelay_platform_news_patch('public.xelay_can_manage_news(uuid,uuid)',
$old$select auth.uid() is not null and p_university_id is not null and ($old$,
$new$select auth.uid() is not null and (p_university_id is not null or p_academic_unit_id is null) and ($new$);
select pg_temp.xelay_platform_news_patch('public.xelay_can_manage_news(uuid,uuid)',
$old$public.xelay_is_platform_admin()
    or exists ($old$,
$new$(p_university_id is not null and public.xelay_is_platform_admin())
    or (p_university_id is null and p_academic_unit_id is null and public.xelay_is_platform_news_admin())
    or (p_university_id is null and p_academic_unit_id is null and exists (
      select 1 from public.user_roles r where r.user_id=auth.uid() and r.role='PLATFORM_EDITOR'
        and r.university_id is null and r.academic_unit_id is null
    ))
    or exists ($new$);

-- Preserve all original direct-chat and group-chat recipient access branches.
select pg_temp.xelay_platform_news_patch('public.xelay_can_read_news(uuid)',
$old$public.xelay_can_manage_news(n.university_id,n.academic_unit_id)
    or exists(select 1 from public.profiles$old$,
$new$public.xelay_can_manage_news(n.university_id,n.academic_unit_id)
    or (n.university_id is null and n.academic_unit_id is null)
    or exists(select 1 from public.profiles$new$);
select pg_temp.xelay_platform_news_patch('public.xelay_can_share_news(uuid,uuid,uuid)',
$old$public.xelay_can_manage_news(n.university_id, n.academic_unit_id)
        or exists ($old$,
$new$public.xelay_can_manage_news(n.university_id, n.academic_unit_id)
        or (n.university_id is null and n.academic_unit_id is null)
        or exists ($new$);
select pg_temp.xelay_platform_news_patch('public.xelay_chat_can_share_news(uuid)',
$old$public.xelay_can_manage_news(n.university_id,n.academic_unit_id)
    or exists(select 1 from public.profiles$old$,
$new$public.xelay_can_manage_news(n.university_id,n.academic_unit_id)
    or (n.university_id is null and n.academic_unit_id is null)
    or exists(select 1 from public.profiles$new$);

select pg_temp.xelay_platform_news_patch('public.xelay_request_editor_access(text,text)',
$old$p_scope not in ('faculty', 'university')$old$,
$new$p_scope not in ('faculty', 'university', 'platform')$new$);
select pg_temp.xelay_platform_news_patch('public.xelay_request_editor_access(text,text)',
$old$Editor scope must be faculty or university$old$,
$new$Editor scope must be faculty, university or platform$new$);
select pg_temp.xelay_platform_news_patch('public.xelay_request_editor_access(text,text)',
$old$  select p.university_id, p.academic_unit_id into v_university_id, v_unit_id
  from public.profiles p
  join public.universities u on u.id = p.university_id and u.is_active
  where p.id = auth.uid();
  if v_university_id is null then raise exception 'Choose your university before applying'; end if;
  if p_scope = 'university' then
    v_unit_id := null;
  elsif v_unit_id is null or not exists (
    select 1 from public.academic_units a
    where a.id = v_unit_id and a.university_id = v_university_id and a.is_active
  ) then
    raise exception 'Choose your faculty before applying for faculty editor access';
  end if;$old$,
$new$  if p_scope='platform' then
    if not exists(select 1 from public.profiles where id=auth.uid()) then
      raise exception 'Complete your profile before applying';
    end if;
    v_university_id:=null; v_unit_id:=null;
  else
    select p.university_id, p.academic_unit_id into v_university_id, v_unit_id
    from public.profiles p
    join public.universities u on u.id = p.university_id and u.is_active
    where p.id = auth.uid();
    if v_university_id is null then raise exception 'Choose your university before applying'; end if;
    if p_scope = 'university' then
      v_unit_id := null;
    elsif v_unit_id is null or not exists (
      select 1 from public.academic_units a
      where a.id = v_unit_id and a.university_id = v_university_id and a.is_active
    ) then
      raise exception 'Choose your faculty before applying for faculty editor access';
    end if;
  end if;$new$);
select pg_temp.xelay_platform_news_patch('public.xelay_request_editor_access(text,text)',
$old$where user_id = auth.uid() and university_id = v_university_id$old$,
$new$where user_id = auth.uid() and university_id is not distinct from v_university_id$new$);

select pg_temp.xelay_platform_news_patch('public.xelay_review_editor_request(uuid,boolean)',
$old$if not found then raise exception 'Pending editor request not found'; end if;$old$,
$new$if not found then raise exception 'Pending editor request not found'; end if;
  if v_request.university_id is null and v_request.academic_unit_id is null
    and not public.xelay_is_platform_news_admin() then
    raise exception 'PLATFORM_NEWS_ADMIN_MFA_REQUIRED' using errcode='42501';
  end if;$new$);
select pg_temp.xelay_platform_news_patch('public.xelay_review_editor_request(uuid,boolean)',
$old$v_role := case when v_request.academic_unit_id is null then 'UNIVERSITY_EDITOR' else 'FACULTY_EDITOR' end;$old$,
$new$v_role := case when v_request.university_id is null and v_request.academic_unit_id is null then 'PLATFORM_EDITOR'
    when v_request.academic_unit_id is null then 'UNIVERSITY_EDITOR' else 'FACULTY_EDITOR' end;$new$);
select pg_temp.xelay_platform_news_patch('public.xelay_review_editor_request(uuid,boolean)',
$old$v_scope_label := case when v_request.academic_unit_id is null then 'загальних новин університету' else 'новин факультету / інституту' end;$old$,
$new$v_scope_label := case when v_request.university_id is null and v_request.academic_unit_id is null then 'новин платформи'
    when v_request.academic_unit_id is null then 'загальних новин університету' else 'новин факультету / інституту' end;$new$);

-- Existing direct insert clients may request only their own, undecided global
-- application. The existing academic policy remains in force for other scopes.
create policy "Users can request platform news editor access" on public.editor_access_requests
  for insert to authenticated with check (
    user_id=auth.uid() and university_id is null and academic_unit_id is null
    and status='pending' and reviewed_by is null and reviewed_at is null
    and not public.xelay_can_manage_news(null::uuid,null::uuid)
    and exists(select 1 from public.profiles where id=auth.uid())
  );

-- A global editor can upload their own bounded media even without a selected
-- university. Existing private storage, file sizes and ownership stay intact.
select pg_temp.xelay_platform_news_patch('public.xelay_can_upload_news_file(text)',
$old$r.role in('FACULTY_EDITOR','UNIVERSITY_EDITOR')$old$,
$new$r.role in('FACULTY_EDITOR','UNIVERSITY_EDITOR','PLATFORM_EDITOR')$new$);
do $$
declare v_name text; v_expression text; v_anchor text:='''UNIVERSITY_EDITOR''::text'; v_count integer;
begin
  foreach v_name in array array['Members can upload their news photos','News photo upload guard'] loop
    select pg_get_expr(p.polwithcheck,p.polrelid) into v_expression from pg_policy p
      where p.polrelid='storage.objects'::regclass and p.polname=v_name and p.polcmd='a';
    if v_expression is null then raise exception 'News photo upload policy prerequisite missing: %',v_name; end if;
    v_count:=(length(v_expression)-length(replace(v_expression,v_anchor,'')))/length(v_anchor);
    if v_count<>1 then raise exception 'News photo role-array anchor mismatch: %',v_name; end if;
    -- Extend only the existing editorial role array, preserving own path,
    -- regex, bucket, metadata and any other installed restrictive predicates.
    v_expression:=replace(v_expression,v_anchor,v_anchor||', ''PLATFORM_EDITOR''::text');
    execute format('alter policy %I on storage.objects with check (%s)',v_name,v_expression);
  end loop;
end $$;

-- Platform news produces the ordinary in-app bell and per-feed unread marker.
-- It deliberately never creates a new bulk email campaign or Resend expense.
select pg_temp.xelay_platform_news_patch('public.xelay_queue_notification_email()',
$old$begin
  if new.recipient_id is null$old$,
$new$begin
  if new.type='news_published' and exists(select 1 from public.news_posts n
    where n.id=new.news_post_id and n.university_id is null and n.academic_unit_id is null) then return new; end if;
  if new.recipient_id is null$new$);
select pg_temp.xelay_platform_news_patch('public.xelay_notify_news_publication()',
$old$v_actor_name:=case when new.academic_unit_id is null$old$,
$new$v_actor_name:=case when new.university_id is null and new.academic_unit_id is null then 'Новини платформи'
    when new.academic_unit_id is null$new$);
select pg_temp.xelay_platform_news_patch('public.xelay_notify_news_publication()',
$old$where p.university_id=new.university_id
    and (new.academic_unit_id is null or p.academic_unit_id=new.academic_unit_id)$old$,
$new$where ((new.university_id is null and new.academic_unit_id is null)
    or (p.university_id=new.university_id
      and (new.academic_unit_id is null or p.academic_unit_id=new.academic_unit_id)))$new$);

-- All other consumers already delegate these permission helpers: news row RLS,
-- comments/likes, private images/files and edit/delete RPCs. The new global
-- identity trigger is independent of any unapplied legacy hardening migration.
comment on column public.news_posts.university_id is
  'NULL together with academic_unit_id: authenticated global platform feed. Otherwise the university-specific feed; academic_unit_id narrows to faculty.';
comment on column public.editor_access_requests.university_id is
  'NULL together with academic_unit_id: independent PLATFORM_EDITOR application. University/faculty approvals never grant this role.';
comment on constraint user_roles_platform_scope_check on public.user_roles is
  'PLATFORM_EDITOR always has NULL university and faculty; new platform administration adds verified MFA without changing the installed academic-admin helper.';
comment on index public.news_posts_platform_feed_idx is
  'Global platform news only; existing university/faculty feed indexes remain unchanged.';

drop function pg_temp.xelay_platform_news_patch(text,text,text);
notify pgrst,'reload schema';
commit;
