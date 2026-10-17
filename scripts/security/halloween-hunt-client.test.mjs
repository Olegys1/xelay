import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
const source=await readFile(new URL('../../src/lib/halloweenHunt.ts',import.meta.url),'utf8')
const ids=['home','questions','news','groups','people','messages','support','opportunities','subscription','profile']
const state={campaignId:'halloween-2026',startsAt:'2026-10-18T09:00:00.000Z',endsAt:'2026-11-01T22:00:00.000Z',
  serverNow:'2026-10-18T09:00:00.000Z',phase:'active',eligible:true,ineligibleReason:null,collected:[],completed:false,completedAt:null,
  badgeEarned:false,showBadge:true,subscriptionWon:false,subscriptionStartsAt:null,subscriptionEndsAt:null,winnersRemaining:10}
const completed={...state,collected:ids,completed:true,completedAt:'2026-10-18T09:01:00Z',badgeEarned:true,
  subscriptionWon:true,subscriptionStartsAt:'2026-10-18T09:01:00Z',subscriptionEndsAt:'2026-11-18T10:01:00Z',winnersRemaining:9}
const plain=x=>JSON.parse(JSON.stringify(x))
function fixture(respond=()=>({data:state,error:null}),{abortable=false}={}){
  const calls=[],events=[],signals=[],module={exports:{}}
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  vm.runInNewContext(code,{module,exports:module.exports,CustomEvent:class{constructor(type){this.type=type}},window:{dispatchEvent:event=>events.push(event.type)},
    require:name=>{assert.equal(name,'./supabase');return {supabase:{rpc:(name,args)=>{
      calls.push({name,args});const request=Promise.resolve(respond(name,args))
      if(abortable)request.abortSignal=signal=>{signals.push(signal);return request}
      return request
    }}}}})
  return {api:module.exports,calls,events,signals}
}
test('Halloween own state reads only server authority and strips unrelated response fields',async()=>{
  const fx=fixture(()=>({data:{...state,privateWinners:['never expose']},error:null}))
  assert.deepEqual(plain(await fx.api.loadMyHalloweenHunt()),state)
  assert.deepEqual(plain(fx.calls),[{name:'xelay_my_halloween_hunt'}])
  assert.deepEqual(plain(fx.api.PUMPKIN_IDS),ids)
  assert.equal(fx.api.HALLOWEEN_STARTS_AT,state.startsAt);assert.equal(fx.api.HALLOWEEN_ENDS_AT,state.endsAt)
  assert.doesNotMatch(source,/localStorage|sessionStorage|p_user_id.*xelay_collect|p_now|p_completed|p_winners/)
})
test('invalid progress, fake rewards, duplicate locations and malformed response data are rejected',()=>{
  const {api}=fixture()
  for(const value of [null,[],{}, {...state,collected:['organizer']},{...state,collected:['home','home']},
    {...state,winnersRemaining:11},{...state,winnersRemaining:-1},{...state,winnersRemaining:1.1},
    {...state,startsAt:'2026-10-18T10:00:00.000Z'},{...state,endsAt:'2026-11-01T21:00:00Z'},
    {...state,eligible:true,ineligibleReason:'email_unconfirmed'},{...state,completed:true},
    {...state,collected:ids},{...state,badgeEarned:true},{...state,showBadge:1},{...state,subscriptionWon:true},
    {...state,subscriptionStartsAt:'2026-10-18T09:00:00Z'},{...completed,subscriptionEndsAt:'2026-10-17T09:00:00Z'},
    {...completed,completedAt:null},{...state,serverNow:'nonsense'}])assert.throws(()=>api.parseHalloweenHuntState(value))
  assert.deepEqual(plain(api.parseHalloweenHuntState({...state,eligible:false,ineligibleReason:'email_unconfirmed'})),{...state,eligible:false,ineligibleReason:'email_unconfirmed'})
  assert.deepEqual(plain(api.parseHalloweenHuntState(completed)),completed)
})
test('collection sends one fixed location and no requested owner, time, count or prize; only real completion dispatches badge refresh',async()=>{
  let response={...state,collected:['home'],newlyCollected:true,newlyCompleted:false}
  const fx=fixture(()=>({data:response,error:null}))
  assert.equal((await fx.api.collectHalloweenPumpkin('home')).newlyCollected,true)
  assert.deepEqual(plain(fx.calls),[{name:'xelay_collect_halloween_pumpkin',args:{p_pumpkin_id:'home'}}]);assert.equal(fx.events.length,0)
  response={...completed,newlyCollected:true,newlyCompleted:true}
  assert.equal((await fx.api.collectHalloweenPumpkin('profile')).newlyCompleted,true)
  assert.deepEqual(fx.events,[fx.api.HALLOWEEN_BADGES_CHANGED])
  response={...completed,newlyCollected:false,newlyCompleted:false};await fx.api.collectHalloweenPumpkin('profile');assert.equal(fx.events.length,1)
  for(const id of ['organizer','HOME','',null,{},12])await assert.rejects(fx.api.collectHalloweenPumpkin(id))
  assert.equal(fx.calls.length,3)
})
test('failed, incomplete and inconsistent claims never appear as a successful local pickup',async()=>{
  for(const value of [state,{...completed,newlyCollected:false,newlyCompleted:true},{...state,newlyCollected:true,newlyCompleted:false},
    {...state,collected:['home'],newlyCollected:true,newlyCompleted:true}]){
    const fx=fixture(()=>({data:value,error:null}));await assert.rejects(fx.api.collectHalloweenPumpkin('home'));assert.equal(fx.events.length,0)
  }
  for(const code of ['HALLOWEEN_NOT_STARTED','HALLOWEEN_ENDED','HALLOWEEN_TOO_FAST','HALLOWEEN_EMAIL_UNCONFIRMED']){
    const fx=fixture(()=>({data:completed,error:{message:code}}));await assert.rejects(fx.api.collectHalloweenPumpkin('home'),e=>e.code===code);assert.equal(fx.events.length,0)
  }
  const offline=fixture(()=>({data:null,error:{message:'upstream details'}}));await assert.rejects(offline.api.loadMyHalloweenHunt(),e=>e.code==='HALLOWEEN_REQUEST_FAILED'&&!e.message.includes('upstream'))
})
test('badge visibility saves independently of hunt phase and minimal public lookup never returns private progress',async()=>{
  const fx=fixture((name,args)=>({data:name==='xelay_halloween_badge'?true:{...completed,phase:'ended',showBadge:args.p_visible},error:null}))
  assert.equal((await fx.api.saveMyHalloweenBadge(false)).showBadge,false)
  assert.equal(await fx.api.loadHalloweenBadge('other-user'),true)
  assert.equal(await fx.api.loadHalloweenBadge(''),false)
  assert.deepEqual(plain(fx.calls),[{name:'xelay_set_my_halloween_badge',args:{p_visible:false}},
    {name:'xelay_halloween_badge',args:{p_user_id:'other-user'}}])
  assert.deepEqual(fx.events,[fx.api.HALLOWEEN_BADGES_CHANGED])
  await assert.rejects(fx.api.saveMyHalloweenBadge('false'));assert.equal(fx.calls.length,2)
  const bad=fixture(()=>({data:{...completed,showBadge:true},error:null}));await assert.rejects(bad.api.saveMyHalloweenBadge(false));assert.equal(bad.events.length,0)
  await assert.rejects(bad.api.loadHalloweenBadge('other-user'))
})
test('optional AbortSignal is forwarded only when supplied to each RPC',async()=>{
  const controller=new AbortController()
  const fx=fixture((name,args)=>({data:name==='xelay_halloween_badge'?true:name==='xelay_set_my_halloween_badge'?{...completed,showBadge:args.p_visible}
    :name==='xelay_collect_halloween_pumpkin'?{...state,collected:['home'],newlyCollected:true,newlyCompleted:false}:state,error:null}),{abortable:true})
  await fx.api.loadMyHalloweenHunt(controller.signal)
  await fx.api.collectHalloweenPumpkin('home',controller.signal)
  await fx.api.saveMyHalloweenBadge(false,controller.signal)
  await fx.api.loadHalloweenBadge('other-user',controller.signal)
  await fx.api.loadMyHalloweenHunt()
  assert.equal(fx.calls.length,5);assert.equal(fx.signals.length,4);assert.ok(fx.signals.every(signal=>signal===controller.signal))
})
test('already cancelled operations make no RPC and never announce success',async()=>{
  const controller=new AbortController();controller.abort()
  const fx=fixture()
  for(const call of [()=>fx.api.loadMyHalloweenHunt(controller.signal),()=>fx.api.collectHalloweenPumpkin('home',controller.signal),
    ()=>fx.api.saveMyHalloweenBadge(false,controller.signal),()=>fx.api.loadHalloweenBadge('other-user',controller.signal)]){
    await assert.rejects(call(),e=>e.code==='HALLOWEEN_REQUEST_ABORTED')
  }
  assert.equal(fx.calls.length,0);assert.equal(fx.events.length,0)
})
test('late successful responses after cancellation cannot masquerade as successful collection, setting, read or public badge load',async()=>{
  const cases=[
    {call:(api,signal)=>api.loadMyHalloweenHunt(signal),response:state},
    {call:(api,signal)=>api.collectHalloweenPumpkin('profile',signal),response:{...completed,newlyCollected:true,newlyCompleted:true}},
    {call:(api,signal)=>api.saveMyHalloweenBadge(false,signal),response:{...completed,showBadge:false}},
    {call:(api,signal)=>api.loadHalloweenBadge('other-user',signal),response:true},
  ]
  for(const item of cases){
    let resolve;const response=new Promise(done=>resolve=done),controller=new AbortController()
    // Simulate a provider that ignores abort: the server may already have committed.
    const fx=fixture(()=>response,{abortable:true}),pending=item.call(fx.api,controller.signal)
    assert.equal(fx.signals[0],controller.signal);controller.abort();resolve({data:item.response,error:null})
    await assert.rejects(pending,e=>e.code==='HALLOWEEN_REQUEST_ABORTED');assert.equal(fx.events.length,0)
  }
})
test('retry after an ambiguous committed completion reconciles server state without a second reward celebration',async()=>{
  let resolve,first=true;const waiting=new Promise(done=>resolve=done),controller=new AbortController()
  const fx=fixture(name=>{
    if(first){first=false;return waiting}
    return {data:name==='xelay_collect_halloween_pumpkin'?{...completed,newlyCollected:false,newlyCompleted:false}:completed,error:null}
  },{abortable:true})
  const pending=fx.api.collectHalloweenPumpkin('profile',controller.signal)
  controller.abort();resolve({data:{...completed,newlyCollected:true,newlyCompleted:true},error:null})
  await assert.rejects(pending,e=>e.code==='HALLOWEEN_REQUEST_ABORTED')
  assert.equal((await fx.api.loadMyHalloweenHunt()).completed,true)
  const retry=await fx.api.collectHalloweenPumpkin('profile');assert.equal(retry.newlyCollected,false);assert.equal(retry.subscriptionWon,true)
  assert.equal(fx.events.length,0)
})
