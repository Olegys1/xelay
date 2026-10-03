// Prepared synthetic Auth MFA integration probe, never a human enrollment UI.
// Dry run by default. Exact test1 only; service credentials only from the fixed
// ignored admin mode. Media HTTP tests must finish before this revokes sessions.
import { createHmac,randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { STAGING_REF,STAGING_ORIGIN } from './hosted-media-checks.mjs'
import { FixtureSetupError,readTest1LocalMode,readTest1AdminMode,validateOwnedReceipt,fixtureUserMatches,fixtureClaims,
  TEST1_LOCAL_DIRECTORY,durableTest1Json,validateTest1Key } from './test1-auth-fixtures.mjs'
import { mediaEnvironmentFromSession } from './run-hosted-media-session.mjs'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODES=new Set(['MFA_CONFIGURATION_INVALID','MFA_SCOPE_DENIED','MFA_REQUEST_DENIED','MFA_REQUEST_LIMIT',
  'MFA_NETWORK_FAILED','MFA_HTTP_FAILED','MFA_RESPONSE_INVALID','MFA_PREFLIGHT_FAILED','MFA_CHECK_FAILED','MFA_LOCAL_IO_FAILED','MFA_SESSION_INVALID'])
export class MfaProbeError extends Error {
  constructor(code='MFA_CHECK_FAILED',status=0){const safe=CODES.has(code)?code:'MFA_CHECK_FAILED';super(safe);this.code=safe;
    this.httpStatus=Number.isInteger(status)&&status>=100&&status<=599?status:0}
}
const reject=(condition,code='MFA_CONFIGURATION_INVALID')=>{if(condition)throw new MfaProbeError(code)}
const PHASES=new Set(['preflight','session_validate','role_planned','role_created','ui_role_confirmed','factor_planned','factor_created',
  'factor_verified','restore_role','role_restored','restore_factor','awaiting_ui_role_delete','complete'])
const ENDPOINTS=new Set(['role_options','auth_identity','list_factors','self_identity','self_profile','roles_read',
  'role_insert','role_delete','enroll_factor','challenge_factor','verify_factor','delete_factor','admin_billing','unknown'])
export const sanitizedMfaFailure=(error,diagnostic)=>({failureCode:error instanceof MfaProbeError?error.code:
    error instanceof FixtureSetupError?'MFA_CONFIGURATION_INVALID':'MFA_LOCAL_IO_FAILED',
  httpStatus:error instanceof MfaProbeError?error.httpStatus:0,
  ...(PHASES.has(error?.phase)?{failurePhase:error.phase}:{}),
  ...(diagnostic?{failurePhase:PHASES.has(diagnostic.phase)?diagnostic.phase:'unknown',
    lastEndpointLabel:ENDPOINTS.has(diagnostic.endpointLabel)?diagnostic.endpointLabel:'unknown',
    lastResponseStatus:Number.isInteger(diagnostic.httpStatus)?diagnostic.httpStatus:0,
    responseBytes:Number.isSafeInteger(diagnostic.responseBytes)&&diagnostic.responseBytes>=0?diagnostic.responseBytes:0,
    responseLimit:[65536,1048576].includes(diagnostic.responseLimit)?diagnostic.responseLimit:65536}:{})})
const fail=sanitizedMfaFailure
const fields=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key))
const ROLE_FIELDS='id,user_id,role,university_id,academic_unit_id,granted_by,granted_at'
const rolePath=(userId)=>`/rest/v1/user_roles?select=${ROLE_FIELDS}&user_id=eq.${userId}&limit=100`
const ownedRolePath=(state)=>`/rest/v1/user_roles?select=${ROLE_FIELDS}&id=eq.${state.adminRoleId}&user_id=eq.${state.userId}&role=eq.ADMIN&university_id=is.null&academic_unit_id=is.null`
const ADMIN_RPC='/rest/v1/rpc/xelay_admin_billing_overview'
function endpointLabel(path,method) {
  if(path==='/rest/v1/user_roles')return method==='OPTIONS'?'role_options':'role_insert'
  if(path.startsWith('/rest/v1/user_roles?'))return method==='DELETE'?'role_delete':'roles_read'
  if(path===ADMIN_RPC)return 'admin_billing'
  if(path==='/auth/v1/user')return 'self_identity'
  if(path.startsWith('/rest/v1/profiles?'))return 'self_profile'
  if(path==='/auth/v1/factors')return 'enroll_factor'
  if(/^\/auth\/v1\/factors\/[^/]+\/challenge$/.test(path))return 'challenge_factor'
  if(/^\/auth\/v1\/factors\/[^/]+\/verify$/.test(path))return 'verify_factor'
  if(/^\/auth\/v1\/admin\/users\/[^/]+\/factors\/[^/]+$/.test(path))return 'delete_factor'
  if(/^\/auth\/v1\/admin\/users\/[^/]+\/factors$/.test(path))return 'list_factors'
  if(/^\/auth\/v1\/admin\/users\/[^/]+$/.test(path))return 'auth_identity'
  return 'unknown'
}
const privateHeaders=(key,token)=>({apikey:key,Accept:'application/json','Content-Type':'application/json',
  ...(token?{Authorization:`Bearer ${token}`}:key.startsWith('ey')?{Authorization:`Bearer ${key}`}:{})})
const canonicalRoles=(roles)=>JSON.stringify([...roles].sort((a,b)=>a.id.localeCompare(b.id)).map(role=>
  Object.fromEntries(ROLE_FIELDS.split(',').map(key=>[key,key==='granted_at'?new Date(role[key]).toISOString():role[key]]))))
function validRole(row,userId) {
  return fields(row,ROLE_FIELDS.split(','))&&UUID.test(row.id||'')&&row.user_id===userId
    &&['ADMIN','FACULTY_EDITOR'].includes(row.role)&&['university_id','academic_unit_id','granted_by']
      .every(key=>row[key]===null||UUID.test(row[key]||''))
    &&typeof row.granted_at==='string'&&row.granted_at.length<=64&&Number.isFinite(Date.parse(row.granted_at))
}
export function totpCode(secret,unixSeconds=Math.floor(Date.now()/1000)) {
  reject(typeof secret!=='string'||!/^[A-Z2-7]{16,128}=*$/.test(secret)||!Number.isFinite(unixSeconds)||unixSeconds<0)
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let buffer=0,bits=0;const bytes=[]
  for(const char of secret.replace(/=+$/,'')) {buffer=(buffer<<5)|alphabet.indexOf(char);bits+=5;
    if(bits>=8){bits-=8;bytes.push((buffer>>>bits)&255);buffer&=(1<<bits)-1}}
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds/30)))
  const hash=createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=hash[hash.length-1]&15
  const value=(hash.readUInt32BE(offset)&0x7fffffff)%1000000
  return String(value).padStart(6,'0')
}
export function parseMfaArguments(args=[]) {
  const options={execute:false,restoreOnly:false,preflightOnly:false,sessionPath:null,receiptPath:null,statePath:null,preseededRolePath:null}
  const flagFields={'--session-file':'sessionPath','--receipt-file':'receiptPath','--state-file':'statePath','--preseeded-role-file':'preseededRolePath'}
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--execute'){reject(options.execute);options.execute=true}
    else if(args[i]==='--restore-only'){reject(options.restoreOnly);options.restoreOnly=true}
    else if(args[i]==='--preflight-only'){reject(options.preflightOnly);options.preflightOnly=true}
    else if(flagFields[args[i]]){const field=flagFields[args[i]];reject(options[field]||!args[i+1]);options[field]=args[++i]}
    else throw new MfaProbeError('MFA_CONFIGURATION_INVALID')
  }
  reject(options.restoreOnly&&(options.preflightOnly||options.preseededRolePath)||options.execute&&(!options.receiptPath
    ||options.restoreOnly&&!options.statePath||!options.restoreOnly&&options.statePath
    ||!options.restoreOnly&&(!options.preflightOnly||options.preseededRolePath)&&!options.sessionPath))
  return options
}
export function assertMfaRequest(input,init={},context) {
  let url
  try{url=new URL(String(input))}catch{throw new MfaProbeError('MFA_REQUEST_DENIED')}
  reject(!context||url.origin!==STAGING_ORIGIN||url.protocol!=='https:'||url.username||url.password||url.hash,'MFA_REQUEST_DENIED')
  const method=(init.method||'GET').toUpperCase(),path=url.pathname+url.search,{userId,state}=context
  const authUser=`/auth/v1/admin/users/${userId}`,factors=authUser+'/factors'
  reject(!UUID.test(userId||''),'MFA_REQUEST_DENIED')
  let allowed=method==='GET'&&[authUser,factors,'/auth/v1/user',rolePath(userId),ADMIN_RPC,
    `/rest/v1/profiles?select=id&id=eq.${userId}`].includes(path)
  allowed=allowed||!context.readonlyRoles&&method==='OPTIONS'&&path==='/rest/v1/user_roles'
  if(state) {
    allowed=allowed||!context.readonlyRoles&&(method==='GET'&&path===ownedRolePath(state)||method==='DELETE'&&path===ownedRolePath(state))
    if(!context.readonlyRoles&&method==='POST'&&path==='/rest/v1/user_roles') {
      const body=init.body
      allowed=fields(body,['id','user_id','role','university_id','academic_unit_id','granted_by'])
        &&body.id===state.adminRoleId&&body.user_id===userId&&body.role==='ADMIN'
        &&body.university_id===null&&body.academic_unit_id===null&&body.granted_by===null
    }
    if(method==='POST'&&path==='/auth/v1/factors') {
      allowed=fields(init.body,['factor_type','friendly_name','issuer'])&&init.body.factor_type==='totp'
        &&init.body.friendly_name===state.factorFriendlyName&&init.body.issuer==='Xelay test1 synthetic'
    }
    if(state.factorId&&UUID.test(state.factorId)) {
      const factorPath=`/auth/v1/factors/${state.factorId}`
      allowed=allowed||method==='POST'&&path===factorPath+'/challenge'&&fields(init.body,['factorId'])&&init.body.factorId===state.factorId
        ||method==='POST'&&path===factorPath+'/verify'&&fields(init.body,['challenge_id','code'])
          &&UUID.test(init.body.challenge_id||'')&&/^\d{6}$/.test(init.body.code||'')
        ||method==='DELETE'&&path===factors+'/'+state.factorId
    }
  }
  reject(!allowed||['GET','DELETE','OPTIONS'].includes(method)&&init.body!=null,'MFA_REQUEST_DENIED')
}
export function mfaTransport(fetchImpl=globalThis.fetch,context,{now=Date.now}={}) {
  let requests=0,active=false,restoring=false,lastDiagnostic=null,enrollmentDiagnostic=null;const started=now()
  const request=async(path,method,headers,body,{allowDenied=false}={})=>{
    assertMfaRequest(STAGING_ORIGIN+path,{method,body},context)
    // Work gets at most 50 seconds/15 calls; reserve at least 70 seconds and
    // 9 calls for exact cleanup. Both phases share the hard 120s/24-call cap.
    const remaining=(restoring?120000:50000)-(now()-started)
    reject(active||requests>=24||!restoring&&requests>=15||remaining<=0,'MFA_REQUEST_LIMIT')
    const serialized=body==null?undefined:JSON.stringify(body)
    reject(serialized&&Buffer.byteLength(serialized)>4096,'MFA_REQUEST_LIMIT')
    const diagnostic={endpointLabel:endpointLabel(path,method),phase:context.phase?.()||'preflight',
      httpStatus:0,responseBytes:0,responseLimit:65536}
    lastDiagnostic=diagnostic
    active=true;requests++
    try {
      const response=await fetchImpl(STAGING_ORIGIN+path,{method,headers,body:serialized,
        signal:AbortSignal.timeout(Math.max(1,Math.floor(Math.min(8000,remaining)))),redirect:'manual',cache:'no-store'})
      diagnostic.httpStatus=response.status
      if(response.status>=300&&response.status<400||response.url&&new URL(response.url).origin!==STAGING_ORIGIN)throw new MfaProbeError('MFA_REQUEST_DENIED',response.status)
      if(!response.ok&&!allowDenied){await response.body?.cancel().catch(()=>{});throw new MfaProbeError('MFA_HTTP_FAILED',response.status)}
      // Auth returns an inline QR SVG in enrollment JSON even when the probe
      // only needs the secret. Increase solely this successful response's cap.
      if(response.ok&&method==='POST'&&path==='/auth/v1/factors')diagnostic.responseLimit=1048576
      if(method==='OPTIONS') {
        const allow=response.headers?.get('allow')||''
        await response.body?.cancel().catch(()=>{})
        reject(allow.length>1024,'MFA_RESPONSE_INVALID')
        return {status:response.status,allow}
      }
      // Successful factor deletion may be empty. All other private responses
      // are bounded and consumed internally without console/error disclosure.
      if(response.status===204)return {status:204,data:null}
      const reader=response.body?.getReader();reject(!reader,'MFA_RESPONSE_INVALID')
      const parts=[]
      try{while(true){const next=await reader.read();if(next.done)break;diagnostic.responseBytes+=next.value.byteLength;
        reject(diagnostic.responseBytes>diagnostic.responseLimit,'MFA_RESPONSE_INVALID');parts.push(Buffer.from(next.value))}}
      catch(error){await reader.cancel().catch(()=>{});throw error}finally{reader.releaseLock()}
      const text=Buffer.concat(parts).toString('utf8')
      try{return {status:response.status,data:text?JSON.parse(text):null}}
      catch{throw new MfaProbeError('MFA_RESPONSE_INVALID',response.status)}
    } catch(error){if(error instanceof MfaProbeError){if(!error.httpStatus)error.httpStatus=diagnostic.httpStatus;throw error}
      throw new MfaProbeError('MFA_NETWORK_FAILED',diagnostic.httpStatus)}
    finally{active=false;if(diagnostic.endpointLabel==='enroll_factor')enrollmentDiagnostic={...diagnostic}}
  }
  return {request,beginRestore:()=>{restoring=true},diagnostics:()=>lastDiagnostic?{...lastDiagnostic}:null,
    metrics:()=>({requests,...(enrollmentDiagnostic?{enrollmentResponseStatus:enrollmentDiagnostic.httpStatus,
      enrollmentResponseBytes:enrollmentDiagnostic.responseBytes,enrollmentResponseLimit:enrollmentDiagnostic.responseLimit}:{})})}
}
function roleMatches(row,state) {return row?.id===state.adminRoleId&&row.user_id===state.userId&&row.role==='ADMIN'
  &&row.university_id===null&&row.academic_unit_id===null&&row.granted_by===null}
function factorMatches(factor,state) {return factor?.id===state.factorId&&factor.friendly_name===state.factorFriendlyName
  &&(factor.factor_type||factor.type)==='totp'}
export function validateMfaRoleSeed(seed,receipt,entry) {
  reject(!fields(seed,['mode','projectRef','origin','runId','probeId','userId','adminRoleId','originalRoles',
    'initialRoleBaselineEmpty','syntheticUserConfirmed','role'])||seed.mode!=='test1-mfa-role-seed'
    ||seed.projectRef!==STAGING_REF||seed.origin!==STAGING_ORIGIN||seed.runId!==receipt.runId||seed.userId!==entry.id
    ||!UUID.test(seed.probeId||'')||!UUID.test(seed.adminRoleId||'')||seed.initialRoleBaselineEmpty!==true
    ||seed.syntheticUserConfirmed!==true||!Array.isArray(seed.originalRoles)||seed.originalRoles.length!==0
    ||!validRole(seed.role,entry.id)||!roleMatches(seed.role,{adminRoleId:seed.adminRoleId,userId:entry.id}),'MFA_SCOPE_DENIED')
  return seed
}
function validateState(state,receipt,entry) {
  reject(!fields(state,['mode','projectRef','origin','runId','probeId','userId','adminRoleId','factorFriendlyName','factorId',
    'originalRoles','rolePending','factorPending','stage','roleMode','seededRole'])||state.mode!=='test1-mfa-probe-owned'
    ||state.projectRef!==STAGING_REF||state.origin!==STAGING_ORIGIN||state.runId!==receipt.runId||state.userId!==entry.id
    ||!UUID.test(state.probeId||'')||!UUID.test(state.adminRoleId||'')
    ||state.factorFriendlyName!==`security_media_mfa_${state.probeId}`||state.factorId!=null&&!UUID.test(state.factorId)
    ||!Array.isArray(state.originalRoles)||state.originalRoles.length>100
    ||state.originalRoles.some(role=>!validRole(role,entry.id)||role.role==='ADMIN')
    ||state.roleMode!=null&&!['service_rest','ui_seeded'].includes(state.roleMode)
    ||state.roleMode==='ui_seeded'&&(state.originalRoles.length!==0||!validRole(state.seededRole,entry.id)
      ||!roleMatches(state.seededRole,state))
    ||typeof state.rolePending!=='boolean'||typeof state.factorPending!=='boolean'
    ||typeof state.stage!=='string'||state.stage.length>40,'MFA_SCOPE_DENIED')
  return state
}
export async function runTest1MfaProbe(options,{fetchImpl=globalThis.fetch,adminMode,load=readTest1LocalMode,
  save=durableTest1Json,now=Date.now}={}) {
  const summary={checksPassed:0,checksFailed:0,requests:0,rolesRestored:0,factorsRemoved:0,pending:1}
  if(!options.execute)return summary
  const admin=adminMode||await readTest1AdminMode()
  reject(admin.mode!=='test1-admin-fixtures'||admin.projectRef!==STAGING_REF||admin.origin!==STAGING_ORIGIN)
  validateTest1Key(admin.serviceKey,'service_role');validateTest1Key(admin.publicKey,'anon')
  const receipt=validateOwnedReceipt(await load(options.receiptPath))
  const entry=receipt.users.find(user=>user.label==='A')
  reject(!entry||entry.status!=='verified','MFA_SCOPE_DENIED')
  const roleSeed=options.preseededRolePath?validateMfaRoleSeed(await load(options.preseededRolePath),receipt,entry):null
  if(roleSeed)reject(resolve(options.preseededRolePath)!==resolve(TEST1_LOCAL_DIRECTORY,
    `test1-mfa-role-seed-${roleSeed.probeId}.json`),'MFA_SCOPE_DENIED')
  // Recovery and read-only service preflight never load user sessions. Exact
  // owned cleanup must still work after Auth verification expires/revokes them.
  let aal1Token=null,userHeaders=null
  if(!options.restoreOnly&&(!options.preflightOnly||roleSeed)) {
    try {
      const session=await load(options.sessionPath)
      mediaEnvironmentFromSession(session,{mode:'test1-media-fixtures',projectRef:STAGING_REF,origin:STAGING_ORIGIN,
        runId:receipt.runId,conversationId:randomUUID(),chatSpaceId:randomUUID()})
      reject(session.runId!==receipt.runId||entry.id!==session.users.A.id,'MFA_SCOPE_DENIED')
      aal1Token=session.users.A.accessToken;reject(fixtureClaims(aal1Token).aal!=='aal1','MFA_SCOPE_DENIED')
      userHeaders=privateHeaders(admin.publicKey,aal1Token)
    } catch(error) {
      if(error instanceof FixtureSetupError)throw Object.assign(new MfaProbeError('MFA_SESSION_INVALID'),{phase:'session_validate'})
      throw error
    }
  }
  const context={userId:entry.id,state:null,readonlyRoles:Boolean(roleSeed)},transport=mfaTransport(fetchImpl,context,{now}),service=privateHeaders(admin.serviceKey)
  let state=null,statePath=null,intentDurable=false
  context.phase=()=>state?.stage||'preflight'
  const check=(condition)=>{if(!condition){summary.checksFailed++;throw new MfaProbeError()}summary.checksPassed++}
  const authIdentity=async()=>{
    const response=await transport.request(`/auth/v1/admin/users/${entry.id}`,'GET',service),user=response.data.user||response.data
    reject(!fixtureUserMatches(user,entry,receipt.runId)||!user.email_confirmed_at,'MFA_SCOPE_DENIED')
    return user
  }
  const roles=async(headers=service)=>{
    const response=await transport.request(rolePath(entry.id),'GET',headers)
    reject(!Array.isArray(response.data)||response.data.length>=100||response.data.some(role=>!validRole(role,entry.id)),'MFA_PREFLIGHT_FAILED')
    return response.data
  }
  const listFactors=async()=>{
    const response=await transport.request(`/auth/v1/admin/users/${entry.id}/factors`,'GET',service)
    const list=Array.isArray(response.data)?response.data:response.data?.factors
    reject(!Array.isArray(list)||list.length>10,'MFA_RESPONSE_INVALID');return list
  }
  const persistRestore=async()=>{
    // Durable intent precedes every mutation. Later disk failures must not
    // prevent removal of the exact role/factor already recorded in that intent.
    try{await save(statePath,state)}catch{summary.stateSaveFailed=1}
  }
  const restore=async()=>{
    transport.beginRestore()
    await authIdentity() // Fresh immutable run identity before privileged removal.
    let restoreError=null
    if(state.roleMode==='ui_seeded') {
      // The operator owns this one row. Never use service REST or a potentially
      // revoked user token for role cleanup; require the separate exact UI SQL.
      summary.roleAwaitingUiDelete=1;summary.pending=1;state.rolePending=true
    } else try {
      const actual=(await transport.request(ownedRolePath(state),'GET',service)).data
      reject(!Array.isArray(actual)||actual.length>1||actual.some(role=>!roleMatches(role,state)),'MFA_SCOPE_DENIED')
      if(actual.length) {
        state.stage='restore_role';await persistRestore()
        const result=await transport.request(ownedRolePath(state),'DELETE',{...service,Prefer:'return=representation'})
        reject(!Array.isArray(result.data)||result.data.length!==1||!roleMatches(result.data[0],state),'MFA_CHECK_FAILED')
      }
      check(canonicalRoles(await roles())===canonicalRoles(state.originalRoles))
      state.rolePending=false;state.stage='role_restored';await persistRestore();summary.rolesRestored=1
    }catch(error){restoreError=error}
    try {
      // An interrupted enroll response may lose its ID; only the unique exact
      // friendly name on the owned synthetic user is eligible for recovery.
      const factors=await listFactors(),matching=factors.filter(factor=>factor.friendly_name===state.factorFriendlyName)
      reject(matching.length>1||matching.some(factor=>(factor.factor_type||factor.type)!=='totp'),'MFA_SCOPE_DENIED')
      if(matching.length) {
        reject(state.factorId&&state.factorId!==matching[0].id||!UUID.test(matching[0].id),'MFA_SCOPE_DENIED')
        state.factorId=matching[0].id;context.state=state
        reject(!factorMatches(matching[0],state),'MFA_SCOPE_DENIED')
        state.stage='restore_factor';state.factorPending=true;await persistRestore()
        await transport.request(`/auth/v1/admin/users/${entry.id}/factors/${state.factorId}`,'DELETE',service)
        summary.factorsRemoved=1
      }
      check(!(await listFactors()).some(factor=>factor.friendly_name===state.factorFriendlyName||factor.id===state.factorId))
      state.factorPending=false;await persistRestore()
    }catch(error){restoreError??=error}
    if(restoreError)throw restoreError
    // Preserve any unrelated factor; it is never an eligible cleanup target.
    await authIdentity();state.stage=state.roleMode==='ui_seeded'?'awaiting_ui_role_delete':'complete';await persistRestore()
  }
  try {
    if(options.restoreOnly)transport.beginRestore()
    else if(!roleSeed) {
      // OPTIONS exposes method privileges without changing grants or a role.
      // Fail closed when the gateway cannot prove SELECT/INSERT/DELETE access.
      const response=await transport.request('/rest/v1/user_roles','OPTIONS',service)
      const allowed=response.allow.split(',').map(method=>method.trim().toUpperCase())
      reject(!['GET','POST','DELETE'].every(method=>allowed.includes(method)),'MFA_PREFLIGHT_FAILED')
      summary.serviceRoleMethodsVerified=1
    }
    await authIdentity()
    if(options.restoreOnly) {
      state=validateState(await load(options.statePath),receipt,entry)
      statePath=resolve(options.statePath)
      reject(statePath!==resolve(TEST1_LOCAL_DIRECTORY,`test1-mfa-probe-${state.probeId}.json`),'MFA_SCOPE_DENIED')
      context.state=state;summary.probeId=state.probeId
      context.readonlyRoles=state.roleMode==='ui_seeded'
      intentDurable=true
      await restore();summary.pending=0
    } else if(options.preflightOnly&&!roleSeed) {
      reject((await roles()).some(role=>role.role==='ADMIN'),'MFA_PREFLIGHT_FAILED')
      summary.checksPassed++;summary.pending=0;summary.preflightOnly=true
    } else {
      const user=(await transport.request('/auth/v1/user','GET',userHeaders)).data
      reject(!fixtureUserMatches(user.user||user,entry,receipt.runId),'MFA_SCOPE_DENIED')
      reject((await listFactors()).length!==0,'MFA_PREFLIGHT_FAILED')
      const profile=(await transport.request(`/rest/v1/profiles?select=id&id=eq.${entry.id}`,'GET',userHeaders)).data
      reject(!Array.isArray(profile)||profile.length!==1||profile[0].id!==entry.id,'MFA_PREFLIGHT_FAILED')
      const actualRoles=await roles(roleSeed?userHeaders:service)
      if(roleSeed)check(canonicalRoles(actualRoles)===canonicalRoles([roleSeed.role]))
      else reject(actualRoles.some(role=>role.role==='ADMIN'),'MFA_PREFLIGHT_FAILED')
      if(options.preflightOnly) {
        summary.preflightOnly=true;summary.preseededRoleVerified=1;summary.roleAwaitingUiDelete=1
        return {...summary,...transport.metrics()}
      }
      const originalRoles=roleSeed?roleSeed.originalRoles:actualRoles
      const probeId=roleSeed?roleSeed.probeId:randomUUID()
      state={mode:'test1-mfa-probe-owned',projectRef:STAGING_REF,origin:STAGING_ORIGIN,runId:receipt.runId,probeId,
        userId:entry.id,adminRoleId:roleSeed?roleSeed.adminRoleId:randomUUID(),factorFriendlyName:`security_media_mfa_${probeId}`,factorId:null,
        originalRoles,rolePending:true,factorPending:false,stage:roleSeed?'ui_role_confirmed':'role_planned',
        roleMode:roleSeed?'ui_seeded':'service_rest',...(roleSeed?{seededRole:roleSeed.role}:{})}
      statePath=resolve(TEST1_LOCAL_DIRECTORY,`test1-mfa-probe-${probeId}.json`);context.state=state;summary.probeId=probeId
      await save(statePath,state,{initial:true})
      intentDurable=true
      if(!roleSeed) {
        const role=await transport.request('/rest/v1/user_roles','POST',{...service,Prefer:'return=representation'},
          {id:state.adminRoleId,user_id:entry.id,role:'ADMIN',university_id:null,academic_unit_id:null,granted_by:null})
        check(Array.isArray(role.data)&&role.data.length===1&&roleMatches(role.data[0],state))
        state.stage='role_created';await save(statePath,state)
      }
      const denied=await transport.request(ADMIN_RPC,'GET',userHeaders,null,{allowDenied:true})
      check([401,403].includes(denied.status)&&denied.data?.code==='42501')
      state.stage='factor_planned';state.factorPending=true;await save(statePath,state)
      const enrolled=(await transport.request('/auth/v1/factors','POST',userHeaders,
        {factor_type:'totp',friendly_name:state.factorFriendlyName,issuer:'Xelay test1 synthetic'})).data
      check(UUID.test(enrolled?.id||'')&&enrolled.type==='totp'&&typeof enrolled.totp?.secret==='string')
      state.factorId=enrolled.id;state.stage='factor_created';await save(statePath,state)
      const challenge=(await transport.request(`/auth/v1/factors/${state.factorId}/challenge`,'POST',userHeaders,{factorId:state.factorId})).data
      check(UUID.test(challenge?.id||''))
      const verified=(await transport.request(`/auth/v1/factors/${state.factorId}/verify`,'POST',userHeaders,
        {challenge_id:challenge.id,code:totpCode(enrolled.totp.secret)})).data
      const aal2Token=verified.access_token,claims=fixtureClaims(aal2Token)
      check(claims.iss===STAGING_ORIGIN+'/auth/v1'&&claims.role==='authenticated'&&claims.sub===entry.id&&claims.aal==='aal2')
      const aal2Headers=privateHeaders(admin.publicKey,aal2Token),fresh=(await transport.request('/auth/v1/user','GET',aal2Headers)).data
      check(fixtureUserMatches(fresh.user||fresh,entry,receipt.runId)
        &&(fresh.user||fresh).factors?.some(factor=>factorMatches(factor,state)&&factor.status==='verified'))
      state.stage='factor_verified';await save(statePath,state)
      // Once a real verified factor exists, the same AAL1 JWT must still fail
      // the DB gate. This isolates the assurance-level check from factor absence.
      const stillDenied=await transport.request(ADMIN_RPC,'GET',userHeaders,null,{allowDenied:true})
      check([401,403].includes(stillDenied.status)&&stillDenied.data?.code==='42501')
      const allowed=await transport.request(ADMIN_RPC,'GET',aal2Headers)
      check(allowed.status===200&&allowed.data&&typeof allowed.data==='object'&&!Array.isArray(allowed.data)
        &&Object.hasOwn(allowed.data,'active_participants')&&Array.isArray(allowed.data.orders)&&Array.isArray(allowed.data.audit))
      summary.pending=0
    }
  } catch(error){if(!summary.checksFailed)summary.checksFailed++;Object.assign(summary,fail(error,transport.diagnostics()))}
  finally {
    if(state&&intentDurable&&!options.restoreOnly) {
      try{await restore()}catch(error){summary.pending=1;summary.restoreFailed=1
        const failure=fail(error,transport.diagnostics())
        if(!summary.failureCode)Object.assign(summary,failure)
        else Object.assign(summary,Object.fromEntries(Object.entries(failure).map(([key,value])=>['restore'+key[0].toUpperCase()+key.slice(1),value])))
      }
    }
  }
  if(summary.checksFailed||summary.stateSaveFailed||summary.roleAwaitingUiDelete)summary.pending=1
  return {...summary,...transport.metrics()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let summary
  try{summary=await runTest1MfaProbe(parseMfaArguments(process.argv.slice(2)))}
  catch(error){summary={checksPassed:0,checksFailed:1,requests:0,rolesRestored:0,factorsRemoved:0,pending:1,...fail(error)}}
  console.log(JSON.stringify(summary))
  if(summary.checksFailed||summary.restoreFailed)process.exitCode=1
}
