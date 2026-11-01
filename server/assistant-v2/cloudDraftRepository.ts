import { createHash, createHmac, randomBytes } from 'node:crypto'

/** Private server port only. The service client touches the confirmation journal;
 * a separate verified-caller client must perform every business/RLS operation. */
export interface AssistantCloudJournalClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}
export type CloudDraftStatus = 'pending' | 'committing' | 'confirmed' | 'cancelled' | 'unknown'
export interface CloudDraftEnvelope {
  id: string; userId: string; revision: number; status: CloudDraftStatus;
  createdAt: string; expiresAt: string; document: Record<string, any>;
  confirmationToken: string; receipt?: Record<string, any>;
}
export interface CloudDraftRepository {
  readonly mode: 'supabase-service-journal'
  create(userId: string, draftDocument: Record<string, any>): Promise<CloudDraftEnvelope>
  replace(userId: string, id: string, expectedRevision: number, confirmationToken: string, document: Record<string, any>): Promise<CloudDraftEnvelope>
  cancel(userId: string, id: string, revision: number, confirmationToken: string): Promise<CloudDraftEnvelope>
  get(userId: string, id: string): Promise<CloudDraftEnvelope>
  list(userId: string, limit?: number): Promise<CloudDraftEnvelope[]>
  claim(userId: string, id: string, revision: number, confirmationToken: string): Promise<{ claimed: boolean; record: CloudDraftEnvelope; claimToken?: string }>
  finish(userId: string, id: string, claimToken: string, outcome: 'confirmed' | 'unknown', receipt?: Record<string, any>): Promise<CloudDraftEnvelope>
}
export class CloudDraftRepositoryError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); this.name = 'CloudDraftRepositoryError' }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^[a-f0-9]{48}$/
const STATUSES = new Set(['pending', 'committing', 'confirmed', 'cancelled', 'unknown'])
const RESERVED = new Set(['id','userId','revision','status','createdAt','expiresAt','receipt','confirmationToken','claimToken'])
const FORBIDDEN = /"(?:__proto__|constructor|prototype|authorization|access_token|refresh_token|password|apiKey|serviceRoleKey|cookie|confirmationToken|claimToken)"\s*:/i
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
function fail(code = 'cloud_draft_unavailable', status = 503): never { throw new CloudDraftRepositoryError(code, status) }
const id = (value: unknown) => typeof value === 'string' && UUID.test(value) && value !== '00000000-0000-0000-0000-000000000000' ? value.toLowerCase() : fail('invalid_identifier', 400)
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1_000_000 ? Number(value) : fail('draft_changed', 409)
const token = (value: unknown) => typeof value === 'string' && TOKEN.test(value) ? value : fail('confirmation_required', 403)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function safeJson(value: unknown, maximum: number) {
  let raw: string | undefined; try { raw = JSON.stringify(value) } catch { fail('invalid_payload', 400) }
  if (!raw || Buffer.byteLength(raw) > maximum || FORBIDDEN.test(raw)) fail('invalid_payload', 400)
}
function documentOf(value: unknown): Record<string, any> {
  if (!object(value)) fail('invalid_payload', 400)
  const document = Object.fromEntries(Object.entries(value).filter(([key]) => !RESERVED.has(key)))
  safeJson(document, 170_000)
  if (!object(document.scope) || !object(document.payload) || typeof document.action !== 'string') fail('invalid_payload', 400)
  return structuredClone(document)
}

export function createCloudDraftRepository(options: { client: AssistantCloudJournalClient; confirmationSecret: string }): CloudDraftRepository {
  if (!options?.client || typeof options.client.rpc !== 'function' || typeof options.confirmationSecret !== 'string'
    || options.confirmationSecret.length < 32 || options.confirmationSecret.length > 8192 || /[\r\n\u0000]/.test(options.confirmationSecret)) throw new TypeError('private_cloud_draft_dependencies_required')
  const confirmation = (userId: string, draftId: string, version: number) => createHmac('sha256', options.confirmationSecret)
    .update(`xelay:assistant:confirmation:v1\0${userId}\0${draftId}\0${version}`).digest('hex').slice(0,48)
  async function rpc(name: string, args: Record<string, unknown>) {
    let result: { data: unknown; error: any }
    try { result = await options.client.rpc(name, args) as typeof result } catch { return fail() }
    if (!result || result.error) {
      const code = result?.error?.code, message = result?.error?.message
      if (code === 'PT404') fail('draft_not_found', 404)
      if (code === 'PT409') fail('draft_changed', 409)
      if (code === 'PT429') fail('draft_limit', 429)
      if (code === '42501' && message === 'ASSISTANT_DRAFT_ACCOUNT_REQUIRED') fail('session_invalid', 401)
      if (code === '22023') fail('invalid_payload', 400)
      return fail()
    }
    return result.data
  }
  function envelope(value: unknown, userId: string, draftId?: string): CloudDraftEnvelope {
    if (!object(value) || id(value.userId) !== userId || draftId && value.id !== draftId || !STATUSES.has(value.status)
      || !object(value.document) || typeof value.createdAt !== 'string' || typeof value.expiresAt !== 'string'
      || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.createdAt) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.expiresAt)
      || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.expiresAt))) fail()
    const normalizedId = id(value.id), version = revision(value.revision)
    safeJson(value.document, 180_000)
    if (value.receipt != null) { if (!object(value.receipt)) fail(); safeJson(value.receipt, 12000) }
    return { id: normalizedId, userId, revision: version, status: value.status, createdAt: value.createdAt, expiresAt: value.expiresAt,
      document: structuredClone(value.document), confirmationToken: confirmation(userId, normalizedId, version),
      ...(value.receipt == null ? {} : { receipt: structuredClone(value.receipt) }) }
  }
  const binding = (user: string, draft: string, version: number, rawToken: string) => ({
    p_user_id: id(user), p_id: id(draft), p_revision: revision(version), p_confirmation_hash: digest(token(rawToken)),
  })
  return {
    mode: 'supabase-service-journal',
    async create(user, value) {
      const userId = id(user), draftId = id(value?.id), document = documentOf(value)
      return envelope(await rpc('xelay_assistant_cloud_draft_create', { p_user_id: userId, p_id: draftId, p_document: document,
        p_confirmation_hash: digest(confirmation(userId,draftId,1)) }), userId, draftId)
    },
    async replace(user, draft, version, rawToken, value) {
      const userId = id(user), draftId = id(draft), nextVersion = revision(version) + 1
      if (nextVersion > 1_000_000) fail('draft_changed',409)
      return envelope(await rpc('xelay_assistant_cloud_draft_replace', { ...binding(userId,draftId,version,rawToken),
        p_document: documentOf(value), p_new_confirmation_hash: digest(confirmation(userId,draftId,nextVersion)) }), userId, draftId)
    },
    async cancel(user, draft, version, rawToken) {
      const userId = id(user), draftId = id(draft)
      return envelope(await rpc('xelay_assistant_cloud_draft_cancel', binding(userId,draftId,version,rawToken)), userId, draftId)
    },
    async get(user, draft) {
      const userId = id(user), draftId = id(draft)
      return envelope(await rpc('xelay_assistant_cloud_draft_get', { p_user_id: userId, p_id: draftId }), userId, draftId)
    },
    async list(user, limit = 30) {
      const userId = id(user)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_request',400)
      const result = await rpc('xelay_assistant_cloud_draft_list', { p_user_id: userId, p_limit: limit })
      if (!Array.isArray(result) || result.length > limit) fail()
      return result.map(row => envelope(row,userId))
    },
    async claim(user, draft, version, rawToken) {
      const userId = id(user), draftId = id(draft), claimToken = randomBytes(24).toString('hex')
      const result = await rpc('xelay_assistant_cloud_draft_claim', { ...binding(userId,draftId,version,rawToken), p_claim_hash: digest(claimToken) })
      if (!object(result) || typeof result.claimed !== 'boolean') fail()
      return { claimed: result.claimed, record: envelope(result.record,userId,draftId), ...(result.claimed ? { claimToken } : {}) }
    },
    async finish(user, draft, rawClaimToken, outcome, receipt) {
      const userId = id(user), draftId = id(draft)
      if (!['confirmed','unknown'].includes(outcome) || outcome === 'confirmed' && !object(receipt) || outcome === 'unknown' && receipt !== undefined) fail('invalid_payload',400)
      if (receipt) safeJson(receipt,12000)
      return envelope(await rpc('xelay_assistant_cloud_draft_finish', { p_user_id: userId, p_id: draftId,
        p_claim_hash: digest(token(rawClaimToken)), p_outcome: outcome, p_receipt: receipt ?? null }), userId, draftId)
    },
  }
}
