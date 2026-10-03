// Offline Auth/PostgREST mocks only. No credential file, network or enrollment.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { STAGING_REF,STAGING_ORIGIN } from './hosted-media-checks.mjs'
import { syntheticIdentity,TEST1_LOCAL_DIRECTORY } from './test1-auth-fixtures.mjs'
import { parseMfaArguments,totpCode,assertMfaRequest,mfaTransport,runTest1MfaProbe,validateMfaRoleSeed,sanitizedMfaFailure } from './test1-mfa-probe.mjs'
import { FixtureSetupError } from './test1-auth-fixtures.mjs'
import { createFixture } from './fixture.mjs'
const copy=(value)=>JSON.parse(JSON.stringify(value))
const token=(claims)=>`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.offline-signature`
const SECRET='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const future=()=>Math.floor(Date.now()/1000)+3600
const response=(value,status=200,headers={})=>new Response(value==null?null:JSON.stringify(value),{status,headers})
function fixtureMock({allow='GET, HEAD, OPTIONS, POST, DELETE',failEnrollment=false,failRoleDelete=false,noServiceRoleRest=false,
  unrelatedFactor=false,saveFailure=false,enrollmentQrBytes=0,enrollmentMalformed=false,enrollmentMissingSecret=false}={}) {
  const runId=randomUUID(),receiptPath=resolve(TEST1_LOCAL_DIRECTORY,`test1-media-receipt-${runId}.json`)
  const sessionPath=resolve(TEST1_LOCAL_DIRECTORY,`test1-media-session-${runId}.json`)
  const receipt={mode:'test1-media-owned-receipt',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId,
    createdAt:new Date().toISOString(),users:['A','B','C'].map(label=>({...syntheticIdentity(runId,label),id:randomUUID(),status:'verified'}))}
  const entry=receipt.users[0],user={id:entry.id,email:entry.email,email_confirmed_at:new Date().toISOString(),
    user_metadata:{username:entry.username},app_metadata:{xelay_security_fixture:'media-v1',xelay_security_run_id:runId,xelay_security_label:'A'}}
  const adminMode={mode:'test1-admin-fixtures',projectRef:STAGING_REF,origin:STAGING_ORIGIN,
    publicKey:token({role:'anon',ref:STAGING_REF,exp:future()}),serviceKey:token({role:'service_role',ref:STAGING_REF,exp:future()})}
  const session={mode:'test1-media-sessions',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId,publicKey:adminMode.publicKey,
    users:Object.fromEntries(receipt.users.map(item=>[item.label,{id:item.id,accessToken:token({sub:item.id,role:'authenticated',
      iss:STAGING_ORIGIN+'/auth/v1',aal:'aal1',exp:future()}),expiresAt:future()}]))}
  const documents=new Map([[receiptPath,receipt],[sessionPath,session]]),saved=[],calls=[],factors=[],roles=[]
  let factorId=null,challengeId=randomUUID(),deleteFails=failRoleDelete
  const load=async(path)=>{assert.ok(documents.has(resolve(path)),'Known ignored mock document only');return copy(documents.get(resolve(path)))}
  const save=async(path,value,options)=>{
    if(saveFailure&&!options?.initial)throw Error('private-disk-error')
    saved.push({path,value:copy(value)});documents.set(resolve(path),copy(value))
  }
  const fetchImpl=async(input,init)=>{
    const url=new URL(input),body=init.body?JSON.parse(init.body):null
    assert.equal(url.origin,STAGING_ORIGIN);assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store')
    calls.push({method:init.method,path:url.pathname+url.search,body})
    if(noServiceRoleRest&&url.pathname==='/rest/v1/user_roles'){
      assert.equal(init.headers.apikey,adminMode.publicKey,'UI mode uses only A self-role SELECT')
      assert.equal(init.method,'GET','No REST role mutation or service OPTIONS in UI mode')
    }
    if(url.pathname==='/rest/v1/user_roles'&&init.method==='OPTIONS')return response(null,204,{Allow:allow})
    if(url.pathname===`/auth/v1/admin/users/${entry.id}`)return response(user)
    if(url.pathname===`/auth/v1/admin/users/${entry.id}/factors`)return response(factors)
    if(url.pathname===`/auth/v1/admin/users/${entry.id}/factors/${factorId}`&&init.method==='DELETE'){
      assert.ok(factors.some(factor=>factor.id===factorId));factors.splice(factors.findIndex(factor=>factor.id===factorId),1)
      return response(null,204)
    }
    if(url.pathname==='/auth/v1/user')return response({...user,factors})
    if(url.pathname==='/rest/v1/profiles')return response([{id:entry.id}])
    if(url.pathname==='/rest/v1/user_roles') {
      if(init.method==='POST'){
        assert.equal(saved.at(-1).value.stage,'role_planned');assert.equal(saved.at(-1).value.rolePending,true)
        roles.push({...body,granted_at:'2026-10-03T00:00:00Z'});return response([roles.at(-1)])
      }
      const id=url.searchParams.get('id')?.slice(3),actual=id?roles.filter(role=>role.id===id):roles
      if(init.method==='GET')return response(actual)
      if(init.method==='DELETE') {
        if(deleteFails){deleteFails=false;return response({code:'42501',message:'private-service-error'},403)}
        const removed=copy(actual);for(const role of actual)roles.splice(roles.indexOf(role),1)
        return response(removed)
      }
    }
    if(url.pathname==='/auth/v1/factors'&&init.method==='POST') {
      assert.equal(saved.at(-1).value.stage,'factor_planned');assert.equal(saved.at(-1).value.factorPending,true)
      factorId=randomUUID();factors.push({id:factorId,friendly_name:body.friendly_name,factor_type:'totp',status:'unverified'})
      if(unrelatedFactor)factors.push({id:randomUUID(),friendly_name:'unrelated-retain',factor_type:'totp',status:'verified'})
      if(failEnrollment)throw Error('private-server-secret '+SECRET)
      if(enrollmentMalformed)return new Response('{"secret":"'+SECRET+'" truncated',{status:200})
      return response({id:factorId,type:'totp',totp:{...(!enrollmentMissingSecret?{secret:SECRET}:{}),...(enrollmentQrBytes?
        {qr_code:'<svg>offline-private-QR-'+ 'q'.repeat(enrollmentQrBytes)+'</svg>'}:{})}})
    }
    if(url.pathname===`/auth/v1/factors/${factorId}/challenge`)return response({id:challengeId})
    if(url.pathname===`/auth/v1/factors/${factorId}/verify`) {
      assert.equal(body.challenge_id,challengeId)
      assert.ok([-30,0,30].some(offset=>body.code===totpCode(SECRET,Math.floor(Date.now()/1000)+offset)))
      factors.find(factor=>factor.id===factorId).status='verified'
      return response({access_token:token({sub:entry.id,role:'authenticated',iss:STAGING_ORIGIN+'/auth/v1',aal:'aal2',exp:future()}),
        refresh_token:'never-persist-this-refresh-token'})
    }
    if(url.pathname==='/rest/v1/rpc/xelay_admin_billing_overview') {
      assert.equal(init.method,'GET');assert.equal(body,null)
      const claims=JSON.parse(Buffer.from(init.headers.Authorization.split(' ')[1].split('.')[1],'base64url'))
      if(claims.aal!=='aal2'||!factors.some(factor=>factor.id===factorId&&factor.status==='verified'))return response({code:'42501',message:'private-denial'},403)
      return response({active_participants:0,orders:[],audit:[]})
    }
    throw Error('unexpected mocked route')
  }
  return {receipt,session,receiptPath,sessionPath,adminMode,entry,user,roles,factors,documents,saved,calls,load,save,fetchImpl,
    options:{execute:true,receiptPath,sessionPath},state:()=>saved.at(-1),factorId:()=>factorId}
}
function seedRole(mocked) {
  const probeId=randomUUID(),adminRoleId=randomUUID()
  const seed={mode:'test1-mfa-role-seed',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId:mocked.receipt.runId,
    probeId,userId:mocked.entry.id,adminRoleId,originalRoles:[],initialRoleBaselineEmpty:true,syntheticUserConfirmed:true,
    role:{id:adminRoleId,user_id:mocked.entry.id,role:'ADMIN',university_id:null,academic_unit_id:null,granted_by:null,
      granted_at:'2026-10-03T00:00:00Z'}}
  const path=resolve(TEST1_LOCAL_DIRECTORY,`test1-mfa-role-seed-${probeId}.json`)
  mocked.documents.set(path,copy(seed));mocked.roles.push(copy(seed.role));mocked.options.preseededRolePath=path
  return {seed,path}
}

test('MFA dry run and cleanup/preflight argument modes do not need user tokens',async()=>{
  let called=false
  const result=await runTest1MfaProbe(parseMfaArguments([]),{load:()=>{called=true},fetchImpl:()=>{called=true}})
  assert.equal(called,false);assert.equal(result.requests,0)
  assert.equal(parseMfaArguments(['--execute','--restore-only','--receipt-file','r','--state-file','s']).restoreOnly,true)
  assert.equal(parseMfaArguments(['--execute','--preflight-only','--receipt-file','r']).preflightOnly,true)
  assert.equal(parseMfaArguments(['--execute','--receipt-file','r','--session-file','s','--preseeded-role-file','p']).preseededRolePath,'p')
  for(const args of [['--execute'],['--execute','--restore-only','--receipt-file','r'],
    ['--execute','--preflight-only','--receipt-file','r','--state-file','s'],['--restore-only','--preflight-only'],['--origin','production']]){
    assert.throws(()=>parseMfaArguments(args))
  }
})
test('six-digit SHA1 TOTP matches independent RFC6238 reference vectors',()=>{
  for(const [seconds,expected] of [[59,'287082'],[1111111109,'081804'],[1111111111,'050471'],[1234567890,'005924'],
    [2000000000,'279037'],[20000000000,'353130']])assert.equal(totpCode(SECRET,seconds),expected)
  for(const secret of ['',SECRET.toLowerCase(),'!'.repeat(32)])assert.throws(()=>totpCode(secret,59))
})
test('MFA route guard permits only exact own role/factor and the read-only billing RPC',()=>{
  const userId=randomUUID(),probeId=randomUUID(),state={userId,adminRoleId:randomUUID(),factorId:randomUUID(),factorFriendlyName:`security_media_mfa_${probeId}`}
  const context={userId,state}
  assertMfaRequest(STAGING_ORIGIN+'/rest/v1/user_roles',{method:'OPTIONS'},context)
  assertMfaRequest(STAGING_ORIGIN+'/rest/v1/user_roles',{method:'POST',body:{id:state.adminRoleId,user_id:userId,role:'ADMIN',
    university_id:null,academic_unit_id:null,granted_by:null}},context)
  for(const [path,method,body] of [[`/auth/v1/admin/users/${randomUUID()}/factors/${state.factorId}`,'DELETE'],
    ['/rest/v1/user_roles','DELETE'],['/rest/v1/user_roles?user_id=eq.'+userId,'DELETE'],
    ['/rest/v1/rpc/xelay_create_billing_order','POST',{}],['/auth/v1/signup','POST',{}],
    ['/rest/v1/rpc/xelay_admin_billing_overview','POST',{}],['/rest/v1/user_roles','OPTIONS',{}]]){
    assert.throws(()=>assertMfaRequest(STAGING_ORIGIN+path,{method,body},context))
  }
  assert.throws(()=>assertMfaRequest('https://production.supabase.co/rest/v1/user_roles',{method:'OPTIONS'},context))
})
test('service preflight has zero mutations and fails closed without all required REST methods',async()=>{
  for(const allow of ['GET,HEAD,OPTIONS','GET,POST,OPTIONS','', 'GET,HEAD,OPTIONS,POST,DELETE']) {
    const mocked=fixtureMock({allow})
    const result=await runTest1MfaProbe({...mocked.options,sessionPath:null,preflightOnly:true},mocked)
    assert.equal(mocked.calls.filter(call=>['POST','DELETE'].includes(call.method)).length,0)
    assert.equal(mocked.saved.length,0)
    if(allow.includes('DELETE')){assert.equal(result.pending,0);assert.equal(result.requests,3);assert.equal(result.serviceRoleMethodsVerified,1)}
    else {assert.equal(result.failureCode,'MFA_PREFLIGHT_FAILED');assert.equal(result.requests,1);assert.equal(result.pending,1)}
  }
})
test('real migration chain supplies no implicit service-role permission for user_roles',async()=>{
  const fx=await createFixture({useStagingParity:true,through:'202610030012'})
  try {
    const row=(await fx.db.query(`select has_table_privilege('service_role','public.user_roles','SELECT') sel,
      has_table_privilege('service_role','public.user_roles','INSERT') ins,has_table_privilege('service_role','public.user_roles','DELETE') del`)).rows[0]
    assert.deepEqual(row,{sel:false,ins:false,del:false})
    const user=randomUUID(),other=randomUUID()
    await fx.seedUser(user,{username:'own_mfa_role'});await fx.seedUser(other,{username:'foreign_mfa_role'})
    await fx.db.query("insert into user_roles(user_id,role) values($1,'ADMIN'),($2,'ADMIN')",[user,other])
    const own=(await fx.asUser(user,'select id,user_id,role from user_roles')).rows
    assert.equal(own.length,1);assert.equal(own[0].user_id,user);assert.equal(own[0].role,'ADMIN')
  }finally{await fx.close()}
})
test('UI-seeded mode verifies exact A own role and uses no service REST role operation',async()=>{
  const mocked=fixtureMock({noServiceRoleRest:true}),{seed}=seedRole(mocked)
  const result=await runTest1MfaProbe(mocked.options,mocked)
  assert.equal(result.checksFailed,0);assert.equal(result.requests,17);assert.equal(result.pending,1)
  assert.equal(result.rolesRestored,0);assert.equal(result.roleAwaitingUiDelete,1);assert.equal(result.factorsRemoved,1)
  assert.deepEqual(mocked.roles,[seed.role]);assert.equal(mocked.factors.length,0)
  assert.equal(mocked.calls.filter(call=>call.path.startsWith('/rest/v1/user_roles')).length,1)
  assert.equal(mocked.state().value.roleMode,'ui_seeded');assert.equal(mocked.state().value.stage,'awaiting_ui_role_delete')
  assert.equal(mocked.state().value.rolePending,true);assert.equal(mocked.state().value.factorPending,false)
})
test('UI-seeded preflight never enrolls or writes state; mismatched role/baseline fails closed',async()=>{
  const mocked=fixtureMock({noServiceRoleRest:true}),{seed,path}=seedRole(mocked)
  const result=await runTest1MfaProbe({...mocked.options,preflightOnly:true},mocked)
  assert.equal(result.preseededRoleVerified,1);assert.equal(result.roleAwaitingUiDelete,1)
  assert.equal(result.requests,5);assert.equal(mocked.saved.length,0)
  assert.ok(mocked.calls.every(call=>call.method==='GET'))
  for(const altered of [{...seed,userId:randomUUID()},{...seed,initialRoleBaselineEmpty:false},
    {...seed,originalRoles:[seed.role]},{...seed,role:{...seed.role,university_id:randomUUID()}}]){
    assert.throws(()=>validateMfaRoleSeed(altered,mocked.receipt,mocked.entry),/MFA_SCOPE_DENIED/)
  }
  mocked.roles[0].id=randomUUID()
  const denied=await runTest1MfaProbe(mocked.options,mocked)
  assert.equal(denied.checksFailed,1);assert.equal(mocked.saved.length,0);assert.equal(mocked.factors.length,0)
  assert.ok(mocked.documents.has(path))
})
test('UI-seeded unknown enrollment result cleans only its factor and leaves exact role for UI removal',async()=>{
  const mocked=fixtureMock({noServiceRoleRest:true,failEnrollment:true,unrelatedFactor:true}),{seed}=seedRole(mocked)
  const result=await runTest1MfaProbe(mocked.options,mocked)
  assert.equal(result.failureCode,'MFA_NETWORK_FAILED');assert.equal(result.factorsRemoved,1)
  assert.equal(result.rolesRestored,0);assert.equal(result.roleAwaitingUiDelete,1)
  assert.deepEqual(mocked.roles,[seed.role]);assert.deepEqual(mocked.factors.map(factor=>factor.friendly_name),['unrelated-retain'])
  const saved=mocked.state(),before=mocked.calls.length
  const restored=await runTest1MfaProbe({execute:true,restoreOnly:true,receiptPath:mocked.receiptPath,statePath:saved.path},
    {...mocked,load:async(path)=>{assert.notEqual(resolve(path),mocked.sessionPath);return mocked.load(path)}})
  assert.equal(restored.roleAwaitingUiDelete,1);assert.equal(restored.rolesRestored,0);assert.equal(restored.pending,1)
  assert.ok(mocked.calls.slice(before).every(call=>!call.path.startsWith('/rest/v1/user_roles')))
})
test('only successful factor enrollment accepts bounded large QR JSON; diagnostics contain counts and labels only',async()=>{
  const mocked=fixtureMock({noServiceRoleRest:true,enrollmentQrBytes:524288});seedRole(mocked)
  const result=await runTest1MfaProbe(mocked.options,mocked)
  assert.equal(result.checksFailed,0);assert.equal(result.factorsRemoved,1)
  assert.equal(result.enrollmentResponseLimit,1048576);assert.equal(result.enrollmentResponseStatus,200)
  assert.ok(result.enrollmentResponseBytes>524288&&result.enrollmentResponseBytes<1048576)
  assert.ok(!JSON.stringify(result).includes(SECRET));assert.ok(!JSON.stringify(result).includes('offline-private-QR'))
  assert.ok(!JSON.stringify(mocked.saved).includes(SECRET));assert.ok(!JSON.stringify(mocked.saved).includes('offline-private-QR'))
})
test('oversized or malformed enrollment stays a failure with measured phase/bytes and exact factor cleanup',async()=>{
  for(const options of [{enrollmentQrBytes:1048576},{enrollmentMalformed:true}]){
    const mocked=fixtureMock({noServiceRoleRest:true,...options});seedRole(mocked)
    const result=await runTest1MfaProbe(mocked.options,mocked)
    assert.equal(result.failureCode,'MFA_RESPONSE_INVALID');assert.equal(result.checksFailed,1);assert.equal(result.pending,1)
    assert.equal(result.failurePhase,'factor_planned');assert.equal(result.lastEndpointLabel,'enroll_factor')
    assert.equal(result.httpStatus,200);assert.equal(result.lastResponseStatus,200);assert.equal(result.responseLimit,1048576)
    assert.equal(result.factorsRemoved,1);assert.equal(mocked.factors.length,0)
    assert.equal(result.enrollmentResponseBytes,result.responseBytes)
    assert.ok(options.enrollmentMalformed?result.responseBytes<65536:result.responseBytes>1048576)
    assert.ok(!JSON.stringify(result).includes(SECRET));assert.ok(!JSON.stringify(result).includes('truncated'))
    assert.ok(!JSON.stringify(mocked.saved).includes(SECRET))
  }
})
test('large enrollment response without a TOTP secret fails before challenge and cleans only its factor',async()=>{
  const mocked=fixtureMock({noServiceRoleRest:true,enrollmentQrBytes:524288,enrollmentMissingSecret:true});seedRole(mocked)
  const result=await runTest1MfaProbe(mocked.options,mocked)
  assert.equal(result.failureCode,'MFA_CHECK_FAILED');assert.equal(result.checksFailed,1)
  assert.equal(result.factorsRemoved,1);assert.equal(mocked.factors.length,0);assert.equal(result.pending,1)
  assert.equal(result.enrollmentResponseLimit,1048576);assert.equal(result.enrollmentResponseStatus,200)
  assert.ok(result.enrollmentResponseBytes>524288&&result.enrollmentResponseBytes<1048576)
  assert.ok(mocked.calls.every(call=>!call.path.endsWith('/challenge')&&!call.path.endsWith('/verify')))
  assert.ok(!JSON.stringify(result).includes('offline-private-QR'));assert.ok(!JSON.stringify(mocked.saved).includes('offline-private-QR'))
})
test('UI-mode request guard denies even exact role mutation paths',()=>{
  const mocked=fixtureMock(),{seed}=seedRole(mocked),context={userId:seed.userId,readonlyRoles:true,
    state:{adminRoleId:seed.adminRoleId,userId:seed.userId}}
  assert.throws(()=>assertMfaRequest(STAGING_ORIGIN+'/rest/v1/user_roles',{method:'POST',body:seed.role},context))
  const path=`/rest/v1/user_roles?select=id,user_id,role,university_id,academic_unit_id,granted_by,granted_at&id=eq.${seed.adminRoleId}`+
    `&user_id=eq.${seed.userId}&role=eq.ADMIN&university_id=is.null&academic_unit_id=is.null`
  assert.throws(()=>assertMfaRequest(STAGING_ORIGIN+path,{method:'DELETE'},context))
})
test('mocked genuine factor verifies AAL1 denial before/after enrollment, AAL2 success and exact cleanup',async()=>{
  const mocked=fixtureMock({unrelatedFactor:true})
  const result=await runTest1MfaProbe(mocked.options,mocked)
  assert.equal(result.checksFailed,0);assert.equal(result.pending,0);assert.equal(result.rolesRestored,1);assert.equal(result.factorsRemoved,1)
  assert.equal(result.requests,22);assert.equal(mocked.roles.length,0)
  assert.deepEqual(mocked.factors.map(factor=>factor.friendly_name),['unrelated-retain'])
  assert.equal(mocked.calls.filter(call=>call.path==='/rest/v1/rpc/xelay_admin_billing_overview').length,3)
  assert.equal(mocked.state().value.stage,'complete');assert.equal(mocked.state().value.rolePending,false);assert.equal(mocked.state().value.factorPending,false)
  const privateValues=[SECRET,mocked.adminMode.serviceKey,mocked.session.users.A.accessToken,'never-persist-this-refresh-token']
  for(const privateValue of privateValues){assert.ok(!JSON.stringify(mocked.saved).includes(privateValue));assert.ok(!JSON.stringify(result).includes(privateValue))}
})
test('lost enrollment response removes only durable exact friendly-name factor and restores role',async()=>{
  const mocked=fixtureMock({failEnrollment:true,unrelatedFactor:true})
  const result=await runTest1MfaProbe(mocked.options,mocked)
  assert.equal(result.failureCode,'MFA_NETWORK_FAILED');assert.equal(result.rolesRestored,1);assert.equal(result.factorsRemoved,1)
  assert.equal(mocked.roles.length,0);assert.deepEqual(mocked.factors.map(factor=>factor.friendly_name),['unrelated-retain'])
  assert.ok(!JSON.stringify(result).includes(SECRET));assert.ok(!JSON.stringify(mocked.saved).includes(SECRET))
})
test('cleanup resumes without loading expired/revoked user sessions after a role-delete failure',async()=>{
  const mocked=fixtureMock({failRoleDelete:true})
  const initial=await runTest1MfaProbe(mocked.options,mocked)
  assert.equal(initial.restoreFailed,1);assert.equal(initial.pending,1);assert.equal(initial.factorsRemoved,1)
  assert.equal(mocked.roles.length,1);assert.equal(mocked.factors.length,0)
  const saved=mocked.state(),before=mocked.calls.length
  const load=async(path)=>{assert.notEqual(resolve(path),mocked.sessionPath,'Restore never loads sessions');return mocked.load(path)}
  const restored=await runTest1MfaProbe({execute:true,restoreOnly:true,receiptPath:mocked.receiptPath,statePath:saved.path}, {...mocked,load})
  assert.equal(restored.pending,0);assert.equal(restored.checksFailed,0);assert.equal(restored.rolesRestored,1)
  assert.equal(mocked.roles.length,0)
  assert.ok(mocked.calls.slice(before).every(call=>!['/auth/v1/user','/auth/v1/factors'].includes(call.path)))
})
test('post-intent disk failure does not block cleanup of an already-created temporary role',async()=>{
  const mocked=fixtureMock({saveFailure:true})
  const result=await runTest1MfaProbe(mocked.options,mocked)
  assert.equal(result.pending,1);assert.equal(result.stateSaveFailed,1);assert.equal(result.rolesRestored,1)
  assert.equal(mocked.roles.length,0);assert.equal(mocked.factors.length,0)
  assert.equal(mocked.saved.length,1);assert.equal(mocked.saved[0].value.stage,'role_planned')
})
test('wrong immutable Auth marker aborts before privileged mutation or state creation',async()=>{
  const mocked=fixtureMock();mocked.user.app_metadata.xelay_security_fixture='different-owner'
  const result=await runTest1MfaProbe(mocked.options,mocked)
  assert.equal(result.failureCode,'MFA_SCOPE_DENIED');assert.equal(mocked.saved.length,0)
  assert.ok(mocked.calls.every(call=>['GET','OPTIONS'].includes(call.method)))
})
test('transport reserves cleanup requests/time and denies redirects, oversized responses and concurrent work',async()=>{
  const context={userId:randomUUID(),state:null},path='/rest/v1/user_roles',fetchImpl=async()=>response(null,204,{Allow:'GET'})
  let milliseconds=0
  const transport=mfaTransport(fetchImpl,context,{now:()=>milliseconds})
  for(let i=0;i<15;i++)await transport.request(path,'OPTIONS',{})
  await assert.rejects(transport.request(path,'OPTIONS',{}),/MFA_REQUEST_LIMIT/)
  transport.beginRestore()
  for(let i=0;i<9;i++)await transport.request(path,'OPTIONS',{})
  await assert.rejects(transport.request(path,'OPTIONS',{}),/MFA_REQUEST_LIMIT/)
  const timed=mfaTransport(fetchImpl,context,{now:()=>milliseconds});milliseconds=50000
  await assert.rejects(timed.request(path,'OPTIONS',{}),/MFA_REQUEST_LIMIT/)
  timed.beginRestore();await timed.request(path,'OPTIONS',{});milliseconds=120000
  await assert.rejects(timed.request(path,'OPTIONS',{}),/MFA_REQUEST_LIMIT/)
  const redirected=mfaTransport(async()=>new Response(null,{status:302,headers:{Location:'https://production.supabase.co'}}),context)
  await assert.rejects(redirected.request(path,'OPTIONS',{}),/MFA_REQUEST_DENIED/)
  const oversized=mfaTransport(async()=>new Response('x'.repeat(65537)),context)
  await assert.rejects(oversized.request('/auth/v1/user','GET',{}),/MFA_RESPONSE_INVALID/)
  let release
  const pending=mfaTransport(()=>new Promise(resolve=>{release=resolve}),context)
  const first=pending.request(path,'OPTIONS',{})
  await assert.rejects(pending.request(path,'OPTIONS',{}),/MFA_REQUEST_LIMIT/)
  release(response(null,204,{Allow:'GET'}));await first
})

test('expired or malformed session validation is a safe MFA_SESSION_INVALID before network or state writes',async()=>{
  for(const malformed of [false,true]){
    const mocked=fixtureMock(),old=mocked.session.users.A,exp=Math.floor(Date.now()/1000)-600
    old.expiresAt=exp;old.accessToken=malformed?'malformed-private-token':token({sub:old.id,role:'authenticated',
      iss:STAGING_ORIGIN+'/auth/v1',aal:'aal1',exp})
    await assert.rejects(runTest1MfaProbe(mocked.options,mocked),error=>{
      const result=sanitizedMfaFailure(error)
      assert.equal(result.failureCode,'MFA_SESSION_INVALID');assert.equal(result.failurePhase,'session_validate')
      assert.ok(!JSON.stringify(result).includes(old.accessToken));return true
    })
    assert.equal(mocked.calls.length,0);assert.equal(mocked.saved.length,0)
  }
  assert.deepEqual(sanitizedMfaFailure(new FixtureSetupError()),{failureCode:'MFA_CONFIGURATION_INVALID',httpStatus:0})
  assert.deepEqual(sanitizedMfaFailure(new Error('private-path-key')), {failureCode:'MFA_LOCAL_IO_FAILED',httpStatus:0})
})
