-- Removing classmates requires the actual group's representative or an accepted
-- approved deputy with the explicit remove_members grant. Platform-admin status
-- alone no longer supplies this action in the ordinary group workspace.
-- No membership, appointment, grade, campaign or notification rows are modified.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Patch only the two reviewed bodies, preserving all function metadata/ACLs.
-- An unexpected body aborts both changes. Reapplying the same patch is safe.
do $member_removal_roles$
declare
 v_patch record;v_proc pg_catalog.pg_proc%rowtype;v_before jsonb;v_after jsonb;
 v_source text;v_definition text;v_expected text;v_old text;v_new text;v_hash text;
begin
 for v_patch in select * from (values
  ('public.xelay_study_group_permissions(uuid)','sql','s','text[]',
   '49133de29b9b4cf3e1089921072f2c56b626043e745062a38f96d1e9398ddd56','3f8661fa70b6b82dfd94638057fcb17622bea9cb42cbb4b1211327057c212a3d',
   $old$allowed.permission in('seminar_comments','invite_members','remove_members') and public.xelay_is_platform_admin()$old$,
   $new$allowed.permission in('seminar_comments','invite_members') and public.xelay_is_platform_admin()$new$),
  ('public.xelay_remove_study_group_member(uuid)','plpgsql','v','void',
   '9d52118468a154b820ac49d30b7300180d67306944a8b6ccab4305d26f82e4ec','7447b2a814fbc0398b457879f4b9eccfaf9042414e6927b06b73619e4779fb2c',
   $old$  perform public.xelay_lock_study_group_permission(v_group_id,'remove_members',false);
  select * into v_member from public.study_group_members where id=p_member_id and group_id=v_group_id for update;$old$,
   $new$  perform public.xelay_lock_study_group_permission(v_group_id,'remove_members',false);
  -- Verify the actual current appointment after the shared group lock. A stale
  -- permission list, platform role or appointment in another group is not enough.
  if not public.xelay_is_study_group_representative(v_group_id) and not exists (
    select 1 from public.study_group_deputy_requests d
    join public.study_group_members m on m.group_id=d.group_id and m.user_id=d.user_id and m.status='accepted'
    where d.group_id=v_group_id and d.user_id=auth.uid() and d.status='approved'
      and 'remove_members'=any(d.permissions)
  ) then raise exception 'STUDY_GROUP_PERMISSION_REQUIRED' using errcode='42501'; end if;
  select * into v_member from public.study_group_members where id=p_member_id and group_id=v_group_id for update;$new$)
 ) patches(signature,language_name,volatility,return_type,before_hash,after_hash,old_source,new_source) loop
  select * into v_proc from pg_catalog.pg_proc where oid=to_regprocedure(v_patch.signature);
  if not found or v_proc.prorettype<>to_regtype(v_patch.return_type) or v_proc.proretset or v_proc.prokind<>'f'
   or v_proc.prolang<>(select oid from pg_catalog.pg_language where lanname=v_patch.language_name)
   or not v_proc.prosecdef or v_proc.provolatile::text<>v_patch.volatility then
   raise exception 'GROUP_MEMBER_REMOVAL_PREREQUISITES_CHANGED: %',v_patch.signature;
  end if;
  v_source:=v_proc.prosrc;
  v_hash:=encode(extensions.digest(replace(v_source,chr(13),''),'sha256'),'hex');
  if v_hash=v_patch.after_hash then continue;end if;
  if v_hash<>v_patch.before_hash then
   raise exception 'GROUP_MEMBER_REMOVAL_SOURCE_CHANGED: %',v_patch.signature;
  end if;
  v_before:=to_jsonb(v_proc)-'prosrc';
  v_definition:=pg_catalog.pg_get_functiondef(v_proc.oid);
  v_old:=replace(v_patch.old_source,E'\r\n',E'\n');v_new:=replace(v_patch.new_source,E'\r\n',E'\n');
  if strpos(v_source,E'\r\n')>0 then
   v_old:=replace(v_old,E'\n',E'\r\n');v_new:=replace(v_new,E'\n',E'\r\n');
  end if;
  if v_old='' or (length(v_source)-length(replace(v_source,v_old,'')))/length(v_old)<>1 then
   raise exception 'GROUP_MEMBER_REMOVAL_ANCHOR_CHANGED: %',v_patch.signature;
  end if;
  v_expected:=replace(v_source,v_old,v_new);
  if encode(extensions.digest(replace(v_expected,chr(13),''),'sha256'),'hex')<>v_patch.after_hash
   or (length(v_definition)-length(replace(v_definition,v_source,'')))/length(v_source)<>1 then
   raise exception 'GROUP_MEMBER_REMOVAL_DEFINITION_CHANGED: %',v_patch.signature;
  end if;
  execute replace(v_definition,v_source,v_expected);
  select to_jsonb(p)-'prosrc',p.prosrc into v_after,v_source from pg_catalog.pg_proc p where p.oid=v_proc.oid;
  if v_before is distinct from v_after or v_source is distinct from v_expected then
   raise exception 'GROUP_MEMBER_REMOVAL_UNEXPECTED_CHANGE: %',v_patch.signature;
  end if;
 end loop;
end;
$member_removal_roles$;

notify pgrst,'reload schema';
commit;
