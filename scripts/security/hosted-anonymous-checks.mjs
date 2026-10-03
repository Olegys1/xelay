// Prepared anonymous HTTP checks for the disposable test1 project only.
// Default is no network. --execute enables at most 20 sequential GET requests.
// Use XELAY_HOSTED_ANON_KEY, or --mode-file .security-audit.local/<file>.json:
// {mode:'test1-anonymous-readonly',projectRef,origin,publicKey}.
// No tokens, service credentials, signup, password, SQL or billing mutations.
import { readFile, lstat, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, sep } from 'node:path'
import { STAGING_REF, STAGING_ORIGIN } from './hosted-media-checks.mjs'

const root=fileURLToPath(new URL('../../',import.meta.url))
const localDirectory=resolve(root,'.security-audit.local')
export class AnonymousCheckError extends Error {
  constructor(code='CONFIGURATION_INVALID'){super(code);this.code=code}
}
const reject=(condition,code='CONFIGURATION_INVALID')=>{if(condition)throw new AnonymousCheckError(code)}
const query=(table,fields)=>`/rest/v1/${table}?select=${fields}&limit=1`
export const ANONYMOUS_CHECKS=Object.freeze([
  {id:'auth_settings',path:'/auth/v1/settings',expected:'settings'},
  // Categories are static CATEGORIES in src/types.ts; there is no categories
  // table. This checks the public question/category projection used by feeds.
  {id:'public_questions_categories',path:query('questions','id,category'),expected:'array'},
  {id:'public_universities',path:query('universities','id'),expected:'catalog'},
  {id:'public_faculties',path:query('academic_units','id'),expected:'catalog'},
  {id:'public_programs',path:query('academic_specialties','id'),expected:'catalog'},
  // 006 intentionally closes the table, while this existing STABLE RPC stays
  // public and exposes a selected field list excluding email. Empty IDs avoid
  // fetching or reporting profiles, and GET has no modifying RPC semantics.
  {id:'public_profile_contract',path:'/rest/v1/rpc/xelay_profiles_by_ids?p_user_ids=%7B%7D',expected:'empty'},
  {id:'profile_email_closed',path:query('profiles','email'),expected:'closed'},
  {id:'legacy_users_closed',path:query('xelay_users','id'),expected:'closed'},
  {id:'private_conversations_closed',path:query('conversations','id'),expected:'closed'},
  {id:'private_messages_closed',path:query('messages','id'),expected:'closed'},
  {id:'chat_metadata_closed',path:query('chat_spaces','id'),expected:'closed'},
  {id:'chat_messages_closed',path:query('chat_posts','id'),expected:'closed'},
  {id:'public_upload_leases_closed',path:query('public_media_upload_reservations','bucket_id'),expected:'closed'},
  {id:'private_upload_leases_closed',path:query('private_media_upload_reservations','bucket_id'),expected:'closed'},
  {id:'public_cleanup_claims_closed',path:query('public_media_cleanup_claims','bucket_id'),expected:'closed'},
  {id:'private_cleanup_claims_closed',path:query('private_media_cleanup_claims','bucket_id'),expected:'closed'},
  {id:'billing_orders_closed',path:query('billing_orders','id'),expected:'closed'},
  {id:'participant_entitlements_closed',path:query('participant_entitlements','id'),expected:'closed'},
  {id:'group_entitlements_closed',path:query('group_entitlements','group_id'),expected:'closed'},
  {id:'cleanup_cursors_closed',path:query('media_cleanup_bucket_cursors','bucket_id'),expected:'closed'},
].map(check=>Object.freeze(check)))

function validateKey(key) {
  reject(typeof key!=='string'||key.length<20||key.length>10000||/\s/.test(key)||key.startsWith('sb_secret_'))
  if(key.startsWith('ey')) {
    let claims
    try{claims=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString('utf8'))}catch{throw new AnonymousCheckError()}
    reject(claims.role!=='anon'||claims.ref!==STAGING_REF||!Number.isFinite(claims.exp)||claims.exp*1000<=Date.now()+60000)
  } else reject(!key.startsWith('sb_publishable_'))
  return key
}

export async function parseAnonymousConfiguration(env={},args=[]) {
  let execute=false,modePath=null
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--execute'){reject(execute);execute=true}
    else if(args[i]==='--mode-file'){reject(modePath||!args[i+1]);modePath=args[++i]}
    else throw new AnonymousCheckError()
  }
  reject(env.XELAY_HOSTED_ANON_REF&&env.XELAY_HOSTED_ANON_REF!==STAGING_REF)
  reject(env.XELAY_HOSTED_ANON_URL&&env.XELAY_HOSTED_ANON_URL!==STAGING_ORIGIN)
  if(!execute)return {execute:false,origin:STAGING_ORIGIN}
  let key=env.XELAY_HOSTED_ANON_KEY
  if(modePath) {
    reject(Boolean(key)) // Use one explicit source; never merge credentials.
    const path=resolve(root,modePath)
    reject(!path.startsWith(localDirectory+sep))
    try {
      const info=await lstat(path)
      reject(!info.isFile()||info.isSymbolicLink()||info.size>16384)
      reject((await lstat(localDirectory)).isSymbolicLink())
      reject(!(await realpath(path)).startsWith((await realpath(localDirectory))+sep))
      // The local directory is ignored by the repository's *.local rule.
      reject(!(await readFile(resolve(root,'.gitignore'),'utf8')).split(/\r?\n/).some(line=>line.trim()==='*.local'))
      const mode=JSON.parse(await readFile(path,'utf8'))
      reject(Object.keys(mode).some(field=>!['mode','projectRef','origin','publicKey'].includes(field))
        ||mode.mode!=='test1-anonymous-readonly'||mode.projectRef!==STAGING_REF||mode.origin!==STAGING_ORIGIN)
      key=mode.publicKey
    } catch {throw new AnonymousCheckError()}
  }
  return {execute:true,origin:STAGING_ORIGIN,key:validateKey(key)}
}

export function assertAnonymousRequest(input,init={}) {
  let url
  try{url=new URL(String(input))}catch{throw new AnonymousCheckError('REQUEST_DENIED')}
  reject(url.origin!==STAGING_ORIGIN||url.protocol!=='https:'||url.username||url.password||url.hash,'REQUEST_DENIED')
  reject((init.method||'GET').toUpperCase()!=='GET'||init.body!=null,'REQUEST_DENIED')
  reject(!ANONYMOUS_CHECKS.some(check=>url.href===STAGING_ORIGIN+check.path),'REQUEST_DENIED')
}

// Error text, details, hints, records and settings values are never reported.
// A hidden schema endpoint is distinguished from a permission error: 404 can
// also mean a missing table, so SQL/schema installation must be verified first.
export function classifyAnonymousResponse(check,status,payload) {
  const rawCode=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload.code:null
  const errorCode=typeof rawCode==='string'&&/^[A-Za-z0-9_]{1,32}$/.test(rawCode)?rawCode:null
  let passed=false,hidden=false
  if(check.expected==='closed') {
    passed=([401,403].includes(status)&&errorCode==='42501')||(status===404&&errorCode==='PGRST205')
    hidden=passed&&status===404
  } else if(status===200) {
    if(check.expected==='settings')passed=payload!==null&&typeof payload==='object'&&!Array.isArray(payload)&&!errorCode
    else passed=Array.isArray(payload)&&(check.expected!=='empty'||payload.length===0)&&(check.expected!=='catalog'||payload.length>0)
  }
  return {status,errorCode,passed,hidden}
}

async function boundedJson(response,signal) {
  // Retain a small private buffer only for status/shape classification. Even
  // an unexpected endpoint response cannot dump arbitrary records or PII.
  const reader=response.body?.getReader()
  if(!reader)throw new AnonymousCheckError('RESPONSE_INVALID')
  const parts=[];let size=0
  try {
    while(true) {
      if(signal.aborted)throw new AnonymousCheckError('REQUEST_FAILED')
      const next=await reader.read()
      if(next.done)break
      size+=next.value.byteLength
      reject(size>65536,'RESPONSE_LIMIT')
      parts.push(Buffer.from(next.value))
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch(error) {
    await reader.cancel().catch(()=>{})
    if(error instanceof AnonymousCheckError)throw error
    throw new AnonymousCheckError('RESPONSE_INVALID')
  } finally {reader.releaseLock()}
}

export async function runAnonymousChecks(config,{fetchImpl=globalThis.fetch}={}) {
  if(!config.execute)return {checksPassed:0,checksFailed:0,requests:0,hiddenEndpoints:0,pending:1,results:[]}
  const key=validateKey(config.key)
  reject(config.origin!==STAGING_ORIGIN)
  const started=Date.now(),results=[]
  let requests=0,transportFailures=0
  const headers={apikey:key,Accept:'application/json'}
  if(key.startsWith('ey'))headers.Authorization=`Bearer ${key}`
  for(const check of ANONYMOUS_CHECKS) {
    try {
      const url=STAGING_ORIGIN+check.path
      assertAnonymousRequest(url)
      reject(requests>=20||Date.now()-started>=60000,'REQUEST_LIMIT')
      const signal=AbortSignal.timeout(Math.min(8000,60000-(Date.now()-started)))
      requests++
      const response=await fetchImpl(url,{method:'GET',headers,signal,redirect:'manual',cache:'no-store'})
      reject(response.status>=300&&response.status<400,'RESPONSE_REDIRECT_DENIED')
      reject(response.url&&new URL(response.url).origin!==STAGING_ORIGIN,'RESPONSE_ORIGIN_DENIED')
      const classified=classifyAnonymousResponse(check,response.status,await boundedJson(response,signal))
      results.push({check:check.id,status:classified.status,errorCode:classified.errorCode,passed:classified.passed,hidden:classified.hidden})
    } catch(error) {
      transportFailures++
      results.push({check:check.id,status:0,errorCode:error instanceof AnonymousCheckError?error.code:'REQUEST_FAILED',passed:false,hidden:false})
      // Continuing after a network/credential/cache issue adds no permission
      // evidence. Schema permission failures themselves still test every case.
      break
    }
  }
  return {checksPassed:results.filter(result=>result.passed).length,checksFailed:results.filter(result=>!result.passed).length,
    requests,hiddenEndpoints:results.filter(result=>result.hidden).length,
    pending:transportFailures||results.length<ANONYMOUS_CHECKS.length?1:0,results}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let summary
  try{summary=await runAnonymousChecks(await parseAnonymousConfiguration(process.env,process.argv.slice(2)))}
  catch{summary={checksPassed:0,checksFailed:1,requests:0,hiddenEndpoints:0,pending:1,results:[]}}
  console.log(JSON.stringify(summary))
  if(summary.checksFailed)process.exitCode=1
}
