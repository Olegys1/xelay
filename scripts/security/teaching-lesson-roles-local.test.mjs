// Execute the real local repository across fictional teacher accounts. No network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url)), native = createRequire(import.meta.url)
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const plain = value => JSON.parse(JSON.stringify(value))
function fixture() {
  const modules = new Map(), storage = new Map()
  function load(path) {
    const filename = resolve(root, path)
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    const code = ts.transpileModule(readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInNewContext(code, { module, exports: module.exports, structuredClone, crypto: { randomUUID }, Date, URL, Blob, File, AbortController, DOMException, TextEncoder, TextDecoder, setTimeout, clearTimeout,
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
      window: { addEventListener() {}, removeEventListener() {} }, fetch() { throw Error('Local role test cannot use a network') },
      require(name) {
        if (name.endsWith('/supabase') || name === './supabase') return { supabase: new Proxy({}, { get() { throw Error('No live Supabase traffic allowed') } }) }
        if (name.startsWith('.')) return load(resolve(dirname(filename), name + (name.endsWith('.ts') ? '' : '.ts')))
        return native(name)
      },
    }, { filename })
    return module.exports
  }
  return { load }
}

test('roles survive reload, stay personal and preserve original grades and the student schedule', async () => {
  const fx = fixture(), api = fx.load('src/lib/localTeachingRepository.ts')
  api.resetLocalTeachingPreview()
  const teacher = api.createLocalTeachingRepository('teacher'), colleague = api.createLocalTeachingRepository('colleague')
  const student = api.createLocalTeachingRepository('student'), course = id(21), group = id(11)
  const before = plain(await teacher.course(course)), studentBefore = plain(await student.group(group)), scheduleBefore = plain(api.localTeachingTimetable(group))
  const initial = await teacher.teacherCalendar('2026-11-05', '2026-11-06')
  assert.equal(initial.teaching_roles.length, 2)
  assert.ok(initial.teaching_roles.every(role => role.version === 0))
  const saved = await teacher.saveLessonRole(course, group, ['lecture'], 0, id(1))
  assert.equal(saved.version, 1)
  await colleague.saveLessonRole(course, group, ['seminar'], 0, id(4))
  const own = await api.createLocalTeachingRepository('teacher').teacherCalendar('2026-11-05', '2026-11-06')
  assert.deepEqual(plain(own.lessons.filter(row => row.group_id === group && row.assigned_to_me).map(row => row.lesson_type)), ['lecture'])
  assert.equal(own.lessons.find(row => row.group_id === group && row.lesson_type === 'lecture').assignment_source, 'role')
  const other = await colleague.teacherCalendar('2026-11-05', '2026-11-06')
  assert.deepEqual(plain(other.lessons.filter(row => row.assigned_to_me).map(row => row.lesson_type)), ['seminar'])
  assert.ok(!other.teaching_roles.some(role => role.group_id === id(12)), 'A colleague cannot discover the second group through role configuration')
  const future = await teacher.teacherCalendar('2026-11-12', '2026-11-13')
  assert.equal(future.lessons.filter(row => row.group_id === group && row.assigned_to_me).length, 1, 'Recurring future lessons follow the saved role')
  assert.ok(!future.lessons.some(row => row.group_id === id(12) && row.assigned_to_me), 'A role applies to exactly one group')
  const after = plain(await teacher.course(course))
  assert.deepEqual(after.grades, before.grades)
  assert.deepEqual(after.activities, before.activities)
  assert.deepEqual(after.course.permissions, before.course.permissions)
  assert.deepEqual(plain(await student.group(group)), studentBefore)
  assert.deepEqual(plain(api.localTeachingTimetable(group)), scheduleBefore)
})

test('manual include/exclude overrides a saved type and survives role changes', async () => {
  const fx = fixture(), api = fx.load('src/lib/localTeachingRepository.ts')
  api.resetLocalTeachingPreview()
  const repo = api.createLocalTeachingRepository('teacher'), course = id(21), group = id(11)
  await repo.saveLessonRole(course, group, ['lecture'], 0, id(1))
  await repo.setCalendarLesson(course, group, id(171), 'timetable', false)
  await repo.setCalendarLesson(course, group, id(172), 'timetable', true)
  let data = await repo.teacherCalendar('2026-11-05', '2026-11-05')
  assert.deepEqual(plain(data.lessons.map(row => [row.lesson_type, row.assigned_to_me, row.assignment_source])), [['lecture', false, 'manual'], ['seminar', true, 'manual']])
  await repo.saveLessonRole(course, group, ['lecture', 'seminar'], 1, id(1))
  data = await repo.teacherCalendar('2026-11-12', '2026-11-12')
  assert.deepEqual(plain(data.lessons.map(row => row.assigned_to_me)), [false, true])
  await repo.saveLessonRole(course, group, [], 2, id(1))
  assert.equal((await repo.teacherCalendar('2026-11-12', '2026-11-12')).lessons.filter(row => row.assigned_to_me).length, 1)
})

test('invalid types, stale versions, another account and a foreign group cannot save roles', async () => {
  const fx = fixture(), api = fx.load('src/lib/localTeachingRepository.ts')
  api.resetLocalTeachingPreview()
  const owner = api.createLocalTeachingRepository('teacher'), colleague = api.createLocalTeachingRepository('colleague'), student = api.createLocalTeachingRepository('student')
  const course = id(21), group = id(11)
  for (const types of [['lecture', 'lecture'], ['admin'], [null], null, 'lecture']) await assert.rejects(owner.saveLessonRole(course, group, types, 0, id(1)), /ROLE_INVALID/)
  await assert.rejects(owner.saveLessonRole(course, group, ['lecture'], 0, id(4)), /ACTOR_CHANGED/)
  await assert.rejects(colleague.saveLessonRole(course, id(12), ['lecture'], 0, id(4)), /FORBIDDEN/)
  await assert.rejects(student.saveLessonRole(course, group, ['lecture'], 0, id(2)), /FORBIDDEN/)
  await owner.saveLessonRole(course, group, ['lecture'], 0, id(1))
  await assert.rejects(owner.saveLessonRole(course, group, ['seminar'], 0, id(1)), /CONFLICT/)
  await assert.rejects(owner.setCalendarLesson(course, group, id(999), 'timetable', true), /LESSON_INVALID/)
  assert.equal((await owner.teacherCalendar('2026-11-07', '2026-11-07')).teaching_roles.length, 2, 'Roles remain editable during a week without lessons')
})
