// Prepare fresh sessions for the already-owned synthetic run. Dry run by default.
// Admin generateLink recovery never creates a missing user or sends mail; POST
// verify consumes that token without setting a password. This records recovery
// token/audit events only for these disposable accounts. No human credential UI.
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { STAGING_REF, STAGING_ORIGIN } from './hosted-media-checks.mjs'
import { FixtureSetupError, fixtureClaims, fixtureUserMatches, validateOwnedReceipt, validateTest1Key,
  readTest1AdminMode, readTest1LocalMode, durableTest1Json, TEST1_LOCAL_DIRECTORY } from './test1-auth-fixtures.mjs'
import { mediaEnvironmentFromSession } from './run-hosted-media-session.mjs'

export const OWNED_REFRESH_RUN='7a7bba48-9d91-4744-9f0a-be05065e056f'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH=/^[A-Za-z0-9_-]{20,256}$/
const LABELS=['A','B','C']
const CODES=new Set(['REFRESH_CONFIGURATION_INVALID','REFRESH_SCOPE_DENIED','REFRESH_REQUEST_DENIED',
  'REFRESH_REQUEST_LIMIT','REFRESH_NETWORK_FAILED','REFRESH_HTTP_FAILED','REFRESH_RESPONSE_INVALID',
  'REFRESH_RESPONSE_LIMIT','REFRESH_SESSION_INVALID','REFRESH_LOCAL_IO_FAILED'])
const PHASES=new Set(['planned','identity_preflight','factor_preflight','identity_before_recovery',
  'generate_recovery','verify_recovery','verify_identity','complete'])
export class SessionRefreshError extends Error {
  constructor(code='REFRESH_CONFIGURATION_INVALID',status=0){const safe=CODES.has(code)?code:'REFRESH_CONFIGURATION_INVALID';super(safe);this.code=safe
    this.httpStatus=Number.isInteger(status)&&status>=100&&status<=599?status:0}
}
const reject=(condition,code='REFRESH_CONFIGURATION_INVALID')=>{if(condition)throw new SessionRefreshError(code)}
const fields=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key))
const failure=(error)=>({failureCode:error instanceof SessionRefreshError?error.code:
  error instanceof FixtureSetupError?'REFRESH_CONFIGURATION_INVALID':'REFRESH_LOCAL_IO_FAILED',
  httpStatus:error instanceof SessionRefreshError?error.httpStatus:0})
const headers=(key,token)=>({apikey:key,Accept:'application/json','Content-Type':'application/json',
  ...(token?{Authorization:`Bearer ${token}`}:key.startsWith('ey')?{Authorization:`Bearer ${key}`}:{})})

export function parseRefreshArguments(args=[]){
  const options={execute:false,receiptPath:null,sessionPath:null}
  for(let i=0;i<args.length;i++){
    if(args[i]==='--execute'){reject(options.execute);options.execute=true}
    else if(['--receipt-file','--session-file'].includes(args[i])){const key=args[i]==='--receipt-file'?'receiptPath':'sessionPath'
      reject(options[key]||!args[i+1]);options[key]=args[++i]}
    else throw new SessionRefreshError()
  }
  reject(options.execute&&(!options.receiptPath||!options.sessionPath));return options
}

export function validateExpiredOwnedSession(session,receipt){
  reject(!fields(session,['mode','projectRef','origin','runId','publicKey','users'])||session.mode!=='test1-media-sessions'
    ||session.projectRef!==STAGING_REF||session.origin!==STAGING_ORIGIN||session.runId!==OWNED_REFRESH_RUN
    ||session.runId!==receipt.runId||!fields(session.users,LABELS)||Object.keys(session.users).length!==3,'REFRESH_SCOPE_DENIED')
  validateTest1Key(session.publicKey,'anon')
  for(const label of LABELS){const entry=receipt.users.find(item=>item.label===label),user=session.users[label]
    reject(!entry||entry.status!=='verified'||!fields(user,['id','accessToken','expiresAt'])||user.id!==entry.id
      ||typeof user.accessToken!=='string'||user.accessToken.length>10000||!Number.isSafeInteger(user.expiresAt),'REFRESH_SCOPE_DENIED')
    const claims=fixtureClaims(user.accessToken)
    // Old expiry is accepted only as backup data, never as an HTTP credential.
    reject(claims.sub!==entry.id||claims.iss!==STAGING_ORIGIN+'/auth/v1'||claims.role!=='authenticated'
      ||claims.aal!=='aal1'||claims.exp!==user.expiresAt,'REFRESH_SCOPE_DENIED')
  }
  return session
}

export function assertRefreshRequest(input,{method='GET',body,phase,label}={},context){
  let url;try{url=new URL(String(input))}catch{throw new SessionRefreshError('REFRESH_REQUEST_DENIED')}
  reject(!context||url.origin!==STAGING_ORIGIN||url.protocol!=='https:'||url.username||url.password||url.hash||url.search
    ||!LABELS.includes(label)||!PHASES.has(phase),'REFRESH_REQUEST_DENIED')
  const entry=context.entries.get(label);reject(!entry||!UUID.test(entry.id),'REFRESH_REQUEST_DENIED')
  const path=url.pathname
  let allowed=method==='GET'&&((['identity_preflight','identity_before_recovery'].includes(phase)&&path===`/auth/v1/admin/users/${entry.id}`)
    ||phase==='factor_preflight'&&path===`/auth/v1/admin/users/${entry.id}/factors`
    ||phase==='verify_identity'&&path==='/auth/v1/user')
  if(method==='POST'&&phase==='generate_recovery'&&path==='/auth/v1/admin/generate_link'){
    allowed=context.checked.has(label)&&fields(body,['type','email'])&&body.type==='recovery'&&body.email===entry.email
  }
  if(method==='POST'&&phase==='verify_recovery'&&path==='/auth/v1/verify'){
    allowed=fields(body,['type','token_hash'])&&body.type==='recovery'&&HASH.test(body.token_hash||'')
      &&context.hashes.get(label)===body.token_hash
  }
  reject(!allowed||method==='GET'&&body!=null,'REFRESH_REQUEST_DENIED')
}

export function refreshTransport(fetchImpl,context,{now=Date.now,beforeRequest=async()=>{}}={}){
  const started=now();let requests=0,active=false
  const request=async(path,method,requestHeaders,body,phase,label)=>{
    assertRefreshRequest(STAGING_ORIGIN+path,{method,body,phase,label},context)
    const remaining=90000-(now()-started)
    reject(active||requests>=16||remaining<=0,'REFRESH_REQUEST_LIMIT')
    const serialized=body==null?undefined:JSON.stringify(body);reject(serialized&&Buffer.byteLength(serialized)>2048,'REFRESH_REQUEST_LIMIT')
    active=true
    try{
      // Safe request intent is fsynced before a request can leave this process.
      await beforeRequest({requestId:randomUUID(),label,phase,ordinal:requests+1})
      const timeout=Math.min(8000,90000-(now()-started));reject(timeout<=0,'REFRESH_REQUEST_LIMIT')
      requests++
      const response=await fetchImpl(STAGING_ORIGIN+path,{method,headers:requestHeaders,body:serialized,
        signal:AbortSignal.timeout(Math.max(1,Math.floor(timeout))),redirect:'manual',cache:'no-store'})
      reject(response.status>=300&&response.status<400||response.url&&new URL(response.url).origin!==STAGING_ORIGIN,'REFRESH_REQUEST_DENIED')
      if(!response.ok){await response.body?.cancel().catch(()=>{});throw new SessionRefreshError('REFRESH_HTTP_FAILED',response.status)}
      const reader=response.body?.getReader();reject(!reader,'REFRESH_RESPONSE_INVALID')
      const parts=[];let bytes=0
      try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength
        reject(bytes>65536,'REFRESH_RESPONSE_LIMIT');parts.push(Buffer.from(next.value))}}
      catch(error){await reader.cancel().catch(()=>{});throw error}finally{reader.releaseLock()}
      try{return JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw new SessionRefreshError('REFRESH_RESPONSE_INVALID',response.status)}
    }catch(error){if(error instanceof SessionRefreshError||error instanceof FixtureSetupError)throw error
      throw new SessionRefreshError('REFRESH_NETWORK_FAILED')}
    finally{active=false}
  }
  return {request,metrics:()=>({requests})}
}

export async function runTest1SessionRefresh(options,{fetchImpl=globalThis.fetch,load=readTest1LocalMode,
  save=durableTest1Json,adminMode,now=Date.now}={}){
  const summary={verified:0,recoveryEvents:0,requests:0,backupsSaved:0,sessionReplaced:0,pending:1}
  if(!options.execute)return summary
  let transport,intent,intentPath
  try{
    const admin=adminMode||await readTest1AdminMode()
    reject(admin.mode!=='test1-admin-fixtures'||admin.projectRef!==STAGING_REF||admin.origin!==STAGING_ORIGIN)
    validateTest1Key(admin.serviceKey,'service_role');validateTest1Key(admin.publicKey,'anon')
    const receipt=validateOwnedReceipt(await load(options.receiptPath))
    reject(receipt.runId!==OWNED_REFRESH_RUN||receipt.users.some(user=>user.status!=='verified'),'REFRESH_SCOPE_DENIED')
    const receiptPath=resolve(options.receiptPath),sessionPath=resolve(options.sessionPath)
    reject(receiptPath!==resolve(TEST1_LOCAL_DIRECTORY,`test1-media-receipt-${OWNED_REFRESH_RUN}.json`)
      ||sessionPath!==resolve(TEST1_LOCAL_DIRECTORY,`test1-media-session-${OWNED_REFRESH_RUN}.json`),'REFRESH_SCOPE_DENIED')
    const previous=validateExpiredOwnedSession(await load(sessionPath),receipt)
    reject(previous.publicKey!==admin.publicKey,'REFRESH_SCOPE_DENIED')
    const refreshId=randomUUID()
    summary.refreshId=refreshId
    await save(resolve(TEST1_LOCAL_DIRECTORY,`test1-media-receipt-backup-${receipt.runId}-${refreshId}.json`),receipt,{initial:true})
    await save(resolve(TEST1_LOCAL_DIRECTORY,`test1-media-session-backup-${receipt.runId}-${refreshId}.json`),previous,{initial:true})
    summary.backupsSaved=2
    intent={mode:'test1-session-refresh-owned',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId:receipt.runId,
      refreshId,stage:'planned',users:receipt.users.map(({label,id})=>({label,id})),requests:[]}
    intentPath=resolve(TEST1_LOCAL_DIRECTORY,`test1-session-refresh-${refreshId}.json`)
    await save(intentPath,intent,{initial:true})
    const context={entries:new Map(receipt.users.map(entry=>[entry.label,entry])),checked:new Set(),hashes:new Map()}
    transport=refreshTransport(fetchImpl,context,{now,beforeRequest:async(request)=>{intent.stage=request.phase;intent.requests.push(request);await save(intentPath,intent)}})
    const service=headers(admin.serviceKey),publicHeaders=headers(admin.publicKey)
    const identity=async(entry,phase)=>{
      const result=await transport.request(`/auth/v1/admin/users/${entry.id}`,'GET',service,null,phase,entry.label)
      const user=result.user||result
      reject(!fixtureUserMatches(user,entry,receipt.runId)||!user.email_confirmed_at||user.deleted_at,'REFRESH_SCOPE_DENIED')
      return user
    }
    const fresh={mode:'test1-media-sessions',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId:receipt.runId,publicKey:admin.publicKey,users:{}}
    const draftPath=resolve(TEST1_LOCAL_DIRECTORY,`test1-media-session-draft-${receipt.runId}-${refreshId}.json`)
    for(const entry of receipt.users){
      // Each account is rechecked immediately before its only token mutation.
      // Recovery's provider-side missing-user branch is 404, never signup.
      await identity(entry,'identity_before_recovery')
      const response=await transport.request(`/auth/v1/admin/users/${entry.id}/factors`,'GET',service,null,'factor_preflight',entry.label)
      const factors=Array.isArray(response)?response:response.factors
      reject(!Array.isArray(factors)||factors.length!==0,'REFRESH_SCOPE_DENIED')
      context.checked.add(entry.label)
      const generated=await transport.request('/auth/v1/admin/generate_link','POST',service,{type:'recovery',email:entry.email},'generate_recovery',entry.label)
      summary.recoveryEvents++
      const generatedUser=generated.user||generated,properties=generated.properties||generated
      reject(!fixtureUserMatches(generatedUser,entry,receipt.runId)||!generatedUser.email_confirmed_at
        ||properties.verification_type!=='recovery'||!HASH.test(properties.hashed_token||''),'REFRESH_SCOPE_DENIED')
      context.hashes.set(entry.label,properties.hashed_token)
      const signed=await transport.request('/auth/v1/verify','POST',publicHeaders,
        {type:'recovery',token_hash:properties.hashed_token},'verify_recovery',entry.label)
      context.hashes.delete(entry.label)
      reject(typeof signed.access_token!=='string'||signed.access_token.length>10000,'REFRESH_SESSION_INVALID')
      const claims=fixtureClaims(signed.access_token)
      reject(claims.sub!==entry.id||claims.iss!==STAGING_ORIGIN+'/auth/v1'||claims.role!=='authenticated'||claims.aal!=='aal1'
        ||!Number.isSafeInteger(claims.exp)||claims.exp*1000<now()+180000,'REFRESH_SESSION_INVALID')
      const current=await transport.request('/auth/v1/user','GET',headers(admin.publicKey,signed.access_token),null,'verify_identity',entry.label)
      const currentUser=current.user||current
      reject(!fixtureUserMatches(currentUser,entry,receipt.runId)||!currentUser.email_confirmed_at||currentUser.deleted_at
        ||currentUser.factors?.length,'REFRESH_SESSION_INVALID')
      fresh.users[entry.label]={id:entry.id,accessToken:signed.access_token,expiresAt:claims.exp};summary.verified++
      // Only owned access tokens enter the ignored draft; refresh tokens, links,
      // OTP/hash and service credentials are never written or reported.
      await save(draftPath,{...fresh,mode:'test1-media-session-refresh-draft'},{initial:summary.verified===1})
    }
    mediaEnvironmentFromSession(fresh,{mode:'test1-media-fixtures',projectRef:STAGING_REF,origin:STAGING_ORIGIN,
      runId:receipt.runId,conversationId:randomUUID(),chatSpaceId:randomUUID()})
    await save(sessionPath,fresh);summary.sessionReplaced=1
    intent.stage='complete';await save(intentPath,intent);summary.pending=0
  }catch(error){summary.failed=1;Object.assign(summary,failure(error))
    if(intent){summary.failurePhase=PHASES.has(intent.stage)?intent.stage:'unknown'}
  }
  return {...summary,...transport?.metrics()}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let summary
  try{summary=await runTest1SessionRefresh(parseRefreshArguments(process.argv.slice(2)))}
  catch(error){summary={verified:0,recoveryEvents:0,requests:0,backupsSaved:0,sessionReplaced:0,pending:1,failed:1,...failure(error)}}
  console.log(JSON.stringify(summary));if(summary.failed)process.exitCode=1
}
