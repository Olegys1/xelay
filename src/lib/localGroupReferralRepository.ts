import { GROUP_REFERRAL_DEFAULT_PRIZES, type GroupReferralAction, type GroupReferralRepository, type GroupReferralWorkspace, type ReferralActor, type ReferralCampaign, type ReferralGroupProgress, type ReferralWinner } from './groupReferralTypes'
import { createGroupReferralPreviewSeed } from './groupReferralPreviewSeed'

export interface LocalReferralActor extends ReferralActor { previewRole: 'admin' | 'organizer' | 'headman' | 'student' }
export interface LocalReferralGroup { id: string; name: string; headmanId: string; createdAt: string; members: { userId: string; accepted: boolean; joinedAt: string }[]; resources: { id: string; kind: 'schedule' | 'homework' | 'material'; active: boolean }[] }
export interface LocalReferralEntry { id: string; campaignId: string; groupId: string; organizerId: string; registeredAt: string; state: ReferralGroupProgress['state']; version: number; reviewReason?: string | null; reviewedAt?: string | null }
export interface LocalReferralState {
  schema: 1; revision: number; clockIso: string; clockOffsetMs: number; campaign: ReferralCampaign
  actors: LocalReferralActor[]; groups: LocalReferralGroup[]; entries: LocalReferralEntry[]
  links: { actorId: string; campaignId: string; code: string; alias: string; rulesVersion: string }[]
  claims: { userId: string; campaignId: string; entryId: string; firstReadAt: string }[]
  reads: { userId: string; entryId: string; resourceId: string; at: string }[]
  snapshot: { entryId: string; groupId: string; organizerId: string; alias: string }[] | null
  winners: (Omit<ReferralWinner, 'isOwn'> & { organizerId: string })[]
  audit: { id: string; at: string; action: string; actorAlias: string; reason?: string; target?: string }[]
  receipts: Record<string, string>
}
export interface LocalReferralStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface LocalReferralOptions { storage?: LocalReferralStorage | null; storageKey?: string; clock?: () => string; randomBytes?: (length: number) => Uint8Array; initialState?: LocalReferralState }

const DAY = 86_400_000
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const fail = (code: string): never => { throw new Error(code) }
const stamp = (value: unknown): number => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN
const day = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
const text = (value: unknown, max = 400) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, JSON.parse(canonical(item))])) : Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : value ?? null)
const browserStorage = (): LocalReferralStorage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }

/** Synthetic preview only. This module never imports Supabase, auth tokens or a network client. */
export function createLocalGroupReferralStore(options: LocalReferralOptions = {}) {
  const storage = options.storage === undefined ? browserStorage() : options.storage
  const key = options.storageKey || 'xelay.group-referral.preview.v1'
  const bytes = options.randomBytes || ((length: number) => crypto.getRandomValues(new Uint8Array(length)))
  let state = clone(options.initialState || createGroupReferralPreviewSeed())
  let flight = Promise.resolve()
  let busy = false
  const listeners = new Set<() => void>()
  const now = () => new Date((options.clock ? stamp(options.clock()) : stamp(state.clockIso)) + (options.clock ? state.clockOffsetMs : 0)).toISOString()
  const random = (length: number) => { const value = bytes(length); if (!(value instanceof Uint8Array) || value.length !== length) fail('REFERRAL_INVALID_PAYLOAD'); return value }
  const id = () => { const value = random(16); value[6] = (value[6] & 15) | 64; value[8] = (value[8] & 63) | 128; const hex = Array.from(value, n => n.toString(16).padStart(2, '0')).join(''); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` }
  const fresh = () => {
    if (!storage) return
    const raw = storage.getItem(key)
    if (!raw) return
    const loaded = JSON.parse(raw) as LocalReferralState
    if (loaded.schema !== 1 || !Number.isSafeInteger(loaded.revision) || !loaded.campaign || !Array.isArray(loaded.actors) || !Array.isArray(loaded.groups) || !Array.isArray(loaded.entries)) fail('REFERRAL_SOURCE_UNAVAILABLE')
    if (loaded.revision !== state.revision) state = loaded
  }
  const commit = (next: LocalReferralState, expectedRevision = state.revision) => {
    fresh()
    if (state.revision !== expectedRevision) fail('REFERRAL_VERSION_CONFLICT')
    next.revision = expectedRevision + 1
    next.clockIso = options.clock ? new Date(stamp(options.clock()) + next.clockOffsetMs).toISOString() : next.clockIso
    if (storage) storage.setItem(key, JSON.stringify(next))
    state = next
    for (const listener of listeners) listener()
  }
  if (storage?.getItem(key)) fresh()
  else if (storage) storage.setItem(key, JSON.stringify(state))

  const actorFor = (snapshot: LocalReferralState, actorId: string | null, verified = true) => {
    const actor = snapshot.actors.find(item => item.id === actorId)
    if (!actor) return fail('REFERRAL_AUTH_REQUIRED')
    if (verified && !actor.verified) return fail('REFERRAL_VERIFICATION_REQUIRED')
    return actor
  }
  const version = (expected: unknown, actual: number) => { if (!Number.isSafeInteger(expected) || expected !== actual) fail('REFERRAL_VERSION_CONFLICT') }
  const audit = (snapshot: LocalReferralState, actor: ReferralActor, action: string, target?: string, reason?: string) => snapshot.audit.push({ id: id(), at: now(), action, actorAlias: actor.alias, ...(target ? { target } : {}), ...(reason ? { reason } : {}) })
  const isOpen = (campaign: ReferralCampaign) => campaign.state === 'open' && stamp(campaign.startsAt) <= stamp(now()) && stamp(now()) <= stamp(campaign.joinsUntil)
  const memberProgress = (snapshot: LocalReferralState, entry: LocalReferralEntry, userId: string) => {
    const group = snapshot.groups.find(item => item.id === entry.groupId)
    const user = snapshot.actors.find(item => item.id === userId)
    const member = group?.members.find(item => item.userId === userId && item.accepted)
    const claim = snapshot.claims.find(item => item.campaignId === snapshot.campaign.id && item.userId === userId)
    if (!user?.verified || !member) return { verified: false, days: 0, counts: false, credited: false }
    if (!claim || claim.entryId !== entry.id) return { verified: true, days: 0, counts: false, credited: false }
    const deadline = Math.min(stamp(claim.firstReadAt) + 7 * DAY, stamp(snapshot.campaign.qualifiesUntil))
    const days = new Set(snapshot.reads.filter(item => item.userId === userId && item.entryId === entry.id && stamp(item.at) >= Math.max(stamp(member.joinedAt), stamp(entry.registeredAt), stamp(claim.firstReadAt)) && stamp(item.at) <= deadline).map(item => day(item.at))).size
    return { verified: true, days: Math.min(days, 2), counts: days >= 2, credited: true }
  }
  const progress = (snapshot: LocalReferralState, entry: LocalReferralEntry, actorId?: string): ReferralGroupProgress => {
    const group = snapshot.groups.find(item => item.id === entry.groupId)!
    const members = [...new Set(group.members.filter(item => item.accepted).map(item => item.userId))].map(userId => memberProgress(snapshot, entry, userId))
    const verifiedStudents = members.filter(item => item.verified).length, returningStudents = members.filter(item => item.counts).length
    const hasSchedule = group.resources.some(item => item.active && item.kind === 'schedule')
    const hasResource = group.resources.some(item => item.active && ['homework', 'material'].includes(item.kind))
    const issues: string[] = []
    if (!snapshot.actors.find(item => item.id === entry.organizerId)?.verified) issues.push('Організатор має відновити підтверджений акаунт.')
    if (!hasSchedule) issues.push('Додайте справжній розклад групи.')
    if (!hasResource) issues.push('Додайте ДЗ або навчальний матеріал.')
    if (verifiedStudents < 10) issues.push(`Потрібно ще ${10 - verifiedStudents} прийнятих учасників із підтвердженою поштою.`)
    if (returningStudents < 10) issues.push(`Ще ${10 - returningStudents} учасників мають користуватися навчальними розділами у два різні дні.`)
    if (!memberProgress(snapshot, entry, group.headmanId).counts) issues.push('Староста також має користуватися навчальними розділами у два різні дні.')
    const own = actorId ? memberProgress(snapshot, entry, actorId) : undefined
    const viewerRole = actorId === entry.organizerId ? 'organizer' : actorId === group.headmanId ? 'representative' : 'member'
    return { id: entry.id, groupId: group.id, groupName: group.name, organizerId: entry.organizerId,
      organizerAlias: snapshot.links.find(item => item.actorId === entry.organizerId && item.campaignId === entry.campaignId)?.alias || 'Організатор',
      createdAt: group.createdAt, registeredAt: entry.registeredAt, state: entry.state, version: entry.version,
      verifiedStudents, returningStudents, hasSchedule, hasResource, eligible: !issues.length, issues,
      reviewReason: entry.reviewReason, reviewedAt: entry.reviewedAt,
      ...(own ? { ownMemberDays: own.days, ownMemberCounts: own.credited } : {}), viewerRole,
      canSubmit: (actorId === group.headmanId || actorId === entry.organizerId) && snapshot.campaign.state === 'open' && !['pending', 'approved'].includes(entry.state) && stamp(now()) <= stamp(snapshot.campaign.qualifiesUntil) }
  }
  const workspace = (actorId: string | null, options: NonNullable<Parameters<GroupReferralRepository['load']>[0]> = {}): GroupReferralWorkspace => {
    fresh()
    for (const cursor of [options.after, options.adminAfter, options.candidateAfter]) if (cursor !== undefined && (typeof cursor !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor))) fail('REFERRAL_SOURCE_UNAVAILABLE')
    const page = <T extends { id: string },>(rows: T[], after?: string) => {
      const selected = rows.filter(row => !after || row.id.toLowerCase() > after.toLowerCase()).sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase())).slice(0, 51)
      return { rows: selected.slice(0, 50), cursor: selected.length > 50 ? selected[49].id : null }
    }
    const actor = state.actors.find(item => item.id === actorId) || null
    const link = state.links.find(item => item.actorId === actorId && item.campaignId === state.campaign.id)
    const official = state.snapshot || state.entries.filter(item => item.state === 'approved' && progress(state, item).eligible).map(item => ({ organizerId: item.organizerId }))
    const visible = state.entries.filter(entry => entry.organizerId === actorId || state.groups.some(group => group.id === entry.groupId && (group.headmanId === actorId || group.members.some(member => member.userId === actorId && member.accepted))))
    const ownPage = page(visible, options.after)
    const adminPage = page(state.entries, options.adminAfter)
    const candidatePage = page(state.groups.filter(group => group.headmanId === actorId && !state.entries.some(entry => entry.groupId === group.id)), options.candidateAfter)
    const canAdmin = Boolean(actor?.canAdmin && actor.verified)
    const winners = canAdmin || state.campaign.state === 'published' ? state.winners.map(winner => {
      if (canAdmin || winner.organizerId === actorId) return { ...winner, isOwn: winner.organizerId === actorId }
      return { id: winner.id, rank: winner.rank, alias: winner.alias, prize: winner.prize, version: winner.version, isOwn: false }
    }) : []
    return clone({ campaign: state.campaign, actor: actor ? { id: actor.id, alias: actor.alias, verified: actor.verified, canAdmin } : null,
      ownLink: link ? { code: link.code, path: `/referrals?ref=${encodeURIComponent(link.code)}` } : null,
      ownGroups: actor ? ownPage.rows.map(entry => progress(state, entry, actorId!)) : [], nextCursor: actor ? ownPage.cursor : null,
      candidateGroups: actor ? candidatePage.rows.map(group => {
        const reason = stamp(now()) < stamp(group.createdAt) ? 'REFERRAL_REGISTRATION_EXPIRED' : !isOpen(state.campaign) ? 'Прийом груп до акції закрито.' : !actor.verified ? 'Підтвердьте пошту акаунта.' : undefined
        return { id: group.id, name: group.name, createdAt: group.createdAt, canRegister: !reason, ...(reason ? { reason } : {}) }
      }) : [], candidateNextCursor: actor ? candidatePage.cursor : null, ownTickets: actor ? official.filter(entry => entry.organizerId === actorId).length : 0, winners,
      ...(canAdmin ? { admin: { groups: adminPage.rows.map(entry => progress(state, entry, actorId!)), audit: [...state.audit].reverse().slice(0, 50), approvedTickets: official.length, eligibleOrganizers: new Set(official.map(item => item.organizerId)).size, nextCursor: adminPage.cursor } } : {}) })
  }

  const act = async (actorId: string | null, action: GroupReferralAction, payload: Record<string, unknown>) => {
    fresh()
    const actor = actorFor(state, actorId)
    if (payload.campaignId !== state.campaign.id || typeof payload.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.requestId)) fail('REFERRAL_INVALID_PAYLOAD')
    const actionFields: Record<GroupReferralAction, string[]> = {
      create_link: ['alias', 'acceptRules'], register_group: ['groupId', 'code'], submit_group: ['entryId', 'version'],
      save_campaign: ['version', 'title', 'startsAt', 'joinsUntil', 'qualifiesUntil', 'drawAt', 'prizes'],
      activate_campaign: ['version', 'confirm'], review_group: ['entryId', 'version', 'decision', 'reason'],
      freeze_entries: ['version', 'confirm'], draw_winners: ['version', 'confirm'], publish_results: ['version', 'confirm'],
      set_prize_status: ['winnerId', 'version', 'prizeStatus', 'reason'], set_interview_status: ['winnerId', 'version', 'interviewStatus', 'reason'],
    }
    if (!actionFields[action] || Object.keys(payload).some(key => !['campaignId', 'requestId', ...actionFields[action]].includes(key)) || new TextEncoder().encode(JSON.stringify(payload)).length > 10_000) fail('REFERRAL_INVALID_PAYLOAD')
    const adminAction = ['save_campaign', 'activate_campaign', 'review_group', 'freeze_entries', 'draw_winners', 'publish_results', 'set_prize_status'].includes(action)
    if (adminAction && !actor.canAdmin) fail('REFERRAL_ADMIN_REQUIRED')
    const receipt = `${state.campaign.id}:${payload.requestId}`, fingerprint = canonical({ actorId: actor.id, action, payload })
    if (state.receipts[receipt]) { if (state.receipts[receipt] !== fingerprint) fail('REFERRAL_INVALID_PAYLOAD'); return workspace(actorId) }
    const next = clone(state), campaign = next.campaign
    const entry = () => next.entries.find(item => item.id === payload.entryId) || fail('REFERRAL_INVALID_PAYLOAD')
    const requireCampaignVersion = () => version(payload.version, campaign.version)
    const confirm = () => { if (payload.confirm !== true) fail('REFERRAL_INVALID_PAYLOAD') }
    let target: string | undefined
    const reason = typeof payload.reason === 'string' ? payload.reason.trim() : ''
    if (reason.length > 1000 || /[\u0000-\u001f\u007f]/.test(reason)) fail('REFERRAL_INVALID_PAYLOAD')
    if (action === 'create_link') {
      if (!isOpen(campaign)) fail('REFERRAL_NOT_OPEN')
      if (payload.acceptRules !== true) fail('REFERRAL_INVALID_PAYLOAD')
      const alias = typeof payload.alias === 'string' ? payload.alias.trim() : ''
      if (alias.length < 3 || alias.length > 60 || /[\u0000-\u001f\u007f<>@]|[0-9]{7}|https?:\/\//i.test(alias)) fail('REFERRAL_INVALID_PAYLOAD')
      const existing = next.links.find(item => item.actorId === actor.id && item.campaignId === campaign.id)
      if (existing && existing.alias !== alias) fail('REFERRAL_INVALID_PAYLOAD')
      if (!next.links.some(item => item.actorId === actor.id && item.campaignId === campaign.id)) {
        let code = ''
        for (let tries = 0; tries < 16; tries++) { code = Array.from(random(8), value => value.toString(16).padStart(2, '0')).join('').toUpperCase(); if (!next.links.some(item => item.code === code)) break; code = '' }
        if (!code) fail('REFERRAL_INVALID_PAYLOAD')
        next.links.push({ actorId: actor.id, campaignId: campaign.id, code, alias, rulesVersion: campaign.rulesVersion })
      }
    } else if (action === 'register_group') {
      if (!isOpen(campaign)) fail('REFERRAL_NOT_OPEN')
      const group = next.groups.find(item => item.id === payload.groupId) || fail('REFERRAL_GROUP_FORBIDDEN')
      if (group.headmanId !== actor.id) fail('REFERRAL_GROUP_FORBIDDEN')
      if (stamp(now()) < stamp(group.createdAt)) fail('REFERRAL_REGISTRATION_EXPIRED')
      if (next.entries.some(item => item.groupId === group.id)) fail('REFERRAL_GROUP_ALREADY_REGISTERED')
      const link = next.links.find(item => item.code === text(payload.code, 64).toUpperCase() && item.campaignId === campaign.id) || fail('REFERRAL_INVALID_CODE')
      const owner = next.actors.find(item => item.id === link.actorId)
      if (!owner?.verified) fail('REFERRAL_INVALID_CODE')
      const row: LocalReferralEntry = { id: id(), campaignId: campaign.id, groupId: group.id, organizerId: link.actorId, registeredAt: now(), state: 'collecting', version: 1 }
      next.entries.push(row); target = row.id
    } else if (action === 'submit_group') {
      if (campaign.state !== 'open' || stamp(now()) > stamp(campaign.qualifiesUntil)) fail('REFERRAL_NOT_OPEN')
      const row = entry(), group = next.groups.find(item => item.id === row.groupId)!
      if (group.headmanId !== actor.id && row.organizerId !== actor.id) fail('REFERRAL_GROUP_FORBIDDEN')
      version(payload.version, row.version)
      if (!['collecting', 'rejected'].includes(row.state)) fail('REFERRAL_INVALID_STATE')
      if (!progress(next, row).eligible) fail('REFERRAL_GROUP_INELIGIBLE')
      row.state = 'pending'; row.version++; row.reviewReason = null; target = row.id
    } else if (action === 'save_campaign') {
      requireCampaignVersion()
      if (campaign.state !== 'draft') fail('REFERRAL_INVALID_STATE')
      if (typeof payload.title !== 'string' || payload.title.trim().length < 3 || payload.title.trim().length > 160 || !Array.isArray(payload.prizes)) fail('REFERRAL_INVALID_PAYLOAD')
      campaign.title = (payload.title as string).trim()
      for (const field of ['startsAt', 'joinsUntil', 'qualifiesUntil', 'drawAt'] as const) if (payload[field] !== undefined) { if (payload[field] !== null && !Number.isFinite(stamp(payload[field]))) fail('REFERRAL_INVALID_PAYLOAD'); campaign[field] = payload[field] as string | null }
      if (payload.prizes !== undefined) {
        const prizes = Array.isArray(payload.prizes) && payload.prizes.length === 3 ? payload.prizes : fail('REFERRAL_INVALID_PAYLOAD')
        campaign.prizes = prizes.map((item, index) => { const prize = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : fail('REFERRAL_INVALID_PAYLOAD'); const label = typeof prize.label === 'string' ? prize.label.trim() : ''; if (Object.keys(prize).some(key => !['rank', 'label', 'months'].includes(key)) || prize.rank !== index + 1 || label.length < 3 || label.length > 80 || prize.months !== null && (!Number.isSafeInteger(prize.months) || Number(prize.months) < 1 || Number(prize.months) > 24)) fail('REFERRAL_INVALID_PAYLOAD'); return { rank: (index + 1) as 1 | 2 | 3, label, months: prize.months as number | null } })
      }
      campaign.version++
    } else if (action === 'activate_campaign') {
      requireCampaignVersion()
      if (campaign.state !== 'draft') fail('REFERRAL_INVALID_STATE')
      const dates = [campaign.startsAt, campaign.joinsUntil, campaign.qualifiesUntil, campaign.drawAt].map(stamp)
      if (dates.some(value => !Number.isFinite(value)) || !(dates[0] < dates[1] && dates[1] <= dates[2] && dates[2] <= dates[3]) || dates[1] <= stamp(now()) || campaign.minimumStudents !== 10 || campaign.prizes.length !== 3 || campaign.prizes.some(prize => !prize.months || !prize.label)) fail('REFERRAL_CAMPAIGN_INCOMPLETE')
      campaign.state = 'open'; campaign.version++
    } else if (action === 'review_group') {
      if (campaign.state !== 'open') fail('REFERRAL_INVALID_STATE')
      const row = entry(); version(payload.version, row.version)
      if (!['approved', 'rejected'].includes(String(payload.decision))) fail('REFERRAL_INVALID_PAYLOAD')
      if (!['pending', 'approved'].includes(row.state)) fail('REFERRAL_INVALID_STATE')
      if (reason.length < 3) fail('REFERRAL_REASON_REQUIRED')
      if (payload.decision === 'approved' && !progress(next, row).eligible) fail('REFERRAL_GROUP_INELIGIBLE')
      row.state = payload.decision as 'approved' | 'rejected'; row.version++; row.reviewReason = reason || null; row.reviewedAt = now(); target = row.id
      campaign.version++
    } else if (action === 'freeze_entries') {
      requireCampaignVersion(); confirm()
      if (campaign.state !== 'open') fail('REFERRAL_INVALID_STATE')
      if (stamp(now()) < stamp(campaign.qualifiesUntil)) fail('REFERRAL_TOO_EARLY')
      const approved = next.entries.filter(item => item.state === 'approved')
      if (approved.some(item => !progress(next, item).eligible)) fail('REFERRAL_GROUP_INELIGIBLE')
      if (new Set(approved.map(item => item.organizerId)).size < 3) fail('REFERRAL_NEED_THREE_ORGANIZERS')
      next.snapshot = approved.map(item => ({ entryId: item.id, groupId: item.groupId, organizerId: item.organizerId, alias: progress(next, item).organizerAlias })).sort((a, b) => a.entryId.localeCompare(b.entryId))
      const evidence = canonical({ campaignId: campaign.id, entries: next.snapshot, prizes: campaign.prizes, rulesVersion: campaign.rulesVersion, frozenAt: now() })
      campaign.snapshotHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(evidence))), value => value.toString(16).padStart(2, '0')).join('')
      campaign.state = 'frozen'; campaign.frozenAt = now(); campaign.version++
    } else if (action === 'draw_winners') {
      confirm()
      requireCampaignVersion()
      if (['drawn', 'published'].includes(campaign.state)) fail('REFERRAL_ALREADY_DRAWN')
      if (campaign.state !== 'frozen' || !next.snapshot) fail('REFERRAL_INVALID_STATE')
      const snapshot = next.snapshot || fail('REFERRAL_INVALID_STATE')
      if (stamp(now()) < stamp(campaign.drawAt)) fail('REFERRAL_TOO_EARLY')
      if (new Set(snapshot.map(item => item.organizerId)).size < 3) fail('REFERRAL_NEED_THREE_ORGANIZERS')
      let pool = [...snapshot]
      for (const prize of campaign.prizes) {
        const limit = 0x100000000 - 0x100000000 % pool.length
        let sample = limit
        for (let tries = 0; tries < 64 && sample >= limit; tries++) { const value = random(4); sample = ((value[0] * 0x1000000) + (value[1] << 16) + (value[2] << 8) + value[3]) >>> 0 }
        if (sample >= limit) fail('REFERRAL_INVALID_PAYLOAD')
        const selected = pool[sample % pool.length]
        next.winners.push({ id: id(), rank: prize.rank, organizerId: selected.organizerId, alias: selected.alias, prize: clone(prize), prizeStatus: 'pending', interviewStatus: 'pending', version: 1 })
        pool = pool.filter(item => item.organizerId !== selected.organizerId)
      }
      campaign.state = 'drawn'; campaign.drawnAt = now(); campaign.version++
    } else if (action === 'publish_results') {
      requireCampaignVersion(); confirm()
      if (campaign.state !== 'drawn' || next.winners.length !== 3) fail('REFERRAL_INVALID_STATE')
      campaign.state = 'published'; campaign.publishedAt = now(); campaign.version++
    } else if (action === 'set_prize_status' || action === 'set_interview_status') {
      if (campaign.state !== 'published') fail('REFERRAL_INVALID_STATE')
      const winner = next.winners.find(item => item.id === payload.winnerId) || fail('REFERRAL_INVALID_PAYLOAD')
      if (!actor.canAdmin && !(action === 'set_interview_status' && winner.organizerId === actor.id && payload.interviewStatus === 'declined')) fail('REFERRAL_ADMIN_REQUIRED')
      version(payload.version, winner.version)
      if (reason.length < 3) fail('REFERRAL_REASON_REQUIRED')
      if (action === 'set_prize_status') { if (!['pending', 'issued'].includes(String(payload.prizeStatus))) fail('REFERRAL_INVALID_PAYLOAD'); winner.prizeStatus = payload.prizeStatus as 'pending' | 'issued' }
      else { if (!['pending', 'invited', 'declined', 'completed'].includes(String(payload.interviewStatus))) fail('REFERRAL_INVALID_PAYLOAD'); winner.interviewStatus = payload.interviewStatus as 'pending' | 'invited' | 'declined' | 'completed' }
      winner.version++; target = winner.id
    } else fail('REFERRAL_INVALID_PAYLOAD')
    next.receipts[receipt] = fingerprint
    audit(next, actor, action, target, reason)
    commit(next)
    return workspace(actorId)
  }

  const fixture = (change: (next: LocalReferralState) => void) => { if (busy) fail('REFERRAL_VERSION_CONFLICT'); fresh(); const next = clone(state); change(next); commit(next); return clone(next) }
  const simulateGroupCreation = ({ headmanId, groupName }: { headmanId: string; groupName: string }) => {
    let groupId = ''
    fixture(next => { actorFor(next, headmanId); groupId = id(); next.groups.push({ id: groupId, name: text(groupName, 100) || 'Навчальна тестова група', headmanId, createdAt: now(), members: [{ userId: headmanId, accepted: true, joinedAt: now() }], resources: [] }) })
    return groupId
  }
  const simulateMembership = ({ groupId, userId, accepted = true, verified }: { groupId: string; userId: string; accepted?: boolean; verified?: boolean }) => fixture(next => {
    const group = next.groups.find(item => item.id === groupId) || fail('REFERRAL_INVALID_PAYLOAD'), actor = actorFor(next, userId, false)
    if (verified !== undefined) actor.verified = verified
    const member = group.members.find(item => item.userId === userId)
    if (member) { if (!member.accepted && accepted) member.joinedAt = now(); member.accepted = accepted }
    else group.members.push({ userId, accepted, joinedAt: now() })
  })
  const simulateGroupContent = ({ groupId, schedule, resource }: { groupId: string; schedule?: boolean; resource?: boolean }) => fixture(next => {
    const group = next.groups.find(item => item.id === groupId) || fail('REFERRAL_INVALID_PAYLOAD')
    for (const [kind, value] of [['schedule', schedule], ['material', resource]] as const) if (value !== undefined) {
      const current = group.resources.find(item => item.kind === kind)
      if (current) current.active = value
      else if (value) group.resources.push({ id: id(), kind, active: true })
    }
  })
  const simulateLearningRead = ({ groupId, userId, kind = 'schedule', resourceId }: { groupId: string; userId: string; kind?: 'schedule' | 'homework' | 'material'; resourceId?: string }) => fixture(next => {
    const actor = actorFor(next, userId), group = next.groups.find(item => item.id === groupId) || fail('REFERRAL_INVALID_PAYLOAD')
    const entry = next.entries.find(item => item.groupId === groupId) || fail('REFERRAL_GROUP_FORBIDDEN')
    const member = group.members.find(item => item.userId === actor.id && item.accepted)
    const resource = group.resources.find(item => item.active && item.kind === kind && (!resourceId || item.id === resourceId)) || fail('REFERRAL_GROUP_FORBIDDEN')
    if (!member) fail('REFERRAL_GROUP_FORBIDDEN')
    if (next.campaign.state !== 'open' || stamp(now()) < stamp(entry.registeredAt) || stamp(now()) > stamp(next.campaign.qualifiesUntil)) fail('REFERRAL_NOT_OPEN')
    let claim = next.claims.find(item => item.campaignId === next.campaign.id && item.userId === userId)
    if (claim && claim.entryId !== entry.id) return
    if (!claim) { claim = { campaignId: next.campaign.id, userId, entryId: entry.id, firstReadAt: now() }; next.claims.push(claim) }
    if (stamp(now()) > stamp(claim.firstReadAt) + 7 * DAY) return
    if (!next.reads.some(item => item.userId === userId && item.entryId === entry.id && item.resourceId === resource.id && item.at === now())) next.reads.push({ userId, entryId: entry.id, resourceId: resource.id, at: now() })
  })
  return {
    repositoryFor(actorId: string | null): GroupReferralRepository { return { load: async options => workspace(actorId, options), action(action, payload) { const next = flight.then(async () => { busy = true; try { return await act(actorId, action, payload) } finally { busy = false } }); flight = next.then(() => undefined, () => undefined); return next } } },
    actors: () => { fresh(); return clone(state.actors) }, getScenarioState: () => { fresh(); return clone(state) }, now,
    getRevision: () => { fresh(); return state.revision }, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    advanceClock(days: number) { if (!Number.isFinite(days) || days < 0 || days > 365) fail('REFERRAL_INVALID_PAYLOAD'); return fixture(next => { if (options.clock) next.clockOffsetMs += days * DAY; else next.clockIso = new Date(stamp(now()) + days * DAY).toISOString() }) },
    resetDemo() { if (busy) fail('REFERRAL_VERSION_CONFLICT'); const next = createGroupReferralPreviewSeed(); next.revision = state.revision + 1; if (storage) storage.setItem(key, JSON.stringify(next)); state = next; for (const listener of listeners) listener(); return clone(state) },
    resetDraft() { if (busy) fail('REFERRAL_VERSION_CONFLICT'); const next = createGroupReferralPreviewSeed(); next.revision = state.revision + 1; next.campaign = { ...next.campaign, state: 'draft', version: 1, startsAt: null, joinsUntil: null, qualifiesUntil: null, drawAt: null, prizes: clone(GROUP_REFERRAL_DEFAULT_PRIZES) }; next.groups = []; next.entries = []; next.links = []; next.claims = []; next.reads = []; next.snapshot = null; next.winners = []; next.audit = []; next.receipts = {}; if (storage) storage.setItem(key, JSON.stringify(next)); state = next; for (const listener of listeners) listener(); return clone(state) },
    simulateGroupCreation, simulateMembership, simulateGroupContent, simulateLearningRead,
    simulateVerification(userId: string, verified: boolean) { return fixture(next => { actorFor(next, userId, false).verified = verified }) },
    simulateLeaveGroup(groupId: string, userId: string) { return simulateMembership({ groupId, userId, accepted: false }) },
    fillVerifiedMembers(groupId: string, count = 10) { return fixture(next => {
      const group = next.groups.find(item => item.id === groupId) || fail('REFERRAL_INVALID_PAYLOAD')
      if (!Number.isSafeInteger(count) || count < 1 || count > next.actors.length) fail('REFERRAL_INVALID_PAYLOAD')
      const reserved = new Set(next.groups.filter(item => item.id !== groupId).flatMap(item => item.members.filter(member => member.accepted).map(member => member.userId)))
      const existing = group.members.filter(item => item.accepted)
      const available = next.actors.filter(actor => actor.previewRole === 'student' && !reserved.has(actor.id) && !existing.some(member => member.userId === actor.id))
      while (group.members.filter(item => item.accepted).length < count && available.length) { const actor = available.shift()!; actor.verified = true; group.members.push({ userId: actor.id, accepted: true, joinedAt: now() }) }
      actorFor(next, group.headmanId, false).verified = true
      if (group.members.filter(item => item.accepted).length < count) fail('REFERRAL_INVALID_PAYLOAD')
    }) },
    readForMembers(groupId: string, kind: 'schedule' | 'homework' | 'material' = 'schedule', count?: number) { const group = state.groups.find(item => item.id === groupId) || fail('REFERRAL_INVALID_PAYLOAD'); const members = group.members.filter(item => item.accepted).slice(0, count ?? group.members.length); for (const member of members) simulateLearningRead({ groupId, userId: member.userId, kind }); return clone(state) },
  }
}

export type LocalGroupReferralStore = ReturnType<typeof createLocalGroupReferralStore>
