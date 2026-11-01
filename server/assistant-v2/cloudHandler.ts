import type { IncomingMessage, ServerResponse } from 'node:http'
import type { VerifiedAssistantSession } from './authenticatedRead.ts'

type Request = IncomingMessage & { body?: unknown }
type ObjectValue = Record<string, any>
export interface AssistantCloudPorts {
  verifySession(credential: string, signal?: AbortSignal): Promise<VerifiedAssistantSession | null>
  catalog(session: VerifiedAssistantSession, credential: string, signal?: AbortSignal): Promise<ObjectValue>
  read(credential: string, value: unknown, signal?: AbortSignal): Promise<ObjectValue>
  chat?(credential: string, value: unknown, signal: AbortSignal | undefined, requestId: string): Promise<ObjectValue>
  tools?:{importSchedule(credential:string,value:unknown,signal?:AbortSignal):Promise<ObjectValue>;batchHomework(credential:string,value:unknown,signal?:AbortSignal):Promise<ObjectValue>;explainMaterial(credential:string,value:unknown,signal?:AbortSignal):Promise<ObjectValue>}
  writes: { [key in 'list' | 'prepare' | 'edit' | 'cancel' | 'confirm']: (credential: string, value?: any) => Promise<ObjectValue> } & {form?:(credential:string,value:unknown)=>Promise<ObjectValue>}
}
export interface AssistantCloudHandlerOptions {
  enabled: boolean
  ports?: AssistantCloudPorts
  trustedOrigins?: readonly string[]
  now?: () => number
}
const maximumBody = 180_000
const methods: Record<string, string> = { bootstrap: 'GET', catalog: 'GET', drafts: 'GET', read: 'POST', chat: 'POST', 'drafts/form':'POST', 'import/prepare':'POST', 'homework/prepare-batch':'POST', 'materials/explain':'POST', 'drafts/prepare': 'POST', 'drafts/edit': 'POST', 'drafts/cancel': 'POST', 'drafts/confirm': 'POST' }
const safeErrors = new Set(('session_invalid session_changed session_unavailable access_denied permission_required access_changed material_changed assistant_disabled configuration_unavailable database_unavailable repository_unavailable repository_scope_violation repository_invalid_response invalid_request invalid_payload invalid_scope invalid_date invalid_date_range invalid_limit invalid_text invalid_schedule schedule_overlap lesson_not_on_date group_required course_required study_subject_required draft_expired draft_changed draft_conflict draft_not_found draft_unavailable confirmation_required draft_review_required invalid_binding draft_limit execution_unknown participant_required membership_required unsupported_action one_off_schedule_required recurring_schedule_requires_platform_editor student_homework_deadline_not_supported rate_limited request_cancelled body_limit origin_required not_found method_not_allowed target_unavailable material_requires_platform_editor account_inactive').split(' '))
for (const code of ('model_not_connected model_configuration_required model_balance_required model_context_invalid model_context_too_large model_invalid_response model_timeout model_unavailable model_rate_limited model_refused chat_context_expired assistant_model_budget_disabled assistant_model_budget_exhausted assistant_model_budget_replay assistant_model_budget_halted assistant_model_budget_unavailable assistant_model_request_failed assistant_model_usage_invalid').split(' ')) safeErrors.add(code)
for(const code of 'model_safety_unavailable import_row_limit attachment_count_limit attachment_name_invalid attachment_encoding_invalid attachment_size_invalid attachment_total_limit attachment_format_unsupported attachment_content_invalid attachment_mime_mismatch table_invalid table_dimensions_limit table_sheet_limit table_text_limit table_empty sheet_url_invalid sheet_download_limit sheet_download_invalid sheet_unavailable material_ai_not_allowed material_content_unavailable'.split(' '))safeErrors.add(code)
for(const code of 'invalid_deadline invalid_reminder invalid_recurrence explicit_series_scope_required material_rights_acceptance_required material_edit_permission_required material_group_permission_required material_author_required material_conflict attachment_owner_required attachment_metadata_immutable invalid_attachment invalid_material_status grade_conflict grade_revision_reason_required invalid_grade grades_have_no_changes invalid_grading_rules invalid_schedule_copy copy_preview_unavailable copy_has_no_new_lessons seminar_reopen_required conflict_version_required material_ai_unavailable material_unavailable material_text_unavailable material_file_invalid material_file_changed material_file_unavailable'.split(' '))safeErrors.add(code)
for(const code of ['seminar_selection_closed','copy_weekend_target_required'])safeErrors.add(code)
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, keys: string[]) => object(value) && Object.keys(value).every(key => keys.includes(key))
const failure = (code: string, status = 400) => Object.assign(new Error(code), { code, status })
function send(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", vary: 'Authorization, Origin' })
  res.end(JSON.stringify(value))
}
async function bodyOf(req: Request,maximumBody=180000) {
  if (typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']) || req.headers['content-encoding']) throw failure('invalid_request', 415)
  const length = req.headers['content-length']
  if (length && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > maximumBody)) throw failure('body_limit', 413)
  let value: unknown
  if (req.body !== undefined) {
    try {
      const raw = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body)
      if (Buffer.byteLength(raw) > maximumBody) throw failure('body_limit', 413)
      value = JSON.parse(raw)
    } catch (error: any) { if (error?.code === 'body_limit') throw error; throw failure('invalid_request') }
  } else {
    const chunks: Buffer[] = []; let size = 0
    try {
      for await (const chunk of req) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > maximumBody) throw failure('body_limit', 413); chunks.push(bytes) }
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure('invalid_request') }
    } finally { chunks.forEach(chunk => chunk.fill(0)) }
  }
  if (!object(value) || Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw failure('invalid_request')
  return value
}

/** Same-origin cloud boundary. The only model port is the separately enabled,
 * budgeted intent chat. No arbitrary provider, caller identity or write retry. */
export function createAssistantCloudHandler(options: AssistantCloudHandlerOptions) {
  const origins = new Set(options.trustedOrigins || ['https://www.xelay.ink', 'https://xelay.ink'])
  const now = options.now || Date.now
  // Cheap per-instance burst guard, in addition to private journal limits and
  // database RLS. This is deliberately not advertised as a global cost cap.
  const bursts = new Map<string, { until: number; count: number }>()
  const ports = options.ports
  return async function assistantCloudHandler(req: Request, res: ServerResponse) {
    const abort = new AbortController(), cancel = () => { if (!res.writableEnded) abort.abort() }
    res.once('close', cancel)
    try {
      const url = new URL(req.url || '/', 'https://www.xelay.ink')
      if ([...url.searchParams.keys()].some(key => key !== 'route') || url.searchParams.getAll('route').length !== 1) throw failure('invalid_request')
      const route = url.searchParams.get('route') || ''
      if (!Object.prototype.hasOwnProperty.call(methods, route)) throw failure('not_found', 404)
      if (req.method !== methods[route]) throw failure('method_not_allowed', 405)
      if (req.method === 'POST' && (typeof req.headers.origin !== 'string' || !origins.has(req.headers.origin) || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) throw failure('origin_required', 403)
      const credential = typeof req.headers.authorization === 'string' ? req.headers.authorization.match(/^Bearer ([^\s]{16,8192})$/)?.[1] : undefined
      if (!credential) throw failure('session_invalid', 401)
      if (route === 'bootstrap') return send(res, 200, { available: !!(options.enabled && ports), modelConnected: !!(options.enabled && ports?.chat), writesAvailable: !!(options.enabled && ports) })
      if (!options.enabled) throw failure('assistant_disabled', 503)
      if (!ports) throw failure('configuration_unavailable', 503)
      const session = await ports.verifySession(credential, abort.signal)
      if (!session || !session.accountActive || !session.emailConfirmed || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= now()) throw failure('session_invalid', 401)
      const key = session.userId, time = now()
      if (bursts.size >= 5000) for (const [id, entry] of bursts) if (entry.until <= time) bursts.delete(id)
      const entry = bursts.get(key)
      if (entry && entry.until > time) { if (++entry.count > 90) throw failure('rate_limited', 429) }
      else { if (bursts.size >= 5000) throw failure('rate_limited', 429); bursts.set(key, { until: time + 60_000, count: 1 }) }
      const body = req.method === 'POST' ? await bodyOf(req,route==='import/prepare'?3800000:maximumBody) : undefined
      let result: ObjectValue
      if (route === 'catalog') {
        result = await ports.catalog(session, credential, abort.signal)
        if (result.userId !== session.userId) throw failure('session_changed', 401)
        const latest = await ports.verifySession(credential, abort.signal)
        if (!latest || !latest.accountActive || !latest.emailConfirmed || !Number.isFinite(Date.parse(latest.expiresAt))
          || Date.parse(latest.expiresAt) <= now() || latest.userId !== session.userId || latest.sessionId !== session.sessionId) throw failure('session_changed', 401)
      } else if (route === 'read') {
        if (!exact(body, ['topic', 'scope', 'limit'])) throw failure('invalid_request')
        const { modelContext: _privateModelContext, ...publicRead } = await ports.read(credential, body, abort.signal)
        if (publicRead.userId !== session.userId) throw failure('session_changed', 401)
        result = publicRead
      } else if (route === 'chat') {
        if (!exact(body, ['message','teacherMessage','scope','history','continuation','requestId']) || typeof body?.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId) || body.requestId === '00000000-0000-0000-0000-000000000000') throw failure('invalid_request')
        if (!ports.chat) throw failure('model_not_connected',409)
        const { requestId, ...chatBody } = body
        result = await ports.chat(credential, chatBody, abort.signal, requestId.toLowerCase())
        if (result.userId !== session.userId) throw failure('session_changed',401)
      } else if(route==='drafts/form') {
        if(!exact(body,['action','scope','payload'])||!ports.writes.form)throw failure('unsupported_action',422)
        result=await ports.writes.form(credential,body)
      } else if(['import/prepare','homework/prepare-batch','materials/explain'].includes(route)) {
        if(!ports.tools)throw failure('model_not_connected',409)
        const operation=route==='import/prepare'?'importSchedule':route==='homework/prepare-batch'?'batchHomework':'explainMaterial'
        result=await ports.tools[operation](credential,body,abort.signal)
        if(result.userId!==session.userId)throw failure('session_changed',401)
      } else if (route === 'drafts') result = await ports.writes.list(credential)
      else {
        const shape = route === 'drafts/prepare' ? ['action', 'scope', 'payload'] : route === 'drafts/edit' ? ['id', 'revision', 'confirmationToken', 'payload'] : route==='drafts/confirm'?['id','revision','confirmationToken','acceptMaterialRights']:['id', 'revision', 'confirmationToken']
        if (!exact(body, shape)) throw failure('invalid_request')
        if(body?.acceptMaterialRights!==undefined&&typeof body?.acceptMaterialRights!=='boolean')throw failure('invalid_request')
        const operation = route.slice('drafts/'.length) as 'prepare' | 'edit' | 'cancel' | 'confirm'
        result = await ports.writes[operation](credential, body)
      }
      if (!abort.signal.aborted) send(res, 200, result)
    } catch (error: any) {
      if (abort.signal.aborted) return
      const code = safeErrors.has(error?.code) ? error.code : 'assistant_unavailable'
      const status = safeErrors.has(error?.code) && Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 503
      send(res, status, { error: code })
    } finally { res.off('close', cancel) }
  }
}
