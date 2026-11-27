import test from'node:test'
import assert from'node:assert/strict'
import{teacherModuleLoader}from'./helpers/loadTeacherModule.mjs'
const api=teacherModuleLoader()('src/lib/teacherLearningClient.ts'),validate=teacherModuleLoader()('src/lib/teacherLearningValidation.ts')
const owner='81000000-0000-4000-8000-000000000001',other='81000000-0000-4000-8000-000000000002',session='81000000-0000-4000-8000-000000000101'
const token=(sub=owner,sid=session,exp=9999999999)=>['header',Buffer.from(JSON.stringify({sub,session_id:sid,exp})).toString('base64url'),'signature'].join('.')
const state={userId:owner,audience:'teacher',planId:'teacher_start',canGenerate:true,canEdit:true,available:true,startsAt:'2026-11-17T00:00:00Z',expiresAt:'2026-12-17T00:00:00Z',budgetPeriod:'subscription_month',budget:{limitMicros:1000000,spentMicros:0,reservedMicros:0},allowedModes:['questions','variants','tasks'],courses:[]}
const fixture=(mutate=()=>{})=>{let user=owner,active=token(),calls=0;const client=api.createTeacherLearningClient({currentUserId:()=>user,session:async()=>({userId:user,accessToken:active}),fetcher:async()=>{calls++;mutate({setUser:v=>user=v,setToken:v=>active=v});return new Response(JSON.stringify(state),{headers:{'content-type':'application/json'}})}});return{client,calls:()=>calls}}
test('teacher client rejects an account switch before revealing the response',async()=>{const fx=fixture(({setUser,setToken})=>{setUser(other);setToken(token(other))});await assert.rejects(fx.client.status(),e=>e.code==='identity_changed')})
test('teacher client rechecks provider session even when React owner prop still has the old value',async()=>{let reads=0;const client=api.createTeacherLearningClient({currentUserId:()=>owner,session:async()=>++reads===1?{userId:owner,accessToken:token()}:{userId:other,accessToken:token(other)},fetcher:async()=>new Response(JSON.stringify(state))});await assert.rejects(client.status(),e=>e.code==='identity_changed')})
test('same user new session is rejected but refresh within the same authenticated session works',async()=>{const changed=fixture(({setToken})=>setToken(token(owner,'81000000-0000-4000-8000-000000000102')));await assert.rejects(changed.client.status(),e=>e.code==='identity_changed');const refreshed=fixture(({setToken})=>setToken(token(owner,session,9999999998)));assert.equal((await refreshed.client.status()).planId,'teacher_start')})
test('request validation never lets client choose a model, forge consent or request more than20 variant questions',()=>{
 const r={requestId:'81000000-0000-4000-8000-000000000201',kind:'questions',courseId:'81000000-0000-4000-8000-000000000301',groupIds:['81000000-0000-4000-8000-000000000401'],prompt:'Нові навчальні питання.',consent:true,questionCount:5}
 assert.equal(validate.validateTeacherLearningRequest(r).questionCount,5)
 for(const changed of [{model:'gpt-5.4'},{consent:false},{groupIds:[...r.groupIds,...r.groupIds]},{kind:'variants',questionCount:10,variantCount:3},{kind:'rubric_review'}])assert.throws(()=>validate.validateTeacherLearningRequest({...r,...changed}))
})
test('status parser rejects a forged teacher budget or student identity claiming generation rights',()=>{assert.throws(()=>validate.validateTeacherLearningStatus({...state,budget:{...state.budget,limitMicros:8000000}}));assert.throws(()=>validate.validateTeacherLearningStatus({...state,audience:'student'}));assert.equal(validate.validateTeacherLearningStatus(state).budget.limitMicros,1000000)})
test('winter Max overlay retains only its explicit original paid cap; free paused status has no allowance',()=>{
 const overlay={...state,planId:'teacher_max',winterBasePlanId:'teacher_start',winterUpgradeUntil:'2027-01-01T00:00:00Z',winterPromoCredits:50}
 assert.equal(validate.validateTeacherLearningStatus(overlay).budget.limitMicros,1000000)
 assert.throws(()=>validate.validateTeacherLearningStatus({...overlay,winterBasePlanId:'free'}))
 assert.throws(()=>validate.validateTeacherLearningStatus({...overlay,budget:{...state.budget,limitMicros:8000000}}))
 assert.throws(()=>validate.validateTeacherLearningStatus({...overlay,winterUpgradeUntil:undefined}))
 assert.equal(validate.validateTeacherLearningStatus({...state,planId:'free',canGenerate:false,canEdit:false,allowedModes:[],budget:{limitMicros:0,spentMicros:0,reservedMicros:0}}).canGenerate,false)
})
