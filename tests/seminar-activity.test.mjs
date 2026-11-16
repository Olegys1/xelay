import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8')
function load(name, dependencies = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(read(name), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date, Intl, AbortController, DOMException,
    require: key => { assert.ok(key in dependencies, 'Unexpected dependency ' + key); return dependencies[key] },
  })
  return module.exports
}
const api = load('src/lib/seminarActivity.ts')
const now = new Date('2026-11-16T10:00:00Z') // Kyiv12:00
const range = { from: '2026-11-10', to: '2026-11-20' }
const member = (id = 'one', extra = {}) => ({ id, name: id, groupId: 'g', accepted: true, ...extra })
const lesson = (id = 'past', extra = {}) => ({ id, subjectId: 's', groupId: 'g', date: '2026-11-12', startsAt: '09:00:00', title: id, ...extra })
const reservation = (id = 'r', extra = {}) => ({ id, groupId: 'g', userId: 'one', seminarId: 'past', role: 'primary', ...extra })
const data = extra => ({ groupId: 'g', members: [member(), member('two')], subjects: [{ id: 's', name: 'Subject', groupId: 'g' }], lessons: [lesson()], reservations: [reservation()], ...extra })
const plain = value => JSON.parse(JSON.stringify(value))

test('Kyiv date is independent of local timezone; midnight, DST and rolling periods are exact', () => {
  assert.equal(api.activityKyivClock(new Date('2026-11-15T22:30:00Z')).date, '2026-11-16')
  assert.equal(api.activityKyivClock(new Date('2026-07-15T21:30:00Z')).date, '2026-07-16')
  assert.deepEqual(plain(api.activityRange('7', now)), { from: '2026-11-10', to: '2026-11-16' })
  assert.deepEqual(plain(api.activityRange('30', now)), { from: '2026-10-18', to: '2026-11-16' })
  assert.deepEqual(plain(api.activityRange('semester', now)), { from: '2026-09-01', to: '2026-11-16' })
  assert.deepEqual(plain(api.activityRange('semester', new Date('2026-01-20T10:00:00Z'))), { from: '2025-09-01', to: '2026-01-20' })
  assert.equal(api.activityRange('semester', new Date('2026-08-31T10:00:00Z')).from, '2026-02-01')
})
test('invalid and excessive date ranges fail visibly rather than producing a partial count', () => {
  for (const date of ['2026-02-30', '2026-13-01', '2026-1-01', '<script>']) assert.equal(api.validActivityDate(date), false)
  for (const value of [{ from: '2026-11-20', to: '2026-11-10' }, { from: '2026-01-01', to: '2026-12-31' }, { from: '', to: '' }]) assert.throws(() => api.validateActivityRange(value))
  assert.throws(() => api.activityKyivClock(new Date('bad')))
})
test('count is from lesson date, not reservation creation date; cancelled and duplicate entries do not inflate it', () => {
  const rows = api.buildSeminarActivity(data({
    lessons: [lesson(), lesson('cancelled', { cancelled: true }), lesson('old', { date: '2026-10-31' })],
    reservations: [reservation(), reservation('duplicate'), reservation('supplement', { role: 'supplement' }), reservation('cancel', { cancelled: true }), reservation('old', { seminarId: 'old', createdAt: '2026-11-16' }), reservation('cancelledLesson', { seminarId: 'cancelled' })],
  }), range, '', now)
  assert.equal(rows[0].counts.primary, 1)
  assert.equal(rows[0].counts.supplement, 1)
  assert.equal(api.individualActivityCount(rows[0].counts), 2)
  assert.equal(rows[0].entries.length, 2)
  assert.equal(rows[1].counts.primary, 0, 'Zero-activity accepted classmates remain visible')
})
test('teams and bookings are independent of individual answers; planned lessons stay separate until start', () => {
  const rows = api.buildSeminarActivity(data({ lessons: [lesson(), lesson('future', { date: '2026-11-17' }), lesson('todayLater', { date: '2026-11-16', startsAt: '12:01:00' }), lesson('todayNow', { date: '2026-11-16', startsAt: '12:00:00' })],
    reservations: [reservation('team', { role: 'team' }), reservation('booking', { role: 'booking' }), reservation('future', { seminarId: 'future' }), reservation('later', { seminarId: 'todayLater' }), reservation('atStart', { seminarId: 'todayNow' })],
  }), range, '', now)
  assert.deepEqual(plain(rows[0].counts), { primary: 1, supplement: 0, team: 1, booking: 1, planned: 2 })
  assert.equal(api.individualActivityCount(rows[0].counts), 1)
})
test('outsiders, pending members, other groups and missing subjects never enter the group result', () => {
  const rows = api.buildSeminarActivity(data({ members: [member(), member('pending', { accepted: false }), member('foreign', { groupId: 'other' })],
    lessons: [lesson(), lesson('foreign', { groupId: 'other' }), lesson('unknown', { subjectId: 'not-found' })],
    reservations: [reservation(), reservation('pending', { userId: 'pending' }), reservation('outsider', { userId: 'notMember' }), reservation('foreign', { groupId: 'other' }), reservation('foreignLesson', { seminarId: 'foreign' }), reservation('unknown', { seminarId: 'unknown' })],
  }), range, '', now)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].entries.length, 1)
})
test('subject filter and inherited-looking identifiers cannot alter another subject or object prototype', () => {
  const rows = api.buildSeminarActivity(data({ subjects: [{ id: '__proto__', name: '<img onerror=alert(1)>', groupId: 'g' }], lessons: [lesson('p', { subjectId: '__proto__' })], reservations: [reservation('p', { seminarId: 'p' })] }), range, '__proto__', now)
  assert.equal(rows[0].subjects.__proto__.primary, 1)
  assert.equal({}.primary, undefined)
  assert.equal(api.buildSeminarActivity(data(), range, 'other-subject', now)[0].entries.length, 0)
})

function loaderFixture(options = {}) {
  const queries = [], access = [], profileReads = []
  const source = { study_groups: { id: 'g', representative_id: 'one' }, study_group_members: [{ user_id: 'two', group_id: 'g', status: 'accepted' }], study_group_seminar_subjects: [{ id: 's', group_id: 'g', name: 'Subject' }], study_group_seminars: [{ id: 'past', group_id: 'g', subject_id: 's', lesson_date: '2026-11-12', starts_at: '09:00:00', title: 'Past' }], study_group_seminar_reservations: [{ id: 'r', group_id: 'g', user_id: 'one', seminar_id: 'past', role: 'primary' }], ...options.tables }
  const supabase = {
    rpc(name, args) { access.push([name, args]); const result = { data: options.revokedAt === access.length ? false : options.authorized !== false, error: null }; return { abortSignal: () => Promise.resolve(result) } },
    from(table) { const query = {}; for (const method of ['select', 'eq', 'order', 'limit', 'abortSignal', 'gte', 'lte', 'in']) query[method] = (...args) => { queries.push([table, method, ...args]); return query }; const result = () => ({ data: source[table], error: options.errorTable === table ? { message: 'error' } : null }); query.single = () => Promise.resolve(result()); query.then = resolve => Promise.resolve(result()).then(resolve); return query },
  }
  const loader = load('src/lib/seminarActivityData.ts', { './supabase': { supabase }, './profiles': { getPublicProfiles: async ids => { profileReads.push(ids); return { data: ids.map(id => ({ id, full_name: id })), error: null } } }, './seminarActivity': api })
  return { ...loader, queries, access, profileReads }
}
test('live reader enforces membership before and after, scopes every table to group and reads no grades', async () => {
  const fx = loaderFixture(), result = await fx.loadSeminarActivityData('g', range)
  assert.equal(fx.access.length, 2)
  assert.ok(fx.access.every(([name, args]) => name === 'xelay_can_view_seminars' && args.p_group_id === 'g'))
  assert.equal(result.members.length, 2)
  assert.ok(fx.queries.filter(([, method]) => method === 'select').every(([, , columns]) => !/grade|email|password|score/i.test(columns)))
  for (const table of ['study_group_members', 'study_group_seminar_subjects', 'study_group_seminars', 'study_group_seminar_reservations']) assert.ok(fx.queries.some(([t, m, key, value]) => t === table && m === 'eq' && key === 'group_id' && value === 'g'))
})
test('unauthorized, revoked, cross-group and truncated result sets fail closed', async () => {
  const denied = loaderFixture({ authorized: false }); await assert.rejects(denied.loadSeminarActivityData('g', range)); assert.equal(denied.queries.length, 0)
  await assert.rejects(loaderFixture({ revokedAt: 2 }).loadSeminarActivityData('g', range))
  await assert.rejects(loaderFixture({ tables: { study_group_seminars: [{ id: 'foreign', group_id: 'other' }] } }).loadSeminarActivityData('g', range))
  await assert.rejects(loaderFixture({ tables: { study_group_seminar_reservations: Array.from({ length: 1000 }, () => ({ id: 'r', group_id: 'g' })) } }).loadSeminarActivityData('g', range))
  const invalid = loaderFixture(); await assert.rejects(invalid.loadSeminarActivityData('g', { from: '', to: '' })); assert.equal(invalid.access.length, 0)
})
test('preview fixture is synthetic, complete and disconnected from production loader', () => {
  const fixtureApi = load('src/lib/seminarActivityFixture.ts', { './seminarActivity': api }), fixture = fixtureApi.createSeminarActivityFixture(now)
  assert.equal(fixture.members.length, 30)
  assert.equal(fixture.subjects.length, 3)
  assert.ok(fixture.reservations.some(row => row.role === 'team'))
  assert.ok(!read('src/lib/seminarActivityData.ts').includes('createSeminarActivityFixture'))
  assert.ok(!read('src/components/SeminarActivityPanel.tsx').includes('dangerouslySetInnerHTML'))
  assert.ok(read('src/components/seminarActivity.css').includes('prefers-reduced-motion'))
})
