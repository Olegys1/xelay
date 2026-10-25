// Real PostgreSQL functions run in isolated PGlite with synthetic accounts only.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const original = await readFile(new URL('../../supabase/migrations/202610200001_seminar_ai_draft.sql', import.meta.url), 'utf8')
const migration = await readFile(new URL('../../supabase/migrations/202610250001_homework_ai_draft.sql', import.meta.url), 'utf8')
const uuid = number => `00000000-0000-4000-9000-${String(number).padStart(12,'0')}`
const db = new PGlite()
after(async()=>db.close())
await db.exec(`
 create role anon; create role authenticated; create role service_role;
 create schema auth;
 create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;
 grant usage on schema auth to anon,authenticated,service_role;
 grant execute on function auth.role() to anon,authenticated,service_role;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
 create table public.profiles(id uuid primary key,is_admin boolean default false,teacher boolean default false);
 create table public.study_groups(id uuid primary key,representative_id uuid not null);
 create table public.study_group_members(group_id uuid,user_id uuid,status text);
 create table public.study_group_deputy_requests(group_id uuid,user_id uuid,status text,permissions text[]);
 create function public.xelay_group_write_access(uuid) returns boolean language sql stable as $$ select coalesce(nullif(current_setting('test.group_access',true),''),'true')::boolean $$;
 create function public.xelay_study_group_permissions(uuid) returns text[] language sql stable as $$ select '{}'::text[] $$;
`)
const insertUser = async (number,options={}) => {
 const id = uuid(number)
 await db.query("insert into auth.users values($1,$2,$3,$4) on conflict(id) do nothing",[id,options.unconfirmed?null:'2026-10-01T12:00:00Z',options.deleted?'2026-10-01T12:00:00Z':null,options.banned?'2099-01-01T00:00:00Z':null])
 await db.query('insert into profiles values($1,$2,$3) on conflict(id) do nothing',[id,Boolean(options.admin),Boolean(options.teacher)])
 return id
}
for(let i=1;i<=9;i++) await insertUser(i,{unconfirmed:i===5,banned:i===6,deleted:i===7,admin:i===4,teacher:i===4})
const GROUP = uuid(20), OTHER = uuid(21)
await db.query('insert into study_groups values($1,$2),($3,$4)',[GROUP,uuid(1),OTHER,uuid(9)])
for(const [number,memberStatus,deputyStatus,permissions] of [[2,'accepted','approved',['homework']],[3,'accepted','approved',['seminars']],[5,'accepted','approved',['homework']],[6,'accepted','approved',['homework']],[7,'accepted','approved',['homework']],[8,'pending','approved',['homework']]]) {
 await db.query('insert into study_group_members values($1,$2,$3)',[GROUP,uuid(number),memberStatus])
 await db.query('insert into study_group_deputy_requests values($1,$2,$3,$4)',[GROUP,uuid(number),deputyStatus,permissions])
}
await db.exec(original)
const permissionsSnapshot = async () => ({
 table:(await db.query("select relacl::text as acl,relrowsecurity from pg_class where oid='public.seminar_ai_draft_usage'::regclass")).rows,
 functions:(await db.query("select proname,proacl::text as acl from pg_proc where proname in('xelay_seminar_ai_draft_allowed','xelay_reserve_seminar_ai_draft') order by proname")).rows,
})
const oldPermissions = await permissionsSnapshot()
await db.exec(migration)
const as = async (role,sql,params=[]) => {
 if(!['postgres','anon','authenticated','service_role'].includes(role))throw Error('Unexpected role')
 await db.exec('reset role')
 await db.query("select set_config('request.jwt.claim.role',$1,false)",[role])
 await db.exec(`set role ${role}`)
 return (await db.query(sql,params)).rows
}
const allowed = async(user,group=GROUP) => (await as('service_role','select public.xelay_homework_ai_draft_allowed($1,$2) as result',[user,group]))[0].result
const reserve = async(user,group=GROUP,kind='homework') => (await as('service_role',`select public.xelay_reserve_${kind}_ai_draft($1,$2) as result`,[user,group]))[0].result
const resetCounters = async()=>{await as('postgres','truncate public.seminar_ai_draft_usage');await db.query("select set_config('test.group_access','true',false)")}
const globalAttempts = async()=>Number((await as('postgres',"select coalesce(sum(attempts),0) as amount from seminar_ai_draft_usage where scope='global'"))[0].amount)

test('new service-only helpers preserve existing seminar/table ACLs and never give clients access to counters',async()=>{
 await as('postgres','select 1')
 assert.deepEqual(await permissionsSnapshot(),oldPermissions)
 const grants=(await db.query("select has_function_privilege('service_role','public.xelay_homework_ai_draft_allowed(uuid,uuid)','EXECUTE') as service,has_function_privilege('authenticated','public.xelay_homework_ai_draft_allowed(uuid,uuid)','EXECUTE') as client,has_function_privilege('anon','public.xelay_reserve_homework_ai_draft(uuid,uuid)','EXECUTE') as anon")).rows[0]
 assert.equal(grants.service,true);assert.equal(grants.client,false);assert.equal(grants.anon,false)
 await assert.rejects(as('authenticated','select public.xelay_homework_ai_draft_allowed($1,$2)',[uuid(1),GROUP]),/permission denied/)
 await assert.rejects(as('service_role','select * from public.seminar_ai_draft_usage'),/permission denied/)
 assert.equal(await allowed(uuid(1)),true)
})

test('only actual representative or accepted approved homework deputy with an active confirmed account can draft',async()=>{
 assert.equal(await allowed(uuid(1)),true)
 assert.equal(await allowed(uuid(2)),true)
 for(const number of [3,4,5,6,7,8,9])assert.equal(await allowed(uuid(number)),false,`user ${number}`)
 assert.equal(await allowed(uuid(2),OTHER),false)
 assert.equal(await allowed(null),false)
 await as('postgres',"select set_config('test.group_access','false',false)")
 assert.equal(await allowed(uuid(1)),false)
 await as('postgres',"select set_config('test.group_access','true',false)")
 await resetCounters()
 await assert.rejects(reserve(uuid(4)),/HOMEWORK_AI_PERMISSION_REQUIRED/)
 await assert.rejects(reserve(uuid(5)),/HOMEWORK_AI_AUTH_REQUIRED/)
 assert.equal(await globalAttempts(),0)
})

test('homework and seminar requests share the same three-attempt actor budget and denied calls do not partially increment',async()=>{
 await resetCounters()
 assert.equal(await reserve(uuid(1),GROUP,'seminar'),true)
 assert.equal(await reserve(uuid(1)),true)
 assert.equal(await reserve(uuid(1)),true)
 assert.equal(await globalAttempts(),3)
 await assert.rejects(reserve(uuid(1)),/HOMEWORK_AI_ACTOR_LIMIT/)
 await assert.rejects(reserve(uuid(1),GROUP,'seminar'),/SEMINAR_AI_ACTOR_LIMIT/)
 assert.equal(await globalAttempts(),3)
 // A homework-only deputy really succeeds without a seminars permission.
 await resetCounters()
 assert.equal(await reserve(uuid(2)),true)
 await assert.rejects(reserve(uuid(2),GROUP,'seminar'),/SEMINAR_AI_PERMISSION_REQUIRED/)
 assert.equal(await globalAttempts(),1)
})

test('the ten-attempt group budget is shared across distinct approved homework editors',async()=>{
 await resetCounters()
 for(let i=100;i<104;i++){
  await as('postgres','select 1');await insertUser(i)
  await db.query("insert into study_group_members values($1,$2,'accepted')",[GROUP,uuid(i)])
  await db.query("insert into study_group_deputy_requests values($1,$2,'approved',array['homework'])",[GROUP,uuid(i)])
 }
 for(let attempt=0;attempt<10;attempt++)assert.equal(await reserve(uuid(100+Math.floor(attempt/3))),true)
 await assert.rejects(reserve(uuid(103)),/HOMEWORK_AI_GROUP_LIMIT/)
 assert.equal(await globalAttempts(),10)
})

test('the existing global budget remains one hundred combined attempts, not a second pool for homework',async()=>{
 await resetCounters()
 for(let i=0;i<34;i++){
  await as('postgres','select 1');await insertUser(600+i)
  await db.query('insert into study_groups values($1,$2)',[uuid(500+i),uuid(600+i)])
 }
 for(let attempt=0;attempt<100;attempt++){
  const user=uuid(600+Math.floor(attempt/3)),group=uuid(500+Math.floor(attempt/3))
  assert.equal(await reserve(user,group,attempt%2?'seminar':'homework'),true)
 }
 await assert.rejects(reserve(uuid(633),uuid(533)),/HOMEWORK_AI_GLOBAL_LIMIT/)
 assert.equal(await globalAttempts(),100)
 await as('postgres','select 1')
 const zero=(await db.query("select count(*)::int as n from seminar_ai_draft_usage where attempts=0")).rows[0].n
 assert.equal(zero,0)
})

test('reapplying migration preserves counters and old grants, and both reservations use identical global locking',async()=>{
 const before=await globalAttempts()
 await as('postgres','select 1');await db.exec(migration)
 assert.equal(await globalAttempts(),before)
 await as('postgres','select 1');assert.deepEqual(await permissionsSnapshot(),oldPermissions)
 const lock="hashtextextended('xelay:seminar-ai-draft:quota',0)"
 assert.ok(original.includes(lock));assert.ok(migration.includes(lock))
 assert.match(migration,/at time zone 'Europe\/Kyiv'/)
 assert.doesNotMatch(migration,/create table|grant (?:select|insert|update|delete)/i)
})
