import { randomUUID } from 'node:crypto'
import {
  CONFIRMED_ASSISTANT_WRITE_ACTIONS, ConfirmedWriteError, createConfirmedWriteDomain, executeConfirmedWritePlan,
  type ConfirmedAssistantWriteAction, type ConfirmedWriteDomainDependencies, type ConfirmedWriteReceipt,
  type ConfirmedWriteStatus, type StoredDraft, type WritePlan,
} from './confirmedWrites.ts'

type Document = Record<string, any>
/** Private server-to-server port. Its implementation must use only service-role
 * journal RPCs, never the caller's business client or a local file store. */
export interface CloudWriteEnvelope {
  id: string; userId: string; revision: number; status: ConfirmedWriteStatus;
  createdAt: string; expiresAt: string; document: Document;
  confirmationToken: string; receipt?: Record<string, unknown>;
}
export interface CloudWriteJournal {
  readonly mode: 'supabase-service-journal';
  create(userId: string, document: Document): Promise<CloudWriteEnvelope>;
  replace(userId: string, id: string, revision: number, confirmationToken: string, document: Document): Promise<CloudWriteEnvelope>;
  cancel(userId: string, id: string, revision: number, confirmationToken: string): Promise<CloudWriteEnvelope>;
  get(userId: string, id: string): Promise<CloudWriteEnvelope>;
  list(userId: string, limit?: number): Promise<CloudWriteEnvelope[]>;
  claim(userId: string, id: string, revision: number, confirmationToken: string): Promise<{ claimed: boolean; record: CloudWriteEnvelope; claimToken?: string }>;
  finish(userId: string, id: string, claimToken: string, outcome: 'confirmed' | 'unknown', receipt?: Record<string, unknown>): Promise<CloudWriteEnvelope>;
}

const pendingText = 'Збереження вже розпочато. Повторне надсилання вимкнено; перевірте результат у групі.'
const unknownText = 'Результат збереження не підтверджено. Повтор вимкнено; перевірте запис у групі.'
function fail(code: string, status = 400): never { throw new ConfirmedWriteError(code, status) }

/** Durable cloud confirmation, with no model, provider, payment or filesystem
 * fallback. The journal receives verified owner IDs only. Every business read
 * and write uses a separate client carrying the current user's verified JWT. */
export function createCloudConfirmedAssistantWrites(dependencies: ConfirmedWriteDomainDependencies & { journal: CloudWriteJournal }) {
  if (!dependencies?.journal || dependencies.journal.mode !== 'supabase-service-journal'
    || ['create', 'replace', 'cancel', 'get', 'list', 'claim', 'finish'].some(method => typeof (dependencies.journal as any)[method] !== 'function')
    || typeof dependencies.verifySession !== 'function' || typeof dependencies.createCallerClient !== 'function') fail('cloud_write_journal_required', 503)
  const domain = createConfirmedWriteDomain(dependencies), journal = dependencies.journal
  const { clock, sessionOf, inspect, publicDraft, review, scopeOf, fingerprint, id, jsonSafe, object, exact } = domain
  const supportedActions = [...CONFIRMED_ASSISTANT_WRITE_ACTIONS]

  function hydrate(envelope: CloudWriteEnvelope, userId: string): StoredDraft {
    const doc = envelope?.document
    if (!envelope || envelope.userId !== userId || !object(doc) || !jsonSafe(doc)
      || !Number.isInteger(envelope.revision) || envelope.revision < 1
      || !['pending', 'committing', 'confirmed', 'cancelled', 'stale', 'unknown'].includes(envelope.status)
      || !Number.isFinite(Date.parse(envelope.createdAt)) || !Number.isFinite(Date.parse(envelope.expiresAt))
      || !supportedActions.includes(doc.action) || !object(doc.payload) || !object(doc.plan)
      || typeof doc.plan.path !== 'string' || !Array.isArray(doc.plan.affectedIds) || doc.plan.affectedIds.length < 1 || doc.plan.affectedIds.length > 30
      || doc.plan.affectedIds.some((value: unknown) => typeof value !== 'string' || id(value) !== value)
      || !/^[a-f0-9]{64}$/.test(doc.fingerprint) || !/^[a-f0-9]{48}$/.test(envelope.confirmationToken)) fail('draft_journal_invalid', 503)
    const draft: StoredDraft = {
      id: id(envelope.id), userId, action: doc.action, revision: envelope.revision, status: envelope.status,
      createdAt: envelope.createdAt, expiresAt: envelope.expiresAt, scope: scopeOf(doc.scope), payload: structuredClone(doc.payload),
      confirmationToken: envelope.confirmationToken, recordId: id(doc.recordId), fingerprint: doc.fingerprint,
      plan: structuredClone(doc.plan) as WritePlan, ...review(doc.action, doc.payload, doc.targetSummary, doc.plan as WritePlan),
      ...(doc.targetSummary ? { targetSummary: structuredClone(doc.targetSummary) } : {}),
    }
    if (envelope.receipt) {
      const receipt = envelope.receipt
      if (!object(receipt) || !exact(receipt, ['draftId', 'action', 'savedAt', 'affectedIds', 'syntheticOnly', 'path'])
        || receipt.draftId !== draft.id || receipt.action !== draft.action || receipt.syntheticOnly !== false
        || typeof receipt.savedAt !== 'string' || !Number.isFinite(Date.parse(receipt.savedAt))
        || !Array.isArray(receipt.affectedIds) || receipt.affectedIds.length > 30 || !receipt.affectedIds.length
        || !receipt.affectedIds.every(value => typeof value === 'string' && id(value) === value)
        || typeof receipt.path !== 'string' || !/^\/(?:groups\/[a-f0-9-]{36}(?:\?[^\r\n]*)?|organizer|teaching)$/.test(receipt.path)) fail('draft_journal_invalid', 503)
      draft.receipt = structuredClone(receipt) as unknown as ConfirmedWriteReceipt
    }
    if (draft.status === 'confirmed' && !draft.receipt) fail('draft_journal_invalid', 503)
    return draft
  }
  function projection(draft: StoredDraft) {
    return { status: draft.status, draft: publicDraft(draft), ...(draft.receipt ? { receipt: structuredClone(draft.receipt) } : {}) }
  }
  function bind(draft: StoredDraft, session: Awaited<ReturnType<typeof sessionOf>>, value: unknown) {
    return domain.owned({ schema: 1, drafts: [draft] }, session, value)
  }
  async function sameSession(credential: string, session: Awaited<ReturnType<typeof sessionOf>>) {
    const latest = await sessionOf(credential)
    if (latest.userId !== session.userId || latest.sessionId !== session.sessionId) fail('session_changed', 401)
  }
  function bindingId(value: unknown) {
    if (!object(value) || !exact(value, ['id', 'revision', 'confirmationToken', 'payload', 'acceptMaterialRights']) || !Number.isInteger(value.revision)) fail('invalid_binding')
    return id(value.id)
  }
  function document(action: ConfirmedAssistantWriteAction, scope: Document, payload: Document, recordId: string, inspected: Awaited<ReturnType<typeof inspect>>) {
    // Reviews are deterministically regenerated from these private inputs;
    // storing duplicate full-text fields/items would quadruple a large task.
    return { action, scope, payload, recordId, ...inspected }
  }

  return {
    form: domain.form,
    supportedActions,
    async list(credential: string) {
      const session = await sessionOf(credential), records = await journal.list(session.userId, 30)
      if (!Array.isArray(records) || records.length > 30) fail('draft_journal_invalid', 503)
      return { drafts: records.map(record => { const draft = hydrate(record, session.userId); return { draft: publicDraft(draft), ...(draft.receipt ? { receipt: structuredClone(draft.receipt) } : {}) } }) }
    },
    async get(credential: string, draftId: string) {
      const session = await sessionOf(credential)
      return projection(hydrate(await journal.get(session.userId, id(draftId)), session.userId))
    },
    async prepare(credential: string, value: unknown) {
      if (!object(value) || !exact(value, ['action', 'scope', 'payload']) || !CONFIRMED_ASSISTANT_WRITE_ACTIONS.includes(value.action)) fail('unsupported_action', 422)
      const action = value.action as ConfirmedAssistantWriteAction, scope = scopeOf(value.scope), payload = structuredClone(value.payload)
      const session = await sessionOf(credential), client = await dependencies.createCallerClient(session, credential), recordId = randomUUID()
      const inspected = await inspect(client, session, action, scope, payload, recordId)
      await sameSession(credential, session)
      const envelope = await journal.create(session.userId, { id: randomUUID(), ...document(action, scope, payload, recordId, inspected) })
      const draft = hydrate(envelope, session.userId)
      if (draft.status !== 'pending' || draft.revision !== 1) fail('draft_journal_invalid', 503)
      return { status: 'draft' as const, draft: publicDraft(draft) }
    },
    async edit(credential: string, value: unknown) {
      const draftId = bindingId(value), session = await sessionOf(credential)
      const draft = bind(hydrate(await journal.get(session.userId, draftId), session.userId), session, value)
      if (draft.status !== 'pending' || Date.parse(draft.expiresAt) <= clock()) fail('draft_unavailable', 409)
      const payload = structuredClone((value as Document).payload), client = await dependencies.createCallerClient(session, credential)
      const inspected = await inspect(client, session, draft.action, draft.scope, payload, draft.recordId)
      await sameSession(credential, session)
      const result = hydrate(await journal.replace(session.userId, draft.id, draft.revision, draft.confirmationToken, document(draft.action, draft.scope, payload, draft.recordId, inspected)), session.userId)
      if (result.revision !== draft.revision + 1 || result.status !== 'pending') fail('draft_journal_invalid', 503)
      return { status: 'draft' as const, draft: publicDraft(result) }
    },
    async cancel(credential: string, value: unknown) {
      const draftId = bindingId(value), session = await sessionOf(credential)
      const draft = bind(hydrate(await journal.get(session.userId, draftId), session.userId), session, value)
      if (draft.status !== 'pending') fail('draft_unavailable', 409)
      const result = hydrate(await journal.cancel(session.userId, draft.id, draft.revision, draft.confirmationToken), session.userId)
      if (result.status !== 'cancelled') fail('draft_journal_invalid', 503)
      return { status: 'cancelled' as const, draft: publicDraft(result) }
    },
    async confirm(credential: string, value: unknown) {
      const draftId = bindingId(value), session = await sessionOf(credential)
      const draft = bind(hydrate(await journal.get(session.userId, draftId), session.userId), session, value)
      if (draft.status === 'confirmed') return projection(draft)
      if (draft.status === 'committing' || draft.status === 'unknown') return { ...projection(draft), text: draft.status === 'committing' ? pendingText : unknownText }
      if (draft.status !== 'pending') fail('draft_unavailable', 409)
      if (Date.parse(draft.expiresAt) <= clock()) fail('draft_expired', 409)
      if (draft.action === 'homework.upsert' && !draft.targetSummary) fail('draft_review_required', 409)
      if (draft.plan.materialRights && (value as Document).acceptMaterialRights !== true) fail('material_rights_acceptance_required', 422)
      const client = await dependencies.createCallerClient(session, credential)
      const inspected = await inspect(client, session, draft.action, draft.scope, draft.payload, draft.recordId)
      if (inspected.fingerprint !== draft.fingerprint || fingerprint(inspected.plan) !== fingerprint(draft.plan)) fail('draft_conflict', 409)
      await sameSession(credential, session)
      // The distributed claim is committed BEFORE the first caller mutation.
      // A lost claim/finish response intentionally strands the draft rather than
      // risking a second dispatch after a server restart or another instance.
      const claimed = await journal.claim(session.userId, draft.id, draft.revision, draft.confirmationToken)
      const current = hydrate(claimed.record, session.userId)
      bind(current, session, value)
      if (!claimed.claimed) {
        if (!['committing', 'unknown', 'confirmed'].includes(current.status)) fail('draft_unavailable', 409)
        return { ...projection(current), ...(current.status === 'confirmed' ? {} : { text: current.status === 'committing' ? pendingText : unknownText }) }
      }
      if (current.status !== 'committing' || typeof claimed.claimToken !== 'string' || !/^[a-f0-9]{48}$/.test(claimed.claimToken)
        || current.fingerprint !== draft.fingerprint || fingerprint(current.plan) !== fingerprint(inspected.plan)
        || fingerprint(current.payload) !== fingerprint(draft.payload) || current.recordId !== draft.recordId) fail('execution_unknown', 409)
      const success = await executeConfirmedWritePlan(client, inspected.plan, { atomicScheduleCreate: true, acceptMaterialRights: (value as Document).acceptMaterialRights === true })
      const receipt: ConfirmedWriteReceipt | undefined = success ? { draftId: draft.id, action: draft.action, savedAt: new Date(clock()).toISOString(), affectedIds: inspected.plan.affectedIds, path: inspected.plan.path, syntheticOnly: false } : undefined
      try {
        const finished = hydrate(await journal.finish(session.userId, draft.id, claimed.claimToken, success ? 'confirmed' : 'unknown', receipt ? { ...receipt } : undefined), session.userId)
        if (finished.status !== (success ? 'confirmed' : 'unknown')) fail('draft_journal_invalid', 503)
        return { ...projection(finished), ...(!success ? { text: unknownText } : {}) }
      } catch {
        // A receipt may already be durable. Read it once; never repeat a write.
        try { const latest = hydrate(await journal.get(session.userId, draft.id), session.userId); if (latest.status === 'confirmed') return projection(latest) } catch { /* Keep the conservative state. */ }
        return { ...projection(current), status: 'unknown' as const, draft: publicDraft({ ...current, status: 'unknown' }), text: unknownText }
      }
    },
  }
}
