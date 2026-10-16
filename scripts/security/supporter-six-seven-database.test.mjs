import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {PGlite} from '@electric-sql/pglite'
const read=path=>readFile(new URL('../../'+path,import.meta.url),'utf8')

test('secret 67 badge follows only confirmed live individual payments and preserves existing payment security',async t=>{
  const db=new PGlite();t.after(()=>db.close())
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;create table profiles(id uuid primary key);`)
  await db.exec(await read('supabase/migrations/202610060001_team_support.sql'))
  await db.exec(await read('supabase/migrations/202610160011_supporter_tiers.sql'))
  async function asRole(role,sql,args=[],uid=''){
    await db.exec('begin');try{await db.exec('set local role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid]);const result=await db.query(sql,args);await db.exec('commit');return result.rows[0]}catch(error){await db.exec('rollback');throw error}
  }
  const service=(sql,args=[])=>asRole('service_role',sql,args)
  const badge=(id,role='anon')=>asRole(role,'select xelay_supporter_badges($1) as value',[id]).then(row=>row.value)
  const summary=id=>service('select xelay_supporter_summary($1) as value',[id]).then(row=>row.value)
  const ids=Object.fromEntries(['old','split','near','states','large','other'].map(name=>[name,randomUUID()]))
  for(const id of Object.values(ids))await db.query('insert into profiles values($1)',[id])
  async function event(ref,status,amount,mode='live',fingerprint=randomUUID()){
    return service('select xelay_apply_support_event($1,$2,$3,$4,$5,$6) as value',[ref,mode,createHash('sha256').update(fingerprint).digest('hex'),status,amount/100,'UAH'])
  }
  async function order(id,amount,mode='live',status='Approved'){
    const ref='xelay_support_'+randomUUID()
    await service('select xelay_create_support_order($1,$2,$3,$4,$5)',[id,mode,ref,amount,'synthetic-'+randomUUID()])
    if(status)await event(ref,status,amount,mode)
    return ref
  }
  const old=await order(ids.old,6700)
  const snapshot=async()=>({
    orders:(await db.query('select * from support_orders order by id')).rows,
    events:(await db.query('select * from support_payment_events order by id')).rows,
    tables:(await db.query("select relname,relacl::text,relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by relname")).rows,
    policies:(await db.query('select polname,pg_get_expr(polqual,polrelid) as using_expression,pg_get_expr(polwithcheck,polrelid) as check_expression from pg_policy order by polname')).rows,
    functions:(await db.query("select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,p.proacl::text from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' order by signature")).rows,
  })
  const before=await snapshot();await db.exec(await read('supabase/migrations/202610160012_supporter_six_seven.sql'));const after=await snapshot()
  await t.test('migration preserves all payment rows, events, policies, table grants and provider functions',async()=>{
    for(const key of ['orders','events','tables','policies'])assert.deepEqual(after[key],before[key])
    assert.equal(after.functions.length,before.functions.length+1)
    for(const row of before.functions)if(row.signature!=='xelay_supporter_summary(uuid)')assert.deepEqual(after.functions.find(next=>next.signature===row.signature),row)
    for(const fn of ['xelay_supporter_badges(uuid)','xelay_supporter_summary(uuid)']){
      const row=(await db.query('select prosecdef,provolatile,proconfig from pg_proc where oid=$1::regprocedure',['public.'+fn])).rows[0]
      assert.equal(row.prosecdef,true);assert.equal(row.provolatile,'s');assert.ok(row.proconfig.includes('search_path=""'))
    }
  })
  await t.test('past exact-67 contributions qualify immediately alongside the normal cumulative tier',async()=>{
    assert.deepEqual(await badge(ids.old),{tier:1,sixSeven:true})
    assert.deepEqual(await summary(ids.old),{tier:1,totalKopiykas:6700,sixSeven:true})
    await order(ids.old,25000);assert.deepEqual(await badge(ids.old),{tier:3,sixSeven:true})
    assert.deepEqual(await summary(ids.old),{tier:3,totalKopiykas:31700,sixSeven:true})
  })
  await t.test('splitting 67, neighboring kopecks and multiples do not qualify',async()=>{
    await order(ids.split,3300);await order(ids.split,3400)
    assert.deepEqual(await badge(ids.split),{tier:1,sixSeven:false})
    for(const amount of [6699,6701,13400])await order(ids.near,amount)
    assert.equal((await badge(ids.near)).sixSeven,false)
  })
  await t.test('test, pending, declined, expired and voided 67 orders cannot award the secret',async()=>{
    await order(ids.states,6700,'test')
    for(const status of [null,'Declined','Expired','Voided'])await order(ids.states,6700,'live',status)
    assert.deepEqual(await badge(ids.states),{tier:0,sixSeven:false})
  })
  await t.test('refund removes the secret only after the final qualifying order; duplicates and late approval cannot mint it',async()=>{
    const second=await order(ids.old,6700)
    await event(old,'Refunded',6700);assert.equal((await badge(ids.old)).sixSeven,true)
    await event(second,'Refunded',6700);assert.deepEqual(await badge(ids.old),{tier:3,sixSeven:false})
    await event(second,'Approved',6700);assert.equal((await badge(ids.old)).sixSeven,false)
    const ref=await order(ids.states,6700)
    await event(ref,'Approved',6700,'live','duplicate');await event(ref,'Approved',6700,'live','duplicate')
    assert.deepEqual(await summary(ids.states),{tier:1,totalKopiykas:6700,sixSeven:true})
    await event(ref,'Voided',6700);assert.deepEqual(await badge(ids.states),{tier:0,sixSeven:false})
  })
  await t.test('badges use the full payment history while the public response never contains totals or references',async()=>{
    await order(ids.large,6700)
    await db.query("insert into support_orders(user_id,order_reference,amount_kopiykas,mode,status,terms_version) select $1,'xelay_support_'||gen_random_uuid(),5000,'live','approved','synthetic' from generate_series(1,25)",[ids.large])
    assert.deepEqual(await badge(ids.large),{tier:5,sixSeven:true});assert.equal((await summary(ids.large)).totalKopiykas,131700)
    for(const role of ['anon','authenticated','service_role'])assert.deepEqual(await badge(ids.large,role),{tier:5,sixSeven:true})
    assert.deepEqual(await badge(null),{tier:0,sixSeven:false});assert.deepEqual(await badge(ids.other),{tier:0,sixSeven:false})
  })
  await t.test('ordinary clients cannot read totals, mint support, edit payment rows or invoke provider events',async()=>{
    const denied=promise=>assert.rejects(promise,error=>error.code==='42501')
    for(const role of ['anon','authenticated'])await denied(asRole(role,'select xelay_supporter_summary($1)',[ids.old],ids.old))
    await denied(asRole('anon','select * from support_orders'))
    await denied(asRole('authenticated','update support_orders set amount_kopiykas=6700 where user_id=$1',[ids.other],ids.other))
    await denied(asRole('authenticated','select xelay_create_support_order($1,$2,$3,$4,$5)',[ids.other,'live','xelay_support_'+randomUUID(),6700,'fake'],ids.other))
    await denied(asRole('authenticated','select xelay_apply_support_event($1,$2,$3,$4,$5,$6)',[old,'live','fake','Approved',67,'UAH'],ids.other))
    assert.equal((await badge(ids.other)).sixSeven,false)
  })
})
