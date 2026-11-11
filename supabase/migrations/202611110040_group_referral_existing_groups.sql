-- Existing groups may register during the unchanged campaign registration window.
-- Remove only the campaign-start group age and first-24-hours requirements.
-- No entries, credits, reads, tickets, campaign settings or frozen evidence are written.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Patch the three known bodies in place. Preserve their exact LF/CRLF, OIDs,
-- owners, execute ACLs, signatures, configuration and all other pg_proc metadata.
-- Unknown source or a changed security boundary aborts this entire transaction.
do $existing_groups$
declare
 v_patch record;v_proc pg_catalog.pg_proc%rowtype;v_pair jsonb;
 v_before jsonb;v_after jsonb;v_source text;v_definition text;v_expected text;
 v_hash text;v_old text;v_new text;v_matches integer;
begin
 for v_patch in select * from (values
  ('public.xelay_group_referral_action(text,jsonb,uuid)',
   'v',
   '1892cf3a4e6fa6b4a13408c3e0070cd22922f10308054f0cfde6b33574b818aa',
   'a7a972f97fa462921f13b42dc8dc91a5e4d9c0c9e825a25b145df438b3c52b11',
   jsonb_build_array(jsonb_build_array(
    $old$  if g.created_at<c.starts_at then raise exception 'REFERRAL_OLD_GROUP';end if;
  if g.created_at>v_now or v_now>g.created_at+interval '24 hours' then raise exception 'REFERRAL_REGISTRATION_EXPIRED';end if;$old$,
    $new$  if g.created_at>v_now then raise exception 'REFERRAL_REGISTRATION_EXPIRED';end if;$new$))),
  ('public.xelay_group_referral_workspace(text,uuid,uuid,uuid)',
   's',
   'e6e6f44ea143991b9003c40c49465001aa6579441087e91d9f6f8eead12fabee',
   '8112b4d4c53a08021e4ce297c01f82252de73032e22fae3499c15434a81cf149',
   jsonb_build_array(jsonb_build_array(
    $old$'canRegister',c.state='open' and statement_timestamp() between c.starts_at and c.joins_until and g.created_at>=c.starts_at and statement_timestamp()<=g.created_at+interval '24 hours' and public.xelay_private_referral_real_group(g.id),$old$,
    $new$'canRegister',c.state='open' and statement_timestamp() between c.starts_at and c.joins_until and g.created_at<=statement_timestamp() and public.xelay_private_referral_real_group(g.id),$new$),
   jsonb_build_array(
    $old$'reason',case when g.created_at<c.starts_at then 'REFERRAL_OLD_GROUP' when not public.xelay_private_referral_real_group(g.id) then 'REFERRAL_GROUP_INELIGIBLE' when statement_timestamp()>g.created_at+interval '24 hours' then 'REFERRAL_REGISTRATION_EXPIRED' else null end)$old$,
    $new$'reason',case when not public.xelay_private_referral_real_group(g.id) then 'REFERRAL_GROUP_INELIGIBLE' when g.created_at>statement_timestamp() then 'REFERRAL_REGISTRATION_EXPIRED' else null end)$new$))),
  ('public.xelay_private_referral_progress(uuid,uuid)',
   's',
   'ae803095a9b778cbd691c07ae29c7eb2717b0add70f8428eb82e47f0b86d98d3',
   'fbfff84f5c5d0769ebeaab504ea7e6c17e67d0495ae0eac11efcb7bf90d39d7d',
   jsonb_build_array(jsonb_build_array(
    $old$if g.created_at<c.starts_at or g.created_at is distinct from e.group_created_at then v_issues:=array_append(v_issues,'old_or_changed_group');end if;$old$,
    $new$if g.created_at is distinct from e.group_created_at then v_issues:=array_append(v_issues,'old_or_changed_group');end if;$new$)))
 ) patches(signature,volatility,before_hash,after_hash,pairs) loop
  select * into v_proc from pg_catalog.pg_proc where oid=to_regprocedure(v_patch.signature);
  if not found or v_proc.prorettype<>'jsonb'::regtype or v_proc.proretset or v_proc.prokind<>'f'
   or v_proc.prolang<>(select oid from pg_catalog.pg_language where lanname='plpgsql')
   or not v_proc.prosecdef or v_proc.provolatile::text<>v_patch.volatility
   or v_proc.proconfig is distinct from array['search_path=""']::text[] then
   raise exception 'REFERRAL_EXISTING_GROUPS_PREREQUISITES_CHANGED: %',v_patch.signature;
  end if;
  v_source:=v_proc.prosrc;
  v_hash:=encode(extensions.digest(replace(v_source,chr(13),''),'sha256'),'hex');
  if v_hash=v_patch.after_hash then continue;end if;
  if v_hash<>v_patch.before_hash then
   raise exception 'REFERRAL_EXISTING_GROUPS_SOURCE_CHANGED: %',v_patch.signature;
  end if;
  v_before:=to_jsonb(v_proc)-'prosrc';
  v_definition:=pg_catalog.pg_get_functiondef(v_proc.oid);
  v_expected:=v_source;
  for v_pair in select value from jsonb_array_elements(v_patch.pairs) loop
   v_old:=replace(v_pair->>0,E'\r\n',E'\n');
   v_new:=replace(v_pair->>1,E'\r\n',E'\n');
   if strpos(v_source,E'\r\n')>0 then
    v_old:=replace(v_old,E'\n',E'\r\n');v_new:=replace(v_new,E'\n',E'\r\n');
   end if;
   if v_old='' then raise exception 'REFERRAL_EXISTING_GROUPS_EMPTY_ANCHOR';end if;
   v_matches:=(length(v_expected)-length(replace(v_expected,v_old,'')))/length(v_old);
   if v_matches<>1 then
    raise exception 'REFERRAL_EXISTING_GROUPS_ANCHOR_CHANGED: %',v_patch.signature;
   end if;
   v_expected:=replace(v_expected,v_old,v_new);
  end loop;
  if encode(extensions.digest(replace(v_expected,chr(13),''),'sha256'),'hex')<>v_patch.after_hash
   or (length(v_definition)-length(replace(v_definition,v_source,'')))/length(v_source)<>1 then
   raise exception 'REFERRAL_EXISTING_GROUPS_DEFINITION_CHANGED: %',v_patch.signature;
  end if;
  execute replace(v_definition,v_source,v_expected);
  select to_jsonb(p)-'prosrc',p.prosrc into v_after,v_source from pg_catalog.pg_proc p where p.oid=v_proc.oid;
  if v_before is distinct from v_after or v_source is distinct from v_expected then
   raise exception 'REFERRAL_EXISTING_GROUPS_UNEXPECTED_CHANGE: %',v_patch.signature;
  end if;
 end loop;
end;
$existing_groups$;

notify pgrst,'reload schema';
commit;
