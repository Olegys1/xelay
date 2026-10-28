import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const uri = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const modelUrl = uri(compile(await read('src/lib/homeDashboardModel.ts')))
const modules = {
  './supabase': uri('export const supabase={from:(...args)=>globalThis.__homeLiveTest.from(...args)};'),
  './profiles': uri('export const getMemberCount=(...args)=>globalThis.__homeLiveTest.getMemberCount(...args);export const getPublicProfiles=(...args)=>globalThis.__homeLiveTest.getPublicProfiles(...args);'),
  '../translations/categories': uri('export const categoryLabel=value=>value;'),
  './homeDashboardRepository': uri('export const loadLearningHomeDashboard=(...args)=>globalThis.__homeLiveTest.loadLearning(...args);export const loadHomeTeachingSummary=(...args)=>globalThis.__homeLiveTest.loadSummary(...args);'),
  './homeTeacherDashboardRepository': uri('export const loadTeacherHomeDashboard=(...args)=>globalThis.__homeLiveTest.loadTeacher(...args);'),
  './homeDashboardModel': modelUrl,
}
let source = compile(await read('src/lib/homeDashboardLive.ts'))
for (const [path, replacement] of Object.entries(modules)) source = source.split(`'${path}'`).join(JSON.stringify(replacement)).split(`"${path}"`).join(JSON.stringify(replacement))
const { emptyLiveHome, loadLiveHome } = await import(uri(source))
const { selectHomeDashboard } = await import(modelUrl)

const id = n => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const actor = id(1), groupId = id(2), teacherGroupId = id(3), courseId = id(4), university = id(5), faculty = id(6)
const profile = { id: actor, userId: actor, name: 'Test Person', isTeacher: false, isClassRepresentative: false, universityId: university, academicUnitId: faculty }
const group = { id: groupId, name: 'Academic group', program: 'Program', studyYear: 1, academicYear: '2026/2027', status: 'accepted', learning: true, teachingSubjectIds: [], gradingSubjectIds: [], permissions: [] }
const learningSlice = patch => ({ groups: [], lessons: [], tasks: [], updates: [], publications: [], isHeadman: false, pendingInvitations: 0, warnings: [], summary: null, ...patch })
const teacherSlice = patch => ({ groups: [], lessons: [], tasks: [], updates: [], publications: [], teachingVerified: true, reviewCountsAvailable: true, warnings: [], ...patch })

function fixture(t, patch = {}) {
  const calls = []
  const tables = patch.tables || { questions: [], news_posts: [] }
  const fx = {
    calls,
    from(table) {
      const filters = [], orders = []
      let columns = '', cap = Infinity, signal
      const query = {
        select(value) { columns = value; return query },
        eq(key, value) { filters.push(['eq', key, value]); return query },
        is(key, value) { filters.push(['is', key, value]); return query },
        order(key, options) { orders.push([key, options?.ascending !== false]); return query },
        limit(value) { cap = value; return query },
        abortSignal(value) { signal = value; return query },
        then(resolve, reject) {
          calls.push({ kind: 'table', table, filters, orders, columns, signal })
          if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError')).then(resolve, reject)
          if (patch.failedTable === table) return Promise.resolve({ data: null, error: { code: 'synthetic_failure' } }).then(resolve, reject)
          let rows = structuredClone(tables[table] || []).filter(row => filters.every(([, key, value]) => row[key] === value))
          for (const [key, ascending] of [...orders].reverse()) rows.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1))
          rows = rows.slice(0, cap)
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
        },
      }
      return query
    },
    async getMemberCount() { calls.push({ kind: 'memberCount' }); return patch.memberResult || { data: 172, error: null } },
    async getPublicProfiles(ids) { calls.push({ kind: 'profiles', ids }); return { data: (patch.authors || []).filter(row => ids.includes(row.id)), error: null } },
    async loadSummary(groupIds, signal) { calls.push({ kind: 'summary', groupIds, signal }); if (patch.summaryError) throw new Error('Summary unavailable'); return patch.summary || { assignments: [], teacher_reviews: [] } },
    async loadLearning(input) { calls.push({ kind: 'learning', input }); return patch.learningRead ? patch.learningRead(input) : learningSlice(patch.learning) },
    async loadTeacher(input) { calls.push({ kind: 'teacher', input }); return teacherSlice(patch.teacher) },
  }
  globalThis.__homeLiveTest = fx
  t.after(() => { delete globalThis.__homeLiveTest })
  return fx
}
const load = (value = profile, signal = new AbortController().signal) => loadLiveHome(value, value.id, signal)

test('empty production state contains no fabricated students, work, grades or publication statuses', () => {
  const result = emptyLiveHome(profile)
  assert.equal(result.status, 'loading')
  for (const field of ['groups', 'lessons', 'tasks', 'updates', 'publications', 'community', 'news']) assert.deepEqual(result[field], [])
  assert.equal(result.displayName, profile.name)
  assert.equal(result.teachingVerified, false)
  assert.equal(result.reviewCountsAvailable, undefined)
})

test('student, headman and verified teacher use actual child scopes and the same authenticated summary', async t => {
  await t.test('student', async t => {
    const fx = fixture(t, { learning: { groups: [group] } })
    const result = await load()
    assert.equal(result.role, 'student')
    assert.deepEqual(result.contexts, ['learning'])
    assert.equal(result.groups[0].id, groupId)
    assert.equal(result.preferredGroupId, groupId)
    assert.equal(fx.calls.some(row => row.kind === 'teacher'), false)
    assert.equal(fx.calls.filter(row => row.kind === 'summary').length, 1)
    assert.equal(fx.calls.find(row => row.kind === 'learning').input.userId, actor)
  })
  await t.test('headman', async t => {
    fixture(t, { learning: { groups: [{ ...group, permissions: ['homework', 'members'] }], isHeadman: true } })
    const result = await load({ ...profile, isClassRepresentative: true })
    assert.equal(result.role, 'headman')
    assert.deepEqual(result.contexts, ['learning'])
    assert.equal(selectHomeDashboard(result).canManage, true)
  })
  await t.test('teacher', async t => {
    const fx = fixture(t, { teacher: { groups: [{ ...group, id: teacherGroupId, learning: false, teachingSubjectIds: [courseId], gradingSubjectIds: [courseId], permissions: ['assignments', 'grades'] }] } })
    const result = await load({ ...profile, isTeacher: true })
    assert.equal(result.role, 'teacher')
    assert.deepEqual(result.contexts, ['teaching'])
    assert.equal(result.groups[0].id, teacherGroupId)
    assert.equal(result.groups[0].learning, false)
    const summary = fx.calls.find(row => row.kind === 'learning').input.summary
    assert.equal(fx.calls.find(row => row.kind === 'teacher').input.summary, summary)
    assert.equal(fx.calls.filter(row => row.kind === 'summary').length, 1)
  })
})

test('dual student/teacher composition never unions teaching material rights into learning management', async t => {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const lesson = { id: 'student-row', groupId, subjectId: 'schedule:slot', subject: 'Mathematics', date, startsAt: '08:00', endsAt: '09:20', type: 'Лекція', href: `/groups/${groupId}` }
  fixture(t, { learning: { groups: [group], lessons: [lesson] }, teacher: { groups: [{ ...group, learning: false, teachingSubjectIds: [courseId], permissions: ['materials'] }], lessons: [{ ...lesson, id: 'teacher-row', subjectId: courseId }] } })
  const result = await load({ ...profile, isTeacher: true })
  assert.deepEqual(result.contexts, ['learning', 'teaching'])
  assert.equal(result.groups.length, 1)
  assert.deepEqual(result.groups[0].permissions, [])
  assert.deepEqual(result.groups[0].learningPermissions, [])
  assert.deepEqual(result.groups[0].teachingPermissions, ['materials'])
  assert.deepEqual(result.lessons.map(row => row.context), ['learning', 'teaching'])
  const studentView = selectHomeDashboard(result, { context: 'learning' })
  const teacherView = selectHomeDashboard(result, { context: 'teaching' })
  assert.equal(studentView.canManage, false)
  assert.deepEqual(studentView.quickActions, [])
  assert.deepEqual(studentView.lessons.map(row => row.id), ['student-row'])
  assert.deepEqual(teacherView.lessons.map(row => row.id), ['teacher-row'])
  assert.equal(teacherView.quickActions.some(row => row.kind === 'materials'), true)
})

test('unknown own work state and reply counts stay unknown instead of becoming zero or unsubmitted', async t => {
  const fx = fixture(t, { tables: { questions: [{ id: id(20), user_id: id(21), title: 'A real question', category: 'IT', author_name: 'Real author', created_at: '2026-10-28T08:00:00Z' }], news_posts: [] } })
  const result = await load()
  assert.deepEqual(result.tasks, [])
  assert.deepEqual(result.updates, [])
  assert.equal(result.community[0].replies, undefined)
  assert.equal(result.community[0].author, 'Real author')
  assert.equal(result.participantCount, 172)
  assert.equal(fx.calls.find(row => row.kind === 'table' && row.table === 'questions').signal.aborted, false)
})

test('real nonzero and zero answer counts remain exact, and no authored profile is invented', async t => {
  fixture(t, { authors: [{ id: id(21), full_name: 'Actual public author' }], tables: { questions: [
    { id: id(20), user_id: id(21), title: 'Seven replies', category: 'IT', answers_count: 7, created_at: '2026-10-28T09:00:00Z' },
    { id: id(22), user_id: id(23), title: 'Zero replies', category: 'IT', answers_count: 0, created_at: '2026-10-28T08:00:00Z' },
  ], news_posts: [] } })
  const result = await load()
  assert.deepEqual(result.community.map(row => row.replies), [7, 0])
  assert.equal(result.community[0].author, 'Actual public author')
  assert.equal(result.community[1].author, 'Учасник спільноти')
})

test('actor mismatch is rejected before any query or child loader', async t => {
  const fx = fixture(t)
  await assert.rejects(loadLiveHome(profile, id(90), new AbortController().signal), /HOME_ACTOR_CHANGED/)
  assert.deepEqual(fx.calls, [])
})

test('unavailable summary produces explicit partial state, preserves published updates and never claims completed work', async t => {
  t.mock.method(console, 'warn', () => undefined)
  const update = { id: 'published-task', groupId, audience: 'learning', kind: 'material', title: 'Known published assignment', description: 'State unavailable', createdAt: new Date().toISOString(), href: `/groups/${groupId}` }
  const fx = fixture(t, { summaryError: true, learning: { groups: [group], updates: [update] }, teacher: { reviewCountsAvailable: false, warnings: ['Queue unavailable'] } })
  const result = await load({ ...profile, isTeacher: true })
  assert.equal(result.status, 'ready')
  assert.equal(typeof result.partialMessage, 'string')
  assert.ok(result.partialMessage.length > 0)
  assert.deepEqual(result.tasks, [])
  assert.deepEqual(result.updates, [update])
  assert.equal(result.reviewCountsAvailable, false)
  assert.equal(fx.calls.find(row => row.kind === 'learning').input.summary, null)
  assert.equal(fx.calls.find(row => row.kind === 'teacher').input.summary, null)
})

test('public news reads only published platform/faculty scopes and uses Kyiv publication day', async t => {
  const base = { status: 'published', title: 'News', excerpt: 'Actual excerpt', is_pinned: false, published_at: '2026-10-27T23:30:00Z' }
  const fx = fixture(t, { tables: { questions: [], news_posts: [
    { ...base, id: id(30), university_id: null, academic_unit_id: null },
    { ...base, id: id(31), university_id: university, academic_unit_id: faculty },
    { ...base, id: id(32), university_id: university, academic_unit_id: id(99) },
    { ...base, id: id(33), university_id: id(98), academic_unit_id: faculty },
    { ...base, id: id(34), university_id: university, academic_unit_id: faculty, status: 'draft' },
  ] } })
  const result = await load()
  assert.deepEqual(result.news.map(row => [row.id, row.kind, row.date]), [[id(30), 'platform', '2026-10-28'], [id(31), 'faculty', '2026-10-28']])
  const queries = fx.calls.filter(row => row.kind === 'table' && row.table === 'news_posts')
  assert.equal(queries.length, 2)
  assert.ok(queries.every(row => row.filters.some(([kind, key, value]) => kind === 'eq' && key === 'status' && value === 'published')))
  assert.ok(queries.some(row => row.filters.some(([kind, key, value]) => kind === 'eq' && key === 'academic_unit_id' && value === faculty)
    && row.filters.some(([kind, key, value]) => kind === 'eq' && key === 'university_id' && value === university)))
})

test('failed public scope becomes partial without replacing authorized work with fixtures', async t => {
  fixture(t, { failedTable: 'news_posts', learning: { groups: [group] }, memberResult: { data: null, error: true } })
  const result = await load()
  assert.equal(result.groups[0].id, groupId)
  assert.deepEqual(result.news, [])
  assert.equal(result.participantCount, 0)
  assert.equal(typeof result.partialMessage, 'string')
})

test('an abort during private child reads discards the composite result', async t => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  fixture(t, { learningRead: () => pending })
  const controller = new AbortController()
  const request = load(profile, controller.signal)
  for (let i = 0; i < 12; i++) await Promise.resolve()
  controller.abort()
  finish(learningSlice({ groups: [group] }))
  await assert.rejects(request, { name: 'AbortError' })
})
