begin;

-- A document URL identifies the file; it must never act as a bearer credential.
-- Check the live session as well as the JWT so logout/revocation and MFA changes
-- take effect on the next authenticated document request.
create or replace function public.xelay_opportunities_can_open_document(p_path text)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null
    and (public.xelay_opportunities_enabled() or public.xelay_opportunities_is_admin())
    and exists(select 1 from auth.users u where u.id=auth.uid()
      and u.email_confirmed_at is not null and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=now()))
    and exists(select 1 from public.opportunities_files f
      join auth.sessions s on s.user_id=auth.uid()
        and s.id=nullif(auth.jwt()->>'session_id','')::uuid
        and (s.not_after is null or s.not_after>now())
      where f.path=p_path and f.kind='company' and (
        f.owner_id=auth.uid()
        or (s.aal::text='aal2' and public.xelay_opportunities_is_admin())
      ));
$$;
revoke all on function public.xelay_opportunities_can_open_document(text) from public,anon,authenticated,service_role;
grant execute on function public.xelay_opportunities_can_open_document(text) to anon,authenticated;

create or replace function public.xelay_opportunities_document_access(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_file public.opportunities_files%rowtype;
begin
  if auth.uid() is null then raise exception 'OPPORTUNITIES_AUTH_REQUIRED' using errcode='42501'; end if;
  select * into v_file from public.opportunities_files f where f.id=p_id and f.kind='company';
  if not found or not public.xelay_opportunities_can_open_document(v_file.path) then
    raise exception 'OPPORTUNITIES_NOT_FOUND' using errcode='42501';
  end if;
  return v_file.data || jsonb_build_object('id',v_file.id,'path',v_file.path,
    'kind','company','ownerId',v_file.owner_id);
end;
$$;
revoke all on function public.xelay_opportunities_document_access(uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_opportunities_document_access(uuid) to authenticated;

-- Restrictive policy also withstands an unrelated permissive storage policy.
-- Signing, listing and copying company proofs are deliberately not allowed.
-- Other attachment kinds keep their existing authorization rules.
drop policy if exists "Organization proof authenticated requests only" on storage.objects;
create policy "Organization proof authenticated requests only" on storage.objects
  as restrictive for select to anon,authenticated using (
    bucket_id<>'opportunities-private' or split_part(name,'/',2)<>'company'
    or (storage.allow_any_operation(array[
      'storage.object.get_authenticated','object.get_authenticated_info',
      'object.head_authenticated_info','storage.object.info_authenticated',
      'storage.object.delete','storage.object.delete_many'
    ]) and public.xelay_opportunities_can_open_document(name))
  );

commit;
