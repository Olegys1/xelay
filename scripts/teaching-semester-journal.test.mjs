// Feature regression checks with fictional teaching data; no provider or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
const root = fileURLToPath(new URL('../', import.meta.url)), native = createRequire(import.meta.url)
const plain = value => JSON.parse(JSON.stringify(value))
function fixture() {
  const modules = new Map(), storage = new Map(), events = new EventTarget(), downloads = []
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-27T10:00:00Z'])) } static now() { return Date.parse('2026-10-27T10:00:00Z') } }
  const xlsx = { utils: { book_new: () => ({ sheets: {} }), aoa_to_sheet: rows => ({ rows }), book_append_sheet: (book, sheet, name) => { book.sheets[name] = sheet }, encode_range: () => 'A1:D20' }, writeFileXLSX: (book, name) => downloads.push({ book, name }) }
  Object.assign(events, { setTimeout, clearTimeout, setInterval, clearInterval })
  function load(path) {
    const filename = resolve(root, path)
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    const code = ts.transpileModule(readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    vm.runInNewContext(code, { module, exports: module.exports, structuredClone, crypto, Date: ClockDate, URL, Blob, File, AbortController, DOMException, TextEncoder, TextDecoder,
      setTimeout, clearTimeout, setInterval, clearInterval, window: events,
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
      fetch() { throw new Error('Provider traffic is disabled') },
      require(name) {
        if (name.endsWith('/supabase') || name === './supabase') return { supabase: new Proxy({}, { get() { throw new Error('Provider traffic is disabled') } }) }
        if (name === 'xlsx') return xlsx
        if (name.startsWith('.')) return load(resolve(dirname(filename), name + (name.endsWith('.ts') || name.endsWith('.tsx') ? '' : '.ts')))
        return native(name)
      },
    }, { filename })
    return module.exports
  }
  const api = load('src/lib/localTeachingRepository.ts'), helper = load('src/lib/teachingSemesterJournal.ts')
  const owner = api.createLocalTeachingRepository('teacher'), head = api.createLocalTeachingRepository('head'), colleague = api.createLocalTeachingRepository('colleague')
  return { api, helper, owner, head, colleague, load, downloads }
}

test('published statement sorting respects group coefficients, keeps zero distinct from missing and excludes drafts', async () => {
  const fx = fixture(), workspace = await fx.owner.workspace(), source = workspace.courses.find(course => course.owner_id === fx.api.LOCAL_TEACHING_IDENTITIES.teacher.userId)
  const snapshot = await fx.owner.course(source.id), group = snapshot.groups[0], secondGroup = snapshot.groups[1]
  const entry = snapshot.entries.find(item => item.group_id === group.group_id && item.user_id === fx.api.LOCAL_TEACHING_IDENTITIES.student.userId)
  const [blank, other] = snapshot.entries.filter(item => item.group_id === group.group_id && item.id !== entry.id)
  group.grading_rules_override = { categories: [{ id: 'seminars', name: 'Seminars', coefficient: 2, max_points: 7 }], total_max: 100 }
  snapshot.grades.push({ id: 'zero', entry_id: blank.id, activity_id: snapshot.activities.find(activity => activity.group_id === group.group_id).id, published_score: 0, published_comment: '', published_at: '2026-10-27T10:00:00Z', version: 1 })
  snapshot.grades = snapshot.grades.filter(grade => grade.entry_id !== other.id)
  const rows = fx.helper.teachingStatementRows(snapshot, group.group_id, 'total_desc')
  assert.equal(rows.find(row => row.entry.id === entry.id).total, 7, 'Published4×2 is capped7; draft5 and unpublished8 are not counted')
  assert.equal(rows.find(row => row.entry.id === blank.id).total, 0)
  assert.equal(rows.at(-1).entry.id, other.id)
  assert.equal(rows.at(-1).total, null)
  assert.ok(rows.every(row => row.entry.group_id !== secondGroup.group_id))
  const ascending = fx.helper.teachingStatementRows(snapshot, group.group_id, 'total_asc')
  assert.equal(ascending[0].total, 0); assert.equal(ascending.at(-1).total, null)
  assert.equal(rows.find(row => row.entry.id === entry.id).pendingDrafts, 2)
})

test('statement rows never expose another subject or a student account peer list', async () => {
  const fx = fixture(), workspace = await fx.owner.workspace(), source = workspace.courses[0], snapshot = await fx.owner.course(source.id), group = snapshot.groups[0]
  snapshot.entries.push({ ...snapshot.entries[0], id: 'foreign-entry', course_id: 'foreign-course' })
  assert.ok(!fx.helper.teachingStatementRows(snapshot, group.group_id).some(row => row.entry.id === 'foreign-entry'))
  snapshot.course.permissions = ['materials']
  assert.deepEqual(plain(fx.helper.teachingStatementRows(snapshot, group.group_id)), [])
})

test('semester boundaries are inclusive and previous/upcoming/all lists do not mutate courses', async () => {
  const fx = fixture(), workspace = await fx.owner.workspace(), course = workspace.courses[0], original = plain(workspace.courses)
  assert.equal(fx.helper.teachingSemesterPeriod(course, course.starts_on), 'current')
  assert.equal(fx.helper.teachingSemesterPeriod(course, course.ends_on), 'current')
  assert.equal(fx.helper.teachingSemesterPeriod(course, '2027-01-01'), 'previous')
  assert.equal(fx.helper.teachingSemesterPeriod(course, '2026-08-31'), 'upcoming')
  assert.equal(fx.helper.teachingSemesterPeriod({ ...course, archived_at: '2026-10-01T00:00Z' }, '2026-10-27'), 'previous')
  assert.equal(fx.helper.nextTeachingSemester({ ends_on: '2026-12-31' }).starts_on, '2027-02-01')
  assert.equal(fx.helper.nextTeachingSemester({ ends_on: '2026-06-30' }).starts_on, '2026-09-01')
  assert.ok(fx.helper.teachingSemesters(workspace.courses, 'all', '2026-10-27').length)
  assert.deepEqual(plain(workspace.courses), original)
})

test('Excel statement uses exactly the displayed published totals and selected order, with safe text cells', async () => {
  const fx = fixture(), workspace = await fx.owner.workspace(), snapshot = await fx.owner.course(workspace.courses[0].id), group = snapshot.groups[0]
  snapshot.entries[0].full_name = '=HYPERLINK("https://invalid.test")'
  const rows = fx.helper.teachingStatementRows(snapshot, group.group_id, 'total_desc')
  await fx.load('src/lib/teachingJournalWorkbook.ts').exportTeachingJournalWorkbook(snapshot, group.group_id, () => true, { sort: 'total_desc', statement: true })
  const download = fx.downloads[0], sheet = download.book.sheets['Для відомості'].rows
  assert.match(download.name, /відомість/)
  assert.deepEqual(plain(sheet.slice(1).map(row => row[2])), plain(rows.map(row => row.total)))
  assert.equal(sheet[1][1], "'" + rows[0].entry.full_name)
  assert.ok(!JSON.stringify(download.book).includes('Чернетка перевірки'))
})

test('dedicated archive preview retains previous homework, material, submission and published grade', async () => {
  const fx = fixture(), before = await fx.owner.workspace(), currentId = before.courses[0].id, current = await fx.owner.course(currentId)
  fx.api.enableLocalTeachingSemesterPreview(); fx.api.enableLocalTeachingSemesterPreview()
  const next = await fx.owner.workspace(), previous = next.courses.filter(course => course.archived_at)
  assert.equal(previous.length, 1, 'The fixture is idempotent')
  const archived = await fx.owner.course(previous[0].id)
  assert.equal(archived.assignments.length, 1); assert.equal(archived.materials.length, 1)
  assert.equal(archived.grades[0].published_score, 36)
  const classroom = await fx.owner.classroom(archived.assignments[0].id, archived.groups[0].group_id)
  assert.equal(classroom.submissions[0].published_score, 36)
  assert.equal(classroom.can_review, false)
  assert.deepEqual(plain(await fx.owner.course(currentId)), plain(current), 'Adding another semester preserves all original records')
})

test('only the author can cancel an unchanged pending request; accepted/rejected requests stay intact', async () => {
  const fx = fixture(); fx.api.enableLocalTeachingSemesterPreview()
  const requests = (await fx.owner.workspace()).sent_group_requests
  const pending = requests.find(item => item.status === 'pending_group'), accepted = requests.find(item => item.status === 'accepted'), rejected = requests.find(item => item.status === 'rejected')
  assert.ok(pending.can_cancel); assert.ok(!accepted.can_cancel && !rejected.can_cancel)
  const payload = { link_id: pending.id, expected_updated_at: pending.updated_at }
  await assert.rejects(fx.head.mutate('cancel_group_invite', payload), /FORBIDDEN/)
  await assert.rejects(fx.colleague.mutate('cancel_group_invite', payload), /FORBIDDEN/)
  await assert.rejects(fx.owner.mutate('cancel_group_invite', { ...payload, expected_updated_at: '2000-01-01' }), /CONFLICT/)
  await assert.rejects(fx.owner.mutate('cancel_group_invite', { link_id: accepted.id, expected_updated_at: accepted.updated_at }), /CONFLICT/)
  await assert.rejects(fx.owner.mutate('cancel_group_invite', { link_id: rejected.id, expected_updated_at: rejected.updated_at }), /CONFLICT/)
  await fx.owner.mutate('cancel_group_invite', payload)
  assert.equal((await fx.owner.workspace()).sent_group_requests.find(item => item.id === pending.id).status, 'removed')
  await assert.rejects(fx.head.mutate('respond_group', { link_id: pending.id, accept: true }), /FORBIDDEN/)
})

test('a head response wins over a late cancellation without losing historical course data', async () => {
  const fx = fixture(); fx.api.enableLocalTeachingSemesterPreview()
  const request = (await fx.owner.workspace()).sent_group_requests.find(item => item.status === 'pending_group')
  await fx.head.mutate('respond_group', { link_id: request.id, accept: true })
  await assert.rejects(fx.owner.mutate('cancel_group_invite', { link_id: request.id, expected_updated_at: request.updated_at }), /CONFLICT/)
  const updated = (await fx.owner.workspace()).sent_group_requests.find(item => item.id === request.id)
  assert.equal(updated.status, 'accepted'); assert.equal(updated.can_cancel, false)
  assert.ok((await fx.owner.course(request.course_id)).groups.some(group => group.group_id === request.group_id && group.status === 'accepted'))
})
