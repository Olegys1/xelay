import test from 'node:test'
import assert from 'node:assert/strict'
import { requestAcademicEmailChange } from '../src/lib/academicEmailChange.ts'

function fixture() {
  let account='a', active=true, verified='a', mutationError=null
  const calls=[]
  const client={auth:{getSession:async()=>({data:{session:{user:{id:account},access_token:'SYNTHETIC-'+account,refresh_token:'SYNTHETIC-REFRESH'}},error:null})}}
  let onVerify=()=>{}, onMutate=()=>{}
  const isolated={auth:{
    setSession:async session=>{calls.push(['session',session.access_token]);return {data:{user:{id:'a'}},error:null}},
    getUser:async()=>{onVerify();return {data:{user:{id:verified}},error:null}},
    updateUser:async(data,options)=>{onMutate();calls.push(['update',data,options]);return {data:{user:{id:'a'}},error:mutationError}},
  }}
  const request=()=>requestAcademicEmailChange({client,createIsolated:()=>isolated,userId:'a',email:'Student@KNU.UA',redirectTo:'https://www.xelay.ink/auth/callback',isActive:()=>active})
  return {request,calls,change:()=>{account='b'},cancel:()=>{active=false},unverified:()=>{verified='b'},fail:()=>{mutationError={code:'email_exists'}},duringVerify:fn=>{onVerify=fn},duringUpdate:fn=>{onMutate=fn}}
}
test('email update uses a verified, isolated session, canonical address and explicit callback',async()=>{
  const f=fixture();await f.request()
  assert.deepEqual(f.calls,[['session','SYNTHETIC-a'],['update',{email:'student@knu.ua'},{emailRedirectTo:'https://www.xelay.ink/auth/callback'}]])
})
test('account switch, unmount and changed verified identity prevent mutation',async()=>{
  for(const arrange of [f=>f.change(),f=>f.cancel(),f=>f.unverified(),f=>f.duringVerify(f.change),f=>f.duringVerify(f.cancel)]) {
    const f=fixture();arrange(f);await assert.rejects(f.request(),/SESSION_CHANGED/)
    assert.equal(f.calls.filter(x=>x[0]==='update').length,0)
  }
})
test('a late sign-in cannot redirect a mutation to a different user',async()=>{
  const f=fixture();f.duringUpdate(f.change);await f.request()
  assert.equal(f.calls[0][1],'SYNTHETIC-a');assert.equal(f.calls.filter(x=>x[0]==='update').length,1)
})
test('Auth rejection is not treated as a completed change',async()=>{
  const f=fixture();f.fail();await assert.rejects(f.request(),e=>e.code==='email_exists')
})
