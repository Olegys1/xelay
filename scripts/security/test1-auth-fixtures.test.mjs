import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { STAGING_REF,STAGING_ORIGIN } from './hosted-media-checks.mjs'
import { validateTest1Key,parseFixtureArguments,syntheticIdentity,assertFixtureRequest,fixtureRequestTransport,
  runTest1AuthFixtures,TEST1_LOCAL_DIRECTORY,validateOwnedReceipt,FixtureSetupError,sanitizedFixtureFailure } from './test1-auth-fixtures.mjs'
import { mediaEnvironmentFromSession,runHostedMediaSession } from './run-hosted-media-session.mjs'
import { resolve } from 'node:path'
const token=(claims)=>`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.offline-signature`
const key=(role='anon',ref=STAGING_REF)=>token({role,ref,exp:Math.floor(Date.now()/1000)+3600})
const mode=()=>({mode:'test1-admin-fixtures',projectRef:STAGING_REF,origin:STAGING_ORIGIN,
  serviceKey:key('service_role'),publicKey:key()})
const copy=(value)=>JSON.parse(JSON.stringify(value))
function creatorMock() {
  const saved=[],users=new Map(),passwords=new Map()
  let calls=0
  const save=async(path,value)=>{saved.push({path,value:copy(value)})}
  const fetchImpl=async(url,init)=>{
    calls++;assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store')
    const path=new URL(url).pathname,body=init.body?JSON.parse(init.body):null
    if(path==='/auth/v1/admin/users') {
      assert.equal(body.email_confirm,true)
      assert.ok(body.email.endsWith('@example.test'))
      assert.equal(Object.hasOwn(body.user_metadata,'xelay_registration_version'),false)
      const receipt=saved.filter(item=>item.value.mode==='test1-media-owned-receipt').at(-1).value
      assert.equal(receipt.users.find(entry=>entry.email===body.email).status,'outcome_unknown')
      const user={id:randomUUID(),email:body.email,email_confirmed_at:new Date().toISOString(),
        user_metadata:body.user_metadata,app_metadata:body.app_metadata}
      users.set(user.id,user);passwords.set(body.email,body.password)
      return new Response(JSON.stringify(user))
    }
    if(path==='/auth/v1/token') {
      const user=[...users.values()].find(user=>user.email===body.email)
      assert.equal(passwords.get(body.email),body.password)
      const receipt=saved.filter(item=>item.value.mode==='test1-media-owned-receipt').at(-1).value
      assert.ok(receipt.users.some(entry=>entry.id===user.id&&entry.status==='created'),'durable UID before sign-in')
      return new Response(JSON.stringify({access_token:token({sub:user.id,role:'authenticated',
        iss:STAGING_ORIGIN+'/auth/v1',exp:Math.floor(Date.now()/1000)+3600}),refresh_token:'must-never-persist'}))
    }
    if(path==='/auth/v1/user') {
      const claims=JSON.parse(Buffer.from(init.headers.Authorization.split(' ')[1].split('.')[1],'base64url'))
      return new Response(JSON.stringify(users.get(claims.sub)))
    }
    throw Error('unexpected route')
  }
  return {saved,users,passwords,save,fetchImpl,metrics:()=>calls}
}
test('fixture setup and media wrapper dry runs never read credentials or perform network',async()=>{
  let called=false
  const fetchImpl=()=>{called=true;throw Error('unexpected')}
  const result=await runTest1AuthFixtures(parseFixtureArguments([]),{fetchImpl})
  assert.equal(called,false);assert.equal(result.requests,0);assert.equal(result.pending,1)
  assert.equal((await runHostedMediaSession({execute:false},{fetchImpl})).requests,0)
  assert.equal(called,false)
})
test('keys/arguments remain bound to isolated test1 and roles; existing credentials cannot be selected as user input',()=>{
  assert.equal(validateTest1Key(key('service_role'),'service_role'),key('service_role'))
  for(const [candidate,role] of [[key('service_role'),'anon'],[key('anon'),'service_role'],[key('service_role','production'),'service_role'],
    ['sb_secret_never_pass_into_media','anon'],[token({role:'service_role',ref:STAGING_REF,exp:1}),'service_role']]) {
    assert.throws(()=>validateTest1Key(candidate,role))
  }
  for(const args of [['--email','real@example.test'],['--password','secret'],['--mode-file','elsewhere'],['--cleanup-only'],['--receipt-file','file']]) {
    assert.throws(()=>parseFixtureArguments(args))
  }
})
test('request guard permits only planned synthetic creation/sign-in and explicitly owned admin user IDs',()=>{
  const runId=randomUUID(),identity=syntheticIdentity(runId,'A'),id=randomUUID(),known=new Set([id]),emails=new Set([identity.email])
  const body={email:identity.email,password:'a'.repeat(64),email_confirm:true,
    user_metadata:{username:identity.username,full_name:'Synthetic media A'},
    app_metadata:{xelay_security_fixture:'media-v1',xelay_security_run_id:runId,xelay_security_label:'A'}}
  assertFixtureRequest(STAGING_ORIGIN+'/auth/v1/admin/users',{method:'POST',body},known,emails)
  assertFixtureRequest(STAGING_ORIGIN+`/auth/v1/admin/users/${id}`,{method:'DELETE'},known)
  assert.throws(()=>assertFixtureRequest(STAGING_ORIGIN+`/auth/v1/admin/users/${randomUUID()}`,{method:'DELETE'},known))
  assert.throws(()=>assertFixtureRequest(STAGING_ORIGIN+'/auth/v1/admin/users',{method:'GET'},known))
  assert.throws(()=>assertFixtureRequest(STAGING_ORIGIN+'/auth/v1/admin/users',{method:'POST',body:{...body,email:'human@example.test'}},known,emails))
  for(const url of ['https://production.supabase.co/auth/v1/admin/users',STAGING_ORIGIN+'/auth/v1/signup',
    STAGING_ORIGIN+'/auth/v1/invite',STAGING_ORIGIN+'/auth/v1/admin/users/human',STAGING_ORIGIN+'/rest/v1/profiles']) {
    assert.throws(()=>assertFixtureRequest(url,{method:'POST',body},known,emails))
  }
})
test('three fresh accounts have durable receipt before subsequent HTTP; session excludes service key/password/refresh token',async()=>{
  const mocked=creatorMock(),admin=mode()
  const result=await runTest1AuthFixtures({execute:true,cleanup:false},{...mocked,adminMode:admin})
  assert.equal(result.created,3);assert.equal(result.verified,3);assert.equal(result.requests,9);assert.equal(result.pending,0)
  assert.equal(new Set(result.users.map(user=>user.id)).size,3)
  const session=mocked.saved.filter(item=>item.value.mode==='test1-media-sessions').at(-1).value
  assert.equal(Object.keys(session.users).length,3)
  const serialized=JSON.stringify(session),summary=JSON.stringify(result)
  assert.equal(serialized.includes(admin.serviceKey),false);assert.equal(serialized.includes('must-never-persist'),false)
  for(const password of mocked.passwords.values())assert.equal(serialized.includes(password),false)
  assert.equal(summary.includes('@example.test'),false);assert.equal(summary.includes('offline-signature'),false)
  assert.equal(mocked.saved.filter(item=>item.value.mode==='test1-media-owned-receipt').at(-1).value.users.every(entry=>entry.status==='verified'),true)
})
test('unknown creation outcome leaves durable intent and no retries or unowned account cleanup',async()=>{
  const saved=[]
  const result=await runTest1AuthFixtures({execute:true,cleanup:false},{adminMode:mode(),save:async(path,value)=>saved.push({path,value:copy(value)}),
    fetchImpl:async()=>{throw Error('secret-password/raw-email@example.test')}})
  assert.equal(result.requests,1);assert.equal(result.pending,1);assert.equal(result.failed,1);assert.equal(result.created,0)
  assert.equal(result.failureCode,'FIXTURE_REQUEST_FAILED');assert.equal(result.httpStatus,0)
  assert.equal(saved.at(-1).value.users[0].status,'outcome_unknown');assert.equal(saved.at(-1).value.users[0].id,null)
  assert.equal(JSON.stringify(result).includes('secret-password'),false)
})
test('failed HTTP reports only allowlisted code and numeric status, never parses or emits response error records',async()=>{
  const secret='password-and-real-email@example.test'
  const saved=[]
  const result=await runTest1AuthFixtures({execute:true,cleanup:false},{adminMode:mode(),
    save:async(path,value)=>saved.push({path,value:copy(value)}),
    fetchImpl:async()=>new Response(JSON.stringify({message:secret,user:{email:secret},code:secret}),{status:422})})
  assert.equal(result.failureCode,'FIXTURE_HTTP_FAILED');assert.equal(result.httpStatus,422)
  assert.equal(result.requests,1);assert.equal(result.created,0);assert.equal(result.pending,1)
  assert.equal(JSON.stringify(result).includes(secret),false)
  assert.equal(saved.at(-1).value.users[0].status,'outcome_unknown')
  assert.deepEqual(sanitizedFixtureFailure(new FixtureSetupError(secret,200)),{failureCode:'FIXTURE_REQUEST_FAILED',httpStatus:200})
  assert.deepEqual(sanitizedFixtureFailure(new FixtureSetupError('FIXTURE_HTTP_FAILED',secret)),{failureCode:'FIXTURE_HTTP_FAILED',httpStatus:0})
  assert.deepEqual(sanitizedFixtureFailure(Error(secret)),{failureCode:'FIXTURE_LOCAL_IO_FAILED',httpStatus:0})
  const tampered=new FixtureSetupError();tampered.code=secret;tampered.httpStatus=secret
  assert.deepEqual(sanitizedFixtureFailure(tampered),{failureCode:'FIXTURE_REQUEST_FAILED',httpStatus:0})
})
test('cleanup verifies remote immutable run identity and deletes only recorded synthetic UIDs, never the human signup account',async()=>{
  const mocked=creatorMock()
  const created=await runTest1AuthFixtures({execute:true,cleanup:false},{...mocked,adminMode:mode()})
  const receipt=mocked.saved.filter(item=>item.value.mode==='test1-media-owned-receipt').at(-1).value
  const receiptPath=resolve(TEST1_LOCAL_DIRECTORY,`test1-media-receipt-${created.runId}.json`)
  const deleted=[],saved=[],removedFiles=[]
  const fetchImpl=async(url,init)=>{
    const id=new URL(url).pathname.split('/').at(-1)
    assert.ok(mocked.users.has(id))
    if(init.method==='DELETE')deleted.push(id)
    return new Response(JSON.stringify(mocked.users.get(id)))
  }
  const result=await runTest1AuthFixtures({execute:true,cleanup:true,receiptPath},{adminMode:mode(),loadReceipt:async()=>copy(receipt),
    save:async(path,value)=>saved.push({path,value:copy(value)}),removeSession:async path=>removedFiles.push(path),fetchImpl})
  assert.equal(result.removed,3);assert.equal(result.requests,6);assert.equal(result.pending,0)
  assert.deepEqual(new Set(deleted),new Set(receipt.users.map(user=>user.id)))
  assert.equal(removedFiles.length,1);assert.ok(removedFiles[0].endsWith(`test1-media-session-${created.runId}.json`))
  const denied=await runTest1AuthFixtures({execute:true,cleanup:true,receiptPath},{adminMode:mode(),loadReceipt:async()=>copy(receipt),save:async()=>{},
    removeSession:async()=>{throw Error('must not remove')},fetchImpl:async()=>new Response(JSON.stringify({id:receipt.users[0].id,email:'human@example.test',
      user_metadata:{username:'security_smoke_mfa'},app_metadata:{}}))})
  assert.equal(denied.removed,0);assert.equal(denied.requests,1);assert.equal(denied.pending,1)
  assert.throws(()=>validateOwnedReceipt({...receipt,users:[...receipt.users.slice(0,2),{...receipt.users[0],label:'C'}]}))
})
test('session wrapper maps only media public key/JWT/fixture IDs and rejects extra secret fields or foreign runs',async()=>{
  const mocked=creatorMock()
  await runTest1AuthFixtures({execute:true,cleanup:false},{...mocked,adminMode:mode()})
  const session=mocked.saved.filter(item=>item.value.mode==='test1-media-sessions').at(-1).value
  const fixture={mode:'test1-media-fixtures',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId:session.runId,
    conversationId:randomUUID(),chatSpaceId:randomUUID()}
  const env=mediaEnvironmentFromSession(session,fixture)
  assert.equal(Object.keys(env).length,6);assert.ok(Object.keys(env).every(name=>name.startsWith('XELAY_HOSTED_MEDIA_')))
  assert.equal(Object.keys(env).some(name=>name.includes('SERVICE')),false)
  assert.throws(()=>mediaEnvironmentFromSession({...session,serviceKey:'never-propagate'},fixture))
  assert.throws(()=>mediaEnvironmentFromSession(session,{...fixture,runId:randomUUID()}))
  assert.throws(()=>mediaEnvironmentFromSession({...session,users:{...session.users,C:session.users.A}},fixture))
})
test('transport bounds requests/concurrency and refuses redirects without raw error leakage',async()=>{
  const transport=fixtureRequestTransport(async()=>new Response('{}'))
  for(let i=0;i<20;i++)await transport.request('/auth/v1/user','GET',{})
  await assert.rejects(transport.request('/auth/v1/user','GET',{}),/FIXTURE_REQUEST_LIMIT/)
  const redirected=fixtureRequestTransport(async(_url,init)=>{assert.equal(init.redirect,'manual');return new Response(null,{status:302})})
  await assert.rejects(redirected.request('/auth/v1/user','GET',{}),error=>error.code==='FIXTURE_REDIRECT_DENIED'&&error.httpStatus===302)
  const failed=fixtureRequestTransport(async()=>{throw Error('password and private-email@example.test')})
  await assert.rejects(failed.request('/auth/v1/user','GET',{}),error=>error.message==='FIXTURE_REQUEST_FAILED')
  const large=fixtureRequestTransport(async()=>new Response(' '.repeat(65537)))
  await assert.rejects(large.request('/auth/v1/user','GET',{}),/FIXTURE_RESPONSE_LIMIT/)
})
