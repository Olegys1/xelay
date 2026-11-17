import test from 'node:test'
import assert from 'node:assert/strict'
import {createPlusBackendFixture,users,sessions,hash,plain,tutor} from './helpers/studentPlusBackend.mjs'

const request=(id,mode='chat',extra={})=>({requestId:'plus-api-'+id,mode,prompt:mode==='chat'?'Привіт':'Підготуй навчальний матеріал про попит і пропозицію',sources:[],...extra})
const generated=async(f,r,who='plus')=>{const result=await f.call('generate',r,who);assert.equal(result.http,200,JSON.stringify(result.value));assert.equal(result.value.status,'ready');return result.value}

test('Plus uses its server-selected model and three-dollar paid-month allowance; caller metadata cannot upgrade it',{timeout:120000},async()=>{
 const schemas=[],f=await createPlusBackendFixture({onProvider:({payload})=>{
  schemas.push(payload.text.format.schema)
  if(payload.model==='gpt-5.4-mini')assert.match(payload.instructions,/authorized Plus activity/)
  else assert.doesNotMatch(payload.instructions,/authorized Plus activity/)
 }})
 try{
  const status=await f.call()
  assert.equal(status.http,200);assert.equal(status.value.planId,'plus');assert.equal(status.value.model,'gpt-5.4-mini')
  assert.equal(status.value.budget.limitUsd,3);assert.equal(status.value.budgetPeriod,'subscription_month');assert.equal(status.value.profileDisplayName,'Марія')
  const greeting=await generated(f,request('greeting'))
  assert.match(greeting.bundle.introduction,/Марія/)
  assert.equal(f.providerInputs[0].personalContext.profile.firstName,'Марія')
  assert.equal(f.providerModels[0],'gpt-5.4-mini')
  assert.equal(schemas[0].properties.plan.maxItems,0);assert.equal(schemas[0].properties.math.type,'null')
  const forged=await f.call('generate',request('forged','chat',{model:'gpt-6.1-sol'}))
  assert.equal(forged.http,400);assert.equal(f.providerModels.length,1)
  const maxStatus=await f.call('status',undefined,'max')
  assert.equal(maxStatus.value.planId,'max');assert.equal(maxStatus.value.model,'gpt-6.1-sol');assert.equal(maxStatus.value.budget.limitUsd,10)
  await generated(f,request('max-greeting'),'max');assert.equal(f.providerModels[1],'gpt-6.1-sol')
  assert.equal((await f.call('status',undefined,'teacher')).value.canGenerate,false)
  assert.equal((await f.call('status',undefined,'legacy')).value.canGenerate,false)
 }finally{await f.close()}
})

test('Plus topic tests and cards are saved through the actual API and SQL, including answers, feedback and revision conflicts',{timeout:120000},async()=>{
 const f=await createPlusBackendFixture()
 try{
  const quiz=await generated(f,request('quiz','quiz'))
  assert.equal(quiz.run.bundle.questions.length,3);assert.equal(quiz.run.bundle.plan.length,0);assert.equal(quiz.run.bundle.math,null)
  const q=quiz.run.bundle.questions[0],wrong=(q.correctIndex+1)%q.options.length
  const progress={answers:{[q.id]:wrong},submitted:[q.id],cardRatings:{},doneTasks:[]}
  const saved=await f.call('progress',{runId:quiz.run.id,expectedRevision:1,progress})
  assert.equal(saved.http,200);assert.equal(saved.value.run.revision,2)
  const reloaded=await f.call('history'),again=reloaded.value.runs.find(r=>r.id===quiz.run.id)
  assert.deepEqual(again.progress,progress)
  assert.equal(again.bundle.questions[0].correctIndex,q.correctIndex)
  assert.ok(again.bundle.questions[0].explanation.length>0)
  assert.equal((await f.call('progress',{runId:quiz.run.id,expectedRevision:1,progress})).http,200)
  assert.equal((await f.call('progress',{runId:quiz.run.id,expectedRevision:1,progress:{...progress,answers:{[q.id]:q.correctIndex}}})).http,409)
  assert.equal((await f.call('progress',{runId:quiz.run.id,expectedRevision:2,progress},'other')).http,403)
  const cards=await generated(f,request('cards','cards'))
  assert.equal(cards.run.bundle.cards.length,3)
  const rated={answers:{},submitted:[],cardRatings:{[cards.run.bundle.cards[0].id]:'repeat'},doneTasks:[]}
  assert.equal((await f.call('progress',{runId:cards.run.id,expectedRevision:1,progress:rated})).http,200)
  const history=await f.call('history')
  assert.deepEqual(history.value.runs.find(r=>r.id===cards.run.id).progress,rated)
  assert.equal((await f.call('history',undefined,'other')).value.runs.length,0)
  const replay=await generated(f,request('quiz','quiz'))
  assert.equal(replay.replayed,true);assert.equal(f.providerModels.length,2)
  assert.deepEqual((await f.rows('select * from official_grades order by id')),[{id:1,score:85},{id:2,score:92}])
  await f.db.query('update xelay_student_private.grants set revoked_at=clock_timestamp() where user_id=$1',[users.plus])
  assert.equal((await f.call()).value.canGenerate,false)
  assert.equal((await f.call('history')).value.runs.length,2)
  assert.equal((await f.call('progress',{runId:cards.run.id,expectedRevision:2,progress:rated})).http,200)
  assert.equal((await f.call('generate',request('expired'))).http,403)
 }finally{await f.close()}
})

test('Plus cannot request premium modes, formats, multiple sources or another person’s conversation',{timeout:120000},async()=>{
 const f=await createPlusBackendFixture()
 try{
  for(const mode of ['plan','math'])assert.equal((await f.call('generate',request(mode,mode))).http,403)
  assert.equal((await f.call('generate',request('format','quiz',{studyFormat:'true_false'}))).http,403)
  const source={id:'my-source',title:'Власний конспект',kind:'own_excerpt',page:null,text:'Попит показує залежність кількості товару від ціни.'}
  assert.equal((await f.call('generate',request('many','quiz',{sources:[source,{...source,id:'my-other-source'}]}))).http,403)
  assert.equal(f.providerModels.length,0)
  const selected=await generated(f,request('source','quiz',{sources:[source]}))
  assert.equal(selected.bundle.citations[0].sourceId,source.id)
  assert.equal(f.providerInputs[0].sources[0].text,source.text)
  const own=await generated(f,request('own-dialogue'))
  assert.equal((await f.call('generate',request('foreign-dialogue','chat',{conversationRunIds:[own.run.id]}),'other')).http,403)
  assert.equal(f.providerModels.length,2)
  assert.equal((await f.rows('select count(*)::int n from xelay_student_private.requests'))[0].n,2)
 }finally{await f.close()}
})

test('tier changes while the provider is working refuse output and settle against the original Plus reservation',{timeout:120000},async()=>{
 const f=await createPlusBackendFixture({onProvider:async({service})=>{await service('xelay_student_plan_grant',[users.plus,'max',new Date(Date.now()-10000).toISOString(),new Date(Date.now()+86400000).toISOString(),'synthetic-midflight-upgrade'])}})
 try{
  const result=await f.call('generate',request('midflight','quiz'))
  assert.equal(result.http,503);assert.equal(result.value.status,'context_changed')
  const rows=await f.rows('select state,charge_micros,budget_limit_micros from xelay_student_private.requests')
  assert.deepEqual(plain(rows),[{state:'done',charge_micros:3000,budget_limit_micros:3000000}])
  assert.equal((await f.call()).value.planId,'max')
  assert.equal((await f.call()).value.budget.spentUsd,0)
  assert.equal((await f.call('history')).value.runs.length,0)
 }finally{await f.close()}
})

test('archived quiz/card progress, conflicts, conversation and replay use owner-only fallback beyond the recent twelve',{timeout:120000},async()=>{
 const f=await createPlusBackendFixture()
 try{
  const quizRequest=request('old-quiz','quiz'),cardsRequest=request('old-cards','cards')
  const quiz=await generated(f,quizRequest),cards=await generated(f,cardsRequest)
  const countFallback=()=>f.rpcCalls.filter(call=>call.name==='xelay_student_library_run').length
  assert.equal(countFallback(),0,'recent generation must not need an archive read')
  const oldAt=new Date(Date.now()-3600000).toISOString()
  await f.db.query('update xelay_student_private.runs set created_at=$1 where user_id=$2',[oldAt,users.plus])
  const grant=(await f.rows('select id from xelay_student_private.grants where user_id=$1 order by created_at desc limit 1',[users.plus]))[0]
  for(let n=0;n<15;n++){
   const r=request('archive-fill-'+n,'quiz'),b=plain(quiz.bundle),at=new Date(Date.now()-600000+n*1000).toISOString()
   await f.db.query("insert into xelay_student_private.requests(user_id,request_id,fingerprint,session_hash,period,reserve_micros,charge_micros,state,request,budget_grant_id,budget_cycle,budget_limit_micros,created_at)values($1,$2,$3,$4,date_trunc('month',clock_timestamp())::date,1000,0,'done',$5,$6,0,3000000,$7)",[users.plus,r.requestId,hash(r.requestId),hash(sessions.plus),r,grant.id,at])
   await f.db.query('insert into xelay_student_private.runs(user_id,id,request,bundle,progress,created_at)values($1,$2,$3,$4,$5,$6)',[users.plus,r.requestId,r,b,tutor.emptyTutorProgress(),at])
  }
  const recent=(await f.call('history')).value.runs
  assert.equal(recent.length,12);assert.equal(recent.some(run=>run.id===quiz.run.id||run.id===cards.run.id),false)
  const recentProgress=await f.call('progress',{runId:recent[0].id,expectedRevision:1,progress:recent[0].progress})
  assert.equal(recentProgress.http,200);assert.equal(countFallback(),0,'recent progress must retain its existing path')
  const q=quiz.bundle.questions[0],progress={answers:{[q.id]:(q.correctIndex+1)%q.options.length},submitted:[q.id],cardRatings:{},doneTasks:[]}
  const saved=await f.call('progress',{runId:quiz.run.id,expectedRevision:1,progress})
  assert.equal(saved.http,200);assert.equal(saved.value.run.revision,2);assert.equal(countFallback(),1)
  const reloaded=await f.own('xelay_student_library_run',[quiz.run.id])
  assert.deepEqual(reloaded.progress,progress)
  const conflict=await f.call('progress',{runId:quiz.run.id,expectedRevision:1,progress:{...progress,answers:{[q.id]:q.correctIndex}}})
  assert.equal(conflict.http,409);assert.equal(conflict.value.run.id,quiz.run.id);assert.equal(conflict.value.run.revision,2);assert.deepEqual(conflict.value.run.progress,progress)
  const rating={answers:{},submitted:[],cardRatings:{[cards.bundle.cards[0].id]:'repeat'},doneTasks:[]}
  assert.equal((await f.call('progress',{runId:cards.run.id,expectedRevision:1,progress:rating})).http,200)
  assert.deepEqual((await f.own('xelay_student_library_run',[cards.run.id])).progress,rating)
  await generated(f,request('archive-followup','chat',{conversationRunIds:[quiz.run.id,cards.run.id]}))
  assert.equal(f.providerModels.length,3);assert.equal(f.providerInputs[2].previousConversation.length,4)
  assert.doesNotMatch(JSON.stringify(f.providerInputs[2].previousConversation),/correctIndex|cardRatings|submitted/)
  const before=(await f.call()).value.budget.spentUsd,replay=await generated(f,quizRequest)
  assert.equal(replay.replayed,true);assert.equal(replay.run.id,quiz.run.id);assert.deepEqual(replay.run.progress,progress)
  assert.equal(f.providerModels.length,3);assert.equal((await f.call()).value.budget.spentUsd,before)
  assert.equal((await f.call('progress',{runId:quiz.run.id,expectedRevision:2,progress},'other')).http,403)
  assert.equal((await f.call('generate',request('foreign-archive','chat',{conversationRunIds:[quiz.run.id]}),'other')).http,403)
  assert.equal(f.providerModels.length,3)
  const fallbackCalls=f.rpcCalls.filter(call=>call.name==='xelay_student_library_run')
  assert.ok(fallbackCalls.length>=8);assert.ok(fallbackCalls.every(call=>call.service===false))
  await f.db.query('update xelay_student_private.grants set revoked_at=clock_timestamp() where user_id=$1',[users.plus])
  assert.equal((await f.call('progress',{runId:cards.run.id,expectedRevision:2,progress:rating})).http,200,'existing own-progress semantics remain available after expiry')
  await f.db.query('delete from auth.sessions where id=$1',[sessions.plus])
  assert.equal((await f.call('progress',{runId:quiz.run.id,expectedRevision:2,progress})).http,403)
  assert.deepEqual((await f.rows('select * from official_grades order by id')),[{id:1,score:85},{id:2,score:92}])
 }finally{await f.close()}
})
