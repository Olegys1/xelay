import { createHash, createHmac } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createAssistantCloudHandler, type AssistantCloudPorts } from './cloudHandler.ts'
import { createAuthenticatedAssistantReadService, type VerifiedAssistantSession } from './authenticatedRead.ts'
import { createSupabaseAssistantReadRepository, verifySupabaseAssistantSession } from './supabaseReadRepository.ts'
import { createCloudDraftRepository } from './cloudDraftRepository.ts'
import { createCloudConfirmedAssistantWrites } from './cloudWrites.ts'
import { createAuthenticatedAssistantChat } from './cloudChat.ts'
import { createOpenAiAssistantPlanner } from './cloudPlanner.ts'
import { createAssistantModelBudget, createSupabaseModelBudgetLedger } from './modelBudget.ts'
import { createCloudStudyServices } from './cloudStudyServices.ts'
import { createAssistantCloudTools } from './cloudTools.ts'
import { createOpenAiCloudTaskModel } from './cloudTaskModel.ts'

const project = 'https://baohfpadxvhqhhjjqtil.supabase.co'
const projectRef = 'baohfpadxvhqhhjjqtil'
// Structural checks reject a secret accidentally supplied as the public key.
// They do not verify a JWT signature; Supabase remains the key authority.
function legacyProjectKey(value: string, role: 'anon' | 'service_role') {
  if (value.length < 32 || value.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return false
  try {
    const [encodedHeader, encodedClaims] = value.split('.')
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'))
    const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'))
    return header?.alg === 'HS256' && (!header.typ || header.typ === 'JWT') && claims?.role === role
      && claims.iss === 'supabase' && claims.ref === projectRef
      && Number.isSafeInteger(claims.iat) && claims.iat > 0 && Number.isSafeInteger(claims.exp) && claims.exp > claims.iat
  } catch { return false }
}
export function assistantCloudConfiguration(env: Record<string, string | undefined>) {
  const enabled = env.ASSISTANT_ENABLED === 'true'
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const publicKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || ''
  const privateKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE || ''
  const isPublic = /^sb_publishable_[A-Za-z0-9_-]{16,200}$/.test(publicKey) || legacyProjectKey(publicKey, 'anon')
  const isPrivate = /^sb_secret_[A-Za-z0-9_-]{16,200}$/.test(privateKey) || legacyProjectKey(privateKey, 'service_role')
  // Drafts and the separately budgeted intent model have independent switches.
  const valid = env.ASSISTANT_CLOUD_DRAFTS_READY === 'true' && url === project && isPublic && isPrivate && publicKey !== privateKey
  const origins = ['https://www.xelay.ink', 'https://xelay.ink']
  if (env.VERCEL_ENV === 'preview' && /^[a-zA-Z0-9-]+\.vercel\.app$/.test(env.VERCEL_URL || '')) origins.push(`https://${env.VERCEL_URL}`)
  if (env.ASSISTANT_LOCAL_PREVIEW === 'true' && !env.VERCEL) origins.push('http://127.0.0.1:3078')
  // Domain separation reuses an already server-only secret. No new permanent
  // access key is created or downloaded. Neither secret reaches the browser.
  const confirmationSecret = valid ? createHmac('sha256', privateKey).update('xelay:assistant:cloud-confirmation-key:v1').digest('hex') : ''
  const modelKey = env.OPENAI_API_KEY || ''
  const modelEnabled = enabled && valid && env.ASSISTANT_MODEL_ENABLED === 'true' && env.ASSISTANT_MODEL_BUDGET_READY === 'true'
    && env.ASSISTANT_MODEL_SPEND_APPROVED === 'true' && /^sk-[A-Za-z0-9_-]{20,500}$/.test(modelKey)
  return { enabled, valid, url, publicKey, privateKey, origins, confirmationSecret, modelEnabled, modelKey }
}

export function createAssistantCloudRuntime(env: Record<string, string | undefined> = process.env) {
  const config = assistantCloudConfiguration(env)
  let ports: AssistantCloudPorts | undefined
  if (config.enabled && config.valid) {
    const safeFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000) })
    const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    const caller = (credential: string) => createClient(config.url, config.publicKey, { auth, global: { headers: { Authorization: `Bearer ${credential}` }, fetch: safeFetch } })
    const service = createClient(config.url, config.privateKey, { auth, global: { fetch: safeFetch } })
    const verifySession = (credential: string, signal?: AbortSignal) => signal?.aborted ? Promise.resolve(null) : verifySupabaseAssistantSession(caller(credential), credential)
    const repository = (credential: string, userId: string, verifiedSession?:VerifiedAssistantSession) => createSupabaseAssistantReadRepository({ client: caller(credential), userId, credential, ...(verifiedSession?{verifiedSession}:{}) })
    const readService = createCloudStudyServices({ verifySession,createCallerClient:(_session,credential)=>caller(credential), createCallerRepository: (session, credential) => repository(credential, session.userId,session),
      readStorageFile:async(descriptor,signal)=>{
        const {bucket,path,size}=descriptor
        if(!['xelay-study-materials','xelay-teaching-files'].includes(bucket)||!Number.isSafeInteger(size)||size<1||size>8*1024*1024||!/^([a-f\d-]{36}\/){2}[a-f\d-]{36}\.[a-z\d]{1,5}$/i.test(path))throw Object.assign(new Error('material_file_invalid'),{code:'material_file_invalid',status:422})
        const response=await safeFetch(config.url+'/storage/v1/object/authenticated/'+bucket+'/'+path.split('/').map(encodeURIComponent).join('/'),{headers:{apikey:config.privateKey,authorization:'Bearer '+config.privateKey},signal})
        const declared=response.headers.get('content-length')
        if(!response.ok||!response.body||declared&&(!/^\d+$/.test(declared)||Number(declared)>size)){try{await response.body?.cancel()}catch{};throw Object.assign(new Error('material_file_unavailable'),{code:'material_file_unavailable',status:503})}
        const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0
        try{for(;;){const r=await reader.read();if(r.done)break;total+=r.value.length;if(total>size){await reader.cancel();throw Object.assign(new Error('material_file_changed'),{code:'material_file_changed',status:409})}chunks.push(r.value)}}finally{reader.releaseLock()}
        if(total!==size)throw Object.assign(new Error('material_file_changed'),{code:'material_file_changed',status:409})
        return new Uint8Array(Buffer.concat(chunks))
      },
    })
    const journal = createCloudDraftRepository({ client: service, confirmationSecret: config.confirmationSecret })
    const writes = createCloudConfirmedAssistantWrites({ verifySession, createCallerClient: (_session, credential) => caller(credential), journal })
    ports = { verifySession, catalog: (session, credential, signal) => repository(credential, session.userId,session).catalog(signal), read: (credential, value, signal) => readService.read(credential, value, signal), writes }
    if (config.modelEnabled) {
      const planner = createOpenAiAssistantPlanner({ apiKey:config.modelKey, enabled:true, billingApproved:true })
      const budget = createAssistantModelBudget({ verifySession, ledger:createSupabaseModelBudgetLedger({client:service}) })
      const taskModel=createOpenAiCloudTaskModel({apiKey:config.modelKey,enabled:true,billingApproved:true})
      ports.tools=createAssistantCloudTools({verifySession,catalog:ports.catalog,read:ports.read,prepare:writes.prepare,materialContent:readService.materialContent,assertMaterialRights:readService.assertMaterialRights,
        canImportTestQuestions: async (credential, courseId, signal) => {
          const query = caller(credential).rpc('xelay_teaching_workspace')
          const { data, error } = await (signal ? query.abortSignal(signal) : query)
          return !error && data?.teacher_status?.has_current_access === true && Array.isArray(data.courses)
            && data.courses.some(course => course?.id === courseId && !course.archived_at
              && Array.isArray(course.permissions) && course.permissions.includes('assignments'))
        },
        model:async(credential,requestId,task)=>{
          const {signal:_signal,...data}=task
          const contextHash=createHash('sha256').update(JSON.stringify(data)).digest('hex')
          const result=await budget.run(credential,{requestId,contextHash},()=>taskModel.generate(task))
          return result.value
        },
      })
      const continuationSecret = createHmac('sha256',config.confirmationSecret).update('xelay:assistant:chat-continuation:v1').digest('hex')
      const readyPorts = ports
      ports.chat = async (credential,value,signal,requestId) => {
        let calls = 0
        const chat = createAuthenticatedAssistantChat({ verifySession, catalog:readyPorts.catalog, read:readyPorts.read, writes, continuationSecret,
          planner: async request => {
            if (++calls > 1) throw Object.assign(new Error('model_request_limit'),{code:'model_unavailable',status:503})
            const { signal:_signal,...data } = request
            const contextHash = createHash('sha256').update(JSON.stringify(data)).digest('hex')
            const output = await budget.run(credential,{requestId,contextHash},async () => {
              const planned = await planner.plan(request)
              return {value:planned.intent,usage:planned.usage}
            })
            return output.value
          } })
        return chat.chat(credential,value,signal)
      }
    }
  }
  return createAssistantCloudHandler({ enabled: config.enabled, ports, trustedOrigins: config.origins })
}
