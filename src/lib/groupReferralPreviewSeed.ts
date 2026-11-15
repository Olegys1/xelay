import type { LocalReferralActor, LocalReferralState } from './localGroupReferralRepository'

const fakeId = (family: number, value: number) => `f${family}000000-0000-4000-8000-${String(value).padStart(12, '0')}`
export const GROUP_REFERRAL_PREVIEW_ACTORS = Object.freeze({ admin: fakeId(0, 1), organizerA: fakeId(0, 2), organizerB: fakeId(0, 3), organizerC: fakeId(0, 4), organizerD: fakeId(0, 5) })
const owners = [GROUP_REFERRAL_PREVIEW_ACTORS.organizerA, GROUP_REFERRAL_PREVIEW_ACTORS.organizerA, GROUP_REFERRAL_PREVIEW_ACTORS.organizerA, GROUP_REFERRAL_PREVIEW_ACTORS.organizerA, GROUP_REFERRAL_PREVIEW_ACTORS.organizerB, GROUP_REFERRAL_PREVIEW_ACTORS.organizerC, GROUP_REFERRAL_PREVIEW_ACTORS.organizerD, GROUP_REFERRAL_PREVIEW_ACTORS.organizerD]
export const GROUP_REFERRAL_PREVIEW_GROUPS = Object.freeze(['Економіка · 1', 'Менеджмент · 2', 'Маркетинг · 3', 'Фінанси · 4', 'Географія · 5', 'Математика · 6', 'Історія · 7', 'Право · 8'].map((name, index) => ({
  id: fakeId(1, index + 1), name: `${name} · приклад`, headmanId: fakeId(0, 101 + index * 10), organizerId: owners[index],
  code: `LOCAL-${owners[index] === GROUP_REFERRAL_PREVIEW_ACTORS.organizerA ? 'AAAA' : owners[index] === GROUP_REFERRAL_PREVIEW_ACTORS.organizerB ? 'BBBB' : owners[index] === GROUP_REFERRAL_PREVIEW_ACTORS.organizerC ? 'CCCC' : 'DDDD'}-2026`,
})))

/** All identities and events here are fictional and confined to local preview storage. */
export function createGroupReferralPreviewSeed(): LocalReferralState {
  const actors: LocalReferralActor[] = [
    { id: GROUP_REFERRAL_PREVIEW_ACTORS.admin, alias: 'Адміністратор · приклад', verified: true, canAdmin: true, previewRole: 'admin' },
    ...['A', 'B', 'C', 'D'].map((letter, index) => ({ id: fakeId(0, index + 2), alias: `Організатор ${letter} · приклад`, verified: true, canAdmin: false, previewRole: 'organizer' as const })),
  ]
  const state: LocalReferralState = {
    schema: 1, revision: 1, clockIso: '2026-11-11T12:00:00Z', clockOffsetMs: 0,
    campaign: { id: fakeId(2, 1), slug: 'zbery-svoyikh-local', title: 'Збери своїх у Xelay', state: 'open', version: 2,
      startsAt: '2026-11-01T08:00:00Z', joinsUntil: '2026-11-21T21:59:00Z', qualifiesUntil: '2026-11-21T21:59:00Z', drawAt: '2026-11-22T16:00:00Z', minimumStudents: 10,
      prizes: [{ rank: 1, label: 'ChatGPT Plus', months: 1 }, { rank: 2, label: 'Telegram Premium', months: 6 }, { rank: 3, label: 'Telegram Premium', months: 3 }], rulesVersion: 'local-2026-11-07' },
    actors, groups: [], entries: [], links: [], claims: [], reads: [], snapshot: null, winners: [], audit: [], receipts: {},
  }
  for (const owner of [...new Set(owners)]) {
    const fixture = GROUP_REFERRAL_PREVIEW_GROUPS.find(group => group.organizerId === owner)!
    state.links.push({ actorId: owner, campaignId: state.campaign.id, code: fixture.code, alias: state.actors.find(actor => actor.id === owner)!.alias, rulesVersion: state.campaign.rulesVersion })
  }
  GROUP_REFERRAL_PREVIEW_GROUPS.forEach((definition, index) => {
    const members = Array.from({ length: 10 }, (_, offset) => {
      const userId = fakeId(0, 101 + index * 10 + offset)
      actors.push({ id: userId, alias: `${offset === 0 ? 'Староста' : 'Студент'} ${index + 1}.${offset + 1} · приклад`, verified: true, canAdmin: false, previewRole: offset === 0 ? 'headman' : 'student' })
      return { userId, accepted: true, joinedAt: index === 7 ? '2026-10-01T09:00:00Z' : '2026-11-02T09:00:00Z' }
    })
    const scheduleId = fakeId(4, index * 10 + 1), materialId = fakeId(4, index * 10 + 2)
    state.groups.push({ id: definition.id, name: definition.name, headmanId: definition.headmanId, createdAt: index === 0 || index === 7 ? '2026-10-01T08:00:00Z' : '2026-11-02T08:00:00Z', members,
      resources: [{ id: scheduleId, kind: 'schedule', active: true }, { id: materialId, kind: 'material', active: true }] })
    if (index === 7) return // An existing group, created before the campaign, can register in preview.
    const entryId = fakeId(3, index + 1)
    state.entries.push({ id: entryId, campaignId: state.campaign.id, groupId: definition.id, organizerId: definition.organizerId,
      registeredAt: '2026-11-03T08:00:00Z', state: index < 6 ? 'approved' : 'collecting', version: index < 6 ? 3 : 1,
      ...(index < 6 ? { reviewedAt: '2026-11-05T10:00:00Z', reviewReason: 'Умови перевірено на вигаданих навчальних даних.' } : {}) })
    for (const [offset, member] of members.entries()) {
      state.claims.push({ userId: member.userId, campaignId: state.campaign.id, entryId, firstReadAt: '2026-11-03T09:00:00Z' })
      state.reads.push({ userId: member.userId, entryId, resourceId: scheduleId, at: '2026-11-03T09:00:00Z' })
      if (index < 6 || offset < 6) state.reads.push({ userId: member.userId, entryId, resourceId: materialId, at: '2026-11-04T09:00:00Z' })
    }
  })
  state.audit.push({ id: fakeId(5, 1), at: '2026-11-01T08:00:00Z', action: 'activate_campaign', actorAlias: actors[0].alias, reason: 'Лише локальний приклад. Робочої акції немає.' })
  return state
}
