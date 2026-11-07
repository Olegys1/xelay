import type { SupabaseClient } from '@supabase/supabase-js'
import type { GroupReferralRepository, GroupReferralWorkspace, ReferralObserveInput } from './groupReferralTypes'

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fail = (code = 'REFERRAL_SOURCE_UNAVAILABLE'): never => { throw new Error(code) }
const id = (v: unknown): string => typeof v === 'string' && uuid.test(v) ? v : fail()
const text = (v: unknown, max = 240): string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) ? v : fail()
const count = (v: unknown): number => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : fail()
const bool = (v: unknown): boolean => typeof v === 'boolean' ? v : fail()
const choice = <T extends string>(v: unknown, values: readonly T[]): T => typeof v === 'string' && values.includes(v as T) ? v as T : fail()
const date = (v: unknown): string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) && v.length <= 64 && Number.isFinite(Date.parse(v)) ? v : fail()
const nullableDate = (v: unknown): string | null => v === null || v === undefined ? null : date(v)
const list = <T>(v: unknown, parse: (v: Record<string, unknown>) => T, limit = 100): T[] => Array.isArray(v) && v.length <= limit ? v.map(x => object(x) ? parse(x) : fail()) : fail()
const prize = (v: Record<string, unknown>) => ({ rank: count(v.rank) as 1 | 2 | 3, label: text(v.label, 160), months: v.months === null ? null : count(v.months) })

export function parseGroupReferralWorkspace(value: unknown, actorId: string | null): GroupReferralWorkspace {
  if (!object(value)) return fail()
  const campaign = value.campaign === null ? null : object(value.campaign) ? {
    id: id(value.campaign.id), slug: text(value.campaign.slug, 64), title: text(value.campaign.title),
    state: choice(value.campaign.state, ['draft', 'open', 'frozen', 'drawn', 'published', 'cancelled'] as const), version: count(value.campaign.version),
    startsAt: nullableDate(value.campaign.startsAt), joinsUntil: nullableDate(value.campaign.joinsUntil), qualifiesUntil: nullableDate(value.campaign.qualifiesUntil), drawAt: nullableDate(value.campaign.drawAt),
    minimumStudents: value.campaign.minimumStudents === 10 ? 10 as const : fail(), prizes: list(value.campaign.prizes, prize, 3), rulesVersion: text(value.campaign.rulesVersion, 80),
    frozenAt: nullableDate(value.campaign.frozenAt), snapshotHash: value.campaign.snapshotHash == null ? null : text(value.campaign.snapshotHash, 128),
    drawnAt: nullableDate(value.campaign.drawnAt), publishedAt: nullableDate(value.campaign.publishedAt),
  } : fail()
  const actor = value.actor === null ? null : object(value.actor) ? { id: id(value.actor.id), verified: bool(value.actor.verified), alias: text(value.actor.alias, 80), canAdmin: bool(value.actor.canAdmin) } : fail()
  if (actor && actor.id !== actorId || actorId === null && (value.admin || value.ownLink)) return fail('REFERRAL_AUTH_REQUIRED')
  const progress = (v: Record<string, unknown>) => ({
    id: id(v.id), groupId: id(v.groupId), groupName: text(v.groupName), organizerId: id(v.organizerId), organizerAlias: text(v.organizerAlias, 80),
    createdAt: date(v.createdAt), registeredAt: date(v.registeredAt), state: choice(v.state, ['collecting', 'pending', 'approved', 'rejected'] as const), version: count(v.version),
    verifiedStudents: count(v.verifiedStudents), returningStudents: count(v.returningStudents), hasSchedule: bool(v.hasSchedule), hasResource: bool(v.hasResource), eligible: bool(v.eligible),
    issues: Array.isArray(v.issues) && v.issues.length <= 30 ? v.issues.map(x => text(x, 1000)) : fail(),
    ...(v.reviewReason == null ? {} : { reviewReason: text(v.reviewReason, 2000) }), reviewedAt: nullableDate(v.reviewedAt),
    ...(v.ownMemberDays === undefined ? {} : { ownMemberDays: count(v.ownMemberDays), ownMemberCounts: bool(v.ownMemberCounts) }),
    ...(v.viewerRole === undefined ? {} : { viewerRole: choice(v.viewerRole, ['organizer', 'representative', 'member'] as const) }),
    ...(v.canSubmit === undefined ? {} : { canSubmit: bool(v.canSubmit) }),
  })
  const workspace: GroupReferralWorkspace = {
    campaign, actor,
    ownLink: value.ownLink === null ? null : object(value.ownLink) && /^[A-Z0-9_-]{6,64}$/i.test(String(value.ownLink.code))
      ? { code: String(value.ownLink.code), path: `/referrals?ref=${encodeURIComponent(String(value.ownLink.code))}` } : fail(),
    ownGroups: list(value.ownGroups, progress), candidateGroups: list(value.candidateGroups, v => ({ id: id(v.id), name: text(v.name), createdAt: date(v.createdAt), canRegister: bool(v.canRegister), ...(v.reason == null ? {} : { reason: text(v.reason, 1000) }) })),
    ownTickets: count(value.ownTickets), nextCursor: value.nextCursor == null ? null : id(value.nextCursor), candidateNextCursor: value.candidateNextCursor == null ? null : id(value.candidateNextCursor),
    winners: list(value.winners, v => ({ id: id(v.id), rank: count(v.rank) as 1 | 2 | 3, alias: text(v.alias, 80), ...(v.organizerId === undefined ? {} : { organizerId: id(v.organizerId) }),
      prize: object(v.prize) ? prize(v.prize) : fail(), version: count(v.version), isOwn: bool(v.isOwn),
      ...(v.prizeStatus === undefined ? {} : { prizeStatus: choice(v.prizeStatus, ['pending', 'issued'] as const) }),
      ...(v.interviewStatus === undefined ? {} : { interviewStatus: choice(v.interviewStatus, ['pending', 'invited', 'declined', 'completed'] as const) }),
    })),
    ...(value.notification == null ? {} : { notification: text(value.notification, 1000) }),
  }
  if (value.admin !== undefined) {
    if (!actor?.canAdmin || !object(value.admin)) return fail('REFERRAL_ADMIN_REQUIRED')
    const a = value.admin
    workspace.admin = { groups: list(a.groups, progress), audit: list(a.audit, v => ({ id: id(v.id), at: date(v.at), action: text(v.action, 80), actorAlias: text(v.actorAlias, 80), ...(v.reason == null ? {} : { reason: text(v.reason, 2000) }), ...(v.target == null ? {} : { target: text(v.target) }) })), approvedTickets: count(a.approvedTickets), eligibleOrganizers: count(a.eligibleOrganizers), nextCursor: a.nextCursor == null ? null : id(a.nextCursor) }
  }
  if (workspace.winners.some(w => w.rank < 1 || w.rank > 3) || new Set(workspace.winners.map(w => w.rank)).size !== workspace.winners.length
    || campaign && (campaign.prizes.length !== 3 || new Set(campaign.prizes.map(p => p.rank)).size !== 3 || campaign.prizes.some(p => p.rank < 1 || p.rank > 3))) return fail()
  if (!actor && (workspace.ownGroups.length || workspace.candidateGroups.length || workspace.ownTickets || workspace.winners.some(w => w.organizerId || w.prizeStatus || w.interviewStatus || w.isOwn))) return fail()
  if (!actor?.canAdmin && workspace.winners.some(w => w.isOwn ? w.organizerId !== actor?.id : w.organizerId !== undefined || w.prizeStatus !== undefined || w.interviewStatus !== undefined)) return fail()
  return workspace
}

async function referralRpc(client: SupabaseClient, actorId: string | null, name: string, args: Record<string, unknown>): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  let subscription: { unsubscribe(): void } | undefined
  let onAbort: (() => void) | undefined
  const checkActor = async () => {
    const session = await client.auth.getSession()
    if (controller.signal.aborted || session.error || (session.data.session?.user.id || null) !== actorId) fail('REFERRAL_AUTH_REQUIRED')
  }
  try {
    subscription = client.auth.onAuthStateChange((_event, session) => { if ((session?.user.id || null) !== actorId) controller.abort() }).data.subscription
    const interrupted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error('REFERRAL_SOURCE_UNAVAILABLE')); controller.signal.addEventListener('abort', onAbort, { once: true }) })
    return await Promise.race([interrupted, (async () => {
      await checkActor()
      const response = await client.rpc(name, args).abortSignal(controller.signal)
      await checkActor()
      if (response.error) throw response.error
      return response.data
    })()])
  } finally { clearTimeout(timer); if (onAbort) controller.signal.removeEventListener('abort', onAbort); subscription?.unsubscribe() }
}

export function createSupabaseGroupReferralRepository(client: SupabaseClient, actorId: string | null): GroupReferralRepository {
  return {
    async load(options = {}) {
      const after = options.after ? id(options.after) : null, adminAfter = options.adminAfter ? id(options.adminAfter) : null, candidateAfter = options.candidateAfter ? id(options.candidateAfter) : null
      return parseGroupReferralWorkspace(await referralRpc(client, actorId, 'xelay_group_referral_workspace', { p_slug: 'bring-your-group', p_after: after, p_admin_after: adminAfter, p_candidate_after: candidateAfter }), actorId)
    },
    async action(action, payload) {
      if (!actorId || !uuid.test(actorId)) return fail('REFERRAL_AUTH_REQUIRED')
      id(payload.requestId); id(payload.campaignId)
      return parseGroupReferralWorkspace(await referralRpc(client, actorId, 'xelay_group_referral_action', { p_action: action, p_payload: payload, p_expected_user_id: actorId }), actorId)
    },
  }
}

const reads = new Map<string, { until: number; pending: boolean; retry?: boolean }>()
export async function observeGroupReferralRead(client: SupabaseClient, actorId: string, input: ReferralObserveInput): Promise<number | null> {
  if (!uuid.test(actorId) || !uuid.test(input.groupId) || !uuid.test(input.resourceId) || !['schedule', 'homework', 'material'].includes(input.kind)) return null
  const now = Date.now(), day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(now), key = `${actorId}:${input.groupId}:${day}`
  if (reads.size > 500) for (const [k, v] of reads) if (v.until < now) reads.delete(k)
  const cached = reads.get(key)
  if (cached?.pending) return null
  if ((cached?.until || 0) > now) return cached?.retry ? cached.until - now : null
  reads.set(key, { pending: true, until: now })
  try {
    const result = await referralRpc(client, actorId, 'xelay_group_referral_observe_read', { p_group_id: input.groupId, p_kind: input.kind, p_resource_id: input.resourceId, p_expected_user_id: actorId })
    reads.set(key, { pending: false, until: now + (object(result) && result.counted === true ? 86_400_000 : 15 * 60_000) })
    return null
  } catch { reads.set(key, { pending: false, until: now + 60_000, retry: true }); return 60_000 }
}
