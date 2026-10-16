// Synthetic entitlement fixture in local PostgreSQL only. No provider calls.
import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import vm from 'node:vm'
import ts from 'typescript'

const baseSql=await readFile(new URL('../../supabase/migrations/202610140005_participant_cheburashka_status.sql',import.meta.url),'utf8')
const sql=await readFile(new URL('../../supabase/migrations/202610160004_participant_animal_statuses.sql',import.meta.url),'utf8')
const latestSql=await readFile(new URL('../../supabase/migrations/202610160006_participant_penguin_status.sql',import.meta.url),'utf8')
const catalogSource=await readFile(new URL('../../src/lib/participantStatus.ts',import.meta.url),'utf8')
const catalogModule={exports:{}}
vm.runInNewContext(ts.transpileModule(catalogSource,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,
  {exports:catalogModule.exports,module:catalogModule})
const catalog=catalogModule.exports
const db=new PGlite()
const paid='00000000-0000-4000-8000-000000000001',free='00000000-0000-4000-8000-000000000002'
const tokens=['sticker:leopard','sticker:frog']
const allowlist=source=>[...source.match(/v_allowed text\[\] := array\[([^;]+)\];/)[1].matchAll(/'([^']+)'/g)].map(match=>match[1])
const first=result=>result.rows[0]
let initialFunctionContract
async function asUser(userId,statement,params=[],role='authenticated') {
  assert.ok(['authenticated','anon','service_role'].includes(role))
  await db.exec(`set role ${role}`)
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[userId||''])
  try{return await db.query(statement,params)}
  finally{await db.exec('reset role');await db.exec('reset "request.jwt.claim.sub"')}
}
const save=(userId,emoji,text='На своєму вайбі')=>asUser(userId,'select xelay_set_participant_status($1,$2)',[text,emoji])
const stored=async()=>first(await db.query('select status_text,emoji_status from premium_preferences where user_id=$1',[paid]))
const functionContract=async()=>first(await db.query(`select proowner::text as owner,proacl::text as acl,
  prosecdef as security_definer,proconfig from pg_proc where oid='public.xelay_set_participant_status(text,text)'::regprocedure`))

before(async()=>{
  await db.exec(`
    create role anon;create role authenticated;create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to authenticated,anon,service_role;
    grant execute on function auth.uid() to authenticated;
    create table public.premium_preferences(user_id uuid primary key,status_text text,emoji_status text,updated_at timestamptz default now());
    alter table public.premium_preferences enable row level security;
    create function public.xelay_has_participant_access(uuid) returns boolean language sql stable as $$ select $1='${paid}'::uuid $$;
    create function public.xelay_set_participant_status(text,text) returns void language sql as $$ select $$;
    revoke all on function public.xelay_set_participant_status(text,text) from public,anon,service_role;
    grant execute on function public.xelay_set_participant_status(text,text) to authenticated;
  `)
  await db.exec(baseSql)
  initialFunctionContract=await functionContract()
  await db.exec(sql)
  await db.exec(latestSql)
})
after(()=>db.close())

test('migration expands only the existing allowlist with two exact unique tokens',()=>{
  const old=allowlist(baseSql),current=allowlist(sql)
  assert.deepEqual(current,[...old,...tokens])
  assert.equal(new Set(current).size,current.length)
  assert.equal(sql.slice(sql.indexOf('create or replace function')),
    baseSql.slice(baseSql.indexOf('create or replace function')).replace("'sticker:cheburashka'];","'sticker:cheburashka','sticker:leopard','sticker:frog'];"))
  assert.doesNotMatch(sql,/\bgrant\b|\brevoke\b|alter table|create table|update public\.(?:profiles|participant_subscriptions)/i)
})

test('current picker catalog exactly matches the effective database setter allowlist',async()=>{
  const body=first(await db.query("select prosrc as body from pg_proc where oid='public.xelay_set_participant_status(text,text)'::regprocedure")).body
  assert.deepEqual(new Set(allowlist(body)),new Set(catalog.PARTICIPANT_STATUS_EMOJIS))
  assert.equal(catalog.PARTICIPANT_LEOPARD_STATUS,'sticker:leopard')
  assert.equal(catalog.PARTICIPANT_FROG_STATUS,'sticker:frog')
  assert.equal(catalog.participantStatusEmojiLabel(tokens[0]),'Леопард')
  assert.equal(catalog.participantStatusEmojiLabel(tokens[1]),'Жабка з сердечками')
  assert.equal(catalog.PARTICIPANT_STATUS_MAX_EMOJIS,3)
  assert.equal(catalog.PARTICIPANT_STATUS_MAX_LENGTH,48)
})

test('paid accounts save either sticker alone, together, or with a third legacy status',async()=>{
  for(const value of [tokens[0],tokens[1],tokens.join(' '),`${tokens.join(' ')} sticker:cheburashka`,`${tokens.join(' ')} 🦛`]) {
    await save(paid,value)
    assert.deepEqual(await stored(),{status_text:'На своєму вайбі',emoji_status:value})
  }
})

test('free, anonymous and otherwise unentitled accounts cannot save either new token or clear a premium status',async()=>{
  const before=await stored()
  for(const value of [...tokens,null])for(const user of [free,null])await assert.rejects(save(user,value),/PARTICIPANT_REQUIRED/)
  for(const role of ['anon','service_role'])await assert.rejects(asUser(paid,'select xelay_set_participant_status(null,$1)',[tokens[0]],role),/permission denied/)
  assert.deepEqual(await stored(),before)
  assert.equal(first(await db.query('select count(*)::int as n from premium_preferences')).n,1)
})

test('three unique exact tokens remain the limit and malformed or unknown inputs leave the saved draft intact',async()=>{
  const before=await stored()
  for(const value of [
    'sticker:leopard sticker:frog sticker:cheburashka 🦛','sticker:leopard sticker:leopard',
    'sticker:frog sticker:frog','sticker:leopard  sticker:frog','sticker:Leopard','sticker:frog-heart',
    'sticker:unknown','https://example.test/frog.png','sticker:frog\nsticker:leopard',
  ]) {
    await assert.rejects(save(paid,value),/INVALID_PARTICIPANT_STATUS_EMOJI/)
    assert.deepEqual(await stored(),before)
  }
  await assert.rejects(save(paid,tokens[0],'x'.repeat(49)),/INVALID_PARTICIPANT_STATUS_TEXT/)
  await assert.rejects(save(paid,tokens[1],'bad\u202Etext'),/INVALID_PARTICIPANT_STATUS_TEXT/)
  assert.deepEqual(await stored(),before)
})

test('all old native/sticker statuses remain valid, text trimming and clearing retain their existing semantics',async()=>{
  for(const value of allowlist(baseSql)) {
    await save(paid,value)
    assert.equal((await stored()).emoji_status,value)
  }
  await save(paid,'sticker:frog','\u00a0 Працюю \u00a0')
  assert.equal((await stored()).status_text,'Працюю')
  await save(paid,null,null)
  assert.deepEqual(await stored(),{status_text:null,emoji_status:null})
  await save(paid,'   ','   ')
  assert.deepEqual(await stored(),{status_text:null,emoji_status:null})
})

test('rerunning migrations preserves saved preferences, effective allowlist, ownership, execution ACLs and absence of direct write access',async()=>{
  await save(paid,'sticker:leopard sticker:frog')
  const before=(await db.query('select to_jsonb(p) as value from premium_preferences p')).rows
  await db.exec(sql)
  await db.exec(latestSql)
  assert.deepEqual((await db.query('select to_jsonb(p) as value from premium_preferences p')).rows,before)
  const body=first(await db.query("select prosrc as body from pg_proc where oid='public.xelay_set_participant_status(text,text)'::regprocedure")).body
  assert.deepEqual(new Set(allowlist(body)),new Set(catalog.PARTICIPANT_STATUS_EMOJIS))
  assert.deepEqual(await functionContract(),initialFunctionContract)
  for(const role of ['anon','authenticated','service_role']) {
    const permissions=first(await db.query(`select has_function_privilege($1,'public.xelay_set_participant_status(text,text)','execute') as execute,
      has_table_privilege($1,'public.premium_preferences','insert,update,delete') as direct_write`,[role]))
    assert.deepEqual(permissions,{execute:role==='authenticated',direct_write:false})
  }
})
