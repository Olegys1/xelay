import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createAssistantModelBudget,createSupabaseModelBudgetLedger,assistantModelCostMicrousd,AssistantModelBudgetError,ASSISTANT_MODEL_RESERVATION_MICROUSD,ASSISTANT_MODEL_BUDGET_LIMITS } from '../../server/assistant-v2/modelBudget.ts'
const id=n=>`40000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const USER=id(1),OTHER=id(2),REQUEST={requestId:id(101),contextHash:'a'.repeat(64)},CREDENTIAL='synthetic-credential-no-network'
const NOW=Date.parse('2026-11-03T10:00:00Z'),remaining=()=>({dayMicrousd:950000,monthMicrousd:1950000,userDayRequests:9})
const session=()=>({userId:USER,expiresAt:'2026-11-03T12:00:00Z',accountActive:true,emailConfirmed:true,sessionId:'synthetic-session'})
const good=()=>({value:{kind:'clarify',text:'Synthetic question'},usage:{inputTokens:2000,outputTokens:500}})
function setup(overrides={}){
  const state={rows:new Map(),reserveCalls:[],finishCalls:[],sessions:0,providerCalls:0,session:session(),deny:null,reservationPatch:{},finishPatch:{},finishUnavailable:false}
  const ledger={mode:'private-model-budget',async reserve(user,request,claimHash){
    state.reserveCalls.push({user,request,claimHash});if(state.deny)return structuredClone(state.deny)
    if(state.rows.has(request.requestId))return{allowed:false,reused:true,reason:'replay',requestId:request.requestId,state:state.rows.get(request.requestId).state}
    const row={allowed:true,reused:false,userId:user,requestId:request.requestId,state:'reserved',reservedMicrousd:50000,expiresAt:'2026-11-03T10:15:00Z',remaining:remaining(),...state.reservationPatch}
    state.rows.set(request.requestId,{...structuredClone(row),claimHash});return structuredClone(row)
  },async finish(user,request,claimHash,outcome,usage){
    state.finishCalls.push({user,request,claimHash,outcome,usage});if(state.finishUnavailable)throw Error('synthetic rawprivate backend error')
    const row=state.rows.get(request.requestId);assert.ok(row);assert.equal(row.userId,user);assert.equal(row.claimHash,claimHash)
    const cost=usage?assistantModelCostMicrousd(usage):50000,halted=!!usage&&(cost>50000||usage.inputTokens>40000||usage.outputTokens>4000)
    Object.assign(row,{state:halted?'over_limit':outcome,charge:halted?Math.max(50000,cost):cost})
    return{finished:true,reused:false,requestId:request.requestId,state:row.state,halted,chargedMicrousd:row.charge,remaining:remaining(),...state.finishPatch}
  }}
  const verifySession=async credential=>{assert.equal(credential,CREDENTIAL);state.sessions++;return state.session}
  const make=patch=>createAssistantModelBudget({ledger,verifySession,now:()=>NOW,...overrides,...patch})
  const provider=async()=>{state.providerCalls++;return good()}
  return{state,ledger,make,provider,run:(request=REQUEST)=>make().run(CREDENTIAL,request,provider)}
}
const rejects=code=>error=>error instanceof AssistantModelBudgetError&&error.code===code

test('pricing uses integer micro-USD ceilings and fixed Standard mini token categories',()=>{
  assert.equal(assistantModelCostMicrousd({inputTokens:2000,outputTokens:500}),3750)
  assert.equal(assistantModelCostMicrousd({inputTokens:1,outputTokens:1}),6)
  assert.equal(assistantModelCostMicrousd({inputTokens:50000,outputTokens:1800}),45600)
  assert.deepEqual(ASSISTANT_MODEL_BUDGET_LIMITS,{inputTokens:40000,outputTokens:4000,telemetryTokens:2000000})
  assert.equal(ASSISTANT_MODEL_RESERVATION_MICROUSD,50000)
  assert.equal(assistantModelCostMicrousd({inputTokens:40000,outputTokens:4000}),48000)
  for(const usage of[{},null,{inputTokens:-1,outputTokens:1},{inputTokens:1.1,outputTokens:1},{inputTokens:1,outputTokens:Infinity},{inputTokens:2000001,outputTokens:1}])assert.throws(()=>assistantModelCostMicrousd(usage),rejects('assistant_model_usage_invalid'))
})
test('invalid request identity or client-supplied owner never reaches reservation or provider',async()=>{
  for(const request of[{},null,{...REQUEST,userId:OTHER},{...REQUEST,requestId:'not-id'},{...REQUEST,contextHash:'bad'},{...REQUEST,requestId:'00000000-0000-0000-0000-000000000000'}]){
    const h=setup();await assert.rejects(h.run(request),rejects('invalid_request'));assert.equal(h.state.reserveCalls.length,0);assert.equal(h.state.providerCalls,0)
  }
})
test('expired inactive unconfirmed absent or unverified sessions cannot reserve',async()=>{
  for(const next of[null,{...session(),expiresAt:'2026-11-03T10:00:00Z'},{...session(),expiresAt:'2026-11-03T12:00:00'},{...session(),accountActive:false},{...session(),emailConfirmed:false},{...session(),userId:'bad'}]){
    const h=setup();h.state.session=next;await assert.rejects(h.run(),rejects('session_invalid'));assert.equal(h.state.reserveCalls.length,0)
  }
  const h=setup({verifySession:async()=>{throw Error('rawsecret')}});await assert.rejects(h.run(),rejects('session_invalid'));assert.equal(h.state.providerCalls,0)
})
test('disabled halted exhausted duplicate and malformed ledgers never invoke a model',async()=>{
  for(const[deny,expected]of[
    [{allowed:false,reused:false,reason:'disabled'},'assistant_model_budget_disabled'],
    [{allowed:false,reused:false,reason:'halted'},'assistant_model_budget_halted'],
    ...['user_day_limit','day_limit','month_limit'].map(reason=>[{allowed:false,reused:false,reason},'assistant_model_budget_exhausted']),
    [{allowed:false,reused:true,reason:'replay',requestId:REQUEST.requestId},'assistant_model_budget_replay'],
    [{allowed:false,reused:true,reason:'replay',requestId:id(999)},'assistant_model_budget_unavailable'],
    [{allowed:'yes',reused:false},'assistant_model_budget_unavailable'],
  ]){const h=setup();h.state.deny=deny;await assert.rejects(h.run(),rejects(expected));assert.equal(h.state.providerCalls,0)}
})
test('malformed foreign expired or incorrectly charged reservations fail closed',async()=>{
  for(const patch of[{userId:OTHER},{requestId:id(99)},{state:'succeeded'},{reservedMicrousd:1},{remaining:{...remaining(),dayMicrousd:-1}},{expiresAt:'2026-11-03T09:00:00Z'},{expiresAt:'2026-11-03T12:00:00'},{reused:true}]){
    const h=setup();h.state.reservationPatch=patch;await assert.rejects(h.run(),rejects('assistant_model_budget_unavailable'));assert.equal(h.state.providerCalls,0);assert.equal(h.state.finishCalls.length,0)
  }
})
test('successful execution binds private claims and returns verified usage accounting without credentials',async()=>{
  const h=setup(),result=await h.run();assert.equal(h.state.providerCalls,1);assert.equal(result.finalized,true);assert.deepEqual(result.value,good().value);assert.deepEqual(result.remaining,remaining())
  assert.equal(h.state.reserveCalls[0].user,USER);assert.match(h.state.reserveCalls[0].claimHash,/^[a-f0-9]{64}$/)
  assert.equal(h.state.reserveCalls[0].claimHash,h.state.finishCalls[0].claimHash);assert.equal(h.state.finishCalls[0].outcome,'succeeded')
  assert.equal(h.state.rows.get(REQUEST.requestId).charge,3750);assert.ok(!JSON.stringify(h.state.reserveCalls).includes(CREDENTIAL));assert.ok(!JSON.stringify(result).includes('claimHash'))
})
test('a changed identity during reservation does not dispatch and keeps an unknown reservation',async()=>{
  const h=setup();const original=h.ledger.reserve;h.ledger.reserve=async(...args)=>{const result=await original(...args);h.state.session={...session(),userId:OTHER};return result}
  await assert.rejects(h.run(),rejects('session_changed'));assert.equal(h.state.providerCalls,0);assert.equal(h.state.finishCalls[0].outcome,'unknown');assert.equal(h.state.rows.get(REQUEST.requestId).charge,50000)
})
test('provider failure and malformed usage retain the full reservation and never retry',async()=>{
  const h=setup();await assert.rejects(h.make().run(CREDENTIAL,REQUEST,async()=>{h.state.providerCalls++;throw Error('RAW_KEY_DO_NOT_RETURN')}),error=>error.code==='assistant_model_request_failed'&&!error.message.includes('RAW_KEY'))
  assert.equal(h.state.providerCalls,1);assert.equal(h.state.rows.get(REQUEST.requestId).charge,50000)
  for(const usage of[null,{},undefined,{inputTokens:-1,outputTokens:1},{inputTokens:10,outputTokens:NaN},{inputTokens:1,outputTokens:2000001}]){
    const h=setup();await assert.rejects(h.make().run(CREDENTIAL,REQUEST,async()=>({value:'ignored',usage})),rejects('assistant_model_usage_invalid'));assert.equal(h.state.rows.get(REQUEST.requestId).charge,50000);assert.equal(h.state.finishCalls[0].outcome,'unknown')
  }
})
test('runner recreation cannot dispatch the same accepted request after success or an unknown result',async()=>{
  const h=setup();await h.run();await assert.rejects(h.make().run(CREDENTIAL,REQUEST,h.provider),rejects('assistant_model_budget_replay'));assert.equal(h.state.providerCalls,1)
  const unknown=setup();await assert.rejects(unknown.make().run(CREDENTIAL,REQUEST,async()=>{unknown.state.providerCalls++;throw Error('lost response')}),rejects('assistant_model_request_failed'))
  await assert.rejects(unknown.make().run(CREDENTIAL,REQUEST,unknown.provider),rejects('assistant_model_budget_replay'));assert.equal(unknown.state.providerCalls,1)
})
test('lost or malformed finalization never causes another provider call or local refund',async()=>{
  const h=setup();h.state.finishUnavailable=true;const result=await h.run();assert.equal(result.finalized,false);assert.equal(h.state.rows.get(REQUEST.requestId).state,'reserved')
  await assert.rejects(h.make().run(CREDENTIAL,REQUEST,h.provider),rejects('assistant_model_budget_replay'));assert.equal(h.state.providerCalls,1)
  for(const patch of[{requestId:id(999)},{remaining:{...remaining(),monthMicrousd:-1}},{chargedMicrousd:1},{state:'reserved'},{halted:'yes'}]){
    const h=setup();h.state.finishPatch=patch;assert.equal((await h.run()).finalized,false);assert.equal(h.state.providerCalls,1)
  }
})
test('unexpected actual usage halts conservatively and does not return an unbudgeted model result',async()=>{
  for(const usage of[{inputTokens:70000,outputTokens:4000},{inputTokens:40001,outputTokens:1},{inputTokens:100,outputTokens:4001}]){
    const h=setup();await assert.rejects(h.make().run(CREDENTIAL,REQUEST,async()=>({value:'notreturned',usage})),rejects('assistant_model_budget_halted'))
    assert.equal(h.state.rows.get(REQUEST.requestId).state,'over_limit');assert.ok(h.state.rows.get(REQUEST.requestId).charge>=50000)
  }
})
test('the expanded output boundary settles within the unchanged reservation without weakening usage bounds',async()=>{
  const h=setup(),usage={inputTokens:40000,outputTokens:4000}
  const result=await h.make().run(CREDENTIAL,REQUEST,async()=>({value:'bounded synthetic result',usage}))
  assert.equal(result.value,'bounded synthetic result');assert.equal(result.finalized,true)
  assert.equal(h.state.rows.get(REQUEST.requestId).state,'succeeded')
  assert.equal(h.state.rows.get(REQUEST.requestId).charge,48000)
  assert.equal(h.state.reserveCalls.length,1);assert.deepEqual(h.state.finishCalls[0].usage,usage)
})
test('out-of-bound usage is rejected even when the private finalizer is unavailable',async()=>{
  for(const usage of[{inputTokens:40001,outputTokens:1},{inputTokens:1,outputTokens:4001}]){
    const h=setup();h.state.finishUnavailable=true
    await assert.rejects(h.make().run(CREDENTIAL,REQUEST,async()=>({value:'never returned',usage})),rejects('assistant_model_budget_halted'))
    assert.equal(h.state.rows.get(REQUEST.requestId).state,'reserved');assert.equal(h.state.rows.get(REQUEST.requestId).reservedMicrousd,50000)
    assert.equal(h.state.finishCalls.length,1)
  }
})
test('a revoked or replaced session after the provider cannot receive its answer',async()=>{
  const h=setup();await assert.rejects(h.make().run(CREDENTIAL,REQUEST,async()=>{h.state.session={...session(),sessionId:'replacement'};return good()}),rejects('session_changed'))
  assert.equal(h.state.finishCalls[0].outcome,'succeeded');assert.equal(h.state.rows.get(REQUEST.requestId).charge,3750)
})
test('private RPC adapter uses only budget calls and redacts raw transport errors',async()=>{
  const calls=[],ledger=createSupabaseModelBudgetLedger({client:{async rpc(name,args){calls.push({name,args});return{data:{ok:true},error:null}}}})
  const hash=createHash('sha256').update('synthetic-once-only-claim').digest('hex')
  assert.equal(ledger.mode,'private-model-budget');await ledger.reserve(USER,REQUEST,hash);await ledger.finish(USER,REQUEST,hash,'succeeded',{inputTokens:100,outputTokens:50})
  assert.deepEqual(calls.map(row=>row.name),['xelay_assistant_model_reserve','xelay_assistant_model_finish']);assert.equal(calls[1].args.p_input_tokens,100)
  for(const code of['42501','PT409','99999']){
    const broken=createSupabaseModelBudgetLedger({client:{async rpc(){return{data:null,error:{code,message:'RAW_SECRET'}}}}})
    await assert.rejects(broken.reserve(USER,REQUEST,hash),error=>error instanceof AssistantModelBudgetError&&!error.message.includes('RAW_SECRET'))
  }
})
