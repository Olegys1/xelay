// Actual PostgreSQL execution of the reviewed member-removal upgrade. Synthetic
// accounts only: no production connection and no real membership is changed.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto'

const read=file=>readFile(new URL(`../../${file}`,import.meta.url),'utf8')
const migration=await read('supabase/migrations/202611110050_study_group_member_removal_roles.sql')
const postcheck=await read('scripts/security/study-group-member-removal-postcheck.sql')
const oldGroups=await read('supabase/migrations/202609290001_study_groups_schedule.sql')
const deputySource=await read('supabase/migrations/202610020008_study_group_deputies.sql')
const permissionsSource=await read('supabase/migrations/202610050002_study_group_materials.sql')
const lockSource=await read('supabase/migrations/202610030016_group_trial.sql')
const adminSource=await read('supabase/migrations/202610030007_admin_mfa.sql')
const functionFrom=(source,name)=>{
 const start=source.indexOf(`create or replace function public.${name}(`)
 assert.ok(start>=0,`real ${name} exists`)
 const body=source.slice(start),tag=body.match(/as (\$[a-z_]*\$)/i)?.[1]
 assert.ok(tag)
 const first=body.indexOf(tag),end=body.indexOf(tag,first+tag.length)
 assert.ok(end>first)
 return body.slice(0,end+tag.length+1)
}
const id=n=>`e5000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const users=Object.fromEntries(['head','headB','ordinary','teacher','admin','deputy','inviteOnly','revoked','pendingAppointment',
 'pendingMember','removedMember','outsider','target','targetB','secondDeputy','noMfaAdmin','noRoleFactor','pendingTarget'].map((n,i)=>[n,id(i+1)]))
const group=id(100),groupB=id(101)
const signatures=['public.xelay_study_group_permissions(uuid)','public.xelay_remove_study_group_member(uuid)']

async function fixture({crlf=false}={}){
 const db=new PGlite({extensions:{pgcrypto},postgresqlconf:['shared_buffers=4MB','work_mem=1MB','maintenance_work_mem=4MB']})
 const rows=async(sql,args=[]) =>(await db.query(sql,args)).rows
 const one=async(sql,args=[]) =>(await rows(sql,args))[0]
 const asUser=async(user,sql,args=[],{role='authenticated',aal='aal1',rollback=false}={})=>{
  const marker=new Error('synthetic rollback');let result
  try{return await db.transaction(async tx=>{
   await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,role,aal})])
   await tx.exec('set local role '+role)
   result=(await tx.query(sql,args)).rows
   if(rollback)throw marker
   return result
  })}catch(error){if(error===marker)return result;throw error}
 }
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
   grant usage on schema auth,public to anon,authenticated,service_role;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;
   create table public.profiles(id uuid primary key,account_type text);
   create table public.user_roles(user_id uuid,role text);
   create table auth.mfa_factors(user_id uuid,status text);
   create table public.study_groups(id uuid primary key,representative_id uuid not null);
   create table public.group_trial_entitlements(group_id uuid primary key);
   create table public.study_group_members(id uuid primary key default gen_random_uuid(),group_id uuid not null references study_groups(id),
    user_id uuid not null,status text not null,invited_by uuid,accepted_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),unique(group_id,user_id));
   create table public.study_group_deputy_requests(id uuid primary key default gen_random_uuid(),group_id uuid not null references study_groups(id),
    user_id uuid not null,status text not null,permissions text[] not null default '{}',reviewed_by uuid,reviewed_at timestamptz,updated_at timestamptz default now(),unique(group_id,user_id));
   create function public.xelay_group_write_access(uuid) returns boolean language sql stable as $$select true$$;
   alter table public.study_group_members enable row level security;
   alter table public.study_group_deputy_requests enable row level security;
   grant select on public.study_groups,public.study_group_members to authenticated;
  `)
  for(const[name,user]of Object.entries(users))await db.query('insert into profiles values($1,$2)',[user,name==='teacher'?'teacher':'student'])
  await db.query("insert into user_roles values($1,'ADMIN'),($2,'ADMIN')",[users.admin,users.noMfaAdmin])
  await db.query("insert into auth.mfa_factors values($1,'verified'),($2,'verified')",[users.admin,users.noRoleFactor])
  await db.query('insert into study_groups values($1,$2),($3,$4)',[group,users.head,groupB,users.headB])
  for(const[name,user]of Object.entries(users)){
   if(['outsider','headB','targetB'].includes(name))continue
   const status=['pendingMember','pendingTarget'].includes(name)?'pending':name==='removedMember'?'removed':'accepted'
   await db.query('insert into study_group_members(group_id,user_id,status,invited_by)values($1,$2,$3,$4)',[group,user,status,users.head])
  }
  await db.query("insert into study_group_members(group_id,user_id,status,invited_by)values($1,$2,'accepted',$3),($1,$3,'accepted',$3),($1,$4,'accepted',$3)",[groupB,users.targetB,users.headB,users.deputy])
  for(const[name,status,permissions]of [
   ['deputy','approved',['remove_members']],['inviteOnly','approved',['invite_members']],['revoked','revoked',[]],
   ['pendingAppointment','pending',['remove_members']],['pendingMember','approved',['remove_members']],
   ['removedMember','approved',['remove_members']],['secondDeputy','approved',['homework']],
  ])await db.query('insert into study_group_deputy_requests(group_id,user_id,status,permissions)values($1,$2,$3,$4)',[group,users[name],status,permissions])
  for(const[source,name]of [[oldGroups,'xelay_is_study_group_representative'],[adminSource,'xelay_is_platform_admin'],
   [permissionsSource,'xelay_study_group_permissions'],[deputySource,'xelay_has_study_group_permission'],
   [lockSource,'xelay_lock_study_group_permission'],[deputySource,'xelay_remove_study_group_member'],
   [deputySource,'xelay_cleanup_study_group_deputy_membership'],[deputySource,'xelay_can_read_study_group_membership']]){
   const sql=functionFrom(source,name).replaceAll('\r','')
   await db.exec(crlf?sql.replaceAll('\n','\r\n'):sql)
  }
  await db.exec(`create trigger study_group_members_deputy_cleanup before update or delete on public.study_group_members
    for each row execute function public.xelay_cleanup_study_group_deputy_membership();
   create policy member_visibility on public.study_group_members for select to authenticated
    using(public.xelay_can_read_study_group_membership(group_id,user_id,status));
   revoke all on function public.xelay_study_group_permissions(uuid),public.xelay_remove_study_group_member(uuid) from public,anon,authenticated,service_role;
   grant execute on function public.xelay_study_group_permissions(uuid),public.xelay_remove_study_group_member(uuid) to authenticated;
   revoke all on function public.xelay_cleanup_study_group_deputy_membership() from public,anon,authenticated,service_role;
  `)
  const member=async(user,g=group)=>(await one('select * from study_group_members where group_id=$1 and user_id=$2',[g,user]))
  const remove=async(actor,target=users.target,{g=group,...options}={})=>asUser(actor,'select public.xelay_remove_study_group_member($1)',[(await member(target,g)).id],options)
  const permissions=async(user,options={})=>(await asUser(user,'select public.xelay_study_group_permissions($1) value',[group],options))[0].value
  const metadata=()=>rows("select to_jsonb(p)-'prosrc' metadata from pg_proc p where oid=any($1::regprocedure[]) order by oid",[signatures])
  const definitions=()=>rows("select oid::regprocedure::text signature,prosrc,pg_get_functiondef(oid) definition from pg_proc where oid=any($1::regprocedure[]) order by oid",[signatures])
  const data=async()=>Object.fromEntries(await Promise.all(['study_groups','study_group_members','study_group_deputy_requests','profiles','user_roles'].map(async table=>[table,(await one(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from public.${table} t`)).value])))
  return{db,one,rows,asUser,member,remove,permissions,metadata,definitions,data,apply:()=>db.exec(migration),close:()=>db.close()}
 }catch(error){await db.close();throw error}
}
const denied=work=>assert.rejects(work,error=>error.code==='42501')

test('member removal: reproduce admin exception and require real group role after upgrade',{timeout:60_000},async t=>{
 const fx=await fixture();t.after(()=>fx.close())
 await t.test('before upgrade ordinary and teacher accounts cannot remove; MFA admin exception is reproducible without persisting removal',async()=>{
  await denied(fx.remove(users.ordinary));await denied(fx.remove(users.teacher))
  assert.equal((await fx.permissions(users.admin,{aal:'aal2'})).includes('remove_members'),true)
  const before=await fx.data();await fx.remove(users.admin,users.target,{aal:'aal2',rollback:true});assert.deepEqual(await fx.data(),before)
  await denied(fx.remove(users.admin,users.target,{aal:'aal1'}));await denied(fx.remove(users.noMfaAdmin,users.target,{aal:'aal2'}));await denied(fx.remove(users.noRoleFactor,users.target,{aal:'aal2'}))
 })
 await t.test('migration changes only two bodies, preserving data, OIDs, owners, ACLs and settings; reapplication is idempotent',async()=>{
  const before={metadata:await fx.metadata(),data:await fx.data(),definitions:await fx.definitions()}
  await fx.apply();assert.deepEqual(await fx.metadata(),before.metadata);assert.deepEqual(await fx.data(),before.data)
  const receipt=(await fx.db.exec(postcheck)).flatMap(result=>result.rows).find(row=>row.verification)?.verification
  assert.equal(receipt.functions.length,2);assert.equal(receipt.relation_fingerprints.length,3);assert.equal(receipt.table_guards.length,3)
  assert.ok(receipt.functions.every(fn=>fn.authenticated_execute&&!fn.anon_execute&&!fn.service_execute))
  const after=await fx.definitions();assert.ok(after.every((value,i)=>value.prosrc!==before.definitions[i].prosrc))
  await fx.apply();assert.deepEqual(await fx.definitions(),after);assert.deepEqual(await fx.metadata(),before.metadata);assert.deepEqual(await fx.data(),before.data)
  assert.deepEqual(await fx.permissions(users.admin,{aal:'aal2'}),['seminar_comments','invite_members'])
  assert.ok((await fx.permissions(users.head)).includes('remove_members'))
 })
 await t.test('ordinary, teacher, admin-only, outsiders and appointments without current explicit authority are denied atomically',async()=>{
  const before=await fx.data()
  for(const name of ['ordinary','teacher','admin','outsider','headB','inviteOnly','revoked','pendingAppointment','pendingMember','removedMember']){
   await denied(fx.remove(users[name],users.target,{aal:name==='admin'?'aal2':'aal1'}))
   assert.equal((await fx.permissions(users[name],{aal:name==='admin'?'aal2':'aal1'})).includes('remove_members'),false,name)
  }
  await denied(fx.remove(null,users.target,{role:'anon'}));await denied(fx.remove(null,users.target,{role:'service_role'}))
  assert.deepEqual(await fx.data(),before)
 })
 await t.test('representative and accepted explicitly permitted deputy can remove accepted members or cancel invitations',async()=>{
  for(const actor of [users.head,users.deputy]){
   await fx.remove(actor,users.target,{rollback:true});assert.equal((await fx.member(users.target)).status,'accepted')
   await fx.remove(actor,users.pendingTarget,{rollback:true});assert.equal((await fx.member(users.pendingTarget)).status,'pending')
  }
  await fx.remove(users.deputy);assert.equal((await fx.member(users.target)).status,'removed')
  await fx.remove(users.deputy);assert.equal((await fx.member(users.target)).status,'removed')
 })
 await t.test('self, representative, other deputies and other-group targets retain their protection',async()=>{
  for(const actor of [users.head,users.deputy]){
   await denied(fx.remove(actor,actor));await denied(fx.remove(actor,users.head))
  }
  await denied(fx.remove(users.deputy,users.secondDeputy))
  await fx.remove(users.head,users.secondDeputy,{rollback:true})
  await denied(fx.remove(users.deputy,users.targetB,{g:groupB}))
  await denied(fx.remove(users.head,users.targetB,{g:groupB}))
  await fx.remove(users.headB,users.targetB,{g:groupB,rollback:true})
 })
 await t.test('revocation and removal take effect immediately, and rejoining never resurrects the appointment',async()=>{
  await fx.db.query("update study_group_deputy_requests set status='revoked',permissions='{}' where group_id=$1 and user_id=$2",[group,users.deputy])
  await denied(fx.remove(users.deputy,users.pendingMember))
  await fx.db.query("update study_group_deputy_requests set status='approved',permissions=array['remove_members'] where group_id=$1 and user_id=$2",[group,users.deputy])
  await fx.db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[group,users.deputy])
  await denied(fx.remove(users.deputy,users.pendingMember))
  await fx.db.query("update study_group_members set status='accepted' where group_id=$1 and user_id=$2",[group,users.deputy])
  assert.equal((await fx.permissions(users.deputy)).includes('remove_members'),false)
  await denied(fx.remove(users.deputy,users.pendingMember))
 })
 await t.test('browser cannot forge group ownership, membership, deputy appointment or table writes',async()=>{
  const before=await fx.data()
  for(const actor of [users.ordinary,users.teacher,users.admin,users.head]){
   await denied(fx.asUser(actor,"update public.study_group_members set status='removed' where group_id=$1 and user_id=$2",[group,users.pendingMember],{aal:'aal2'}))
   await denied(fx.asUser(actor,'delete from public.study_group_members where group_id=$1',[group],{aal:'aal2'}))
   await denied(fx.asUser(actor,"insert into public.study_group_members(group_id,user_id,status)values($1,$2,'accepted')",[group,users.outsider],{aal:'aal2'}))
   await denied(fx.asUser(actor,"update public.study_group_deputy_requests set status='approved',permissions=array['remove_members'] where user_id=$1",[actor],{aal:'aal2'}))
   await denied(fx.asUser(actor,'update public.study_groups set representative_id=$1 where id=$2',[actor,group],{aal:'aal2'}))
  }
  assert.deepEqual(await fx.data(),before)
 })
 await t.test('even a stale/forged permission provider cannot bypass the actual-appointment check inside removal',async()=>{
  const original=(await fx.one("select pg_get_functiondef('public.xelay_has_study_group_permission(uuid,text)'::regprocedure) definition")).definition
  await fx.db.exec('create or replace function public.xelay_has_study_group_permission(p_group_id uuid,p_permission text) returns boolean language sql volatile security definer set search_path=public,pg_temp as $$select true$$;')
  try{for(const actor of [users.ordinary,users.teacher,users.admin,users.revoked,users.pendingMember])await denied(fx.remove(actor,users.pendingMember,{aal:'aal2'}))}
  finally{await fx.db.exec(original)}
 })
})

test('member removal migration: unexpected source rolls back both body changes and preserves CRLF',{timeout:60_000},async t=>{
 const fx=await fixture({crlf:true});t.after(()=>fx.close())
 const initial=await fx.definitions(),metadata=await fx.metadata(),data=await fx.data()
 assert.ok(initial.every(row=>row.prosrc.includes('\r\n')))
 await fx.db.exec(initial[1].definition.replace('declare v_group_id uuid;', 'declare v_group_id uuid; -- synthetic source drift\r\n'))
 const drift=await fx.definitions()
 await assert.rejects(fx.apply(),/GROUP_MEMBER_REMOVAL_SOURCE_CHANGED/)
 // A failed explicit transaction remains aborted until ROLLBACK, as on Postgres.
 await fx.db.exec('rollback')
 assert.deepEqual(await fx.definitions(),drift);assert.deepEqual(await fx.metadata(),metadata);assert.deepEqual(await fx.data(),data)
 await fx.db.exec(initial[1].definition)
 await fx.apply();const after=await fx.definitions();assert.ok(after.every(row=>row.prosrc.includes('\r\n')))
 assert.deepEqual(await fx.metadata(),metadata);assert.deepEqual(await fx.data(),data)
 await fx.apply();assert.deepEqual(await fx.definitions(),after)
})
