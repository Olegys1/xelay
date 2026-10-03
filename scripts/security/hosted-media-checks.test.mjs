import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { STAGING_ORIGIN,STAGING_REF,MEDIA_BUCKETS,parseHostedConfiguration,guardedHostedFetch,allowHostedRequest,
  HostedCleanupScope,deniedStorageResult,deniedDeleteResult,runHostedMediaChecks,guardedFinalRejection,
  sanitizedMediaDiagnostic,validateMediaReceipt,writeMediaReceipt } from './hosted-media-checks.mjs'
import { readFile,unlink } from 'node:fs/promises'

const token=(payload)=>`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.offline-signature`
const environment=()=>({XELAY_HOSTED_MEDIA_ANON_KEY:token({role:'anon',ref:STAGING_REF}),
  ...Object.fromEntries(['A','B','C'].map(who=>[`XELAY_HOSTED_MEDIA_USER_${who}_TOKEN`,token({role:'authenticated',
    iss:STAGING_ORIGIN+'/auth/v1',sub:randomUUID(),exp:Math.floor(Date.now()/1000)+1000})])),
  XELAY_HOSTED_MEDIA_CONVERSATION_ID:randomUUID(),XELAY_HOSTED_MEDIA_CHAT_SPACE_ID:randomUUID()})

test('hosted runner defaults to a dry run without credentials, SDK initialization or network',async()=>{
  let called=false
  const result=await runHostedMediaChecks(parseHostedConfiguration({},[]),{fetchImpl:()=>{called=true;throw Error('unexpected')},
    clientFactory:()=>{called=true;throw Error('unexpected')}})
  assert.equal(called,false);assert.equal(result.requests,0);assert.equal(result.pending,1);assert.equal(result.buckets,5)
})
test('hosted configuration rejects production/ref mismatch, service keys, expired or foreign tokens',()=>{
  const env=environment()
  assert.equal(parseHostedConfiguration(env,['--execute']).origin,STAGING_ORIGIN)
  for(const changed of [{XELAY_HOSTED_MEDIA_URL:'https://production.supabase.co'}, {XELAY_HOSTED_MEDIA_REF:'production'},
    {XELAY_HOSTED_MEDIA_ANON_KEY:'sb_secret_not_allowed_here'},
    {XELAY_HOSTED_MEDIA_ANON_KEY:token({role:'service_role',ref:STAGING_REF})},
    {XELAY_HOSTED_MEDIA_USER_A_TOKEN:token({role:'authenticated',iss:'https://production.supabase.co/auth/v1',sub:randomUUID(),exp:Date.now()})},
    {XELAY_HOSTED_MEDIA_USER_A_TOKEN:token({role:'authenticated',iss:STAGING_ORIGIN+'/auth/v1',sub:randomUUID(),exp:1})},
    {XELAY_HOSTED_MEDIA_USER_C_TOKEN:env.XELAY_HOSTED_MEDIA_USER_A_TOKEN}]) {
    assert.throws(()=>parseHostedConfiguration({...env,...changed},['--execute']),/CONFIGURATION_INVALID/)
  }
  assert.throws(()=>parseHostedConfiguration(env,['--cleanup']),/CONFIGURATION_INVALID/)
  assert.throws(()=>parseHostedConfiguration(env,['--execute','--live']),/CONFIGURATION_INVALID/)
})
test('request allowlist uses the five actual app buckets and excludes billing, auth mutations and foreign origins',()=>{
  for(const bucket of MEDIA_BUCKETS)assert.equal(allowHostedRequest(`${STAGING_ORIGIN}/storage/v1/object/${bucket}/fixture.png`,{method:'POST'}).method,'POST')
  for(const url of ['https://www.xelay.ink/api/billing/checkout','http://saufzpryybuawudohhwj.supabase.co/auth/v1/user',
    STAGING_ORIGIN+'.example.test/auth/v1/user',STAGING_ORIGIN+'/auth/v1/admin/users',STAGING_ORIGIN+'/rest/v1/rpc/xelay_create_checkout',
    STAGING_ORIGIN+'/storage/v1/object/xelay-seminar-files/fixture.pdf',STAGING_ORIGIN+'/storage/v1/object/direct-message-media/fixture.png']) {
    assert.throws(()=>allowHostedRequest(url,{method:'POST'}))
  }
  assert.throws(()=>allowHostedRequest(STAGING_ORIGIN+'/auth/v1/user',{method:'DELETE'}))
  assert.throws(()=>allowHostedRequest(STAGING_ORIGIN+'/rest/v1/conversations',{method:'POST'}))
  assert.throws(()=>allowHostedRequest(STAGING_ORIGIN+'/rest/v1/questions',{method:'DELETE'}))
})
test('request guard never follows redirects and sanitizes transport errors before any report',async()=>{
  let calls=0
  const redirect=guardedHostedFetch(async(_input,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://foreign.test/private-token'}})})
  await assert.rejects(redirect.fetch(STAGING_ORIGIN+'/auth/v1/user'),/RESPONSE_REDIRECT_DENIED/)
  assert.equal(calls,1)
  const secret='synthetic-sensitive-token-and-path'
  const failed=guardedHostedFetch(async()=>{throw Error(secret)})
  await assert.rejects(failed.fetch(STAGING_ORIGIN+'/auth/v1/user'),error=>error.message==='REQUEST_FAILED'&&!JSON.stringify(error).includes(secret))
})
test('request guard bounds concurrency, request count, file bytes and aggregate body bytes',async()=>{
  for(const changed of [{maxRequests:NaN},{maxDurationMs:Infinity},{requestTimeoutMs:0}])assert.throws(()=>guardedHostedFetch(undefined,changed),/CONFIGURATION_INVALID/)
  let calls=0
  const limited=guardedHostedFetch(async()=>{calls++;return new Response('{}')},{maxRequests:1})
  await limited.fetch(STAGING_ORIGIN+'/auth/v1/user')
  await assert.rejects(limited.fetch(STAGING_ORIGIN+'/auth/v1/user'),/REQUEST_BUDGET_EXCEEDED/)
  assert.equal(calls,1)
  const bodyLimited=guardedHostedFetch(async()=>new Response('{}'),{maxFileBytes:10})
  const form=new FormData();form.append('file',new Blob([Buffer.alloc(11)]))
  await assert.rejects(bodyLimited.fetch(STAGING_ORIGIN+'/storage/v1/object/avatars/fixture.png',{method:'POST',body:form}),/REQUEST_BODY_LIMIT/)
  assert.equal(bodyLimited.metrics().requests,0)
  let release
  const concurrent=guardedHostedFetch(()=>new Promise(resolve=>{release=resolve}))
  const first=concurrent.fetch(STAGING_ORIGIN+'/auth/v1/user')
  await assert.rejects(concurrent.fetch(STAGING_ORIGIN+'/auth/v1/user'),/CONCURRENT_REQUEST_DENIED/)
  release(new Response('{}'));await first
})
test('cleanup only allows this run registered paths/rows and refuses supplied fixture groups',()=>{
  const scope=new HostedCleanupScope(randomUUID(),randomUUID())
  for(const bucket of MEDIA_BUCKETS) {
    const path=scope.path(bucket,'fixture',randomUUID());scope.assertPath(bucket,path)
    assert.throws(()=>scope.assertPath(bucket,'foreign/existing.png'),/CLEANUP_SCOPE_DENIED/)
    const foreign=`${randomUUID()}/avatars/existing.png`
    scope.paths.set(`${bucket}:${foreign}`,{bucket,path:foreign})
    assert.throws(()=>scope.assertPath(bucket,foreign),/CLEANUP_SCOPE_DENIED/)
  }
  const id=randomUUID();scope.row('question',id);scope.assertRow('question',id)
  assert.throws(()=>scope.assertRow('question',randomUUID()),/CLEANUP_SCOPE_DENIED/)
  assert.throws(()=>scope.row('conversation',scope.conversationId),/CLEANUP_SCOPE_DENIED/)
})
test('Storage denials distinguish empty successful delete from mutation, expiry and server failures',()=>{
  for(const status of [400,403,404])assert.equal(deniedStorageResult({error:{status}}),true)
  for(const status of [401,409,429,500,503])assert.equal(deniedStorageResult({error:{status}}),false)
  assert.equal(deniedDeleteResult({data:[],error:null},'fixture'),true)
  assert.equal(deniedDeleteResult({data:[{name:'fixture'}],error:null},'fixture'),false)
  assert.equal(deniedDeleteResult({data:null,error:null},'fixture'),false)
})

test('known provider final SQL rejection is narrow and diagnostics discard raw fields',()=>{
  const raw='never-print@example.test/private-token/path'
  const expected={error:{name:'StorageApiError',status:500,statusCode:'DatabaseError',message:'database error, code: 22023'}}
  assert.equal(guardedFinalRejection(expected),true)
  for(const changed of [{status:503},{statusCode:'InternalError'},{message:'database error, code: 42501'},
    {name:'OtherError'},{message:`database error, code: 22023 ${raw}`}]) {
    assert.equal(guardedFinalRejection({error:{...expected.error,...changed}}),false)
  }
  assert.equal(deniedStorageResult(expected),false)
  const diagnostic=sanitizedMediaDiagnostic({error:{name:raw,code:raw,message:raw,originalError:{private:raw}}},
    {httpStatus:404,cacheState:raw,headers:raw})
  assert.equal(diagnostic.httpStatus,404)
  assert.equal(diagnostic.sdkName,'OtherError');assert.equal(diagnostic.errorCode,'OtherError')
  assert.equal(diagnostic.cacheState,'UNKNOWN');assert.equal(JSON.stringify(diagnostic).includes(raw),false)
  assert.equal(sanitizedMediaDiagnostic({data:{private:raw},error:null},{httpStatus:200,cacheState:'MISS'}).sdkName,'None')
})

test('owned media receipts are durable, token-free and reject widened paths/rows',async()=>{
  const scope=new HostedCleanupScope(randomUUID(),randomUUID()),path=scope.path('avatars','valid')
  const receipt={mode:'test1-media-check-owned',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId:scope.runId,
    fixtureRunId:randomUUID(),ownerId:scope.ownerId,conversationId:scope.conversationId,spaceId:randomUUID(),
    createdAt:new Date().toISOString(),stage:'prepared',paths:[{bucket:'avatars',path,phase:'upload_pending',reservationPending:true}],rows:[]}
  const local=new URL(`../../.security-audit.local/test1-media-check-receipt-${scope.runId}.json`,import.meta.url)
  try {
    await writeMediaReceipt(receipt)
    assert.deepEqual(JSON.parse(await readFile(local,'utf8')),receipt)
    assert.throws(()=>validateMediaReceipt({...receipt,serviceKey:'denied'}))
    assert.throws(()=>validateMediaReceipt({...receipt,paths:[{...receipt.paths[0],path:path.replace('/avatars/','/questions/') }]}))
    assert.throws(()=>validateMediaReceipt({...receipt,paths:[{...receipt.paths[0],path:path+'/extra' }]}))
    assert.throws(()=>validateMediaReceipt({...receipt,rows:[{kind:'conversation',id:scope.conversationId,phase:'created'}]}))
  } finally {await unlink(local).catch(()=>{})}
})

function providerMock(config,saved,{wrongIdentity=false,arbitraryFinalError=false,unreservedServerError=false}={}) {
  const blobs=new Map(),reservations=new Map(),rows=new Map(),nonces=[],runId=config.fixtureRunId
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cf-cache-status':'MISS'}})
  const denied=(status=403)=>json({message:'controlled denial',code:'AccessDenied'},status)
  const fetchImpl=async(input,init={})=>{
    const url=new URL(String(input)),method=init.method||'GET',headers=new Headers(init.headers)
    const who=Object.keys(config.users).find(label=>headers.get('authorization')===`Bearer ${config.users[label].token}`)
    const body=typeof init.body==='string'?JSON.parse(init.body):init.body
    if(url.pathname==='/auth/v1/user')return json({id:config.users[who].id,email_confirmed_at:'2026-01-01',
      app_metadata:wrongIdentity?{}:{xelay_security_fixture:'media-v1',xelay_security_run_id:runId,xelay_security_label:who}})
    if(url.pathname==='/rest/v1/conversations')return json(who==='C'?[]:[{id:config.conversationId,user_one_id:config.users.A.id,user_two_id:config.users.B.id}])
    if(url.pathname==='/rest/v1/chat_spaces')return json(who==='C'?[]:[{id:config.spaceId,kind:'group',visibility:'private'}])
    if(url.pathname.startsWith('/rest/v1/rpc/')) {
      const rpc=url.pathname.split('/').at(-1),key=`${body.p_bucket_id}:${body.p_storage_path}`
      if(rpc==='xelay_reserve_public_media_upload') {
        if(body.p_byte_size>(body.p_bucket_id==='avatars'?5242880:26214400))return json({code:'22023'},403)
        reservations.set(key,{size:body.p_byte_size,mime:body.p_mimetype});return json(null)
      }
      if(rpc==='xelay_private_reserve_media'){reservations.set(key,{size:26214400,mime:'image/png'});return json(null)}
      if(rpc==='xelay_cancel_public_media_upload'){reservations.delete(key);return json(null)}
      if(['xelay_send_direct_message','xelay_chat_send'].includes(rpc)) {
        if(body.p_attachments[0].mime_type!=='image/png')return json({code:'22023'},403)
        const path=body.p_attachments[0].storage_path,id=body.p_message_id||randomUUID()
        const blob=[...blobs.values()].find(item=>item.path===path);blob.linked=true
        rows.set(id,blob);return json(rpc==='xelay_chat_send'?id:{id})
      }
      const id=body.p_question_id||body.p_message_id||body.p_post_id
      if(rows.has(id)){rows.get(id).linked=false;rows.delete(id)}
      return json(null)
    }
    if(url.pathname==='/rest/v1/questions'){assert.equal(saved.at(-1).rows[0].id,body.id);return json({id:body.id,user_id:body.user_id},201)}
    if(url.pathname==='/rest/v1/answers')return json({id:randomUUID()},201)
    if(['/rest/v1/question_images','/rest/v1/answer_images'].includes(url.pathname))return who==='B'?json({code:'42501'},403):json(null,201)
    const parts=url.pathname.split('/').filter(Boolean),signed=parts[3]==='sign',publicRead=parts[3]==='public'
    const bucket=publicRead||signed?parts[4]:parts[3],path=parts.slice(publicRead||signed?5:4).join('/'),key=`${bucket}:${path}`
    if(method==='DELETE') {
      const removed=[]
      for(const path of body.prefixes) {
        const item=blobs.get(`${bucket}:${path}`)
        if(who==='A'&&item&&!item.linked){blobs.delete(`${bucket}:${path}`);removed.push({name:path})}
      }
      return json(removed)
    }
    if(signed&&method==='POST')return json({signedURL:`/object/sign/${bucket}/${path}?token=synthetic-offline`})
    if(['POST','PUT'].includes(method)) {
      if(who!=='A')return denied()
      const own=saved.at(-1).paths.find(item=>item.bucket===bucket&&item.path===path)
      assert.ok(own,'upload path intent persisted before the SDK sends data')
      if(method==='POST')assert.equal(own.phase,'upload_pending')
      const reserve=reservations.get(key)
      if(!reserve)return unreservedServerError?json({code:'InternalError',message:'controlled server failure'},500):denied()
      const upload=[...body.values()].find(value=>value instanceof Blob)
      if(upload.size>reserve.size)return json({code:arbitraryFinalError?'InternalError':'AccessDenied',
        message:arbitraryFinalError?'unexpected server error':'controlled final denial'},arbitraryFinalError?500:403)
      if(upload.type!==reserve.mime)return json({code:'22023',message:'controlled MIME mismatch'},400)
      reservations.delete(key);blobs.set(key,{path,data:await upload.arrayBuffer(),linked:false})
      return json({Id:randomUUID(),Key:bucket+'/'+path})
    }
    if(bucket.startsWith('xelay-')&&publicRead)return denied(404)
    const item=blobs.get(key)
    if(!publicRead&&!signed){assert.ok(UUID.test(url.searchParams.get('cacheNonce')||''));nonces.push(url.searchParams.get('cacheNonce'))}
    if(!item) {
      if(saved.at(-1)?.stage==='cleanup_running')assert.equal(saved.at(-1).paths.find(entry=>entry.bucket===bucket&&entry.path===path)?.phase,'remove_pending',
        'DELETE 200 remains pending durably until independent absence is confirmed')
      return denied(404)
    }
    if(bucket.startsWith('xelay-')&&!signed&&(who==='C'||who==='B'&&!item.linked))return denied()
    return new Response(item.data,{headers:{'content-type':'image/png','cf-cache-status':'MISS'}})
  }
  return {fetchImpl,blobs,reservations,nonces}
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

test('real SDK offline provider protocol covers multipart final rejection, cache-busted absence and scoped cleanup within budget',async()=>{
  const config={...parseHostedConfiguration(environment(),['--execute','--cleanup']),fixtureRunId:randomUUID()}
  const saved=[],mocked=providerMock(config,saved)
  const result=await runHostedMediaChecks(config,{fetchImpl:mocked.fetchImpl,receiptWriter:async receipt=>saved.push(structuredClone(receipt))})
  assert.equal(result.checksFailed,0,JSON.stringify(result.diagnostics.filter(item=>!item.passed)))
  assert.equal(result.cleanupFailed,0);assert.equal(result.pending,0)
  assert.ok(result.requests<=100);assert.equal(mocked.blobs.size,0);assert.equal(mocked.reservations.size,0)
  assert.equal(new Set(mocked.nonces).size,mocked.nonces.length)
  const rejection=result.diagnostics.find(item=>item.checkName==='answer_media_size_upload_denied')
  assert.equal(rejection.httpStatus,403);assert.equal(rejection.guardedFinalRejection,false)
  assert.equal(result.diagnostics.find(item=>item.checkName==='answer_media_size_absent').httpStatus,404)
  assert.equal(saved.at(-1).stage,'complete');assert.ok(saved.at(-1).paths.every(item=>item.phase==='removed'))
  for(const secret of [config.key,...Object.values(config.users).map(user=>user.token),...saved.at(-1).paths.map(item=>item.path)])assert.equal(JSON.stringify(result).includes(secret),false)
})

test('an arbitrary mismatch provider 500 remains FAIL while required absence and independent bucket checks continue',async()=>{
  const config={...parseHostedConfiguration(environment(),['--execute','--cleanup']),fixtureRunId:randomUUID()}
  const saved=[],mocked=providerMock(config,saved,{arbitraryFinalError:true})
  const result=await runHostedMediaChecks(config,{fetchImpl:mocked.fetchImpl,receiptWriter:async receipt=>saved.push(structuredClone(receipt))})
  assert.ok(result.checksPassed>43);assert.equal(result.checksFailed,1);assert.equal(result.pending,1)
  const failed=result.diagnostics.find(item=>!item.passed)
  assert.equal(failed.checkName,'answer_media_size_upload_denied');assert.equal(failed.errorCode,'InternalError')
  assert.equal(failed.guardedFinalRejection,false);assert.equal(result.cleanupFailed,0)
  assert.equal(result.diagnostics.find(item=>item.checkName==='answer_media_size_absent').passed,true)
  assert.equal(result.diagnostics.find(item=>item.checkName==='answer_media_mime_absent').passed,true)
  assert.equal(result.diagnostics.find(item=>item.checkName==='xelay_chat_media_linked_owner_bytes').passed,true)
  assert.equal(mocked.blobs.size,0);assert.equal(mocked.reservations.size,0)
})

test('an Auth user outside the immutable synthetic run cannot trigger cleanup or uploads',async()=>{
  const config={...parseHostedConfiguration(environment(),['--execute','--cleanup']),fixtureRunId:randomUUID()}
  const saved=[],mocked=providerMock(config,saved,{wrongIdentity:true})
  const result=await runHostedMediaChecks(config,{fetchImpl:mocked.fetchImpl,receiptWriter:async receipt=>saved.push(structuredClone(receipt))})
  assert.equal(result.requests,1);assert.equal(result.checksFailed,1);assert.equal(result.cleanupPassed,0)
  assert.equal(result.diagnostics[0].checkName,'auth_A');assert.equal(saved.at(-1).paths.length,0)
})

test('a 500 outside the two deliberate mismatch uploads still aborts the remaining checks',async()=>{
  const config={...parseHostedConfiguration(environment(),['--execute','--cleanup']),fixtureRunId:randomUUID()}
  const saved=[],mocked=providerMock(config,saved,{unreservedServerError:true})
  const result=await runHostedMediaChecks(config,{fetchImpl:mocked.fetchImpl,receiptWriter:async receipt=>saved.push(structuredClone(receipt))})
  assert.equal(result.checksPassed,9);assert.equal(result.checksFailed,1);assert.equal(result.pending,1)
  assert.equal(result.diagnostics.find(item=>!item.passed).checkName,'avatars_unreserved_denied')
  assert.equal(result.diagnostics.some(item=>item.checkName==='avatars_reserve'),false)
  assert.equal(mocked.blobs.size,0);assert.equal(result.cleanupFailed,0)
})

test('cleanup-only retries exact owned failed paths without replaying publication or upload checks',async()=>{
  const config={...parseHostedConfiguration(environment(),['--execute','--cleanup']),fixtureRunId:randomUUID()}
  const saved=[],mocked=providerMock(config,saved)
  const result=await runHostedMediaChecks(config,{fetchImpl:mocked.fetchImpl,receiptWriter:async receipt=>saved.push(structuredClone(receipt))})
  assert.equal(result.pending,0)
  const receipt=structuredClone(saved.at(-1)),entry=receipt.paths.find(item=>item.bucket==='avatars'&&item.path.endsWith('-valid.png'))
  entry.phase='remove_failed';receipt.stage='cleanup_pending'
  // Retry proof requires no real record lookup or bucket listing. Inject only
  // the exact path already registered durably by this synthetic run.
  mocked.blobs.set(`${entry.bucket}:${entry.path}`,{path:entry.path,data:Buffer.from('offline remaining body'),linked:false})
  const retried=await runHostedMediaChecks({...config,cleanupOnly:true,cleanupReceipt:receipt},
    {fetchImpl:mocked.fetchImpl,receiptWriter:async receipt=>saved.push(structuredClone(receipt))})
  assert.equal(retried.pending,0);assert.equal(retried.requests,5);assert.equal(retried.checksPassed,3)
  assert.equal(mocked.blobs.size,0);assert.equal(saved.at(-1).stage,'complete')
  assert.ok(retried.diagnostics.every(item=>/^auth_|^cleanup_/.test(item.checkName)))
  await assert.rejects(runHostedMediaChecks({...config,cleanupOnly:true,cleanupReceipt:{...receipt,fixtureRunId:randomUUID()}},
    {fetchImpl:()=>{throw Error('must not send')},receiptWriter:async()=>{}}),/CLEANUP_SCOPE_DENIED/)
})
