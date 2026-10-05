import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const productionRef='baohfpadxvhqhhjjqtil';
const pub='supabase/migrations/202610030004_legacy_content_storage_security.sql';
const priv='supabase/migrations/202610030005_message_chat_security.sql';
const quote=value=>`'${value.replaceAll("'","''")}'`;
const values=rows=>rows.map(row=>`(${row.map(quote).join(',')})`).join(',\n');
const functions=[
  [pub,'xelay_owns_legacy_public_object','text,text,text'],[pub,'xelay_reserve_public_media_upload','text,text,bigint,text'],
  [pub,'xelay_cancel_public_media_upload','text,text'],[pub,'xelay_finish_public_media_upload',''],
  [priv,'xelay_private_object_owner','jsonb'],[priv,'xelay_private_object_bytes','jsonb'],
  [priv,'xelay_private_media_attached','text,text'],[priv,'xelay_private_can_upload_media','text,text'],
  [priv,'xelay_private_reserve_media','text,text'],[priv,'xelay_private_consume_upload_reservation',''],
  [priv,'xelay_private_can_read_media','text,text'],[priv,'xelay_private_can_read_media_row','text,text,jsonb'],
  [priv,'xelay_private_can_remove_media','text,text'],[priv,'xelay_private_capture_attachment_cleanup',''],
  [priv,'xelay_private_validate_message_attachment',''],[priv,'xelay_private_media_cleanup_paths','text,integer'],
  [priv,'xelay_send_direct_message','uuid,uuid,text,uuid,jsonb'],
];
const customSignature='public.xelay_media_compat_guard_direct_delete()';
const tables=[[pub,'public_media_upload_receipts'],[pub,'public_media_upload_reservations'],
  [priv,'private_media_upload_events'],[priv,'private_media_upload_reservations'],[priv,'private_media_cleanup']];
const indexes=[[pub,'public_media_upload_receipts_user_time_idx'],[pub,'public_media_upload_reservations_user_idx'],
  [priv,'private_media_upload_events_owner_time_idx'],[priv,'private_media_upload_reservations_owner_idx'],[priv,'private_media_cleanup_actor_idx']];
const triggers=[[pub,'xelay_finish_public_media_upload','storage.objects','xelay_finish_public_media_upload'],
  [priv,'xelay_private_consume_upload_reservation','storage.objects','xelay_private_consume_upload_reservation'],
  [priv,'xelay_private_attachment_cleanup','public.message_attachments','xelay_private_capture_attachment_cleanup'],
  [priv,'xelay_private_validate_message_attachment','public.message_attachments','xelay_private_validate_message_attachment']];
const expectedTriggers=[...triggers.map(s=>[s[2],s[1],'public.'+s[3]+'()']),
  ['storage.objects','xelay_media_compat_direct_delete_guard',customSignature]];
const rpc=['public.xelay_reserve_public_media_upload(text,text,bigint,text)','public.xelay_cancel_public_media_upload(text,text)',
  'public.xelay_private_reserve_media(text,text)','public.xelay_private_media_cleanup_paths(text,integer)',
  'public.xelay_send_direct_message(uuid,uuid,text,uuid,jsonb)'];
const policyHelpers=['public.xelay_private_media_attached(text,text)','public.xelay_private_can_read_media_row(text,text,jsonb)',
  'public.xelay_private_can_remove_media(text,text)'];
const selectPolicy='Media repair uploaders read detached direct media';
const deletePolicy='Media repair protects attached direct media';
const baseline={
  'public.questions':['id','user_id'],'public.answers':['id','user_id','media_url'],
  'public.question_images':['question_id','image_url'],'public.answer_images':['answer_id','image_url'],
  'public.profiles':['id','avatar_url'],
  'public.messages':['id','conversation_id','sender_id','recipient_id','body','created_at','deleted_at','reply_to_message_id'],
  'public.message_attachments':['id','message_id','conversation_id','uploaded_by','storage_path','file_name','media_type','mime_type','created_at'],
  'public.conversations':['id','user_one_id','user_two_id'],'public.chat_attachments':['storage_path','post_id'],
  'public.chat_spaces':['id','avatar_path'],'public.chat_publications':['id','kind','content','post_id','message_id'],
  'public.chat_posts':['id','deleted_at'],'storage.objects':['id','bucket_id','name','metadata','created_at','updated_at'],
};
const deps=['auth.uid()','public.xelay_chat_valid_media_path(text)','public.xelay_chat_can_read_post(uuid)',
  'public.xelay_chat_can_view_space(uuid)','public.xelay_chat_can_read_publication(uuid)','public.xelay_validate_message_reply()',
  'public.xelay_remove_deleted_message_attachments()'];
const preserved=['public.messages','public.message_attachments','public.profiles','storage.objects','public.chat_publications'];
const sig=s=>`public.${s[1]}(${s[2]})`;
const allSignatures=()=>[...functions.map(sig),customSignature];
const bodyHashes=()=>preserved.map(r=>`select ${quote(r)} kind,md5(coalesce(string_agg((to_jsonb(r)${r==='public.message_attachments'?"-'file_size'":''})::text,',' order by r.id),'')) fingerprint from ${r} r`).join('\nunion all\n');
const countHashes=()=>preserved.map(r=>`select ${quote(r)} relation_name,count(*) row_count,md5(coalesce(string_agg(id::text,',' order by id),'')) ids_md5 from ${r}`).join('\nunion all\n');
const sizeHash="select 'attachment_sizes',md5(coalesce(string_agg(jsonb_build_object('id',r.id,'file_size',to_jsonb(r)->'file_size')::text,',' order by r.id),'')) from public.message_attachments r";

function extract(source,kind,name) {
  const patterns={function:new RegExp(`^create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`,'gm'),
    table:new RegExp(`^create table public\\.${name} \\([\\s\\S]*?^\\);`,'gm'),
    index:new RegExp(`^create index ${name} on public\\.[^;]+;`,'gm'),
    trigger:new RegExp(`^create trigger ${name} [\\s\\S]*?execute function public\\.[a-z_0-9]+\\(\\);`,'gm')};
  const matches=[...source.matchAll(patterns[kind])];
  if(matches.length!==1) throw new Error(`Expected one exact ${kind} statement for ${name}`);
  return matches[0][0];
}

function dependencyChecks() {
  return `do $media_compat_dependencies$
declare v_relation text; v_signature text; v_required record; v_missing text[]:='{}';
begin
  if session_user not in('postgres','supabase_admin') or current_user not in('postgres','supabase_admin')
    or auth.uid() is not null then raise exception 'Trusted SQL operator without client JWT required'; end if;
  foreach v_relation in array array[${Object.keys(baseline).map(quote).join(',')},'auth.users','storage.buckets'] loop
    if to_regclass(v_relation) is null then v_missing:=array_append(v_missing,v_relation);
    elsif v_relation not in('auth.users','storage.buckets') and not exists(select 1 from pg_class where oid=to_regclass(v_relation) and relrowsecurity) then
      v_missing:=array_append(v_missing,v_relation||' RLS enabled'); end if;
  end loop;
  for v_required in select * from(values ${values(Object.entries(baseline).flatMap(([r,cols])=>cols.map(c=>[r,c])))}) required(relation_name,column_name) loop
    if not exists(select 1 from pg_attribute where attrelid=to_regclass(v_required.relation_name) and attname=v_required.column_name and attnum>0 and not attisdropped) then
      v_missing:=array_append(v_missing,v_required.relation_name||'.'||v_required.column_name); end if;
  end loop;
  if not exists(select 1 from pg_attribute where attrelid=to_regclass('storage.objects') and attname in('owner_id','owner') and attnum>0 and not attisdropped) then
    v_missing:=array_append(v_missing,'storage.objects owner_id/owner'); end if;
  foreach v_signature in array array[${deps.map(quote).join(',')}] loop
    if to_regprocedure(v_signature) is null then v_missing:=array_append(v_missing,v_signature); end if;
  end loop;
  if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.messages') and tgname='validate_message_reply_insert'
    and tgfoid=to_regprocedure('public.xelay_validate_message_reply()') and not tgisinternal and tgenabled='O') then
    v_missing:=array_append(v_missing,'enabled original same-conversation reply validation trigger'); end if;
  if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.messages') and tgname='remove_deleted_message_attachments'
    and tgfoid=to_regprocedure('public.xelay_remove_deleted_message_attachments()') and not tgisinternal and tgenabled='O') then
    v_missing:=array_append(v_missing,'enabled original soft-delete attachment cleanup trigger'); end if;
  if cardinality(v_missing)>0 then raise exception 'Missing media compatibility dependencies: %',array_to_string(v_missing,', '); end if;
  if not has_table_privilege('authenticated','public.messages','SELECT') or not has_table_privilege('authenticated','public.message_attachments','SELECT')
    or not has_table_privilege('authenticated','storage.objects','SELECT') then raise exception 'Original SELECT grants missing'; end if;
  if exists(select 1 from pg_attribute where attrelid='public.message_attachments'::regclass and attname='file_size' and not attisdropped and atttypid<>'bigint'::regtype) then
    raise exception 'Existing attachment file_size type differs from source contract'; end if;
  if exists(select 1 from(values('avatars',true),('answer-media',true),('question-images',true),('xelay-message-media',false),('xelay-chat-media',false)) required(id,is_public)
    left join storage.buckets b on b.id=required.id where b.id is null or b.public is distinct from required.is_public) then raise exception 'Required media buckets or visibility missing'; end if;
  foreach v_relation in array array[${[...tables,...indexes].map(s=>quote('public.'+s[1])).join(',')}] loop
    if to_regclass(v_relation) is not null then raise exception 'Media compatibility marker already exists: %',v_relation; end if;
  end loop;
  foreach v_signature in array array[${allSignatures().map(quote).join(',')}] loop
    if to_regprocedure(v_signature) is not null then raise exception 'Media function already exists; review partial rollout: %',v_signature; end if;
  end loop;
  for v_required in select * from(values ${values(expectedTriggers.map(s=>s.slice(0,2)))}) required(relation_name,trigger_name) loop
    if exists(select 1 from pg_trigger where tgrelid=to_regclass(v_required.relation_name) and tgname=v_required.trigger_name) then
      raise exception 'Media trigger already exists: %.%',v_required.relation_name,v_required.trigger_name; end if;
  end loop;
  if exists(select 1 from pg_policy where polrelid='storage.objects'::regclass and polname in(${quote(selectPolicy)},${quote(deletePolicy)})) then raise exception 'Compatibility policy already exists'; end if;
end;
$media_compat_dependencies$;`;
}

function capture() {
  return `-- Briefly block writes to ensure unchanged-data assertions; a busy lock aborts without changes.
lock table ${preserved.join(',')} in share mode;
create temporary table xelay_media_compat_before(kind text primary key,fingerprint text not null) on commit drop;
insert into xelay_media_compat_before ${bodyHashes()} union all ${sizeHash};
create temporary table xelay_media_compat_counts_before on commit drop as ${countHashes()};
insert into xelay_media_compat_before select 'policies',md5(coalesce(string_agg(to_jsonb(p)::text,',' order by p.oid),'')) from pg_policy p;
insert into xelay_media_compat_before select 'table_acl',md5(coalesce(string_agg(jsonb_build_object('oid',c.oid,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity)::text,',' order by c.oid),''))
  from pg_class c where c.oid in(${Object.keys(baseline).map(n=>quote(n)+'::regclass').join(',')});
create temporary table xelay_media_compat_column_acl_before on commit drop as select a.attrelid,a.attnum,a.attname,a.attacl from pg_attribute a
  where a.attnum>0 and not a.attisdropped and a.attrelid in(${Object.keys(baseline).map(n=>quote(n)+'::regclass').join(',')});
insert into xelay_media_compat_before select 'triggers',md5(coalesce(string_agg(to_jsonb(t)::text,',' order by t.oid),'')) from pg_trigger t where not t.tgisinternal;
insert into xelay_media_compat_before select 'buckets',md5(coalesce(string_agg(to_jsonb(b)::text,',' order by b.id),'')) from storage.buckets b;`;
}

function postconditions() {
  return `do $media_compat_postconditions$
declare v_signature text; v_relation text; v_required record; v_expected text; v_actual text; v_role text;
begin
  foreach v_signature in array array[${allSignatures().map(quote).join(',')}] loop
    if to_regprocedure(v_signature) is null or has_function_privilege('anon',to_regprocedure(v_signature),'EXECUTE') or has_function_privilege('service_role',to_regprocedure(v_signature),'EXECUTE')
      or exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(v_signature) and a.grantee=0 and a.privilege_type='EXECUTE') then
      raise exception 'New media function/ACL postcondition failed: %',v_signature; end if;
  end loop;
  foreach v_signature in array array[${[...rpc,...policyHelpers].map(quote).join(',')}] loop
    if not has_function_privilege('authenticated',to_regprocedure(v_signature),'EXECUTE') then raise exception 'Required authenticated grant missing: %',v_signature; end if;
  end loop;
  foreach v_relation in array array[${tables.map(s=>quote('public.'+s[1])).join(',')}] loop
    if not exists(select 1 from pg_class where oid=to_regclass(v_relation) and relrowsecurity) then raise exception 'Internal RLS missing: %',v_relation; end if;
    foreach v_role in array array['anon','authenticated','service_role'] loop
      if has_table_privilege(v_role,to_regclass(v_relation),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then raise exception 'Unexpected internal-table access: % %',v_role,v_relation; end if;
    end loop;
  end loop;
  for v_required in select * from(values ${values(expectedTriggers)}) required(relation_name,trigger_name,function_signature) loop
    if not exists(select 1 from pg_trigger where tgrelid=to_regclass(v_required.relation_name) and tgname=v_required.trigger_name and not tgisinternal and tgenabled='O'
      and tgfoid=to_regprocedure(v_required.function_signature)) then raise exception 'Required media trigger missing: %.%',v_required.relation_name,v_required.trigger_name; end if;
  end loop;
  for v_required in select * from(${bodyHashes()} union all ${sizeHash}) fingerprints loop
    select fingerprint into v_expected from xelay_media_compat_before where kind=v_required.kind;
    if v_expected is distinct from v_required.fingerprint then raise exception 'Existing row data changed: %',v_required.kind; end if;
  end loop;
  if exists(select 1 from(${countHashes()}) a full join xelay_media_compat_counts_before b using(relation_name)
    where a.row_count is distinct from b.row_count or a.ids_md5 is distinct from b.ids_md5) then raise exception 'Existing row counts or identities changed'; end if;
  select md5(coalesce(string_agg(to_jsonb(p)::text,',' order by p.oid),'')) into v_actual from pg_policy p where not(p.polrelid='storage.objects'::regclass and p.polname in(${quote(selectPolicy)},${quote(deletePolicy)}));
  select fingerprint into v_expected from xelay_media_compat_before where kind='policies';
  if v_actual is distinct from v_expected then raise exception 'An original policy changed'; end if;
  for v_required in select * from(values(${quote(selectPolicy)},'r',true),(${quote(deletePolicy)},'d',false)) required(policy_name,command,permissive) loop
    if not exists(select 1 from pg_policy where polrelid='storage.objects'::regclass and polname=v_required.policy_name and polcmd=v_required.command::"char"
      and polpermissive=v_required.permissive and polroles=array[(select oid from pg_roles where rolname='authenticated')]::oid[]) then raise exception 'Expected narrow direct-media policy missing'; end if;
  end loop;
  select md5(coalesce(string_agg(jsonb_build_object('oid',c.oid,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity)::text,',' order by c.oid),'')) into v_actual
    from pg_class c where c.oid in(${Object.keys(baseline).map(n=>quote(n)+'::regclass').join(',')});
  select fingerprint into v_expected from xelay_media_compat_before where kind='table_acl';
  if v_actual is distinct from v_expected then raise exception 'Original table ACL/RLS changed'; end if;
  if exists(select 1 from xelay_media_compat_column_acl_before old_column left join pg_attribute a on a.attrelid=old_column.attrelid and a.attnum=old_column.attnum
    where a.attname is distinct from old_column.attname or a.attacl is distinct from old_column.attacl or a.attisdropped) then raise exception 'Original column ACL changed'; end if;
  select md5(coalesce(string_agg(to_jsonb(t)::text,',' order by t.oid),'')) into v_actual from pg_trigger t where not t.tgisinternal and not exists(
    select 1 from(values ${values(expectedTriggers.map(s=>s.slice(0,2)))}) added(relation_name,trigger_name) where t.tgrelid=to_regclass(added.relation_name) and t.tgname=added.trigger_name);
  select fingerprint into v_expected from xelay_media_compat_before where kind='triggers';
  if v_actual is distinct from v_expected then raise exception 'An original trigger changed'; end if;
  select md5(coalesce(string_agg(to_jsonb(b)::text,',' order by b.id),'')) into v_actual from storage.buckets b;
  select fingerprint into v_expected from xelay_media_compat_before where kind='buckets';
  if v_actual is distinct from v_expected then raise exception 'An original bucket configuration changed'; end if;
end;
$media_compat_postconditions$;
notify pgrst,'reload schema';
commit;
select ${quote(productionRef)} as intended_project,'media_compatibility_repair_committed' as status,5 as restored_user_rpcs,5 as added_internal_tables,
  18 as added_functions,5 as added_triggers,2 as added_scoped_direct_media_policies;`;
}

export async function buildProductionMediaRepair() {
  const originals=new Map(await Promise.all([pub,priv].map(async name=>[name,await readFile(resolve(repository,name),'utf8')])));
  const manifest=[];
  const exact=(kind,s)=>{
    const statement=extract(originals.get(s[0]),kind,s[1]);
    manifest.push({source:s[0],kind,name:s[1],sha256:createHash('sha256').update(statement).digest('hex')});
    return `-- Exact source: ${s[0]} / ${kind} ${s[1]}\n-- Statement SHA-256: ${manifest.at(-1).sha256}\n${statement}`;
  };
  const directDeleteGuard=`-- Narrow adaptation of the attached-object check in 005 xelay_private_guard_storage_delete.
-- Only direct-message files are guarded; no lease/claims worker or other bucket changes.
create function public.xelay_media_compat_guard_direct_delete()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.bucket_id='xelay-message-media' and public.xelay_private_media_attached(old.bucket_id,old.name) then
    raise exception 'PRIVATE_MEDIA_IN_USE' using errcode='42501'; end if;
  return old;
end;
$$;`;
  const sql=[
    `-- COMPATIBILITY ONLY, intended project ${productionRef} / Xelay mvp: verify the dashboard target before execution.`,
    '-- Supersedes the eight-migration proposal. No complete source migration, user/role seed, content/poll repair, or background maintenance is replayed.',
    '-- Original policies, existing guards, grants, subscriptions, content and bucket configuration are preserved.',
    '-- Two new policies affect ONLY detached/attached direct-message media. A row-lock DELETE trigger prevents ambiguous-send cleanup deleting a committed attachment.',
    '-- Existing raw-Storage ownership/quota bypass debt remains; this is NOT completion of the security audit.',
    '-- Future complete 004/005 migrations must reconcile these partial source objects; do not replay them blindly.',
    'begin;',"set local lock_timeout='5s';","set local statement_timeout='60s';",
    "select pg_advisory_xact_lock(hashtextextended('xelay:production-media-compatibility-repair:20261004',0));",
    dependencyChecks(),capture(),'alter table public.message_attachments add column if not exists file_size bigint;',
    ...tables.flatMap(s=>[exact('table',s),`alter table public.${s[1]} enable row level security;\nrevoke all on public.${s[1]} from public,anon,authenticated,service_role;`]),
    ...indexes.map(s=>exact('index',s)),...functions.map(s=>exact('function',s)),directDeleteGuard,
    `revoke all on function ${allSignatures().join(',\n')} from public,anon,authenticated,service_role;`,
    `grant execute on function ${[...rpc,...policyHelpers].join(',\n')} to authenticated;`,
    ...triggers.map(s=>exact('trigger',s)),
    'create trigger xelay_media_compat_direct_delete_guard before delete on storage.objects for each row execute function public.xelay_media_compat_guard_direct_delete();',
    `-- Owner-only detached row visibility is needed by Storage permission preview/RETURNING and failed-upload cleanup.
create policy "${selectPolicy}" on storage.objects for select to authenticated
  using(bucket_id='xelay-message-media' and not public.xelay_private_media_attached(bucket_id,name)
    and public.xelay_private_can_read_media_row(bucket_id,name,to_jsonb(objects)));
create policy "${deletePolicy}" on storage.objects as restrictive for delete to authenticated
  using(bucket_id<>'xelay-message-media' or(not public.xelay_private_media_attached(bucket_id,name)
    and public.xelay_private_can_remove_media(bucket_id,name)));`,postconditions(),
  ].join('\n\n');
  const dependencySql=`-- READ ONLY: intended project ${productionRef}, verify dashboard target manually.\n${dependencyChecks()}\nselect 'media_compatibility_dependencies_present_and_targets_absent' as status;\n`;
  return {sql,dependencySql,manifest,customGuardSha256:createHash('sha256').update(directDeleteGuard).digest('hex'),
    sources:[...originals].map(([name,body])=>({name,sha256:createHash('sha256').update(body).digest('hex')}))};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length!==2) throw new Error('Usage: node scripts/security/build-production-media-repair.mjs');
    const result=await buildProductionMediaRepair();
    const outputDir=resolve(repository,'.security-audit.local');
    if(!outputDir.startsWith(repository+sep)) throw new Error('Output directory outside repository');
    await mkdir(outputDir,{recursive:true});
    await writeFile(resolve(outputDir,'production-media-repair-20261004.sql'),result.sql);
    await writeFile(resolve(outputDir,'production-media-repair-dependencies-20261004.sql'),result.dependencySql);
    await writeFile(resolve(outputDir,'production-media-repair-manifest-20261004.json'),JSON.stringify({intendedProject:productionRef,scope:'compatibility-only',
      sources:result.sources,exactStatements:result.manifest,customDirectDeleteGuardSha256:result.customGuardSha256,applied:false},null,2));
    console.log(JSON.stringify({intendedProject:productionRef,scope:'compatibility-only',exactSourceStatements:result.manifest.length,bytes:Buffer.byteLength(result.sql),applied:false}));
  } catch(error) {
    console.error(`Media compatibility preparation failed: ${error.message}. No cloud operation was performed.`);
    process.exitCode=1;
  }
}
