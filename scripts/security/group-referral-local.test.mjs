import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const typesUrl = uri(compile(await read('src/lib/groupReferralTypes.ts')))
const seedUrl = uri(compile(await read('src/lib/groupReferralPreviewSeed.ts')))
const engineSource = await read('src/lib/localGroupReferralRepository.ts')
const engineUrl = uri(compile(engineSource).replace(/['"]\.\/groupReferralTypes['"]/g, JSON.stringify(typesUrl)).replace(/['"]\.\/groupReferralPreviewSeed['"]/g, JSON.stringify(seedUrl)))
const { createLocalGroupReferralStore } = await import(engineUrl)
const { parseGroupReferralWorkspace } = await import(uri(compile(await read('src/lib/groupReferralRepository.ts'))))
const { GROUP_REFERRAL_PREVIEW_ACTORS: ACTORS, GROUP_REFERRAL_PREVIEW_GROUPS: GROUPS } = await import(seedUrl)
let sequence = 0
const requestId = () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
const createStore = extra => createLocalGroupReferralStore({ storage: null, ...extra })
const action = async (repository, name, payload = {}) => repository.action(name, { campaignId: (await repository.load()).campaign.id, requestId: requestId(), ...payload })
const adminCampaign = async (store, name, payload = {}) => { const repository = store.repositoryFor(ACTORS.admin); return action(repository, name, { version: (await repository.load()).campaign.version, ...payload }) }
const ownEntry = async (store, actorId, groupId) => (await store.repositoryFor(actorId).load()).ownGroups.find(item => item.groupId === groupId)

async function registerCandidate(store) {
  const fixture = GROUPS[7], repository = store.repositoryFor(fixture.headmanId)
  await action(repository, 'register_group', { groupId: fixture.id, code: fixture.code })
  return { fixture, repository }
}

test('the persisted demo contains realistic private scopes and unlimited group chances for one organizer', async () => {
  const store = createStore(), state = store.getScenarioState()
  assert.ok(state.actors.length >= 40)
  assert.ok(state.actors.filter(actor => actor.previewRole === 'organizer').length >= 4)
  assert.ok(state.groups.length >= 4)
  assert.ok(state.groups.every(group => group.members.length >= 10 && group.members.some(member => member.userId === group.headmanId)))
  assert.deepEqual(state.campaign.prizes[0], { rank: 1, label: 'ChatGPT Plus', months: 1 })
  const organizer = await store.repositoryFor(ACTORS.organizerA).load()
  assert.equal(organizer.ownTickets, 4)
  assert.equal(organizer.ownGroups.filter(group => group.state === 'approved').length, 4)
  assert.equal(organizer.admin, undefined)
  assert.ok(organizer.ownGroups.every(group => group.organizerId === ACTORS.organizerA))
  const studentId = state.groups[0].members[1].userId
  const student = await store.repositoryFor(studentId).load()
  assert.deepEqual(student.ownGroups.map(group => group.groupId), [GROUPS[0].id])
  assert.equal(student.ownGroups[0].viewerRole, 'member')
  assert.equal(student.ownGroups[0].canSubmit, false)
  const guest = await store.repositoryFor(null).load()
  assert.deepEqual(guest.ownGroups, []); assert.equal(guest.admin, undefined); assert.equal(guest.ownLink, null)
  assert.doesNotMatch(JSON.stringify(organizer), /@[^\s"]+\.(?:com|ua)|email|grades|access_token|refresh_token/i)
  for (const actor of [null, ...store.actors().map(item => item.id)]) {
    const response = await store.repositoryFor(actor).load()
    assert.doesNotThrow(() => parseGroupReferralWorkspace(response, actor), 'every synthetic actor must satisfy the production response parser')
  }
})

test('fresh draft must define exact prizes and dates before activation and actor/version checks precede writes', async () => {
  const store = createStore(); store.resetDraft()
  const admin = store.repositoryFor(ACTORS.admin), organizer = store.repositoryFor(ACTORS.organizerA)
  await assert.rejects(adminCampaign(store, 'activate_campaign'), /REFERRAL_CAMPAIGN_INCOMPLETE/)
  await assert.rejects(action(organizer, 'activate_campaign', { version: 1 }), /REFERRAL_ADMIN_REQUIRED/)
  await assert.rejects(action(store.repositoryFor(null), 'create_link', { alias: 'Student', acceptRules: true }), /REFERRAL_AUTH_REQUIRED/)
  await assert.rejects(action(admin, 'save_campaign', { version: 99, title: 'Changed' }), /REFERRAL_VERSION_CONFLICT/)
  await assert.rejects(action(admin, 'save_campaign', { version: 1, minimumStudents: 9 }), /REFERRAL_INVALID_PAYLOAD/)
  assert.equal((await admin.load()).campaign.state, 'draft')
  store.simulateVerification(ACTORS.organizerA, false)
  await assert.rejects(action(organizer, 'create_link', { alias: 'Student', acceptRules: true }), /REFERRAL_VERIFICATION_REQUIRED/)
})

test('campaign and public alias validation match the production mutation contract', async () => {
  const store = createStore(); store.resetDraft()
  const settings = { title: 'Перевірка умов акції', startsAt: store.now(), joinsUntil: '2026-11-21T21:59:00Z', qualifiesUntil: '2026-11-20T21:59:00Z', drawAt: '2026-11-22T16:00:00Z',
    prizes: [{ rank: 1, label: 'ChatGPT Plus', months: 1 }, { rank: 2, label: 'Telegram Premium', months: 6 }, { rank: 3, label: 'Telegram Premium', months: 3 }] }
  await adminCampaign(store, 'save_campaign', settings)
  await assert.rejects(adminCampaign(store, 'activate_campaign'), /REFERRAL_CAMPAIGN_INCOMPLETE/, 'qualification cannot finish before campaign registration')
  await adminCampaign(store, 'save_campaign', { ...settings, qualifiesUntil: settings.joinsUntil })
  await adminCampaign(store, 'activate_campaign')
  const organizer = store.repositoryFor(ACTORS.organizerA)
  for (const alias of ['@contact', 'https://example.org', 'Номер 1234567', '<script>', 'a\nb']) {
    await assert.rejects(action(organizer, 'create_link', { alias, acceptRules: true }), /REFERRAL_INVALID_PAYLOAD/)
  }
  const alias = store.actors().find(actor => actor.id === ACTORS.organizerA).alias
  const created = await action(organizer, 'create_link', { alias, acceptRules: true })
  assert.ok(created.ownLink)
  await assert.rejects(action(organizer, 'create_link', { alias: 'Інше ім’я', acceptRules: true }), /REFERRAL_INVALID_PAYLOAD/, 'an accepted public alias is immutable')
  await assert.rejects(action(organizer, 'create_link', { alias, acceptRules: true, at: '2099-01-01T00:00:00Z' }), /REFERRAL_INVALID_PAYLOAD/)
  await assert.rejects(adminCampaign(store, 'save_campaign', { ...settings, rulesVersion: 'invented' }), /REFERRAL_INVALID_PAYLOAD/)
})

test('headman registration accepts existing groups and locks attribution against duplicate or foreign registration', async () => {
  const source = createStore().getScenarioState(), candidate = source.groups[7]
  assert.ok(Date.parse(candidate.createdAt) < Date.parse(source.campaign.startsAt))
  assert.ok(Date.parse(source.clockIso) - Date.parse(candidate.createdAt) > 86_400_000)
  const store = createStore(), { fixture, repository } = await registerCandidate(store)
  await assert.rejects(action(repository, 'register_group', { groupId: fixture.id, code: GROUPS[0].code }), /REFERRAL_GROUP_ALREADY_REGISTERED/)
  await assert.rejects(action(store.repositoryFor(ACTORS.organizerA), 'register_group', { groupId: fixture.id, code: GROUPS[0].code }), /REFERRAL_GROUP_FORBIDDEN/)
  const original = await ownEntry(store, fixture.headmanId, fixture.id)
  assert.equal(original.organizerId, ACTORS.organizerD)
  assert.equal(original.viewerRole, 'representative')
  assert.equal(original.canSubmit, true)
  assert.equal(original.createdAt, candidate.createdAt)
  assert.equal(original.registeredAt, store.now())
  assert.equal((await repository.load()).candidateGroups.some(group => group.id === fixture.id), false)
})

test('a headman may create a code and qualify their existing own group with unchanged activity requirements', async () => {
  const store = createStore(), fixture = GROUPS[7], repository = store.repositoryFor(fixture.headmanId)
  const before = await repository.load(), candidate = before.candidateGroups.find(group => group.id === fixture.id)
  assert.equal(candidate.canRegister, true)
  const linked = await action(repository, 'create_link', { alias: before.actor.alias, acceptRules: true })
  await assert.rejects(action(repository, 'register_group', { groupId: fixture.id, code: linked.ownLink.code, createdAt: store.now() }), /REFERRAL_INVALID_PAYLOAD/)
  await action(repository, 'register_group', { groupId: fixture.id, code: linked.ownLink.code })
  let entry = await ownEntry(store, fixture.headmanId, fixture.id)
  assert.equal(entry.organizerId, fixture.headmanId)
  assert.equal(entry.viewerRole, 'organizer')
  assert.equal(entry.createdAt, candidate.createdAt)
  assert.equal(entry.verifiedStudents, 10)
  assert.equal(entry.returningStudents, 0)
  assert.equal(entry.eligible, false)
  await assert.rejects(action(repository, 'submit_group', { entryId: entry.id, version: entry.version }), /REFERRAL_GROUP_INELIGIBLE/)
  store.readForMembers(fixture.id)
  assert.equal((await ownEntry(store, fixture.headmanId, fixture.id)).eligible, false)
  store.advanceClock(1); store.readForMembers(fixture.id)
  entry = await ownEntry(store, fixture.headmanId, fixture.id)
  assert.equal(entry.returningStudents, 10)
  assert.equal(entry.eligible, true)
  await action(repository, 'submit_group', { entryId: entry.id, version: entry.version })
  entry = await ownEntry(store, fixture.headmanId, fixture.id)
  const approved = await action(store.repositoryFor(ACTORS.admin), 'review_group', { entryId: entry.id, version: entry.version, decision: 'approved', reason: 'Перевірено навчальне використання власної групи' })
  assert.equal(approved.admin.groups.find(group => group.id === entry.id).eligible, true)
  assert.equal((await repository.load()).ownTickets, 1)
})

test('real reads on two Kyiv days qualify late joiners in their own seven-day window without trusting client times', async () => {
  const store = createStore(), { fixture, repository } = await registerCandidate(store)
  store.advanceClock(6)
  store.readForMembers(fixture.id)
  const firstRead = await ownEntry(store, fixture.headmanId, fixture.id)
  assert.equal(firstRead.returningStudents, 0)
  assert.equal(firstRead.ownMemberCounts, true, 'a first read assigns the unique campaign credit before two-day qualification')
  assert.equal(firstRead.ownMemberDays, 1)
  store.advanceClock(2)
  store.readForMembers(fixture.id)
  const result = await ownEntry(store, fixture.headmanId, fixture.id)
  assert.equal(result.returningStudents, 10)
  assert.equal(result.eligible, true)
  assert.equal(result.canSubmit, true)
  await action(repository, 'submit_group', { entryId: result.id, version: result.version })
  assert.equal((await ownEntry(store, fixture.headmanId, fixture.id)).state, 'pending')

  const expired = createStore(), candidate = await registerCandidate(expired)
  expired.readForMembers(candidate.fixture.id)
  expired.advanceClock(8)
  expired.readForMembers(candidate.fixture.id)
  assert.equal((await ownEntry(expired, candidate.fixture.headmanId, candidate.fixture.id)).returningStudents, 0)

  const midnight = createStore(), last = await registerCandidate(midnight)
  midnight.advanceClock((9 * 60 + 59) / (24 * 60)) // 23:59 in Kyiv.
  midnight.readForMembers(last.fixture.id)
  midnight.advanceClock(2 / (24 * 60))
  midnight.readForMembers(last.fixture.id)
  assert.equal((await ownEntry(midnight, last.fixture.headmanId, last.fixture.id)).returningStudents, 10)
  const member = midnight.getScenarioState().groups[7].members[0].userId
  midnight.simulateLearningRead({ groupId: last.fixture.id, userId: member, kind: 'schedule', at: '2099-01-01T00:00:00Z' })
  assert.ok(midnight.getScenarioState().reads.every(row => row.at < '2027'))
})

test('the final campaign deadline bounds each personal week while ordinary group creation remains available', async () => {
  const source = createStore().getScenarioState()
  source.campaign.joinsUntil = source.campaign.qualifiesUntil = '2026-11-21T21:59:00Z' // 21 November, 23:59 in Kyiv.
  source.campaign.drawAt = '2026-11-22T16:00:00Z'
  const timely = createStore({ initialState: source }), first = await registerCandidate(timely)
  timely.advanceClock(9)
  timely.readForMembers(first.fixture.id)
  timely.advanceClock(1)
  timely.readForMembers(first.fixture.id)
  assert.equal((await ownEntry(timely, first.fixture.headmanId, first.fixture.id)).returningStudents, 10)

  const late = createStore({ initialState: source }), last = await registerCandidate(late)
  late.advanceClock(10 + (9 * 60 + 58) / (24 * 60)) // First read is one minute before the shared deadline.
  late.readForMembers(last.fixture.id)
  const before = await ownEntry(late, last.fixture.headmanId, last.fixture.id)
  assert.equal(before.ownMemberDays, 1)
  late.advanceClock(3 / (24 * 60))
  assert.throws(() => late.readForMembers(last.fixture.id), /REFERRAL_NOT_OPEN/)
  const after = await ownEntry(late, last.fixture.headmanId, last.fixture.id)
  assert.equal(after.returningStudents, 0, 'the seven-day window never extends past the public deadline')
  assert.equal(after.ownMemberDays, 1)
  assert.equal(after.canSubmit, false)
  const normalGroupId = late.simulateGroupCreation({ headmanId: last.fixture.headmanId, groupName: 'Звичайна група після завершення акції' })
  assert.ok(late.getScenarioState().groups.some(group => group.id === normalGroupId))
  await assert.rejects(action(last.repository, 'register_group', { groupId: normalGroupId, code: last.fixture.code }), /REFERRAL_NOT_OPEN/)
})

test('a student receives one campaign credit on first authorized read and cannot inflate another group', async () => {
  const store = createStore(), { fixture } = await registerCandidate(store)
  const original = store.getScenarioState(), ownMember = original.groups[7].members[9].userId, creditedElsewhere = original.groups[0].members[1].userId
  store.simulateLeaveGroup(fixture.id, ownMember)
  store.simulateMembership({ groupId: fixture.id, userId: creditedElsewhere })
  store.readForMembers(fixture.id)
  store.advanceClock(1); store.readForMembers(fixture.id)
  const result = await ownEntry(store, fixture.headmanId, fixture.id)
  assert.equal(result.verifiedStudents, 10)
  assert.equal(result.returningStudents, 9)
  assert.equal(result.eligible, false)
  assert.equal(store.getScenarioState().claims.filter(claim => claim.userId === creditedElsewhere).length, 1)
  const member = await store.repositoryFor(creditedElsewhere).load()
  assert.equal(member.ownGroups.find(group => group.groupId === fixture.id).ownMemberCounts, false)
  await assert.rejects(action(store.repositoryFor(fixture.headmanId), 'submit_group', { entryId: result.id, version: result.version }), /REFERRAL_GROUP_INELIGIBLE/)
})

test('registration has no age limit while future dates and unverified participants remain blocked', async () => {
  const fixture = GROUPS[7]
  for (const createdAt of ['2026-10-01T08:00:00Z', '2026-11-05T08:00:00Z']) {
    const source = createStore().getScenarioState(); source.groups[7].createdAt = createdAt
    const store = createStore({ initialState: source }), repository = store.repositoryFor(fixture.headmanId)
    store.advanceClock(1)
    assert.equal((await repository.load()).candidateGroups.find(group => group.id === fixture.id).canRegister, true)
    await action(repository, 'register_group', { groupId: fixture.id, code: fixture.code })
    assert.equal((await ownEntry(store, fixture.headmanId, fixture.id)).createdAt, createdAt)
  }
  const future = createStore().getScenarioState()
  future.groups[7].createdAt = '2026-11-12T12:00:00Z'
  const futureStore = createStore({ initialState: future }), futureRepository = futureStore.repositoryFor(fixture.headmanId)
  assert.equal((await futureRepository.load()).candidateGroups.find(group => group.id === fixture.id).canRegister, false)
  await assert.rejects(action(futureRepository, 'register_group', { groupId: fixture.id, code: fixture.code }), /REFERRAL_REGISTRATION_EXPIRED/)
  const unverified = createStore()
  unverified.simulateVerification(fixture.headmanId, false)
  assert.equal((await unverified.repositoryFor(fixture.headmanId).load()).candidateGroups.find(group => group.id === fixture.id).canRegister, false)
  await assert.rejects(action(unverified.repositoryFor(fixture.headmanId), 'register_group', { groupId: fixture.id, code: fixture.code }), /REFERRAL_VERIFICATION_REQUIRED/)
  const revoked = createStore()
  revoked.simulateVerification(ACTORS.organizerD, false)
  await assert.rejects(action(revoked.repositoryFor(fixture.headmanId), 'register_group', { groupId: fixture.id, code: fixture.code }), /REFERRAL_INVALID_CODE/)
})

test('review and freeze recheck current membership, verification and actual learning resources', async () => {
  const store = createStore(), { fixture, repository } = await registerCandidate(store)
  store.readForMembers(fixture.id); store.advanceClock(1); store.readForMembers(fixture.id)
  let entry = await ownEntry(store, fixture.headmanId, fixture.id)
  await action(repository, 'submit_group', { entryId: entry.id, version: entry.version })
  entry = await ownEntry(store, fixture.headmanId, fixture.id)
  const studentId = store.getScenarioState().groups[7].members[1].userId
  store.simulateVerification(studentId, false)
  await assert.rejects(action(store.repositoryFor(ACTORS.admin), 'review_group', { entryId: entry.id, version: entry.version, decision: 'approved', reason: 'Перевірено участь' }), /REFERRAL_GROUP_INELIGIBLE/)
  await assert.rejects(action(store.repositoryFor(ACTORS.admin), 'review_group', { entryId: entry.id, version: entry.version, decision: 'rejected' }), /REFERRAL_REASON_REQUIRED/)
  store.simulateVerification(studentId, true)
  await action(store.repositoryFor(ACTORS.admin), 'review_group', { entryId: entry.id, version: entry.version, decision: 'approved', reason: 'Підтверджено навчальне використання' })
  store.simulateGroupContent({ groupId: GROUPS[0].id, resource: false })
  store.advanceClock(20)
  await assert.rejects(adminCampaign(store, 'freeze_entries', { confirm: true }), /REFERRAL_GROUP_INELIGIBLE/)
  assert.equal((await store.repositoryFor(ACTORS.admin).load()).campaign.state, 'open')
})

test('the organizer can submit an eligible group and both review decisions require a reason', async () => {
  const store = createStore(), { fixture } = await registerCandidate(store), admin = store.repositoryFor(ACTORS.admin)
  store.readForMembers(fixture.id); store.advanceClock(1); store.readForMembers(fixture.id)
  let entry = await ownEntry(store, ACTORS.organizerD, fixture.id)
  assert.equal(entry.viewerRole, 'organizer'); assert.equal(entry.canSubmit, true)
  await action(store.repositoryFor(ACTORS.organizerD), 'submit_group', { entryId: entry.id, version: entry.version })
  entry = await ownEntry(store, ACTORS.organizerD, fixture.id)
  for (const decision of ['approved', 'rejected']) {
    await assert.rejects(action(admin, 'review_group', { entryId: entry.id, version: entry.version, decision }), /REFERRAL_REASON_REQUIRED/)
    await assert.rejects(action(admin, 'review_group', { entryId: entry.id, version: entry.version, decision, reason: 'no' }), /REFERRAL_REASON_REQUIRED/)
  }
  await action(admin, 'review_group', { entryId: entry.id, version: entry.version, decision: 'approved', reason: 'Перевірено всі умови' })
  entry = await ownEntry(store, ACTORS.organizerD, fixture.id)
  await action(admin, 'review_group', { entryId: entry.id, version: entry.version, decision: 'rejected', reason: 'Потрібна повторна адміністративна перевірка' })
  assert.equal((await ownEntry(store, ACTORS.organizerD, fixture.id)).state, 'rejected')
  assert.equal((await store.repositoryFor(ACTORS.organizerD).load()).ownTickets, 0)
})

test('an administrative review invalidates a stale confirmation of the freeze set', async () => {
  const store = createStore(), admin = store.repositoryFor(ACTORS.admin)
  const before = await admin.load(), entry = before.admin.groups.find(item => item.groupId === GROUPS[0].id)
  const after = await action(admin, 'review_group', { entryId: entry.id, version: entry.version, decision: 'approved', reason: 'Повторно перевірено перед фіксацією' })
  assert.equal(after.campaign.version, before.campaign.version + 1)
  store.advanceClock(17)
  await assert.rejects(action(admin, 'freeze_entries', { version: before.campaign.version, confirm: true }), /REFERRAL_VERSION_CONFLICT/)
  assert.equal((await admin.load()).campaign.state, 'open')
  assert.equal((await adminCampaign(store, 'freeze_entries', { confirm: true })).campaign.state, 'frozen')
})

test('frozen weighted entries stay immutable, draw has three distinct organizers and results require publication', async () => {
  const store = createStore(), admin = store.repositoryFor(ACTORS.admin)
  await assert.rejects(adminCampaign(store, 'freeze_entries', { confirm: true }), /REFERRAL_TOO_EARLY/)
  store.advanceClock(17)
  const frozen = await adminCampaign(store, 'freeze_entries', { confirm: true })
  assert.equal(frozen.campaign.state, 'frozen')
  assert.match(frozen.campaign.snapshotHash, /^[0-9a-f]{64}$/)
  assert.equal(store.getScenarioState().snapshot.filter(entry => entry.organizerId === ACTORS.organizerA).length, 4)
  const snapshot = structuredClone(store.getScenarioState().snapshot), hash = frozen.campaign.snapshotHash
  store.simulateLeaveGroup(GROUPS[0].id, store.getScenarioState().groups[0].members[0].userId)
  assert.deepEqual(store.getScenarioState().snapshot, snapshot)
  const drawPayload = { campaignId: frozen.campaign.id, requestId: requestId(), version: frozen.campaign.version, confirm: true }
  const drawn = await admin.action('draw_winners', drawPayload)
  assert.equal(drawn.campaign.snapshotHash, hash)
  assert.equal(new Set(drawn.winners.map(winner => winner.organizerId)).size, 3)
  assert.deepEqual(drawn.winners.map(winner => winner.rank), [1, 2, 3])
  assert.deepEqual((await store.repositoryFor(ACTORS.organizerA).load()).winners, [])
  await assert.rejects(action(store.repositoryFor(drawn.winners[0].organizerId), 'set_interview_status', { winnerId: drawn.winners[0].id, version: drawn.winners[0].version, interviewStatus: 'declined', reason: 'Відмова від інтерв’ю' }), /REFERRAL_INVALID_STATE/)
  const auditLength = store.getScenarioState().audit.length
  assert.deepEqual((await admin.action('draw_winners', drawPayload)).winners, drawn.winners)
  await assert.rejects(adminCampaign(store, 'draw_winners', { confirm: true }), /REFERRAL_ALREADY_DRAWN/)
  assert.equal(store.getScenarioState().audit.length, auditLength)
  const published = await adminCampaign(store, 'publish_results', { confirm: true })
  assert.equal(published.campaign.state, 'published')
  const guest = await store.repositoryFor(null).load()
  assert.equal(guest.winners.length, 3)
  assert.ok(guest.winners.every(winner => !winner.organizerId && !winner.isOwn))
  assert.ok(guest.winners.every(winner => winner.prizeStatus === undefined && winner.interviewStatus === undefined))
  const winner = published.winners[0], winnerRepo = store.repositoryFor(winner.organizerId)
  await assert.rejects(action(winnerRepo, 'set_prize_status', { winnerId: winner.id, version: winner.version, prizeStatus: 'issued' }), /REFERRAL_ADMIN_REQUIRED/)
  await assert.rejects(action(winnerRepo, 'set_interview_status', { winnerId: winner.id, version: winner.version, interviewStatus: 'completed' }), /REFERRAL_ADMIN_REQUIRED/)
  await assert.rejects(action(winnerRepo, 'set_interview_status', { winnerId: winner.id, version: winner.version, interviewStatus: 'declined' }), /REFERRAL_REASON_REQUIRED/)
  await assert.rejects(action(admin, 'set_prize_status', { winnerId: winner.id, version: winner.version, prizeStatus: 'issued' }), /REFERRAL_REASON_REQUIRED/)
  await action(winnerRepo, 'set_interview_status', { winnerId: winner.id, version: winner.version, interviewStatus: 'declined', reason: 'Не бажаю брати участь в інтерв’ю' })
  const current = (await admin.load()).winners.find(row => row.id === winner.id)
  await action(admin, 'set_prize_status', { winnerId: winner.id, version: current.version, prizeStatus: 'issued', reason: 'Вручено вручну у локальному прикладі' })
  assert.equal((await winnerRepo.load()).winners.find(row => row.isOwn).prizeStatus, 'issued')
  assert.doesNotThrow(() => parseGroupReferralWorkspace(guest, null))
  assert.doesNotThrow(() => parseGroupReferralWorkspace(published, ACTORS.admin))
  const ownPublished = await winnerRepo.load()
  assert.doesNotThrow(() => parseGroupReferralWorkspace(ownPublished, winner.organizerId))
})

test('local storage survives reconstruction, emits revisions and request replay has no duplicate side effects', async () => {
  const values = new Map(), storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) }
  const store = createStore({ storage }), repository = store.repositoryFor(GROUPS[7].headmanId)
  let notifications = 0
  const unsubscribe = store.subscribe(() => { notifications++ })
  const payload = { campaignId: (await repository.load()).campaign.id, requestId: requestId(), groupId: GROUPS[7].id, code: GROUPS[7].code }
  const [first, duplicate] = await Promise.all([repository.action('register_group', payload), repository.action('register_group', payload)])
  assert.equal(first.ownGroups.length, 1); assert.equal(duplicate.ownGroups.length, 1)
  assert.equal(store.getScenarioState().entries.filter(entry => entry.groupId === GROUPS[7].id).length, 1)
  assert.equal(notifications, 1)
  await assert.rejects(repository.action('register_group', { ...payload, code: GROUPS[0].code }), /REFERRAL_INVALID_PAYLOAD/)
  await assert.rejects(store.repositoryFor(ACTORS.organizerD).action('register_group', payload), /REFERRAL_INVALID_PAYLOAD/)
  const reconstructed = createStore({ storage })
  assert.deepEqual((await reconstructed.repositoryFor(GROUPS[7].headmanId).load()).ownGroups, first.ownGroups)
  const before = reconstructed.getRevision()
  store.advanceClock(1)
  assert.ok(reconstructed.getRevision() > before)
  assert.equal(reconstructed.now(), store.now())
  unsubscribe()
  const count = notifications; store.advanceClock(1); assert.equal(notifications, count)
})

test('candidate, own and admin keyset pages stay bounded and preserve every group without duplicates', async () => {
  const source = createStore().getScenarioState(), headmanId = GROUPS[7].headmanId
  const groupTemplate = source.groups[7], entryTemplate = source.entries[0]
  const fakeId = (family, n) => `${family}-0000-4000-8000-${String(n).padStart(12, '0')}`
  for (let n = 1; n <= 120; n++) source.groups.push({ ...structuredClone(groupTemplate), id: fakeId('ac000000', n), name: `Синтетична кандидатна група ${n}` })
  for (let n = 1; n <= 62; n++) {
    const groupId = fakeId('ad000000', n)
    source.groups.push({ ...structuredClone(groupTemplate), id: groupId, name: `Синтетична зареєстрована група ${n}` })
    source.entries.push({ ...structuredClone(entryTemplate), id: fakeId('ae000000', n), groupId, organizerId: ACTORS.organizerA, state: 'collecting' })
  }
  const store = createStore({ initialState: source }), repository = store.repositoryFor(headmanId), organizer = store.repositoryFor(ACTORS.organizerA), admin = store.repositoryFor(ACTORS.admin)
  const walk = async (repo, rows, cursorField, option, expected) => {
    let cursor, pages = 0
    const ids = []
    const actorId = repo === admin ? ACTORS.admin : repo === organizer ? ACTORS.organizerA : headmanId
    do {
      const response = await repo.load(cursor ? { [option]: cursor } : {})
      assert.doesNotThrow(() => parseGroupReferralWorkspace(response, actorId))
      const batch = rows(response)
      assert.ok(batch.length <= 50)
      ids.push(...batch.map(row => row.id))
      cursor = cursorField(response)
      if (cursor) assert.equal(cursor, batch.at(-1).id)
      pages++
      assert.ok(pages < 10, 'each cursor must advance')
    } while (cursor)
    assert.equal(ids.length, expected)
    assert.equal(new Set(ids).size, expected)
    assert.deepEqual(ids, [...ids].sort())
    return ids
  }
  const candidateIds = await walk(repository, result => result.candidateGroups, result => result.candidateNextCursor, 'candidateAfter', 121)
  const ownIds = await walk(organizer, result => result.ownGroups, result => result.nextCursor, 'after', 66)
  const adminIds = await walk(admin, result => result.admin.groups, result => result.admin.nextCursor, 'adminAfter', 69)
  assert.ok(candidateIds.every(id => !source.entries.some(entry => entry.groupId === id)), 'registered groups never reappear as candidates')
  assert.ok(ownIds.every(id => source.entries.find(entry => entry.id === id).organizerId === ACTORS.organizerA))
  assert.equal(adminIds.length, source.entries.length)
  const pastEnd = await repository.load({ candidateAfter: candidateIds.at(-1) })
  assert.deepEqual(pastEnd.candidateGroups, []); assert.equal(pastEnd.candidateNextCursor, null)
  for (const option of ['candidateAfter', 'after', 'adminAfter']) await assert.rejects(repository.load({ [option]: 'invalid-cursor' }), /REFERRAL_SOURCE_UNAVAILABLE/)
  const guest = await store.repositoryFor(null).load({ candidateAfter: candidateIds[49], after: ownIds[49], adminAfter: adminIds[49] })
  assert.deepEqual(guest.candidateGroups, []); assert.deepEqual(guest.ownGroups, []); assert.equal(guest.admin, undefined)
})

test('the injected cryptographic draw rejects biased random words and samples unlimited tickets without repeating organizers', async () => {
  const words = [0xffffffff, 3, 0, 0]
  let draws = 0, identities = 0
  const store = createStore({ randomBytes(length) {
    if (length !== 4) return new Uint8Array(length).fill(++identities)
    const value = words[draws++]
    assert.notEqual(value, undefined)
    return new Uint8Array([value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255])
  } })
  store.advanceClock(17)
  await adminCampaign(store, 'freeze_entries', { confirm: true })
  const result = await adminCampaign(store, 'draw_winners', { confirm: true })
  assert.equal(draws, 4, 'the first out-of-range word is discarded instead of reduced modulo six')
  assert.deepEqual(result.winners.map(winner => winner.organizerId), [ACTORS.organizerA, ACTORS.organizerB, ACTORS.organizerC])
})

test('the complete local path runs from an empty draft to approval, frozen draw, publication and manual prize issue', async () => {
  const store = createStore(); store.resetDraft()
  const admin = store.repositoryFor(ACTORS.admin)
  await adminCampaign(store, 'save_campaign', { title: 'Вигадана навчальна акція', startsAt: store.now(), joinsUntil: '2026-11-20T20:00:00Z', qualifiesUntil: '2026-11-27T20:00:00Z', drawAt: '2026-11-28T12:00:00Z',
    prizes: [{ rank: 1, label: 'ChatGPT Plus', months: 1 }, { rank: 2, label: 'Telegram Premium', months: 6 }, { rank: 3, label: 'Telegram Premium', months: 3 }] })
  await adminCampaign(store, 'activate_campaign')
  const groups = []
  for (const [index, owner] of [ACTORS.organizerA, ACTORS.organizerB, ACTORS.organizerC].entries()) {
    const organizer = store.repositoryFor(owner)
    const link = await action(organizer, 'create_link', { alias: `Participant_${index}`, acceptRules: true })
    assert.match(link.ownLink.path, /^\/referrals\?ref=/)
    const headmanId = GROUPS[index].headmanId
    const groupId = store.simulateGroupCreation({ headmanId, groupName: `Нова вигадана група ${index + 1}` })
    store.fillVerifiedMembers(groupId, 10)
    store.simulateGroupContent({ groupId, schedule: true, resource: true })
    await action(store.repositoryFor(headmanId), 'register_group', { groupId, code: link.ownLink.code })
    store.readForMembers(groupId)
    groups.push({ groupId, headmanId, owner })
  }
  store.advanceClock(1)
  for (const group of groups) {
    store.readForMembers(group.groupId, 'material')
    let entry = await ownEntry(store, group.headmanId, group.groupId)
    assert.equal(entry.eligible, true)
    await action(store.repositoryFor(group.headmanId), 'submit_group', { entryId: entry.id, version: entry.version })
    entry = await ownEntry(store, group.headmanId, group.groupId)
    await action(admin, 'review_group', { entryId: entry.id, version: entry.version, decision: 'approved', reason: 'Перевірено навчальне використання' })
    assert.equal((await store.repositoryFor(group.owner).load()).ownTickets, 1)
  }
  store.advanceClock(30)
  await adminCampaign(store, 'freeze_entries', { confirm: true })
  await adminCampaign(store, 'draw_winners', { confirm: true })
  const published = await adminCampaign(store, 'publish_results', { confirm: true })
  assert.equal(published.winners.length, 3)
  for (const winner of published.winners) await action(admin, 'set_prize_status', { winnerId: winner.id, version: winner.version, prizeStatus: 'issued', reason: 'Вручено приз вручну' })
  assert.ok((await admin.load()).winners.every(winner => winner.prizeStatus === 'issued'))
  assert.doesNotMatch(engineSource, /from ['"][^'"]*(?:supabase|payment)|\bfetch\s*\(|process\.env|SERVICE_ROLE|access_token|refresh_token/)
})
