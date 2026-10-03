// Offline mocks only: no credential files, Auth requests or recovery events.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { STAGING_REF,STAGING_ORIGIN } from './hosted-media-checks.mjs'
import { syntheticIdentity,TEST1_LOCAL_DIRECTORY } from './test1-auth-fixtures.mjs'
import { OWNED_REFRESH_RUN,parseRefreshArguments,validateExpiredOwnedSession,assertRefreshRequest,
  refreshTransport,runTest1SessionRefresh } from './test1-session-refresh.mjs'
const copy=value=>JSON.parse(JSON.stringify(value))
const token=claims=>`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.offline-signature`
const nowSeconds=()=>Math.floor(Date.now()/1000)
const response=(data,status=200)=>new Response(JSON.stringify(data),{status})
function fixture({wrongMarker=false,missingDuringGenerate=false,wrongVerifiedUser=false,aal2=false,backupFails=false}={}){
  const receipt={mode:'test1-media-owned-receipt',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId:OWNED_REFRESH_RUN,
    createdAt:new Date().toISOString(),users:['A','B','C'].map(label=>({...syntheticIdentity(OWNED_REFRESH_RUN,label),id:randomUUID(),status:'verified'}))}
  const user=entry=>({id:entry.id,email:entry.email,email_confirmed_at:new Date().toISOString(),
    user_metadata:{username:entry.username},app_metadata:{xelay_security_fixture:wrongMarker?'wrong':'media-v1',
      xelay_security_run_id:OWNED_REFRESH_RUN,xelay_security_label:entry.label},factors:[]})
  const claims=(entry,exp,aal='aal1')=>({sub:entry.id,exp,aal,role:'authenticated',iss:STAGING_ORIGIN+'/auth/v1'})
  const adminMode={mode:'test1-admin-fixtures',projectRef:STAGING_REF,origin:STAGING_ORIGIN,
    publicKey:token({ref:STAGING_REF,role:'anon',exp:nowSeconds()+3600}),
    serviceKey:token({ref:STAGING_REF,role:'service_role',exp:nowSeconds()+3600})}
  const previous={mode:'test1-media-sessions',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId:OWNED_REFRESH_RUN,
    publicKey:adminMode.publicKey,users:Object.fromEntries(receipt.users.map(entry=>[entry.label,
      {id:entry.id,accessToken:token(claims(entry,nowSeconds()-600)),expiresAt:nowSeconds()-600}]))}
  const receiptPath=resolve(TEST1_LOCAL_DIRECTORY,`test1-media-receipt-${OWNED_REFRESH_RUN}.json`)
  const sessionPath=resolve(TEST1_LOCAL_DIRECTORY,`test1-media-session-${OWNED_REFRESH_RUN}.json`)
  const documents=new Map([[receiptPath,receipt],[sessionPath,previous]]),saved=[],calls=[],hashes=new Map()
  const load=async(path)=>{assert.ok(documents.has(resolve(path)));return copy(documents.get(resolve(path)))}
  const save=async(path,value,options={})=>{
    if(backupFails&&path.includes('backup'))throw Error('private-path-service-secret')
    if(options.initial)assert.ok(!documents.has(path),'No existing private receipt overwrite')
    saved.push({path,value:copy(value),options});documents.set(path,copy(value))
  }
  const fetchImpl=async(input,init)=>{
    const url=new URL(input),body=init.body?JSON.parse(init.body):null
    assert.equal(url.origin,STAGING_ORIGIN);assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store')
    assert.ok(saved.some(item=>item.path.includes('receipt-backup')));assert.ok(saved.some(item=>item.path.includes('session-backup')))
    const intent=saved.filter(item=>item.value.mode==='test1-session-refresh-owned').at(-1).value
    assert.equal(intent.requests.length,calls.length+1,'Intent precedes HTTP')
    calls.push({path:url.pathname,method:init.method,body})
    const entry=receipt.users.find(item=>url.pathname===`/auth/v1/admin/users/${item.id}`||url.pathname===`/auth/v1/admin/users/${item.id}/factors`)
    if(entry)return response(url.pathname.endsWith('/factors')?[]:user(entry))
    if(url.pathname==='/auth/v1/admin/generate_link'){
      assert.equal(init.headers.apikey,adminMode.serviceKey);assert.equal(body.type,'recovery');assert.deepEqual(Object.keys(body).sort(),['email','type'])
      if(missingDuringGenerate)return response({message:'private-account-response'},404)
      const found=receipt.users.find(item=>item.email===body.email);assert.ok(found)
      const hash=found.label.repeat(64);hashes.set(hash,found)
      return response({...user(found),verification_type:'recovery',hashed_token:hash,email_otp:'12345678',
        action_link:'https://foreign.invalid/?token=private-do-not-follow',redirect_to:'https://foreign.invalid/'})
    }
    if(url.pathname==='/auth/v1/verify'){
      assert.equal(init.headers.apikey,adminMode.publicKey);assert.equal(body.type,'recovery')
      const found=hashes.get(body.token_hash);assert.ok(found)
      return response({access_token:token(claims(wrongVerifiedUser?receipt.users[1]:found,nowSeconds()+3600,aal2?'aal2':'aal1')),
        refresh_token:'private-refresh-token',expires_in:3600,user:user(found)})
    }
    if(url.pathname==='/auth/v1/user'){
      assert.equal(init.headers.apikey,adminMode.publicKey)
      const access=init.headers.Authorization.slice(7),sub=JSON.parse(Buffer.from(access.split('.')[1],'base64url')).sub
      return response(user(receipt.users.find(item=>item.id===sub)))
    }
    throw Error('Unexpected offline route')
  }
  return {options:{execute:true,receiptPath,sessionPath},receipt,previous,adminMode,documents,saved,calls,load,save,fetchImpl}
}

test('dry run does not read private files or issue requests; only exact argument flags accepted',async()=>{
  const invalid=async()=>{throw Error('Must not read')}
  const result=await runTest1SessionRefresh(parseRefreshArguments([]),{load:invalid,fetchImpl:invalid})
  assert.equal(result.requests,0);assert.equal(result.sessionReplaced,0)
  assert.throws(()=>parseRefreshArguments(['--execute']));assert.throws(()=>parseRefreshArguments(['--password','x']))
})
test('expired owned sessions are only backup data and cannot broaden identity or run scope',()=>{
  const mocked=fixture();assert.equal(validateExpiredOwnedSession(mocked.previous,mocked.receipt),mocked.previous)
  for(const altered of [{...mocked.previous,runId:randomUUID()},{...mocked.previous,origin:'https://production.supabase.co'},
    {...mocked.previous,users:{...mocked.previous.users,A:{...mocked.previous.users.A,id:randomUUID()}}}])
    assert.throws(()=>validateExpiredOwnedSession(altered,mocked.receipt))
})
test('three recovery sessions require current exact Auth identities and replace session only after15requests',async()=>{
  const mocked=fixture(),originalReceipt=copy(mocked.receipt),originalSession=copy(mocked.previous)
  const result=await runTest1SessionRefresh(mocked.options,mocked)
  assert.equal(result.verified,3);assert.equal(result.recoveryEvents,3);assert.equal(result.requests,15)
  assert.equal(result.sessionReplaced,1);assert.equal(result.backupsSaved,2);assert.equal(result.pending,0)
  assert.deepEqual(mocked.documents.get(mocked.options.receiptPath),originalReceipt)
  assert.deepEqual(mocked.saved.find(item=>item.path.includes('session-backup')).value,originalSession)
  assert.equal(mocked.documents.get(mocked.options.sessionPath).users.A.id,mocked.previous.users.A.id)
  assert.equal(mocked.saved.filter(item=>item.path===mocked.options.sessionPath).length,1)
  for(const item of mocked.saved)assert.ok(!JSON.stringify(item.value).includes('private-refresh-token'))
  for(const value of [mocked.adminMode.serviceKey,'12345678','private-do-not-follow',mocked.receipt.users[0].email])assert.ok(!JSON.stringify(result).includes(value))
  assert.ok(mocked.calls.every(call=>!call.path.includes('/token')&&!call.path.includes('/otp')&&!call.path.includes('/logout')&&!call.path.includes('/rest/')))
})
test('wrong immutable marker fails before generate and never replaces old session',async()=>{
  const mocked=fixture({wrongMarker:true}),result=await runTest1SessionRefresh(mocked.options,mocked)
  assert.equal(result.failureCode,'REFRESH_SCOPE_DENIED');assert.equal(result.requests,1)
  assert.equal(result.recoveryEvents,0);assert.equal(result.sessionReplaced,0)
  assert.deepEqual(mocked.documents.get(mocked.options.sessionPath),mocked.previous)
})
test('provider missing user404 remains failed with no create/send/password fallback',async()=>{
  const mocked=fixture({missingDuringGenerate:true}),result=await runTest1SessionRefresh(mocked.options,mocked)
  assert.equal(result.failureCode,'REFRESH_HTTP_FAILED');assert.equal(result.httpStatus,404)
  assert.equal(result.requests,3);assert.equal(result.recoveryEvents,0);assert.equal(result.pending,1)
  assert.ok(!mocked.calls.some(call=>call.path==='/auth/v1/admin/users'));assert.equal(result.sessionReplaced,0)
  assert.ok(!JSON.stringify(result).includes('private-account-response'))
})
test('different verified UID or unexpectedAAL2 fail without replacing session or exporting response secrets',async()=>{
  for(const options of [{wrongVerifiedUser:true},{aal2:true}]){
    const mocked=fixture(options),result=await runTest1SessionRefresh(mocked.options,mocked)
    assert.equal(result.failureCode,'REFRESH_SESSION_INVALID');assert.equal(result.verified,0)
    assert.equal(result.sessionReplaced,0);assert.equal(result.pending,1);assert.equal(result.requests,4)
    assert.deepEqual(mocked.documents.get(mocked.options.sessionPath),mocked.previous)
  }
})
test('backup failure prohibits HTTP; failed network never prints raw response or credentials',async()=>{
  const backup=fixture({backupFails:true}),failed=await runTest1SessionRefresh(backup.options,backup)
  assert.equal(failed.requests,0);assert.equal(failed.sessionReplaced,0);assert.equal(failed.failureCode,'REFRESH_LOCAL_IO_FAILED')
  const mocked=fixture();mocked.fetchImpl=async()=>{throw Error(mocked.adminMode.serviceKey)}
  const result=await runTest1SessionRefresh(mocked.options,mocked)
  assert.equal(result.failureCode,'REFRESH_NETWORK_FAILED');assert.ok(!JSON.stringify(result).includes(mocked.adminMode.serviceKey))
})
test('request guard allows only checked recovery identities and memory-issued hashes, never mail/signout/newusers',()=>{
  const mocked=fixture(),entry=mocked.receipt.users[0],context={entries:new Map([[entry.label,entry]]),checked:new Set(),hashes:new Map()}
  const url=STAGING_ORIGIN+'/auth/v1/admin/generate_link',options={method:'POST',phase:'generate_recovery',label:'A',body:{type:'recovery',email:entry.email}}
  assert.throws(()=>assertRefreshRequest(url,options,context));context.checked.add('A');assertRefreshRequest(url,options,context)
  for(const changed of [{...options,body:{type:'magiclink',email:entry.email}},{...options,body:{...options.body,password:'not-allowed'}},
    {...options,body:{type:'recovery',email:'human@example.test'}}])assert.throws(()=>assertRefreshRequest(url,changed,context))
  for(const path of ['/auth/v1/otp','/auth/v1/logout','/auth/v1/admin/users','/rest/v1/user_roles'])
    assert.throws(()=>assertRefreshRequest(STAGING_ORIGIN+path,options,context))
  assert.throws(()=>assertRefreshRequest('https://production.supabase.co/auth/v1/admin/generate_link',options,context))
  const verify={method:'POST',phase:'verify_recovery',label:'A',body:{type:'recovery',token_hash:'a'.repeat(64)}}
  assert.throws(()=>assertRefreshRequest(STAGING_ORIGIN+'/auth/v1/verify',verify,context));context.hashes.set('A',verify.body.token_hash)
  assertRefreshRequest(STAGING_ORIGIN+'/auth/v1/verify',verify,context)
})
test('transport enforces16sequentialrequests90s, redirection and64KiB response bounds',async()=>{
  const mocked=fixture(),entry=mocked.receipt.users[0],context={entries:new Map([['A',entry]]),checked:new Set(),hashes:new Map()}
  const path=`/auth/v1/admin/users/${entry.id}`,args=[path,'GET',{},null,'identity_preflight','A']
  const transport=refreshTransport(async()=>response({}),context)
  for(let i=0;i<16;i++)await transport.request(...args)
  await assert.rejects(transport.request(...args),/REFRESH_REQUEST_LIMIT/)
  let time=0;const timed=refreshTransport(async()=>response({}),context,{now:()=>time});time=90000
  await assert.rejects(timed.request(...args),/REFRESH_REQUEST_LIMIT/)
  const redirect=refreshTransport(async()=>new Response(null,{status:302,headers:{Location:'https://foreign.invalid/'}}),context)
  await assert.rejects(redirect.request(...args),/REFRESH_REQUEST_DENIED/)
  const oversized=refreshTransport(async()=>new Response('x'.repeat(65537)),context)
  await assert.rejects(oversized.request(...args),/REFRESH_RESPONSE_LIMIT/)
})
