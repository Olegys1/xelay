// Prepared, not HTTP-verified. The only supported host is the disposable test1
// project below. No sign-up, password changes, service key, billing or SQL API.
// Default: node scripts/security/hosted-media-checks.mjs (no network).
// Explicit integration run: append --execute; append --cleanup to remove only
// this run's new publications and exact registered media paths afterwards.
// Required isolated env: XELAY_HOSTED_MEDIA_ANON_KEY, USER_A_TOKEN,
// USER_B_TOKEN, USER_C_TOKEN (all prefixed XELAY_HOSTED_MEDIA_),
// CONVERSATION_ID (A+B), CHAT_SPACE_ID (private A+B; C absent).
import { createHash, randomUUID } from 'node:crypto'
import { lstat,readFile,realpath,open,rename,unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve,sep } from 'node:path'

export const STAGING_REF='saufzpryybuawudohhwj'
export const STAGING_ORIGIN=`https://${STAGING_REF}.supabase.co`
export const MEDIA_BUCKETS=Object.freeze(['avatars','question-images','answer-media','xelay-message-media','xelay-chat-media'])
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG2kAAAAASUVORK5CYII=','base64')
const RPCS=new Set(['xelay_reserve_public_media_upload','xelay_cancel_public_media_upload','xelay_private_reserve_media',
  'xelay_send_direct_message','xelay_chat_send','xelay_delete_own_question','xelay_delete_message','xelay_chat_delete_post'])
const TABLES=new Set(['questions','answers','question_images','answer_images','conversations','chat_spaces','chat_members','messages'])
const LOCAL=resolve(fileURLToPath(new URL('../../',import.meta.url)),'.security-audit.local')
const SAFE_ERRORS=new Set(['CHECK_FAILED','CONFIGURATION_INVALID','REQUEST_ORIGIN_DENIED','REQUEST_METHOD_DENIED',
  'REQUEST_ROUTE_DENIED','REQUEST_BODY_DENIED','CONCURRENT_REQUEST_DENIED','REQUEST_BUDGET_EXCEEDED','REQUEST_BODY_LIMIT',
  'RESPONSE_REDIRECT_DENIED','RESPONSE_ORIGIN_DENIED','REQUEST_FAILED','CLEANUP_SCOPE_DENIED','RECEIPT_IO_FAILED'])
const SAFE_SDK_NAMES=new Set(['StorageError','StorageApiError','StorageUnknownError','AuthApiError','AuthUnknownError',
  'AuthSessionMissingError','AuthRetryableFetchError','AuthInvalidJwtError','HostedCheckError'])
const SAFE_PROVIDER_CODES=new Set(['AccessDenied','NoSuchBucket','NoSuchKey','NotFound','InvalidRequest','InvalidMimeType',
  'InvalidUploadId','KeyAlreadyExists','ResourceAlreadyExists','ResourceLocked','DatabaseError','InternalError',
  'UnknownError','EntityTooLarge','InvalidJWT','MissingContentLength','InvalidSignature','JWTExpired','42501','22023',
  'P0001','54000','PGRST116'])

// Never emit arbitrary SDK messages, code/name strings, object names or URLs.
// HTTP status is taken from the transport separately: SDK wrapping can otherwise
// lose it (for example a BlobDownloadBuilder around a transport error).
export function sanitizedMediaDiagnostic(result,lastResponse={}) {
  const error=result instanceof Response?null:result&&Object.hasOwn(result,'error')?result.error:result
  const status=Number(error?.status||(/^[1-5][0-9]{2}$/.test(String(error?.statusCode))?error.statusCode:0)||lastResponse.httpStatus)
  const code=error?.code||error?.statusCode||error?.originalError?.code
  return {httpStatus:Number.isInteger(status)&&status>=100&&status<=599?status:0,
    sdkName:SAFE_SDK_NAMES.has(error?.name)?error.name:error?'OtherError':'None',
    errorCode:SAFE_ERRORS.has(code)||SAFE_PROVIDER_CODES.has(code)||/^[1-5][0-9]{2}$/.test(String(code))?String(code):error?'OtherError':'None',
    guardedFinalRejection:guardedFinalRejection(result),
    cacheState:['HIT','MISS','EXPIRED','DYNAMIC','BYPASS','REVALIDATED','STALE'].includes(lastResponse.cacheState)?lastResponse.cacheState:'UNKNOWN'}
}

// Supabase Storage 1.77.5 maps a custom final-write SQL 22023 to HTTP 500.
// This narrowly observed provider case is distinct from successful persistence
// or arbitrary server errors. The runner still independently checks absence.
export function guardedFinalRejection(result) {
  const error=result?.error
  return error?.name==='StorageApiError'&&Number(error.status)===500
    &&(error.statusCode==='DatabaseError'||error.code==='DatabaseError')
    &&error.message==='database error, code: 22023'
}

export async function writeMediaReceipt(receipt) {
  validateMediaReceipt(receipt)
  const target=resolve(LOCAL,`test1-media-check-receipt-${receipt.runId}.json`)
  let temporary
  try {
    reject((await lstat(LOCAL)).isSymbolicLink(),'RECEIPT_IO_FAILED')
    const root=resolve(LOCAL,'..')
    reject(!(await readFile(resolve(root,'.gitignore'),'utf8')).split(/\r?\n/).some(line=>line.trim()==='*.local'),'RECEIPT_IO_FAILED')
    const dir=await realpath(LOCAL)
    reject(!target.startsWith(dir+sep),'RECEIPT_IO_FAILED')
    try {reject((await lstat(target)).isSymbolicLink(),'RECEIPT_IO_FAILED')}catch(error){if(error.code!=='ENOENT')throw error}
    temporary=target+`.${randomUUID()}.tmp`
    const handle=await open(temporary,'wx',0o600)
    try {await handle.writeFile(JSON.stringify(receipt));await handle.sync()}finally{await handle.close()}
    await rename(temporary,target);temporary=null
  } catch {throw new HostedCheckError('RECEIPT_IO_FAILED')}
  finally {if(temporary)await unlink(temporary).catch(()=>{})}
}

export function validateMediaReceipt(receipt) {
  const fields=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key))
  reject(!fields(receipt,['mode','projectRef','origin','runId','fixtureRunId','ownerId','conversationId','spaceId','createdAt','stage','paths','rows'])
    ||receipt.mode!=='test1-media-check-owned'||receipt.projectRef!==STAGING_REF||receipt.origin!==STAGING_ORIGIN
    ||!UUID.test(receipt.runId||'')||!UUID.test(receipt.ownerId||'')||!UUID.test(receipt.conversationId||'')||!UUID.test(receipt.spaceId||'')
    ||(receipt.fixtureRunId!==null&&!UUID.test(receipt.fixtureRunId||''))||!Number.isFinite(Date.parse(receipt.createdAt))
    ||!['prepared','running','checks_failed','checks_complete','cleanup_running','complete','cleanup_pending'].includes(receipt.stage)
    ||!Array.isArray(receipt.paths)||receipt.paths.length>30||!Array.isArray(receipt.rows)||receipt.rows.length>3,'CLEANUP_SCOPE_DENIED')
  const scope=new HostedCleanupScope(receipt.ownerId,receipt.conversationId,receipt.runId)
  const phases=['planned','upload_pending','uploaded','upload_rejected','upload_unknown','removed','remove_pending','remove_failed']
  for(const entry of receipt.paths) {
    reject(!fields(entry,['bucket','path','phase','reservationPending'])||!phases.includes(entry.phase)
      ||typeof entry.reservationPending!=='boolean','CLEANUP_SCOPE_DENIED')
    reject(scope.paths.has(`${entry.bucket}:${entry.path}`),'CLEANUP_SCOPE_DENIED')
    scope.paths.set(`${entry.bucket}:${entry.path}`,{bucket:entry.bucket,path:entry.path});scope.assertPath(entry.bucket,entry.path)
  }
  for(const row of receipt.rows) {
    reject(!fields(row,['kind','id','phase'])||!['planned','created','removed','remove_pending','remove_failed'].includes(row.phase),'CLEANUP_SCOPE_DENIED')
    reject(scope.rows.has(`${row.kind}:${row.id}`),'CLEANUP_SCOPE_DENIED');scope.row(row.kind,row.id)
  }
  return scope
}

export class HostedCheckError extends Error {
  constructor(code='CHECK_FAILED') {super(code);this.code=code}
}
const reject=(condition,code='CONFIGURATION_INVALID')=>{if(condition)throw new HostedCheckError(code)}
const jwtPayload=(token)=>{
  try {return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'))}
  catch {throw new HostedCheckError('CONFIGURATION_INVALID')}
}
export function parseHostedConfiguration(env={},args=[]) {
  reject(args.some(arg=>!['--execute','--cleanup'].includes(arg)) || (args.includes('--cleanup')&&!args.includes('--execute')))
  reject(env.XELAY_HOSTED_MEDIA_URL && env.XELAY_HOSTED_MEDIA_URL!==STAGING_ORIGIN)
  reject(env.XELAY_HOSTED_MEDIA_REF && env.XELAY_HOSTED_MEDIA_REF!==STAGING_REF)
  const config={execute:args.includes('--execute'),cleanup:args.includes('--cleanup'),origin:STAGING_ORIGIN}
  if(!config.execute)return config
  const key=env.XELAY_HOSTED_MEDIA_ANON_KEY
  reject(typeof key!=='string'||key.length<20||key.length>10000||/\s/.test(key)||key.startsWith('sb_secret_'))
  if(key.startsWith('ey')) {const claims=jwtPayload(key);reject(claims.role!=='anon'||claims.ref!==STAGING_REF)}
  else reject(!key.startsWith('sb_publishable_'))
  const users={}
  for(const who of ['A','B','C']) {
    const token=env[`XELAY_HOSTED_MEDIA_USER_${who}_TOKEN`]
    reject(typeof token!=='string'||token.length>20000||/\s/.test(token))
    const claims=jwtPayload(token)
    reject(claims.iss!==`${STAGING_ORIGIN}/auth/v1`||claims.role!=='authenticated'||!UUID.test(claims.sub||'')
      ||!Number.isFinite(claims.exp)||claims.exp*1000<Date.now()+180000)
    users[who]={token,id:claims.sub}
  }
  reject(new Set(Object.values(users).map(user=>user.id)).size!==3)
  const conversationId=env.XELAY_HOSTED_MEDIA_CONVERSATION_ID,spaceId=env.XELAY_HOSTED_MEDIA_CHAT_SPACE_ID
  reject(!UUID.test(conversationId||'')||!UUID.test(spaceId||''))
  return {...config,key,users,conversationId,spaceId}
}

function bodyBudget(body) {
  if(body==null)return {bytes:0,fileBytes:0}
  if(typeof body==='string')return {bytes:Buffer.byteLength(body),fileBytes:0}
  if(body instanceof Blob)return {bytes:body.size,fileBytes:body.size}
  if(body instanceof FormData) {
    let bytes=0,fileBytes=0
    for(const [name,value] of body.entries()) {
      bytes+=Buffer.byteLength(name)+128
      if(typeof value==='string')bytes+=Buffer.byteLength(value)
      else {bytes+=value.size;fileBytes+=value.size}
    }
    return {bytes,fileBytes}
  }
  if(body instanceof ArrayBuffer || ArrayBuffer.isView(body))return {bytes:body.byteLength,fileBytes:body.byteLength}
  throw new HostedCheckError('REQUEST_BODY_DENIED')
}
export function allowHostedRequest(input,init={}) {
  const url=new URL(input instanceof Request?input.url:String(input))
  reject(url.origin!==STAGING_ORIGIN||url.protocol!=='https:'||url.username||url.password||url.hash,'REQUEST_ORIGIN_DENIED')
  const method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase()
  reject(!['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(method),'REQUEST_METHOD_DENIED')
  const pieces=url.pathname.split('/').filter(Boolean)
  let allowed=false
  if(url.pathname==='/auth/v1/user')allowed=method==='GET'
  if(pieces[0]==='rest'&&pieces[1]==='v1') {
    allowed=pieces[2]==='rpc'?method==='POST'&&pieces.length===4&&RPCS.has(pieces[3])
      :pieces.length===3&&TABLES.has(pieces[2])&&(method==='GET'||method==='POST'&&['questions','answers','question_images','answer_images'].includes(pieces[2]))
  }
  if(pieces[0]==='storage'&&pieces[1]==='v1'&&pieces[2]==='object') {
    const bucket=['public','authenticated','sign'].includes(pieces[3])?pieces[4]:pieces[3]
    allowed=MEDIA_BUCKETS.includes(bucket)
  }
  reject(!allowed,'REQUEST_ROUTE_DENIED')
  return {url,method}
}
export function guardedHostedFetch(fetchImpl=globalThis.fetch,{maxRequests=100,maxFileBytes=65536,maxRequestBytes=131072,
  maxDurationMs=120000,requestTimeoutMs=8000}={}) {
  reject([maxRequests,maxFileBytes,maxRequestBytes,maxDurationMs,requestTimeoutMs].some(value=>!Number.isFinite(value)||value<1)
    ||maxRequests>100||maxFileBytes>65536||maxRequestBytes>131072||maxDurationMs>120000||requestTimeoutMs>8000)
  const state={requests:0,fileBytes:0,requestBytes:0,start:Date.now(),active:false,last:{httpStatus:0}}
  const fetch=async(input,init={})=>{
    allowHostedRequest(input,init)
    reject(state.active,'CONCURRENT_REQUEST_DENIED')
    reject(state.requests>=maxRequests||Date.now()-state.start>=maxDurationMs,'REQUEST_BUDGET_EXCEEDED')
    const budget=bodyBudget(init.body||(input instanceof Request?input.body:null))
    reject(budget.bytes>16384||state.requestBytes+budget.bytes>maxRequestBytes||state.fileBytes+budget.fileBytes>maxFileBytes,'REQUEST_BODY_LIMIT')
    state.requests++;state.fileBytes+=budget.fileBytes;state.requestBytes+=budget.bytes;state.active=true;state.last={httpStatus:0}
    try {
      const timeout=AbortSignal.timeout(requestTimeoutMs)
      const signal=init.signal?AbortSignal.any([init.signal,timeout]):timeout
      const response=await fetchImpl(input,{...init,signal,redirect:'manual',cache:'no-store'})
      state.last={httpStatus:response.status,cacheState:response.headers.get('cf-cache-status')||response.headers.get('x-cache')||'UNKNOWN'}
      reject(response.status>=300&&response.status<400,'RESPONSE_REDIRECT_DENIED')
      if(response.url)reject(new URL(response.url).origin!==STAGING_ORIGIN,'RESPONSE_ORIGIN_DENIED')
      return response
    } catch(error) {
      if(error instanceof HostedCheckError)throw error
      throw new HostedCheckError('REQUEST_FAILED')
    } finally {state.active=false}
  }
  return {fetch,lastResponse:()=>({...state.last}),metrics:()=>({requests:state.requests,fileBytes:state.fileBytes,requestBytes:state.requestBytes})}
}

// Storage often reports denial as HTTP 400, or DELETE 200 with zero rows.
// 401/5xx/network failures are not evidence that an access rule worked.
export function deniedStorageResult(result) {
  const status=Number(result?.error?.status||result?.error?.statusCode)
  return Boolean(result?.error)&&[400,403,404].includes(status)
}
export function deniedDeleteResult(result,path) {
  return deniedStorageResult(result)||(!result?.error&&Array.isArray(result?.data)&&!result.data.some(row=>row.name===path))
}
export class HostedCleanupScope {
  constructor(ownerId,conversationId,runId=randomUUID()) {
    reject(!UUID.test(ownerId)||!UUID.test(conversationId)||!UUID.test(runId))
    this.ownerId=ownerId;this.conversationId=conversationId;this.runId=runId;this.paths=new Map();this.rows=new Map()
  }
  path(bucket,purpose,messageId) {
    reject(!MEDIA_BUCKETS.includes(bucket)||!/^[a-z0-9-]{1,40}$/.test(purpose),'CLEANUP_SCOPE_DENIED')
    let path
    if(bucket==='xelay-chat-media')path=`${this.ownerId}/${this.runId}/${purpose}.png`
    else if(bucket==='xelay-message-media') {
      reject(!UUID.test(messageId||''),'CLEANUP_SCOPE_DENIED')
      path=`${this.conversationId}/${this.ownerId}/${messageId}/${this.runId}-${purpose}.png`
    } else path=`${this.ownerId}/${bucket==='avatars'?'avatars':bucket==='answer-media'?'answers':'questions'}/${this.runId}-${purpose}.png`
    this.paths.set(`${bucket}:${path}`,{bucket,path})
    return path
  }
  assertPath(bucket,path) {
    reject(!this.paths.has(`${bucket}:${path}`),'CLEANUP_SCOPE_DENIED')
    const parts=path.split('/')
    const valid=bucket==='xelay-chat-media'?parts.length===3&&parts[0]===this.ownerId&&parts[1]===this.runId
      :bucket==='xelay-message-media'?parts.length===4&&parts[0]===this.conversationId&&parts[1]===this.ownerId&&UUID.test(parts[2])&&parts[3].startsWith(`${this.runId}-`)
        :MEDIA_BUCKETS.slice(0,3).includes(bucket)&&parts.length===3&&parts[0]===this.ownerId
          &&parts[1]===(bucket==='avatars'?'avatars':bucket==='answer-media'?'answers':'questions')&&parts[2].startsWith(`${this.runId}-`)
    reject(!valid,'CLEANUP_SCOPE_DENIED')
    const filename=parts.at(-1),suffix=filename.slice(filename.indexOf(this.runId)+this.runId.length)
    reject(!new RegExp(bucket==='xelay-chat-media'?'^[a-z0-9-]{1,40}\\.png$':'^-[a-z0-9-]{1,40}\\.png$').test(bucket==='xelay-chat-media'?filename:suffix),
      'CLEANUP_SCOPE_DENIED')
  }
  row(kind,id) {
    reject(!['question','message','post'].includes(kind)||!UUID.test(id||''),'CLEANUP_SCOPE_DENIED')
    this.rows.set(`${kind}:${id}`,{kind,id})
  }
  assertRow(kind,id) {reject(!this.rows.has(`${kind}:${id}`),'CLEANUP_SCOPE_DENIED')}
}

const resultDenied=(result)=>Boolean(result?.error)&&['42501','22023','P0001'].includes(result.error.code)
const file=(type='image/png',extra=0)=>new File([PNG,Buffer.alloc(extra)],type==='image/png'?'pixel.png':'pixel.jpg',{type})
const digest=(data)=>createHash('sha256').update(data).digest('hex')
export async function runHostedMediaChecks(config,{fetchImpl=globalThis.fetch,clientFactory,receiptWriter=writeMediaReceipt}={}) {
  if(!config.execute)return {checksPassed:0,checksFailed:0,requests:0,fileBytes:0,cleanupPassed:0,cleanupFailed:0,pending:1,buckets:5}
  const guard=guardedHostedFetch(fetchImpl)
  if(!clientFactory)clientFactory=(await import('@supabase/supabase-js')).createClient
  const clients=Object.fromEntries(Object.entries(config.users).map(([who,user])=>[who,clientFactory(STAGING_ORIGIN,config.key,{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{headers:{Authorization:`Bearer ${user.token}`},fetch:guard.fetch},
  })]))
  const scope=config.cleanupReceipt?validateMediaReceipt(config.cleanupReceipt):new HostedCleanupScope(config.users.A.id,config.conversationId)
  reject(scope.ownerId!==config.users.A.id||scope.conversationId!==config.conversationId
    ||(config.cleanupReceipt&&(config.cleanupReceipt.spaceId!==config.spaceId
      ||config.cleanupReceipt.fixtureRunId!==config.fixtureRunId)),'CLEANUP_SCOPE_DENIED')
  const receipt=config.cleanupReceipt||{mode:'test1-media-check-owned',projectRef:STAGING_REF,origin:STAGING_ORIGIN,
    runId:scope.runId,fixtureRunId:config.fixtureRunId||null,ownerId:scope.ownerId,conversationId:scope.conversationId,
    spaceId:config.spaceId,createdAt:new Date().toISOString(),stage:'prepared',paths:[],rows:[]}
  if(config.cleanupReceipt) {
    for(const item of receipt.paths)Object.assign(scope.paths.get(`${item.bucket}:${item.path}`),item)
    for(const item of receipt.rows)Object.assign(scope.rows.get(`${item.kind}:${item.id}`),item)
  }
  const save=async(stage=receipt.stage)=>{
    receipt.stage=stage
    receipt.paths=[...scope.paths.values()].map(item=>({bucket:item.bucket,path:item.path,phase:item.phase||'planned',reservationPending:Boolean(item.reservationPending)}))
    receipt.rows=[...scope.rows.values()].map(item=>({kind:item.kind,id:item.id,phase:item.phase||'planned'}))
    validateMediaReceipt(receipt);await receiptWriter(receipt)
  }
  const state={checksPassed:0,checksFailed:0,cleanupPassed:0,cleanupFailed:0,pending:1,buckets:5,runId:scope.runId,diagnostics:[]}
  let lastName='prepare',lastResult
  const observed=async(name,operation)=>{
    reject(!/^[a-zA-Z0-9_-]{1,80}$/.test(name),'CONFIGURATION_INVALID')
    lastName=name;lastResult=undefined
    try{lastResult=await operation();return lastResult}catch(error){lastResult={error};throw error}
  }
  const check=condition=>{
    state.diagnostics.push({checkName:lastName,passed:Boolean(condition),...sanitizedMediaDiagnostic(lastResult,guard.lastResponse())})
    if(!condition) {
      state.checksFailed++
      // A provider-specific final-write 500 remains a FAIL. Only these two
      // deliberate mismatch uploads may proceed to mandatory absence checks
      // so they do not conceal the remaining independent bucket coverage.
      if(['answer_media_size_upload_denied','answer_media_mime_upload_denied'].includes(lastName)
        &&Number(lastResult?.error?.status)===500)return
      throw new HostedCheckError()
    }
    state.checksPassed++
  }
  const checked=async(name,operation,predicate=result=>!result.error)=>{
    const result=await observed(name,operation);check(await predicate(result));return result
  }
  const rpc=(who,name,args)=>clients[who].rpc(name,args)
  const reservePublic=async(bucket,path,bytes=PNG.length,mime='image/png')=>{
    const entry=scope.paths.get(`${bucket}:${path}`);scope.assertPath(bucket,path);entry.reservationPending=true
    await save('running')
    const result=await rpc('A','xelay_reserve_public_media_upload',{p_bucket_id:bucket,p_storage_path:path,p_byte_size:bytes,p_mimetype:mime})
    if(resultDenied(result))entry.reservationPending=false
    await save();return result
  }
  const cancelPublic=async(bucket,path)=>{
    const result=await rpc('A','xelay_cancel_public_media_upload',{p_bucket_id:bucket,p_storage_path:path})
    if(!result.error)scope.paths.get(`${bucket}:${path}`).reservationPending=false
    await save();return result
  }
  const upload=async(who,bucket,path,body=file())=>{
    // Durable exact intent survives an ambiguous upload response; no bucket listing.
    const entry=scope.paths.get(`${bucket}:${path}`);scope.assertPath(bucket,path)
    entry.phase='upload_pending';await save('running')
    const result=await clients[who].storage.from(bucket).upload(path,body,{contentType:body.type,upsert:false,cacheControl:'0'})
    entry.phase=result.error?(deniedStorageResult(result)?'upload_rejected':'upload_unknown'):'uploaded'
    if(!result.error)entry.reservationPending=false
    await save();return result
  }
  // Public objects can outlive metadata briefly in a CDN cache. A new query key
  // is essential for independent integrity/absence checks after a mutation.
  const download=(who,bucket,path)=>clients[who].storage.from(bucket).download(path,{cacheNonce:randomUUID()}, {cache:'no-store'})
  const verifyBytes=(name,who,bucket,path)=>checked(name,()=>download(who,bucket,path),async result=>
    !result.error&&result.data instanceof Blob&&digest(Buffer.from(await result.data.arrayBuffer()))===digest(PNG))
  const publicUrl=(bucket,path)=>clients.A.storage.from(bucket).getPublicUrl(path).data.publicUrl
  const publicPaths={}
  let identitiesVerified=false
  try {
    await save()
    for(const who of ['A','B','C']) {
      await checked(`auth_${who}`,()=>clients[who].auth.getUser(config.users[who].token),user=>
        !user.error&&user.data?.user?.id===config.users[who].id&&Boolean(user.data.user.email_confirmed_at)
        &&user.data.user.app_metadata?.xelay_security_fixture==='media-v1'
        &&UUID.test(user.data.user.app_metadata?.xelay_security_run_id||'')
        &&user.data.user.app_metadata?.xelay_security_label===who
        &&(!receipt.fixtureRunId||user.data.user.app_metadata.xelay_security_run_id===receipt.fixtureRunId))
      if(!receipt.fixtureRunId)receipt.fixtureRunId=lastResult.data.user.app_metadata.xelay_security_run_id
      if(config.cleanupOnly)continue
      await checked(`conversation_${who}`,()=>clients[who].from('conversations').select('id,user_one_id,user_two_id').eq('id',config.conversationId),conv=>
        !conv.error&&(who==='C'?conv.data.length===0:conv.data.length===1&&new Set([conv.data[0].user_one_id,conv.data[0].user_two_id]).size===2
          &&[config.users.A.id,config.users.B.id].every(id=>[conv.data[0].user_one_id,conv.data[0].user_two_id].includes(id))))
      await checked(`private_group_${who}`,()=>clients[who].from('chat_spaces').select('id,kind,visibility').eq('id',config.spaceId),space=>
        !space.error&&(who==='C'?space.data.length===0:space.data.length===1&&space.data[0].kind==='group'&&space.data[0].visibility==='private'))
    }
    identitiesVerified=true;await save()
    if(!config.cleanupOnly) {
      for(const bucket of MEDIA_BUCKETS.slice(0,3)) {
        const prefix=bucket.replaceAll('-','_')
        await checked(`${prefix}_unreserved_denied`,()=>upload('A',bucket,scope.path(bucket,'unreserved')),deniedStorageResult)
        const path=scope.path(bucket,'valid');publicPaths[bucket]=path
        await checked(`${prefix}_reserve`,()=>reservePublic(bucket,path))
        await checked(`${prefix}_upload`,()=>upload('A',bucket,path))
        await checked(`${prefix}_public_bytes`,()=>guard.fetch(publicUrl(bucket,path)),async response=>
          response.ok&&digest(Buffer.from(await response.arrayBuffer()))===digest(PNG))
        await checked(`${prefix}_foreign_update_denied`,()=>clients.B.storage.from(bucket).update(path,file(),{contentType:'image/png',cacheControl:'0'}),deniedStorageResult)
        await checked(`${prefix}_foreign_delete_denied`,()=>clients.B.storage.from(bucket).remove([path]),result=>deniedDeleteResult(result,path))
        await verifyBytes(`${prefix}_owner_bytes`,'A',bucket,path)
        if(bucket==='avatars') {
          await checked('avatars_foreign_upsert_denied',()=>clients.B.storage.from(bucket).upload(path,file(),{contentType:'image/png',upsert:true,cacheControl:'0'}),deniedStorageResult)
          await checked('avatars_owner_replace_reserve',()=>reservePublic(bucket,path))
          await checked('avatars_owner_replace',()=>clients.A.storage.from(bucket).update(path,file(),{contentType:'image/png',cacheControl:'0'}))
          scope.paths.get(`${bucket}:${path}`).reservationPending=false;await save()
          await verifyBytes('avatars_owner_replace_bytes','A',bucket,path)
        }
        await checked(`${prefix}_oversize_reserve_denied`,()=>reservePublic(bucket,scope.path(bucket,'oversize'),bucket==='avatars'?5242881:26214401),resultDenied)
      }
      const questionId=randomUUID();scope.row('question',questionId);await save()
      const question=await checked('question_insert',()=>clients.A.from('questions').insert({id:questionId,user_id:config.users.A.id,
        title:'Synthetic media verification',content:'Synthetic integration content',category:'Business'}).select('id,user_id').single(),result=>
        !result.error&&result.data?.id===questionId&&result.data.user_id===config.users.A.id)
      scope.rows.get(`question:${questionId}`).phase='created';await save()
      await checked('question_image_owner_link',()=>clients.A.from('question_images').insert({question_id:question.data.id,
        image_url:publicUrl('question-images',publicPaths['question-images'])}))
      await checked('question_image_foreign_link_denied',()=>clients.B.from('question_images').insert({question_id:question.data.id,
        image_url:publicUrl('question-images',publicPaths['question-images'])}),resultDenied)
      const answer=await checked('answer_insert',()=>clients.A.from('answers').insert({question_id:question.data.id,user_id:config.users.A.id,
        content:'Synthetic answer',media_url:publicUrl('answer-media',publicPaths['answer-media']),media_type:'image'}).select('id').single(),result=>
        !result.error&&UUID.test(result.data?.id||''))
      await checked('answer_image_owner_link',()=>clients.A.from('answer_images').insert({answer_id:answer.data.id,
        image_url:publicUrl('answer-media',publicPaths['answer-media']),media_type:'image'}))
      const sizePath=scope.path('answer-media','size-mismatch')
      await checked('answer_media_size_reserve',()=>reservePublic('answer-media',sizePath))
      await checked('answer_media_size_upload_denied',()=>upload('A','answer-media',sizePath,file('image/png',1)),deniedStorageResult)
      await checked('answer_media_size_absent',()=>download('A','answer-media',sizePath),deniedStorageResult)
      await checked('answer_media_size_cancel',()=>cancelPublic('answer-media',sizePath))
      const mimePath=scope.path('answer-media','mime-mismatch')
      await checked('answer_media_mime_reserve',()=>reservePublic('answer-media',mimePath))
      await checked('answer_media_mime_upload_denied',()=>upload('A','answer-media',mimePath,file('image/jpeg')),deniedStorageResult)
      await checked('answer_media_mime_absent',()=>download('A','answer-media',mimePath),deniedStorageResult)
      await checked('answer_media_mime_cancel',()=>cancelPublic('answer-media',mimePath))
      for(const bucket of MEDIA_BUCKETS.slice(3)) {
        const prefix=bucket.replaceAll('-','_'),messageId=randomUUID(),path=scope.path(bucket,'valid',messageId)
        await checked(`${prefix}_unreserved_denied`,()=>upload('A',bucket,scope.path(bucket,'unreserved',messageId)),deniedStorageResult)
        await save()
        await checked(`${prefix}_reserve`,()=>rpc('A','xelay_private_reserve_media',{p_bucket_id:bucket,p_storage_path:path}))
        await checked(`${prefix}_upload`,()=>upload('A',bucket,path))
        await verifyBytes(`${prefix}_owner_unlinked_bytes`,'A',bucket,path)
        await checked(`${prefix}_member_unlinked_denied`,()=>download('B',bucket,path),deniedStorageResult)
        await checked(`${prefix}_anonymous_denied`,()=>guard.fetch(publicUrl(bucket,path)),response=>[400,403,404].includes(response.status))
        await checked(`${prefix}_foreign_update_denied`,()=>clients.B.storage.from(bucket).update(path,file(),{contentType:'image/png'}),deniedStorageResult)
        await checked(`${prefix}_foreign_delete_denied`,()=>clients.B.storage.from(bucket).remove([path]),result=>deniedDeleteResult(result,path))
        await verifyBytes(`${prefix}_owner_bytes_after_foreign_mutations`,'A',bucket,path)
        const descriptor={storage_path:path,file_name:'pixel.png',media_type:'image',mime_type:'image/png'}
        const send=mime=>bucket==='xelay-message-media'
          ?rpc('A','xelay_send_direct_message',{p_message_id:messageId,p_conversation_id:config.conversationId,p_body:'Synthetic media verification',
            p_reply_to:null,p_attachments:[{...descriptor,mime_type:mime}]})
          :rpc('A','xelay_chat_send',{p_space_id:config.spaceId,p_body:'Synthetic media verification',p_parent_post_id:null,p_reply_to:null,
            p_shared_news_post_id:null,p_attachments:[{...descriptor,mime_type:mime,file_size:PNG.length}]})
        await checked(`${prefix}_wrong_descriptor_denied`,()=>send('image/jpeg'),resultDenied)
        if(bucket==='xelay-message-media'){scope.row('message',messageId);await save()}
        const sent=await checked(`${prefix}_send`,()=>send('image/png'),result=>!result.error&&UUID.test((bucket==='xelay-message-media'?result.data?.id:result.data)||''))
        const rowId=bucket==='xelay-message-media'?sent.data.id:sent.data
        scope.row(bucket==='xelay-message-media'?'message':'post',rowId)
        scope.rows.get(`${bucket==='xelay-message-media'?'message':'post'}:${rowId}`).phase='created';await save()
        await verifyBytes(`${prefix}_member_linked_bytes`,'B',bucket,path)
        await checked(`${prefix}_nonmember_denied`,()=>download('C',bucket,path),deniedStorageResult)
        const signed=await checked(`${prefix}_member_signed_url`,()=>clients.B.storage.from(bucket).createSignedUrl(path,60),result=>
          !result.error&&typeof result.data?.signedUrl==='string')
        await checked(`${prefix}_signed_bytes`,()=>guard.fetch(signed.data.signedUrl),async response=>
          response.ok&&digest(Buffer.from(await response.arrayBuffer()))===digest(PNG))
        await checked(`${prefix}_linked_owner_delete_denied`,()=>clients.A.storage.from(bucket).remove([path]),result=>deniedDeleteResult(result,path))
        await verifyBytes(`${prefix}_linked_owner_bytes`,'A',bucket,path)
      }
    }
    state.pending=state.checksFailed?1:0;await save(state.checksFailed?'checks_failed':'checks_complete')
  } catch(error) {
    if(!(error instanceof HostedCheckError&&error.code==='CHECK_FAILED')){state.checksFailed++;state.diagnostics.push({checkName:lastName,passed:false,
      ...sanitizedMediaDiagnostic({error},guard.lastResponse())})}
    await save('checks_failed').catch(()=>{})
  } finally {
    if(config.cleanup&&identitiesVerified) {
      try {
        await save('cleanup_running')
        const clean=async(name,operation,predicate=result=>!result.error)=>{
          const result=await observed(name,operation),passed=Boolean(await predicate(result))
          state.diagnostics.push({checkName:name,passed,...sanitizedMediaDiagnostic(result,guard.lastResponse())})
          if(passed)state.cleanupPassed++;else state.cleanupFailed++
          return {result,passed}
        }
        for(const entry of scope.paths.values()) {
          if(!entry.reservationPending||!MEDIA_BUCKETS.slice(0,3).includes(entry.bucket))continue
          scope.assertPath(entry.bucket,entry.path)
          await clean(`cleanup_${entry.bucket.replaceAll('-','_')}_cancel_reservation`,()=>cancelPublic(entry.bucket,entry.path))
        }
        const rowRpcs={question:['xelay_delete_own_question','p_question_id'],message:['xelay_delete_message','p_message_id'],post:['xelay_chat_delete_post','p_post_id']}
        for(const entry of scope.rows.values()) {
          if(entry.phase==='removed')continue
          scope.assertRow(entry.kind,entry.id);entry.phase='remove_pending';await save()
          const [name,arg]=rowRpcs[entry.kind],result=await clean(`cleanup_${entry.kind}`,()=>rpc('A',name,{[arg]:entry.id}))
          entry.phase=result.passed?'removed':'remove_failed';await save()
        }
        for(const bucket of MEDIA_BUCKETS) {
          const entries=[...scope.paths.values()].filter(item=>item.bucket===bucket&&item.phase!=='removed')
          if(!entries.length)continue
          // Retain the pre-delete phase: only bodies known uploaded or with an
          // ambiguous outcome require independent download absence verification.
          const verify=entries.filter(item=>['uploaded','upload_pending','upload_unknown','remove_pending','remove_failed'].includes(item.phase))
          for(const entry of entries){scope.assertPath(bucket,entry.path);entry.phase='remove_pending'}
          await save()
          const removed=await clean(`cleanup_${bucket.replaceAll('-','_')}_remove`,()=>clients.A.storage.from(bucket).remove(entries.map(item=>item.path)))
          for(const entry of entries)entry.phase=removed.passed?(verify.includes(entry)?'remove_pending':'removed'):'remove_failed'
          await save()
          for(const entry of verify) {
            const absent=await clean(`cleanup_${bucket.replaceAll('-','_')}_absent`,()=>download('A',bucket,entry.path),deniedStorageResult)
            entry.phase=removed.passed&&absent.passed?'removed':'remove_failed'
            await save()
          }
        }
      } catch(error) {
        state.cleanupFailed++;state.diagnostics.push({checkName:lastName,passed:false,...sanitizedMediaDiagnostic({error},guard.lastResponse())})
      }
      await save(state.cleanupFailed?'cleanup_pending':'complete').catch(()=>{state.cleanupFailed++})
    }
  }
  if(state.cleanupFailed)state.pending=1
  return {...state,...guard.metrics()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let summary
  try {summary=await runHostedMediaChecks(parseHostedConfiguration(process.env,process.argv.slice(2)))}
  catch {summary={checksPassed:0,checksFailed:1,requests:0,fileBytes:0,cleanupPassed:0,cleanupFailed:0,pending:1,buckets:5}}
  console.log(JSON.stringify(summary))
  if(summary.checksFailed||summary.cleanupFailed)process.exitCode=1
}
