// Synthetic integration accounts only. Does not run by default. No UI,
// invitations, real email delivery, existing-account reuse or key creation.
// Admin credentials: ignored .security-audit.local/test1-admin-mode.json only.
// Cleanup is a separate --execute --cleanup-only --receipt-file <owned JSON>.
import { randomBytes,randomUUID } from 'node:crypto'
import { lstat,realpath,readFile,open,rename,unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve,sep } from 'node:path'
import { STAGING_REF,STAGING_ORIGIN } from './hosted-media-checks.mjs'

const root=fileURLToPath(new URL('../../',import.meta.url))
export const TEST1_LOCAL_DIRECTORY=resolve(root,'.security-audit.local')
const ADMIN_MODE_PATH=resolve(TEST1_LOCAL_DIRECTORY,'test1-admin-mode.json')
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LABELS=['A','B','C']
const FAILURE_CODES=new Set(['FIXTURE_CONFIGURATION_INVALID','FIXTURE_REQUEST_DENIED','FIXTURE_REQUEST_LIMIT',
  'FIXTURE_REDIRECT_DENIED','FIXTURE_RESPONSE_ORIGIN_DENIED','FIXTURE_RESPONSE_INVALID','FIXTURE_RESPONSE_LIMIT',
  'FIXTURE_HTTP_FAILED','FIXTURE_REQUEST_FAILED','FIXTURE_CLEANUP_SCOPE_DENIED','FIXTURE_CREATE_INVALID',
  'FIXTURE_SESSION_INVALID','FIXTURE_LOCAL_IO_FAILED'])
export class FixtureSetupError extends Error {
  constructor(code='FIXTURE_CONFIGURATION_INVALID',httpStatus=0){
    const safeCode=FAILURE_CODES.has(code)?code:'FIXTURE_REQUEST_FAILED'
    super(safeCode);this.code=safeCode
    this.httpStatus=Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599?httpStatus:0
  }
}
export function sanitizedFixtureFailure(error) {
  return error instanceof FixtureSetupError?{failureCode:FAILURE_CODES.has(error.code)?error.code:'FIXTURE_REQUEST_FAILED',
    httpStatus:Number.isInteger(error.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599?error.httpStatus:0}
    :{failureCode:'FIXTURE_LOCAL_IO_FAILED',httpStatus:0}
}
const reject=(condition,code='FIXTURE_CONFIGURATION_INVALID')=>{if(condition)throw new FixtureSetupError(code)}
const fields=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key))
export function fixtureClaims(token) {
  try{return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'))}
  catch{throw new FixtureSetupError()}
}
export function validateTest1Key(key,role) {
  reject(typeof key!=='string'||key.length<20||key.length>10000||/\s/.test(key))
  if(key.startsWith('ey')) {
    const claims=fixtureClaims(key)
    reject(claims.role!==role||claims.ref!==STAGING_REF||!Number.isFinite(claims.exp)||claims.exp*1000<Date.now()+60000)
  } else reject(!key.startsWith(role==='anon'?'sb_publishable_':'sb_secret_'))
  return key
}
export async function readTest1LocalMode(path) {
  const target=resolve(root,path)
  reject(!target.startsWith(TEST1_LOCAL_DIRECTORY+sep))
  try {
    const info=await lstat(target)
    reject(!info.isFile()||info.isSymbolicLink()||info.size>65536||(await lstat(TEST1_LOCAL_DIRECTORY)).isSymbolicLink())
    reject(!(await realpath(target)).startsWith((await realpath(TEST1_LOCAL_DIRECTORY))+sep))
    reject(!(await readFile(resolve(root,'.gitignore'),'utf8')).split(/\r?\n/).some(line=>line.trim()==='*.local'))
    const mode=JSON.parse(await readFile(target,'utf8'))
    reject(mode.projectRef!==STAGING_REF||mode.origin!==STAGING_ORIGIN)
    return mode
  } catch {throw new FixtureSetupError()}
}
export async function readTest1AdminMode() {
  const mode=await readTest1LocalMode(ADMIN_MODE_PATH)
  reject(!fields(mode,['mode','projectRef','origin','serviceKey','publicKey'])||mode.mode!=='test1-admin-fixtures')
  return {...mode,serviceKey:validateTest1Key(mode.serviceKey,'service_role'),publicKey:validateTest1Key(mode.publicKey,'anon')}
}
export function parseFixtureArguments(args=[]) {
  const options={execute:false,cleanup:false,receiptPath:null}
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--execute'){reject(options.execute);options.execute=true}
    else if(args[i]==='--cleanup-only'){reject(options.cleanup);options.cleanup=true}
    else if(args[i]==='--receipt-file'){reject(options.receiptPath||!args[i+1]);options.receiptPath=args[++i]}
    else throw new FixtureSetupError()
  }
  reject(options.cleanup!==Boolean(options.receiptPath))
  return options
}
export function syntheticIdentity(runId,label) {
  reject(!UUID.test(runId)||!LABELS.includes(label))
  return {label,email:`security_media_${label.toLowerCase()}_${runId.replaceAll('-','')}@example.test`,
    username:`security_media_${label.toLowerCase()}_${runId.slice(0,8)}`}
}
function metadata(runId,label) {return {xelay_security_fixture:'media-v1',xelay_security_run_id:runId,xelay_security_label:label}}
export function fixtureUserMatches(user,entry,runId) {
  const expected=syntheticIdentity(runId,entry.label)
  return UUID.test(user?.id||'')&&user.id===entry.id&&user.email===expected.email
    &&user.user_metadata?.username===expected.username
    &&Object.entries(metadata(runId,entry.label)).every(([key,value])=>user.app_metadata?.[key]===value)
}
export function assertFixtureRequest(input,init={},knownUserIds=new Set(),allowedEmails=new Set()) {
  let url
  try{url=new URL(String(input))}catch{throw new FixtureSetupError('FIXTURE_REQUEST_DENIED')}
  reject(url.origin!==STAGING_ORIGIN||url.protocol!=='https:'||url.username||url.password||url.hash,'FIXTURE_REQUEST_DENIED')
  const method=(init.method||'GET').toUpperCase()
  const adminUser=/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/i.exec(url.pathname)
  const allowed=url.search===''&&((url.pathname==='/auth/v1/admin/users'&&method==='POST')
    ||(url.pathname==='/auth/v1/user'&&method==='GET')
    ||(adminUser&&UUID.test(adminUser[1])&&knownUserIds.has(adminUser[1])&&['GET','DELETE'].includes(method)))
    ||url.pathname==='/auth/v1/token'&&url.search==='?grant_type=password'&&method==='POST'
  reject(!allowed,'FIXTURE_REQUEST_DENIED')
  reject(['GET','DELETE'].includes(method)&&init.body!=null,'FIXTURE_REQUEST_DENIED')
  if(url.pathname==='/auth/v1/admin/users'&&method==='POST') {
    const body=init.body,runId=body?.app_metadata?.xelay_security_run_id,label=body?.app_metadata?.xelay_security_label
    reject(!UUID.test(runId||'')||!LABELS.includes(label),'FIXTURE_REQUEST_DENIED')
    const identity=syntheticIdentity(runId,label)
    reject(!fields(body,['email','password','email_confirm','user_metadata','app_metadata'])||body.email!==identity.email
      ||!allowedEmails.has(body.email)||body.email_confirm!==true||typeof body.password!=='string'||body.password.length<48
      ||!fields(body.user_metadata,['username','full_name'])||body.user_metadata.username!==identity.username
      ||body.user_metadata.full_name!==`Synthetic media ${label}`
      ||!fields(body.app_metadata,Object.keys(metadata(runId,label)))
      ||Object.entries(metadata(runId,label)).some(([key,value])=>body.app_metadata[key]!==value),'FIXTURE_REQUEST_DENIED')
  }
  if(url.pathname==='/auth/v1/token') {
    reject(!fields(init.body,['email','password'])||!allowedEmails.has(init.body.email)
      ||typeof init.body.password!=='string'||init.body.password.length<48,'FIXTURE_REQUEST_DENIED')
  }
}
export function fixtureRequestTransport(fetchImpl=globalThis.fetch,{knownUserIds=new Set(),allowedEmails=new Set()}={}) {
  let requests=0,active=false
  const started=Date.now()
  const request=async(path,method,headers,body)=>{
    const url=STAGING_ORIGIN+path
    assertFixtureRequest(url,{method,body},knownUserIds,allowedEmails)
    reject(active||requests>=20||Date.now()-started>=60000,'FIXTURE_REQUEST_LIMIT')
    const serialized=body==null?undefined:JSON.stringify(body)
    reject(serialized&&Buffer.byteLength(serialized)>8192,'FIXTURE_REQUEST_LIMIT')
    requests++;active=true
    try {
      const response=await fetchImpl(url,{method,headers,body:serialized,signal:AbortSignal.timeout(Math.min(8000,60000-(Date.now()-started))),
        redirect:'manual',cache:'no-store'})
      if(response.status>=300&&response.status<400)throw new FixtureSetupError('FIXTURE_REDIRECT_DENIED',response.status)
      if(response.url&&new URL(response.url).origin!==STAGING_ORIGIN)throw new FixtureSetupError('FIXTURE_RESPONSE_ORIGIN_DENIED',response.status)
      if(!response.ok) {
        // An HTTP denial is different from a network failure. Its status is
        // sufficient diagnostic evidence; discard the body without parsing or
        // reporting server messages, credentials or user records.
        await response.body?.cancel().catch(()=>{})
        throw new FixtureSetupError('FIXTURE_HTTP_FAILED',response.status)
      }
      // Parse only a bounded internal buffer; raw errors and user records are
      // never returned in the CLI summary or logged.
      const reader=response.body?.getReader();reject(!reader,'FIXTURE_RESPONSE_INVALID')
      const parts=[];let bytes=0
      try {
        while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;
          reject(bytes>65536,'FIXTURE_RESPONSE_LIMIT');parts.push(Buffer.from(next.value))}
      } catch(error){await reader.cancel().catch(()=>{});throw error}finally{reader.releaseLock()}
      try{return JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw new FixtureSetupError('FIXTURE_RESPONSE_INVALID')}
    } catch(error) {
      if(error instanceof FixtureSetupError)throw error
      throw new FixtureSetupError('FIXTURE_REQUEST_FAILED')
    } finally{active=false}
  }
  return {request,metrics:()=>({requests})}
}
const headers=(key,bearer)=>({apikey:key,'Content-Type':'application/json',Accept:'application/json',
  ...(bearer?{Authorization:`Bearer ${bearer}`} :key.startsWith('ey')?{Authorization:`Bearer ${key}`}:{})})
export async function durableTest1Json(path,value,{initial=false}={}) {
  // Files are ignored, narrowly scoped and created with private POSIX mode.
  // Windows inherits the existing user's directory ACL; mode is not a DACL.
  const temporary=initial?path:`${path}.${randomUUID()}.tmp`
  const handle=await open(temporary,'wx',0o600)
  try {await handle.writeFile(JSON.stringify(value));await handle.sync()}finally{await handle.close()}
  if(!initial)await rename(temporary,path)
}
export function validateOwnedReceipt(receipt) {
  reject(!fields(receipt,['mode','projectRef','origin','runId','createdAt','users'])||receipt.mode!=='test1-media-owned-receipt'
    ||!UUID.test(receipt.runId||'')||receipt.projectRef!==STAGING_REF||receipt.origin!==STAGING_ORIGIN
    ||!Array.isArray(receipt.users)||receipt.users.length!==3)
  const labels=new Set(),ids=new Set()
  for(const entry of receipt.users) {
    reject(!fields(entry,['label','email','username','id','status'])||labels.has(entry.label))
    const expected=syntheticIdentity(receipt.runId,entry.label)
    reject(entry.email!==expected.email||entry.username!==expected.username
      ||!['planned','outcome_unknown','created','verified','deleted'].includes(entry.status)
      ||(entry.id!=null&&!UUID.test(entry.id))||(['created','verified','deleted'].includes(entry.status)&&!entry.id))
    labels.add(entry.label)
    if(entry.id){reject(ids.has(entry.id));ids.add(entry.id)}
  }
  return receipt
}
export async function runTest1AuthFixtures(options,{fetchImpl=globalThis.fetch,adminMode,save=durableTest1Json,
  loadReceipt=readTest1LocalMode,removeSession=unlink}={}) {
  if(!options.execute)return {created:0,verified:0,removed:0,requests:0,pending:1,users:[]}
  const mode=adminMode||await readTest1AdminMode()
  reject(mode.mode!=='test1-admin-fixtures'||mode.projectRef!==STAGING_REF||mode.origin!==STAGING_ORIGIN)
  validateTest1Key(mode.serviceKey,'service_role');validateTest1Key(mode.publicKey,'anon')
  const knownUserIds=new Set(),allowedEmails=new Set(),transport=fixtureRequestTransport(fetchImpl,{knownUserIds,allowedEmails})
  const summary={created:0,verified:0,removed:0,pending:1,users:[]}
  if(options.cleanup) {
    const receipt=validateOwnedReceipt(await loadReceipt(options.receiptPath))
    const receiptPath=resolve(root,options.receiptPath)
    // Cleanup cannot repurpose another local document as an owned receipt.
    reject(receiptPath!==resolve(TEST1_LOCAL_DIRECTORY,`test1-media-receipt-${receipt.runId}.json`))
    summary.runId=receipt.runId
    for(const entry of receipt.users)if(['created','verified'].includes(entry.status))knownUserIds.add(entry.id)
    try {
      for(const entry of receipt.users) {
        if(!knownUserIds.has(entry.id))continue
        const found=await transport.request(`/auth/v1/admin/users/${entry.id}`,'GET',headers(mode.serviceKey))
        const user=found.user||found
        reject(!fixtureUserMatches(user,entry,receipt.runId),'FIXTURE_CLEANUP_SCOPE_DENIED')
        await transport.request(`/auth/v1/admin/users/${entry.id}`,'DELETE',headers(mode.serviceKey))
        entry.status='deleted';await save(receiptPath,receipt);summary.removed++
      }
      const unknown=receipt.users.some(entry=>entry.status==='outcome_unknown')
      if(!unknown) {
        try{await removeSession(resolve(TEST1_LOCAL_DIRECTORY,`test1-media-session-${receipt.runId}.json`))}
        catch(error){if(error.code!=='ENOENT')throw error}
        summary.pending=0
      }
    } catch(error) {summary.pending=1;summary.failed=1;Object.assign(summary,sanitizedFixtureFailure(error))}
    return {...summary,...transport.metrics()}
  }
  const runId=randomUUID(),receiptPath=resolve(TEST1_LOCAL_DIRECTORY,`test1-media-receipt-${runId}.json`)
  const sessionPath=resolve(TEST1_LOCAL_DIRECTORY,`test1-media-session-${runId}.json`)
  const receipt={mode:'test1-media-owned-receipt',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId,
    createdAt:new Date().toISOString(),users:LABELS.map(label=>({...syntheticIdentity(runId,label),id:null,status:'planned'}))}
  for(const entry of receipt.users)allowedEmails.add(entry.email)
  const session={mode:'test1-media-sessions',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId,
    publicKey:mode.publicKey,users:{}}
  summary.runId=runId
  await save(receiptPath,receipt,{initial:true}) // Durable intent before the first creation.
  try {
    for(const entry of receipt.users) {
      const password=randomBytes(48).toString('base64url')+'aA1!'
      entry.status='outcome_unknown';await save(receiptPath,receipt)
      const created=await transport.request('/auth/v1/admin/users','POST',headers(mode.serviceKey),{
        email:entry.email,password,email_confirm:true,
        user_metadata:{username:entry.username,full_name:`Synthetic media ${entry.label}`},
        app_metadata:metadata(runId,entry.label),
      })
      const user=created.user||created
      reject(!UUID.test(user?.id||'')||knownUserIds.has(user.id),'FIXTURE_CREATE_INVALID')
      entry.id=user.id
      reject(!fixtureUserMatches(user,entry,runId)||!user.email_confirmed_at,'FIXTURE_CREATE_INVALID')
      knownUserIds.add(user.id);entry.status='created'
      await save(receiptPath,receipt) // Store known ownership before sign-in or the next account.
      summary.created++;summary.users.push({label:entry.label,id:entry.id})
      const signed=await transport.request('/auth/v1/token?grant_type=password','POST',headers(mode.publicKey),{email:entry.email,password})
      const claims=fixtureClaims(signed.access_token)
      reject(claims.iss!==STAGING_ORIGIN+'/auth/v1'||claims.role!=='authenticated'||claims.sub!==entry.id
        ||!Number.isFinite(claims.exp)||claims.exp*1000<Date.now()+180000,'FIXTURE_SESSION_INVALID')
      const verified=await transport.request('/auth/v1/user','GET',headers(mode.publicKey,signed.access_token))
      reject(!fixtureUserMatches(verified.user||verified,entry,runId)||!(verified.user||verified).email_confirmed_at,'FIXTURE_SESSION_INVALID')
      entry.status='verified';await save(receiptPath,receipt)
      session.users[entry.label]={id:entry.id,accessToken:signed.access_token,expiresAt:claims.exp}
      await save(sessionPath,session,{initial:summary.verified===0})
      summary.verified++
    }
    summary.pending=0
  } catch(error) {summary.failed=1;Object.assign(summary,sanitizedFixtureFailure(error))}
  return {...summary,...transport.metrics()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let summary
  try{summary=await runTest1AuthFixtures(parseFixtureArguments(process.argv.slice(2)))}
  catch(error){summary={created:0,verified:0,removed:0,requests:0,pending:1,failed:1,users:[],...sanitizedFixtureFailure(error)}}
  console.log(JSON.stringify(summary))
  if(summary.failed)process.exitCode=1
}
