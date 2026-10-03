import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { STAGING_REF,STAGING_ORIGIN } from './hosted-media-checks.mjs'
import { TEST1_LOCAL_DIRECTORY } from './test1-auth-fixtures.mjs'
import { parseDirectRaceArguments,validateDirectRaceReceipt,assertDirectRaceRequest,directRaceTransport,
  directRaceBodies,isDuplicateRaceResult,runTest1DirectRace } from './test1-direct-race.mjs'

const jwt=claims=>`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.offline-signature`
const sources=()=>{
  const exp=Math.floor(Date.now()/1000)+1200,runId=randomUUID()
  return {session:{mode:'test1-media-sessions',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId,
    publicKey:jwt({role:'anon',ref:STAGING_REF,exp}),users:Object.fromEntries(['A','B','C'].map(who=>{
      const id=randomUUID();return [who,{id,expiresAt:exp,accessToken:jwt({role:'authenticated',iss:STAGING_ORIGIN+'/auth/v1',sub:id,exp})}]
    }))},fixture:{mode:'test1-media-fixtures',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId,conversationId:randomUUID(),chatSpaceId:randomUUID()}}
}
const options={execute:true,cleanupOnly:false,sessionPath:'unused-owned-session',fixturePath:'unused-owned-fixture'}
const copy=value=>structuredClone(value)
const json=(data,status=200)=>new Response(data===null?null:JSON.stringify(data),{status,headers:{'content-type':'application/json'}})
function integrationMock({raceFailure=false,overwrite=false,wrongIdentity=false,deletedResponseFailure=false}={}) {
  const inputs=sources(),saved=[],rows=new Map(),operations=[],racePending=[]
  let raceActive=0,maxRaceActive=0,deleteCalls=0
  const save=async(path,value)=>saved.push({path,value:copy(value)})
  const fetchImpl=async(input,init)=>{
    const url=new URL(String(input)),method=init.method||'GET',headers=new Headers(init.headers)
    const who=Object.keys(inputs.session.users).find(label=>headers.get('authorization')===`Bearer ${inputs.session.users[label].accessToken}`)
    const body=init.body?JSON.parse(init.body):null
    assert.equal(headers.get('apikey'),inputs.session.publicKey)
    operations.push({path:url.pathname,method,who})
    if(url.pathname==='/auth/v1/user')return json({id:inputs.session.users[who].id,email_confirmed_at:'2026-01-01',
      app_metadata:wrongIdentity?{}:{xelay_security_fixture:'media-v1',xelay_security_run_id:inputs.session.runId,xelay_security_label:who}})
    if(url.pathname==='/rest/v1/conversations')return json(who==='C'?[]:[{id:inputs.fixture.conversationId,
      user_one_id:inputs.session.users.A.id,user_two_id:inputs.session.users.B.id}])
    if(url.pathname==='/rest/v1/rpc/xelay_send_direct_message') {
      const intent=saved.at(-1).value
      assert.equal(intent.stage,'race_pending');assert.equal(intent.messageId,body.p_message_id)
      raceActive++;maxRaceActive=Math.max(maxRaceActive,raceActive)
      // Both HTTP requests are pending together; release only once the second
      // has arrived. The resulting database behavior is independently mocked.
      return new Promise(resolveRequest=>{
        racePending.push({body,resolveRequest})
        if(racePending.length===2) {
          const first=racePending[0],second=racePending[1]
          const row={id:first.body.p_message_id,conversation_id:first.body.p_conversation_id,sender_id:inputs.session.users.A.id,
            recipient_id:inputs.session.users.B.id,body:first.body.p_body,deleted_at:null}
          rows.set(row.id,row)
          first.resolveRequest(json(copy(row)))
          if(overwrite){row.body=second.body.p_body;second.resolveRequest(json(copy(row)))}
          else second.resolveRequest(raceFailure?json({code:'23505',message:'private-token@example.test/server-error'},500)
            :json({code:'23505',message:'sensitive duplicate detail'},409))
          raceActive=0
        }
      })
    }
    if(url.pathname==='/rest/v1/messages'&&method==='POST') {
      assert.equal(who,'B');assert.equal(body.sender_id,inputs.session.users.A.id)
      return json({code:'42501',message:'private RLS detail'},403)
    }
    if(url.pathname==='/rest/v1/rpc/xelay_delete_message') {
      deleteCalls++
      const intent=saved.at(-1).value
      assert.equal(intent.stage,'delete_pending');assert.ok(intent.winnerDigest)
      const row=rows.get(body.p_message_id);row.body='';row.deleted_at='2026-10-03T12:00:00Z'
      return deletedResponseFailure?json({code:'P0001',message:'unknown delete response'},500):json(null)
    }
    if(url.pathname==='/rest/v1/messages') {
      const id=url.searchParams.get('id').slice(3),row=rows.get(id)
      return json(who==='C'||!row||url.searchParams.get('deleted_at')==='is.null'&&row.deleted_at!==null?[]:[copy(row)])
    }
    throw Error('unexpected route with sensitive-token')
  }
  return {...inputs,saved,save,fetchImpl,rows,operations,metrics:()=>({maxRaceActive,deleteCalls})}
}

test('direct race defaults to no network, no session reads, no secret access',async()=>{
  const result=await runTest1DirectRace(parseDirectRaceArguments([]),{load:()=>{throw Error('must not read')},fetchImpl:()=>{throw Error('must not fetch')}})
  assert.equal(result.requests,0);assert.equal(result.pending,1)
  for(const args of [['--cleanup-only'],['--execute'],['--execute','--service-key','hidden'],['--receipt-file','unused']])assert.throws(()=>parseDirectRaceArguments(args))
})
test('owned receipt and route guard reject foreign origins, wrong scopes, messages, sender fields and arbitrary calls',()=>{
  const input=sources(),scope={mode:'test1-direct-race-owned',projectRef:STAGING_REF,origin:STAGING_ORIGIN,
    fixtureRunId:input.session.runId,probeId:randomUUID(),messageId:randomUUID(),ownerId:input.session.users.A.id,
    recipientId:input.session.users.B.id,outsiderId:input.session.users.C.id,conversationId:input.fixture.conversationId,
    createdAt:new Date().toISOString(),stage:'prepared',winnerDigest:null}
  const good={who:'A',method:'POST',paired:true,body:{p_message_id:scope.messageId,p_conversation_id:scope.conversationId,
    p_body:directRaceBodies(scope.probeId)[0],p_reply_to:null,p_attachments:[]}}
  assertDirectRaceRequest(STAGING_ORIGIN+'/rest/v1/rpc/xelay_send_direct_message',good,scope)
  for(const changed of [{who:'B'},{paired:false},{body:{...good.body,p_message_id:randomUUID()}},
    {body:{...good.body,sender_id:scope.ownerId}},{body:{...good.body,p_attachments:[{}]}},
    {body:{...good.body,p_body:'arbitrary human text'}}])assert.throws(()=>assertDirectRaceRequest(STAGING_ORIGIN+'/rest/v1/rpc/xelay_send_direct_message',{...good,...changed},scope))
  for(const url of ['http://saufzpryybuawudohhwj.supabase.co/auth/v1/user','https://production.supabase.co/auth/v1/user',
    STAGING_ORIGIN+'/auth/v1/admin/users',STAGING_ORIGIN+'/rest/v1/rpc/xelay_create_checkout',STAGING_ORIGIN+'/rest/v1/messages?select=*']) {
    assert.throws(()=>assertDirectRaceRequest(url,{who:'A'},scope))
  }
  assert.throws(()=>validateDirectRaceReceipt({...scope,serviceKey:'never accepted'}))
  assert.throws(()=>validateDirectRaceReceipt({...scope,messageId:'all messages'}))
})
test('only PG duplicate conflict at the expected HTTP status is an acceptable race loser',()=>{
  assert.equal(isDuplicateRaceResult({ok:false,httpStatus:409,errorCode:'23505'}),true)
  for(const result of [{ok:false,httpStatus:500,errorCode:'23505'},{ok:false,httpStatus:409,errorCode:'OtherError'},
    {ok:false,httpStatus:403,errorCode:'42501'},{ok:true,httpStatus:200,errorCode:'23505'},{}])assert.equal(isDuplicateRaceResult(result),false)
})

test('transport permits one pair only, rejects unrelated concurrency, caps 16 requests and sanitizes errors',async()=>{
  const input=sources(),scope={mode:'test1-direct-race-owned',projectRef:STAGING_REF,origin:STAGING_ORIGIN,
    fixtureRunId:input.session.runId,probeId:randomUUID(),messageId:randomUUID(),ownerId:input.session.users.A.id,
    recipientId:input.session.users.B.id,outsiderId:input.session.users.C.id,conversationId:input.fixture.conversationId,
    createdAt:new Date().toISOString(),stage:'race_pending',winnerDigest:null}
  const config={fixtureRunId:input.session.runId,conversationId:input.fixture.conversationId,key:input.session.publicKey,
    users:Object.fromEntries(Object.entries(input.session.users).map(([who,user])=>[who,{id:user.id,token:user.accessToken}]))}
  let releases=[],calls=0
  const transport=directRaceTransport(config,scope,async(_url,init)=>{
    calls++;assert.equal(init.redirect,'manual')
    if(init.method==='POST')return new Promise(resolveResponse=>releases.push(resolveResponse))
    return json({})
  })
  const pair=transport.racePair()
  assert.equal(calls,2)
  await assert.rejects(transport.request('A','/auth/v1/user'),/RACE_REQUEST_LIMIT/)
  await assert.rejects(transport.racePair(),/RACE_REQUEST_LIMIT/)
  releases.forEach(release=>release(json({})));await pair
  for(let index=0;index<14;index++)await transport.request('A','/auth/v1/user')
  await assert.rejects(transport.request('A','/auth/v1/user'),/RACE_REQUEST_LIMIT/)
  assert.equal(calls,16)
  const redirected=directRaceTransport(config,scope,async()=>new Response(null,{status:302,headers:{location:'https://foreign.test/private'}}))
  await assert.rejects(redirected.request('A','/auth/v1/user'),/RACE_REDIRECT_DENIED/)
  const failed=directRaceTransport(config,scope,async()=>{throw Error('never-print-password@example.test')})
  await assert.rejects(failed.request('A','/auth/v1/user'),error=>error.message==='RACE_NETWORK_FAILED'
    &&!JSON.stringify(error).includes('never-print'))
})
test('real duplicate pair is the sole concurrency exception and exact owned cleanup succeeds in 16 requests',async()=>{
  const mocked=integrationMock(),result=await runTest1DirectRace(options,mocked)
  assert.equal(result.checksFailed,0,JSON.stringify(result.diagnostics));assert.equal(result.cleanupFailed,0)
  assert.equal(result.pending,0);assert.equal(result.requests,16);assert.equal(result.cleanupPassed,3)
  assert.equal(mocked.metrics().maxRaceActive,2);assert.equal(mocked.metrics().deleteCalls,1)
  assert.equal(mocked.rows.size,1);assert.equal([...mocked.rows.values()][0].body,'');assert.ok([...mocked.rows.values()][0].deleted_at)
  assert.equal(mocked.saved.at(-1).value.stage,'deleted')
  assert.ok(mocked.saved.every(item=>item.path===resolve(TEST1_LOCAL_DIRECTORY,`test1-direct-race-receipt-${result.probeId}.json`)))
  for(const value of [mocked.session.publicKey,...Object.values(mocked.session.users).map(user=>user.accessToken),
    ...directRaceBodies(result.probeId),mocked.saved[0].value.messageId])assert.equal(JSON.stringify(result).includes(value),false)
})
test('500 duplicate response never passes; unknown outcome is independently scoped before cleanup',async()=>{
  const mocked=integrationMock({raceFailure:true}),result=await runTest1DirectRace(options,mocked)
  assert.equal(result.checksFailed,1);assert.equal(result.pending,1);assert.equal(result.cleanupFailed,0)
  assert.equal(result.diagnostics.find(item=>item.checkName==='duplicate_send_result_2').passed,false)
  assert.equal(mocked.metrics().deleteCalls,1);assert.equal(mocked.saved.at(-1).value.stage,'deleted')
  assert.equal(JSON.stringify(result).includes('private-token@example.test'),false)
})
test('a duplicate send that overwrites the original or returns two winners fails',async()=>{
  const mocked=integrationMock({overwrite:true}),result=await runTest1DirectRace(options,mocked)
  assert.equal(result.checksFailed,1);assert.equal(result.pending,1)
  assert.equal(result.diagnostics.find(item=>item.checkName==='duplicate_send_one_winner').passed,false)
  assert.equal(result.cleanupFailed,0)
})
test('unowned Auth identity is rejected before send or deletion',async()=>{
  const mocked=integrationMock({wrongIdentity:true}),result=await runTest1DirectRace(options,mocked)
  assert.equal(result.requests,1);assert.equal(result.checksFailed,1);assert.equal(result.cleanupPassed,0)
  assert.equal(mocked.operations.some(item=>item.method==='POST'),false)
})
test('cleanup-only safely restores an exact delete with unknown HTTP outcome without replaying race',async()=>{
  const mocked=integrationMock({deletedResponseFailure:true}),failed=await runTest1DirectRace(options,mocked)
  assert.equal(failed.cleanupFailed,1)
  const receipt=copy(mocked.saved.at(-1).value),receiptPath=resolve(TEST1_LOCAL_DIRECTORY,`test1-direct-race-receipt-${receipt.probeId}.json`)
  const before=mocked.operations.length,removed=mocked.metrics().deleteCalls
  const result=await runTest1DirectRace({...options,cleanupOnly:true,receiptPath},{...mocked,receipt})
  assert.equal(result.pending,0);assert.equal(result.requests,9);assert.equal(mocked.metrics().deleteCalls,removed)
  assert.equal(mocked.operations.slice(before).some(item=>item.path==='/rest/v1/rpc/xelay_send_direct_message'),false)
  assert.equal(mocked.saved.at(-1).value.stage,'deleted')
  await assert.rejects(runTest1DirectRace({...options,cleanupOnly:true,receiptPath},{...mocked,
    receipt:{...receipt,ownerId:randomUUID()}}),/RACE_CLEANUP_SCOPE_DENIED/)
})
