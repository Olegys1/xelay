// Exact prepared SQL, synthetic accounts, one queued PGlite connection. This
// exercises accounting/ACL statements, not independent-backend load capacity.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createSupabaseModelBudgetLedger, createAssistantModelBudget } from '../../server/assistant-v2/modelBudget.ts'

const migration = await readFile(new URL('../../supabase/migrations/202610310004_assistant_model_budget.sql',import.meta.url),'utf8')
const usageBoundsMigration = await readFile(new URL('../../supabase/migrations/202610310007_assistant_model_usage_bounds.sql',import.meta.url),'utf8')
const prerequisite = await readFile(new URL('../../supabase/migrations/202610310002_assistant_cloud_drafts.sql',import.meta.url),'utf8')
const id = n => `30000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const OWNER=id(1),OTHER=id(2),HASH='a'.repeat(64),CLAIM='b'.repeat(64),OTHERCLAIM='c'.repeat(64)
const rejects = code => error => error.code===code
const signatures=['xelay_assistant_model_reserve(uuid,uuid,text,text)','xelay_assistant_model_finish(uuid,uuid,text,text,text,integer,integer)']

test('assistant model accounting is dormant, private, bounded and persistent before provider dispatch',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close())
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on function auth.role() to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
    create table public.profiles(id uuid primary key);
    insert into auth.users(id,email_confirmed_at) values('${OWNER}',now()),('${OTHER}',now());insert into profiles select id from auth.users;`)
  await db.exec(prerequisite);await db.exec(migration)
  const rows=async(sql,args=[])=>(await db.query(sql,args)).rows
  const asRole=async(role,operation,claim=role)=>{
    await db.exec(`set role ${role}`);await db.query("select set_config('request.jwt.claim.role',$1,false)",[claim])
    try{return await operation()}finally{await db.exec("reset role;select set_config('request.jwt.claim.role','',false)")}
  }
  const rawRpc=async(name,args)=>(await rows(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args))[0].result
  const rpc=(name,args)=>asRole('service_role',()=>rawRpc('xelay_assistant_model_'+name,args))
  const reserve=(n=101,user=OWNER,hash=HASH,claim=CLAIM)=>rpc('reserve',[user,id(n),hash,claim])
  const finish=(n=101,user=OWNER,outcome='succeeded',input=1000,output=100,claim=CLAIM)=>rpc('finish',[user,id(n),HASH,claim,outcome,input,output])
  const reset=async(day=1000000,month=1000000,user=20)=>{
    await db.exec('truncate assistant_model_ledger,assistant_model_usage;update auth.users set email_confirmed_at=now(),deleted_at=null,banned_until=null;insert into profiles select id from auth.users on conflict do nothing')
    await db.query('update assistant_model_control set enabled=true,day_microusd_limit=$1,month_microusd_limit=$2,user_day_request_limit=$3,halted_reason=null,halted_at=null where singleton',[day,month,user])
  }
  const used=()=>rows('select scope,charged_microusd::int amount,requests::int requests from assistant_model_usage order by scope')
  let queue=Promise.resolve()
  const client={rpc(name,args){const execute=()=>asRole('service_role',async()=>{
    assert.ok(signatures.some(signature=>signature.startsWith(name+'(')))
    try{return{data:await rawRpc(name,Object.values(args)),error:null}}catch(error){return{data:null,error:{code:error.code,message:error.message}}}
  });const result=queue.then(execute,execute);queue=result.then(()=>undefined,()=>undefined);return result}}

  await t.test('all defaults are zero/off; no browser/table grants or helper execution are installed',async()=>{
    assert.deepEqual((await rows('select enabled,day_microusd_limit::int as day_limit,month_microusd_limit::int as month_limit,user_day_request_limit as requests from assistant_model_control'))[0],{enabled:false,day_limit:0,month_limit:0,requests:0})
    for(const role of['anon','authenticated','service_role']){
      for(const table of['assistant_model_control','assistant_model_usage','assistant_model_ledger']){
        for(const privilege of['select','insert','update','delete'])assert.equal((await rows('select has_table_privilege($1,$2,$3) allowed',[role,table,privilege]))[0].allowed,false)
        await assert.rejects(asRole(role,()=>db.query(`select * from ${table}`)),rejects('42501'))
        assert.equal((await rows('select relrowsecurity enabled from pg_class where oid=$1::regclass',[table]))[0].enabled,true)
      }
      for(const signature of signatures)assert.equal((await rows('select has_function_privilege($1,$2,\'execute\') allowed',[role,'public.'+signature]))[0].allowed,role==='service_role')
      assert.equal((await rows('select has_function_privilege($1,\'public.xelay_assistant_model_remaining(uuid,date,date)\',\'execute\') allowed',[role]))[0].allowed,false)
    }
    assert.equal((await reserve()).reason,'disabled');assert.equal((await rows('select count(*)::int n from assistant_model_ledger'))[0].n,0)
    for(const role of['anon','authenticated'])await assert.rejects(asRole(role,()=>rawRpc('xelay_assistant_model_reserve',[OWNER,id(1),HASH,CLAIM]),'service_role'),rejects('42501'))
    await assert.rejects(asRole('service_role',()=>rawRpc('xelay_assistant_model_reserve',[OWNER,id(1),HASH,CLAIM]),'authenticated'),rejects('42501'))
  })
  await t.test('the separate bounds upgrade preserves approved limits, dormant state and every existing receipt or reservation',async()=>{
    await reset(1000000,5000000,20)
    await reserve(201);const oldReceipt=await finish(201,OWNER,'succeeded',50000,1800)
    assert.equal(oldReceipt.state,'succeeded');assert.equal(oldReceipt.chargedMicrousd,45600)
    await reserve(202);await reserve(203);await finish(203,OWNER,'unknown',null,null)
    await db.exec('update assistant_model_control set enabled=false where singleton')
    const snapshot=async()=>({
      control:await rows('select * from assistant_model_control order by singleton'),
      usage:await rows('select * from assistant_model_usage order by scope,period,scope_id'),
      ledger:await rows('select * from assistant_model_ledger order by request_id'),
    })
    const before=await snapshot()
    const signatureBefore=(await rows("select proargnames,proargtypes::text args,prorettype::regtype::text result,prosecdef,proconfig from pg_proc where oid='public.xelay_assistant_model_finish(uuid,uuid,text,text,text,integer,integer)'::regprocedure"))[0]
    await db.exec(usageBoundsMigration)
    assert.deepEqual(await snapshot(),before)
    assert.deepEqual((await rows("select proargnames,proargtypes::text args,prorettype::regtype::text result,prosecdef,proconfig from pg_proc where oid='public.xelay_assistant_model_finish(uuid,uuid,text,text,text,integer,integer)'::regprocedure"))[0],signatureBefore)
    for(const role of ['anon','authenticated','service_role']){
      assert.equal((await rows("select has_function_privilege($1,'public.xelay_assistant_model_finish(uuid,uuid,text,text,text,integer,integer)','execute') allowed",[role]))[0].allowed,role==='service_role')
      for(const table of ['assistant_model_control','assistant_model_usage','assistant_model_ledger'])for(const privilege of ['select','insert','update','delete'])assert.equal((await rows('select has_table_privilege($1,$2,$3) allowed',[role,table,privilege]))[0].allowed,false)
    }
    assert.equal((await reserve(204)).reason,'disabled')
    const replay=await finish(201,OWNER,'succeeded',50000,1800)
    assert.equal(replay.reused,true);assert.equal(replay.state,'succeeded');assert.equal(replay.chargedMicrousd,45600)
    assert.equal((await finish(203,OWNER,'unknown',null,null)).reused,true)
    await assert.rejects(finish(203,OWNER,'succeeded',1,1),rejects('PT409'))
    assert.equal((await reserve(202)).reason,'replay')
    const pending=await finish(202,OWNER,'succeeded',40000,4000)
    assert.equal(pending.state,'succeeded');assert.equal(pending.chargedMicrousd,48000)
    assert.deepEqual((await rows('select enabled,day_microusd_limit::int day_limit,month_microusd_limit::int month_limit,user_day_request_limit requests,halted_reason from assistant_model_control'))[0],{enabled:false,day_limit:1000000,month_limit:5000000,requests:20,halted_reason:null})
    const settled=await snapshot();await db.exec(usageBoundsMigration);assert.deepEqual(await snapshot(),settled)
  })
  await t.test('zero ceilings and inactive/unconfirmed/missing profiles prevent all reservations',async()=>{
    await reset(0,0,0);assert.equal((await reserve()).allowed,false)
    assert.equal((await rows('select count(*)::int n from assistant_model_ledger'))[0].n,0)
    await reset()
    for(const change of['email_confirmed_at=null','deleted_at=now()',"banned_until=now()+interval'1 hour'"]){
      await db.exec(`update auth.users set ${change} where id='${OWNER}'`);await assert.rejects(reserve(),rejects('42501'))
      await db.exec('update auth.users set email_confirmed_at=now(),deleted_at=null,banned_until=null')
    }
    await db.query('delete from profiles where id=$1',[OWNER]);await assert.rejects(reserve(),rejects('42501'))
    await assert.rejects(reserve(101,id(99)),rejects('42501'))
    assert.equal((await rows('select count(*)::int n from assistant_model_ledger'))[0].n,0)
  })
  await t.test('reserves exactly50000 micro-USD atomically across day/month/user request ceilings',async()=>{
    await reset(100000,100000,20)
    const first=await reserve();assert.equal(first.allowed,true);assert.equal(first.reservedMicrousd,50000)
    assert.deepEqual(first.remaining,{dayMicrousd:50000,monthMicrousd:50000,userDayRequests:19})
    assert.equal((await reserve(102,OTHER)).allowed,true);assert.equal((await reserve(103)).reason,'day_limit')
    await reset(1000000,50000,20);assert.equal((await reserve()).allowed,true);assert.equal((await reserve(102)).reason,'month_limit')
    await reset(1000000,1000000,1);assert.equal((await reserve()).allowed,true);assert.equal((await reserve(102)).reason,'user_day_limit');assert.equal((await reserve(103,OTHER)).allowed,true)
    for(const row of await used())assert.ok(row.amount>=0&&row.requests>=0)
  })
  await t.test('request identifiers are once-only across owners, contexts, status and expiry',async()=>{
    await reset();await reserve();const replay=await reserve(101,OWNER,HASH,OTHERCLAIM)
    assert.equal(replay.allowed,false);assert.equal(replay.reused,true);assert.equal(replay.reason,'replay')
    await assert.rejects(reserve(101,OTHER),rejects('PT409'));await assert.rejects(reserve(101,OWNER,'d'.repeat(64)),rejects('PT409'))
    await db.exec("update assistant_model_ledger set expires_at=reserved_at+interval'1 second',reserved_at=reserved_at-interval'1 day'")
    assert.equal((await reserve()).allowed,false);assert.equal((await used()).find(row=>row.scope==='day').amount,50000)
    const columns=(await rows("select column_name from information_schema.columns where table_schema='public' and table_name='assistant_model_ledger'")).map(row=>row.column_name)
    for(const forbidden of['prompt','response','body','text','access_token','refresh_token','api_key','credential'])assert.equal(columns.includes(forbidden),false)
    assert.equal(JSON.stringify(replay).includes(CLAIM),false);assert.equal(JSON.stringify(replay).includes(HASH),false)
  })
  await t.test('only verified successful token usage releases the unused reservation exactly once',async()=>{
    await reset();await reserve();const result=await finish()
    assert.equal(result.state,'succeeded');assert.equal(result.chargedMicrousd,1200);assert.equal(result.halted,false)
    assert.deepEqual(result.remaining,{dayMicrousd:998800,monthMicrousd:998800,userDayRequests:19})
    for(const row of await used())assert.deepEqual({amount:row.amount,requests:row.requests},{amount:1200,requests:1})
    assert.equal((await finish()).reused,true);assert.equal((await used()).find(row=>row.scope==='day').amount,1200)
    await assert.rejects(finish(101,OWNER,'succeeded',1001,100),rejects('PT409'))
    await assert.rejects(finish(101,OTHER),rejects('PT409'));await assert.rejects(finish(101,OWNER,'succeeded',1000,100,OTHERCLAIM),rejects('PT409'))
    assert.equal((await reserve()).reason,'replay')
  })
  await t.test('unknown outcomes retain full cost permanently and cannot become a later refund',async()=>{
    await reset();await reserve();const result=await finish(101,OWNER,'unknown',null,null)
    assert.equal(result.state,'unknown');assert.equal(result.chargedMicrousd,50000)
    assert.equal((await finish(101,OWNER,'unknown',null,null)).reused,true)
    await assert.rejects(finish(),rejects('PT409'));assert.equal((await reserve()).reason,'replay')
    for(const row of await used())assert.equal(row.amount,50000)
    await assert.rejects(finish(101,OWNER,'unknown',0,0),rejects('22023'))
  })
  await t.test('usage above the reserve or configured provider bound pauses the whole assistant conservatively',async()=>{
    await reset();await reserve();const expensive=await finish(101,OWNER,'succeeded',70000,1800)
    assert.equal(expensive.state,'over_limit');assert.equal(expensive.chargedMicrousd,60600);assert.equal(expensive.halted,true)
    assert.deepEqual((await rows('select enabled,halted_reason from assistant_model_control'))[0],{enabled:false,halted_reason:'usage_over_reservation'})
    assert.equal((await reserve(102,OTHER)).reason,'halted');assert.equal((await finish(101,OWNER,'succeeded',70000,1800)).reused,true)
    assert.equal((await used()).find(row=>row.scope==='day').amount,60600)
    for(const [input,output] of [[40001,1],[10,4001]]){
      await reset();await reserve();const outside=await finish(101,OWNER,'succeeded',input,output)
      assert.equal(outside.state,'over_limit');assert.equal(outside.chargedMicrousd,50000)
      assert.equal((await rows('select halted_reason from assistant_model_control'))[0].halted_reason,'usage_outside_bound')
      assert.equal((await reserve(102,OTHER)).reason,'halted')
    }
  })
  await t.test('the new full input/output envelope refunds only the verified difference from the unchanged reservation',async()=>{
    await reset(1000000,5000000,20);const reservation=await reserve()
    assert.equal(reservation.reservedMicrousd,50000)
    const result=await finish(101,OWNER,'succeeded',40000,4000)
    assert.equal(result.state,'succeeded');assert.equal(result.halted,false);assert.equal(result.chargedMicrousd,48000)
    assert.deepEqual(result.remaining,{dayMicrousd:952000,monthMicrousd:4952000,userDayRequests:19})
    for(const row of await used())assert.deepEqual({amount:row.amount,requests:row.requests},{amount:48000,requests:1})
    assert.equal((await finish(101,OWNER,'succeeded',40000,4000)).reused,true)
    assert.equal((await used()).find(row=>row.scope==='day').amount,48000)
  })
  await t.test('late completion changes its original UTC buckets without consuming a new day or month',async()=>{
    await reset();await reserve()
    await db.exec("update assistant_model_ledger set utc_day=(current_date-40),utc_month=date_trunc('month',current_date-interval'40 days')::date;update assistant_model_usage set period=case when scope='month' then date_trunc('month',current_date-interval'40 days')::date else current_date-40 end")
    const result=await finish();assert.deepEqual(result.remaining,{dayMicrousd:1000000,monthMicrousd:1000000,userDayRequests:20})
    for(const row of await used())assert.equal(row.amount,1200)
    assert.equal((await reserve()).reason,'replay')
  })
  await t.test('queued contenders share one budget and runner recreation never repeats an attempted request',async()=>{
    await reset(100000,100000,20)
    const results=await Promise.all([101,102,103,104].map(n=>client.rpc('xelay_assistant_model_reserve',{p_user_id:OWNER,p_request_id:id(n),p_context_hash:HASH,p_claim_hash:CLAIM})))
    assert.equal(results.filter(row=>row.data.allowed).length,2);assert.equal((await used()).find(row=>row.scope==='day').amount,100000)
    await reset()
    const verifySession=async()=>({userId:OWNER,expiresAt:new Date(Date.now()+600000).toISOString(),accountActive:true,emailConfirmed:true,sessionId:'synthetic-session'})
    const make=()=>createAssistantModelBudget({ledger:createSupabaseModelBudgetLedger({client}),verifySession})
    let calls=0
    const first=await make().run('synthetic-credential-no-network',{requestId:id(501),contextHash:HASH},async()=>{calls++;return{value:{intent:'synthetic'},usage:{inputTokens:1000,outputTokens:100}}})
    assert.equal(first.finalized,true);assert.equal(first.remaining.dayMicrousd,998800)
    await assert.rejects(make().run('synthetic-credential-no-network',{requestId:id(501),contextHash:HASH},async()=>{calls++;return{value:null,usage:{inputTokens:1,outputTokens:1}}}),error=>error.code==='assistant_model_budget_replay')
    assert.equal(calls,1)
  })
  await t.test('a lost provider result persists its full reservation across a new runner',async()=>{
    await reset();const verifySession=async()=>({userId:OWNER,expiresAt:new Date(Date.now()+600000).toISOString(),accountActive:true,emailConfirmed:true})
    const make=()=>createAssistantModelBudget({ledger:createSupabaseModelBudgetLedger({client}),verifySession})
    await assert.rejects(make().run('synthetic-credential-no-network',{requestId:id(601),contextHash:HASH},async()=>{throw Error('synthetic secret that must never escape')}),error=>error.code==='assistant_model_request_failed'&&!error.message.includes('secret'))
    assert.deepEqual((await rows('select state,charged_microusd::int charge from assistant_model_ledger'))[0],{state:'unknown',charge:50000})
    await assert.rejects(make().run('synthetic-credential-no-network',{requestId:id(601),contextHash:HASH},async()=>assert.fail('no second provider call')),error=>error.code==='assistant_model_budget_replay')
    for(const row of await used())assert.equal(row.amount,50000)
  })
})
