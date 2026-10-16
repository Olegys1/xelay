// Actual current PostgreSQL migration chain, synthetic users and local data only.
// No Supabase, camera, mail, billing-provider or other network calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import {createFixture} from './fixture.mjs'

const root=new URL('../../',import.meta.url)
const migration=await readFile(new URL('supabase/migrations/202610160006_participant_penguin_status.sql',root),'utf8')
const audit=await readFile(new URL('supabase/audits/202610160006_participant_penguin_status.sql',root),'utf8')
const catalogSource=await readFile(new URL('src/lib/participantStatus.ts',root),'utf8')
const catalogModule={exports:{}}
vm.runInNewContext(ts.transpileModule(catalogSource,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,
  {exports:catalogModule.exports,module:catalogModule})
const catalog=catalogModule.exports
const token='sticker:penguin'
const oldAnchor="'sticker:cheburashka','sticker:leopard','sticker:frog'];"
const newAnchor="'sticker:cheburashka','sticker:leopard','sticker:frog','sticker:penguin'];"
const first=result=>result.rows[0]
const allowlist=source=>[...source.match(/v_allowed text\[\] := array\[([^;]+)\];/)[1].matchAll(/'([^']+)'/g)].map(match=>match[1])
const contractSql=`select pg_get_userbyid(proowner) as owner,proacl::text as acl,prosecdef,proconfig,
  prorettype::regtype::text as result,pg_get_function_identity_arguments(oid) as arguments
  from pg_proc where oid='public.xelay_set_participant_status(text,text)'::regprocedure`

test('static penguin is accepted only by the existing guarded premium setter',async t=>{
  const fx=await createFixture({useStagingParity:true,through:'202610160005',beforeMigrationsSql:`
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  `})
  t.after(()=>fx.close())
  const {db,asUser,seedUser}=fx
  const paid=randomUUID(),free=randomUUID(),expired=randomUUID(),revoked=randomUUID(),otherPaid=randomUUID()
  for(const id of [paid,free,expired,revoked,otherPaid])await seedUser(id,{username:'peng_'+id.replaceAll('-','').slice(0,16),categories:['General']})
  for(const id of [paid,otherPaid])await db.query(`insert into participant_entitlements(user_id,source,valid_from,valid_until)
    values($1,'admin_grant',now()-interval '1 day',now()+interval '1 day')`,[id])
  await db.query(`insert into participant_entitlements(user_id,source,valid_from,valid_until)
    values($1,'admin_grant',now()-interval '2 days',now()-interval '1 day')`,[expired])
  await db.query(`insert into participant_entitlements(user_id,source,valid_from,valid_until,revoked_at)
    values($1,'admin_grant',now()-interval '1 day',now()+interval '1 day',now())`,[revoked])
  const save=(user,emoji,text='На своєму вайбі')=>asUser(user,'select xelay_set_participant_status($1,$2)',[text,emoji])
  const stored=async(user=paid)=>first(await db.query('select status_text,emoji_status from premium_preferences where user_id=$1',[user]))
  const snapshots=async()=>Object.fromEntries(await Promise.all(['profiles','participant_entitlements','premium_preferences'].map(async table=>
    [table,(await db.query(`select to_jsonb(t) as value from ${table} t order by ${table==='premium_preferences'?'user_id':'id'}`)).rows])))
  const privilegeSnapshot=async()=>(await db.query(`select r.rolname,
    has_function_privilege(r.oid,'public.xelay_set_participant_status(text,text)','execute') as execute,
    has_table_privilege(r.oid,'public.premium_preferences','insert,update,delete') as direct_write
    from pg_roles r where rolname in('anon','authenticated','service_role') order by rolname`)).rows
  const body=async()=>first(await db.query("select prosrc as body from pg_proc where oid='public.xelay_set_participant_status(text,text)'::regprocedure")).body
  await save(paid,'sticker:frog','Existing saved status')
  await save(otherPaid,'🦛','Other account unchanged')
  // A saved preference can outlive entitlement; adding a token must not unlock it.
  await db.query("insert into premium_preferences(user_id,status_text,emoji_status) values($1,'Legacy retained','😊')",[free])
  const initial=await snapshots(),oldBody=await body(),oldContract=first(await db.query(contractSql)),oldPrivileges=await privilegeSnapshot()
  const auditBefore=await db.exec(audit)
  await db.exec(migration)

  await t.test('migration appends exactly one token and keeps ownership, ACLs, grants and existing data',async()=>{
    assert.equal(await body(),oldBody.replace(oldAnchor,newAnchor))
    assert.deepEqual(allowlist(await body()),[...allowlist(oldBody),token])
    assert.deepEqual(first(await db.query(contractSql)),oldContract)
    assert.deepEqual(await privilegeSnapshot(),oldPrivileges)
    assert.deepEqual(await snapshots(),initial)
    assert.doesNotMatch(migration,/\b(?:grant|revoke)\b|\b(?:insert\s+into|update|delete\s+from)\s+public\./i)
    const auditAfter=await db.exec(audit)
    const auditValue=results=>{
      const value=results.find(result=>result.rows?.[0]?.audit!==undefined)?.rows[0].audit
      assert.ok(value&&Array.isArray(value.relations)&&value.setter,'Expected the production audit JSON envelope')
      assert.equal(value.relations.length,3)
      for(const row of value.relations){assert.equal(typeof row.row_count,'number');assert.match(row.aggregate_row_hash,/^[0-9a-f]{32}$/)}
      return value
    }
    const aggregates=results=>auditValue(results).relations
    const setter=results=>auditValue(results).setter
    assert.deepEqual(aggregates(auditAfter),aggregates(auditBefore))
    assert.equal(setter(auditBefore).allows_penguin,false);assert.equal(setter(auditAfter).allows_penguin,true)
    const {implementation_hash:oldHash,allows_penguin:oldPenguin,...beforeContract}=setter(auditBefore)
    const {implementation_hash:newHash,allows_penguin:newPenguin,...afterContract}=setter(auditAfter)
    assert.notEqual(oldHash,newHash);assert.deepEqual(afterContract,beforeContract)
    for(const guard of ['authentication_guard','premium_guard','text_limit_48','emoji_limit_3','unique_emoji_guard'])assert.equal(setter(auditAfter)[guard],true)
  })

  await t.test('current picker exactly matches the effective allowlist and exposes the Ukrainian penguin label',async()=>{
    const allowed=allowlist(await body())
    assert.equal(new Set(allowed).size,allowed.length)
    assert.deepEqual(new Set(allowed),new Set(catalog.PARTICIPANT_STATUS_EMOJIS))
    assert.equal(catalog.PARTICIPANT_PENGUIN_STATUS,token)
    assert.equal(catalog.participantStatusEmojiLabel(token),'Пінгвін')
    assert.equal(catalog.PARTICIPANT_STATUS_MAX_EMOJIS,3);assert.equal(catalog.PARTICIPANT_STATUS_MAX_LENGTH,48)
  })

  await t.test('active participants save the penguin alone or with two legacy statuses and cannot touch another account',async()=>{
    const other=await stored(otherPaid)
    for(const value of [token,`${token} 🦛`,`${token} sticker:leopard sticker:frog`,`${token} 😊 ❤️`]){
      await save(paid,value)
      assert.deepEqual(await stored(),{status_text:'На своєму вайбі',emoji_status:value})
    }
    assert.deepEqual(await stored(otherPaid),other)
    assert.equal((await db.query('select count(*)::int as n from premium_preferences')).rows[0].n,3)
  })

  await t.test('anonymous, free, expired and revoked accounts cannot save or clear a status',async()=>{
    const before=await snapshots()
    for(const user of [null,free,expired,revoked])for(const value of [token,null]){
      await assert.rejects(save(user,value),error=>error.code==='42501'&&/PARTICIPANT_REQUIRED/.test(error.message))
    }
    await assert.rejects(asUser(null,'select xelay_set_participant_status(null,$1)',[token],{role:'anon'}),/permission denied/)
    assert.deepEqual(await snapshots(),before)
    const authPrivilege=oldPrivileges.find(row=>row.rolname==='authenticated')
    assert.equal(authPrivilege.execute,true);assert.equal(authPrivilege.direct_write,false)
  })

  await t.test('three unique tokens and 48-character text remain enforced atomically',async()=>{
    const before=await stored()
    for(const invalid of [`${token} ${token}`,`${token} sticker:leopard sticker:frog 🦛`,`${token}  😊`,
      'sticker:Penguin','sticker:penguin-heart','sticker:unknown','https://example.test/penguin.png',`${token}\n😊`]){
      await assert.rejects(save(paid,invalid),error=>error.code==='22023'&&/INVALID_PARTICIPANT_STATUS_EMOJI/.test(error.message))
      assert.deepEqual(await stored(),before)
    }
    for(const text of ['x'.repeat(49),'bad\ntext','bad\u202Etext','bad\u0085text']){
      await assert.rejects(save(paid,token,text),error=>error.code==='22023'&&/INVALID_PARTICIPANT_STATUS_TEXT/.test(error.message))
      assert.deepEqual(await stored(),before)
    }
    await save(paid,token,'я'.repeat(48));assert.equal((await stored()).status_text,'я'.repeat(48))
  })

  await t.test('all legacy statuses, whitespace trimming and clearing keep their existing behavior',async()=>{
    for(const value of allowlist(oldBody)){
      await save(paid,value);assert.equal((await stored()).emoji_status,value)
    }
    await save(paid,token,'\u00a0 Працюю \u00a0');assert.equal((await stored()).status_text,'Працюю')
    await save(paid,null,null);assert.deepEqual(await stored(),{status_text:null,emoji_status:null})
    await save(paid,'   ','   ');assert.deepEqual(await stored(),{status_text:null,emoji_status:null})
  })

  await t.test('rerunning the migration does not alter preferences, entitlements, profiles or the setter contract',async()=>{
    await save(paid,token)
    const before=await snapshots(),definition=await body(),contract=first(await db.query(contractSql))
    await db.exec(migration)
    assert.deepEqual(await snapshots(),before);assert.equal(await body(),definition)
    assert.deepEqual(first(await db.query(contractSql)),contract);assert.deepEqual(await privilegeSnapshot(),oldPrivileges)
  })

  await t.test('unexpected allowlist anchors or missing premium guards fail closed without changing data or privileges',async()=>{
    const definition=first(await db.query("select pg_get_functiondef('public.xelay_set_participant_status(text,text)'::regprocedure) as value")).value
    const before=await snapshots()
    for(const modified of [definition.replace("'sticker:frog'","'sticker:fixture-unexpected'"),
      definition.replace('not public.xelay_has_participant_access(v_user_id)','false')]){
      await db.exec(modified)
      await assert.rejects(db.exec(migration),/PARTICIPANT_STATUS_ALLOWLIST_CONTRACT_MISMATCH/)
      await db.exec('rollback')
      assert.deepEqual(await snapshots(),before);assert.deepEqual(await privilegeSnapshot(),oldPrivileges)
      await db.exec(definition)
    }
    assert.deepEqual(first(await db.query(contractSql)),oldContract)
  })
})
