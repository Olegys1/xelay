import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'

const sql=await readFile(new URL('../../supabase/migrations/202610310005_assistant_material_ai_consent.sql',import.meta.url),'utf8')
const id=n=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const OWNER=id(1),COLLEAGUE=id(2),STUDENT=id(3),FOREIGN=id(4),GROUP=id(10),MAT=id(20),TEACH=id(21)
test('exact dormant author-AI migration enforces source rights, binding, revocation and private ACLs',async t=>{
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table public.study_group_materials(id uuid primary key,group_id uuid,created_by uuid,title text,body text,attachments jsonb,links jsonb,updated_at timestamptz);
 create table public.teaching_items(id uuid primary key,kind text,created_by uuid,title text,body text,attachments jsonb,links jsonb,version integer,updated_at timestamptz,status text,withdrawn_at timestamptz,access_until timestamptz);
 create function public.xelay_can_read_study_group_materials(g uuid) returns boolean language sql stable as $$select auth.uid() in('${OWNER}','${COLLEAGUE}','${STUDENT}')$$;
 create function public.xelay_teaching_can_read_item(m uuid,u uuid) returns boolean language sql stable as $$select u in('${OWNER}','${COLLEAGUE}','${STUDENT}')$$;
 insert into auth.users(id,email_confirmed_at) values('${OWNER}',now()),('${COLLEAGUE}',now()),('${STUDENT}',now()),('${FOREIGN}',now());
 insert into public.study_group_materials values('${MAT}','${GROUP}','${OWNER}','Study title','PRIVATE_STUDY_BODY','[]','[]',now());
 insert into public.teaching_items values('${TEACH}','material','${OWNER}','Teacher title','PRIVATE_TEACHING_BODY','[]','[]',1,now(),'published',null,null);`)
 await db.exec(sql)
 const user=async(uid,query,args=[])=>{
  await db.exec('begin;set local role authenticated;');await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid])
  try{const result=await db.query(query,args);await db.exec('commit');return result.rows}catch(e){await db.exec('rollback');throw e}
 }
 const get=async(uid,kind='teaching',material=TEACH)=>(await user(uid,'select public.xelay_assistant_material_ai($1,$2) as value',[kind,material]))[0].value
 const set=async(uid,version,allow,kind='teaching',material=TEACH)=>(await user(uid,'select public.xelay_assistant_set_material_ai($1,$2,$3,$4) as value',[kind,material,allow,version]))[0].value
 await t.test('existing materials stay blocked and only authenticated guarded RPCs are granted',async()=>{
  for(const [kind,item] of [['study',MAT],['teaching',TEACH]])assert.equal((await get(STUDENT,kind,item)).allowAi,false)
  const acl=(await db.query(`select has_table_privilege('authenticated','public.assistant_material_ai_consents','select') as reader,
   has_table_privilege('service_role','public.assistant_material_ai_consents','insert') as serverwrite,
   has_function_privilege('anon','public.xelay_assistant_material_ai(text,uuid)','execute') as anon,
   has_function_privilege('authenticated','public.xelay_private_assistant_material_source(text,uuid,boolean)','execute') as helper`)).rows[0]
  assert.deepEqual(acl,{reader:false,serverwrite:false,anon:false,helper:false})
  assert.equal((await db.query('select count(*)::int as count from public.assistant_material_ai_consents')).rows[0].count,0)
 })
 await t.test('only actual author can grant; current viewers can inspect, foreign callers cannot',async()=>{
  const before=await get(OWNER);assert.equal(before.canChange,true)
  assert.equal((await get(COLLEAGUE)).canChange,false)
  await assert.rejects(set(COLLEAGUE,before.rightsVersion,true),/AUTHOR_REQUIRED/)
  await assert.rejects(get(FOREIGN),/FORBIDDEN/)
  const saved=await set(OWNER,before.rightsVersion,true);assert.equal(saved.allowAi,true);assert.notEqual(saved.rightsVersion,before.rightsVersion)
  assert.equal(saved.body,undefined);assert.equal(saved.attachments,undefined)
  assert.equal((await get(STUDENT)).allowAi,true)
 })
 await t.test('stale toggles fail; explicit revoke invalidates the prior version immediately',async()=>{
  const before=await get(OWNER),saved=await set(OWNER,before.rightsVersion,false)
  await assert.rejects(set(OWNER,before.rightsVersion,true),/MATERIAL_CHANGED/)
  assert.equal(saved.allowAi,false);assert.notEqual(saved.rightsVersion,before.rightsVersion)
  assert.equal((await get(STUDENT)).allowAi,false)
 })
 await t.test('content or attachment update invalidates old allowance without changing historical receipt',async()=>{
  const before=await get(OWNER);await set(OWNER,before.rightsVersion,true)
  await db.exec(`update public.teaching_items set body='Updated author body',version=2 where id='${TEACH}'`)
  const after=await get(STUDENT);assert.equal(after.allowAi,false)
  assert.equal((await db.query(`select allowed from public.assistant_material_ai_consents where material_id='${TEACH}'`)).rows[0].allowed,true)
  await assert.rejects(set(OWNER,before.rightsVersion,true),/MATERIAL_CHANGED/)
 })
 await t.test('another author borrowed file descriptor cannot be opted into AI by copying a material',async()=>{
  await db.query('update public.teaching_items set attachments=$1 where id=$2',[JSON.stringify([{storage_path:`${GROUP}/${FOREIGN}/${id(90)}.pdf`,name:'private.pdf',size:10,mime_type:'application/pdf'}]),TEACH])
  await assert.rejects(set(OWNER,(await get(OWNER)).rightsVersion,true),/OWNED_FILES_REQUIRED/)
  assert.equal((await get(STUDENT)).allowAi,false)
 })
 await t.test('batch output contains permissions only, never raw body or paths; source withdrawal fails closed',async()=>{
  const batch=(await user(STUDENT,'select public.xelay_assistant_material_ai_batch($1,$2) as value',['teaching',[TEACH]]))[0].value
  assert.equal(batch.length,1);assert.equal(JSON.stringify(batch).includes('PRIVATE_'),false);assert.equal(batch[0].body,undefined);assert.equal(batch[0].attachments,undefined)
  await db.exec(`update public.teaching_items set withdrawn_at=now() where id='${TEACH}'`)
  await assert.rejects(get(STUDENT),/FORBIDDEN/)
 })
})
