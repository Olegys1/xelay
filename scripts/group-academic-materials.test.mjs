// Academic archive checks use synthetic rows and a local query stub only.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const plain = value => JSON.parse(JSON.stringify(value))
function fixture({ rows = {}, teacherMaterials = [], renderStates = [] } = {}) {
  const modules = new Map(), queries = [], reads = [], writes = []
  let stateIndex = 0
  const jsx = (type, props) => ({ type, props: props || {} })
  const react = { useState: initial => [stateIndex < renderStates.length ? renderStates[stateIndex++] : (stateIndex++, typeof initial === 'function' ? initial() : initial), () => {}],
    useRef: initial => ({ current: initial }), useMemo: fn => fn(), useCallback: fn => fn,
    useEffect: () => {}, useId: () => 'academic-test', lazy: () => 'LazyPreview', Suspense: 'Suspense' }
  const supabase = { from(table) {
    const query = { table, filters: [] }; queries.push(query)
    const chain = { select() { return chain }, eq(key, value) { query.filters.push(['eq', key, value]); return chain },
      order() { return chain }, limit() { return chain }, gt(key, value) { query.filters.push(['gt', key, value]); return chain },
      gte(key, value) { query.filters.push(['gte', key, value]); return chain }, lte(key, value) { query.filters.push(['lte', key, value]); return chain },
      then(resolve) { return Promise.resolve({ data: (rows[table] || []).filter(row => query.filters.every(([operation, key, value]) => operation === 'eq' ? row[key] === value : operation === 'gt' ? row[key] > value : operation === 'gte' ? row[key] >= value : row[key] <= value)).sort((a, b) => a.id.localeCompare(b.id)), error: null }).then(resolve) } }
    return chain
  }, rpc() { writes.push('rpc'); throw new Error('No live writes allowed') } }
  const teaching = { mode: 'supabase', async groupMaterials(groupId) { reads.push(groupId); return { subjects: [], materials: teacherMaterials } } }
  function load(file) {
    const filename = resolve(root, file)
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    const result = ts.transpileModule(readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } })
    vm.runInNewContext(result.outputText, { module, exports: module.exports, console, structuredClone, crypto, Date, URL, Blob, File, AbortController, DOMException,
      setTimeout, clearTimeout, window: {}, document: {}, fetch() { throw new Error('No network allowed') },
      require(name) {
        if (name === 'react') return react
        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
        if (name === 'lucide-react') return new Proxy({}, { get: (_, name) => String(name) })
        if (name.endsWith('/supabase') || name === './supabase') return { supabase }
        if (name.endsWith('/teaching') || name === './teaching') return { supabaseTeachingRepository: teaching }
        if (name.endsWith('/ToastContext')) return { useToast: () => ({ notify: () => {} }) }
        if (name.startsWith('./teaching/')) return new Proxy({}, { get: (_, name) => String(name) })
        if (name.startsWith('.')) return load(resolve(dirname(filename), name + (/\.(?:ts|tsx)$/.test(name) ? '' : '.ts')))
        throw new Error('Unexpected dependency ' + name)
      } }, { filename })
    return module.exports
  }
  function render(component, props) {
    stateIndex = 0
    let tree = component(props)
    if (typeof tree.type === 'function') tree = tree.type(tree.props)
    return tree
  }
  return { load, queries, reads, writes, teaching, render }
}

test('academic year boundaries include September and next August exactly', () => {
  const api = fixture().load('src/lib/studyGroupAcademicYears.ts')
  assert.deepEqual(plain(api.groupAcademicYearRange(2025)), { from: '2025-09-01', until: '2026-08-31' })
  assert.equal(api.groupAcademicYearForDate('2026-08-31'), 2025)
  assert.equal(api.groupAcademicYearForDate('2026-09-01'), 2026)
  for (const date of ['2025-09-01', '2026-01-01', '2026-08-31']) assert.equal(api.groupAcademicDateInYear(date, 2025), true)
  for (const date of ['2025-08-31', '2026-09-01']) assert.equal(api.groupAcademicDateInYear(date, 2025), false)
})

test('invalid and unknown dates never fall into a selected year and remain discoverable in all years', () => {
  const api = fixture().load('src/lib/studyGroupAcademicYears.ts')
  for (const date of ['', 'unknown', '2026-02-29', '2026-04-31', '2026-09-01T12:00:00Z']) {
    assert.equal(api.groupAcademicYearForDate(date), null)
    assert.equal(api.groupAcademicDateInYear(date, 2026), false)
    assert.equal(api.groupAcademicDateInYear(date, null), true)
    assert.equal(api.groupAcademicDateInYear(date), true)
  }
  assert.equal(api.groupAcademicDateInYear('2024-02-29', 2023), true)
  assert.equal(api.groupAcademicDateInYear('2024-02-29', 2024), false)
  assert.throws(() => api.groupAcademicYearRange(Number.NaN), /навчальний рік/)
  assert.throws(() => api.groupAcademicYearRange(2026.5), /навчальний рік/)
})

const group = 'academic-group', subject = 'academic-subject'
const material = (id, date) => ({ id, group_id: group, subject_id: subject, title: id, material_date: date, body: '', links: [], attachments: [] })
const teacherMaterial = (id, date) => ({ id, group_id: group, subject_id: subject, subject_name: 'Економіка', course_title: 'Економіка', title: id, body: '', material_date: date,
  published_at: date ? date + 'T10:00:00Z' : null, created_by: 'teacher', source: 'teacher', read_only: true, targets: [{ group_id: group }] })

test('selected-year material reads stay group scoped and apply date bounds before pagination', async () => {
  const fx = fixture({ rows: { study_group_material_subjects: [{ id: subject, group_id: group, name: 'Економіка' }],
    study_group_materials: [material('a', '2025-10-05'), material('b', '2026-10-05'), { ...material('c', '2025-12-12'), group_id: 'foreign-group' }] },
    teacherMaterials: [teacherMaterial('old-teacher', '2025-09-01'), teacherMaterial('new-teacher', '2026-09-01'), teacherMaterial('unknown-teacher', '')] })
  const result = await fx.load('src/lib/studyGroupMaterials.ts').loadStudyGroupMaterials(group, () => true, fx.teaching, 2025)
  assert.deepEqual(plain(result.materials.map(item => item.id)), ['a', 'teacher:old-teacher'])
  const requests = fx.queries.filter(query => query.table === 'study_group_materials')
  assert.equal(requests.length, 2)
  for (const query of requests) {
    assert.ok(query.filters.some(filter => filter.join('|') === 'eq|group_id|academic-group'))
    assert.ok(query.filters.some(filter => filter.join('|') === 'gte|material_date|2025-09-01'))
    assert.ok(query.filters.some(filter => filter.join('|') === 'lte|material_date|2026-08-31'))
  }
  assert.equal(fx.writes.length, 0)
})

test('all-years material reads preserve undated rows without assigning a current year', async () => {
  const fx = fixture({ rows: { study_group_material_subjects: [], study_group_materials: [material('unknown', ''), material('old', '2025-09-01')] },
    teacherMaterials: [teacherMaterial('unknown-teacher', '')] })
  const result = await fx.load('src/lib/studyGroupMaterials.ts').loadStudyGroupMaterials(group, () => true, fx.teaching, null)
  assert.deepEqual(plain(result.materials.map(item => item.id)), ['old', 'unknown', 'teacher:unknown-teacher'])
  assert.ok(fx.queries.every(query => !query.filters.some(([operation]) => operation === 'gte' || operation === 'lte')))
  assert.equal(fx.writes.length, 0)
})

test('local teaching projection filters years identically to the live read adapter', async () => {
  const fx = fixture({ teacherMaterials: [teacherMaterial('old', '2025-10-01'), teacherMaterial('new', '2026-10-01')] })
  fx.teaching.mode = 'local'
  const result = await fx.load('src/lib/studyGroupMaterials.ts').loadStudyGroupMaterials(group, () => true, fx.teaching, 2025)
  assert.deepEqual(plain(result.materials.map(item => item.id)), ['teacher:old'])
  assert.equal(fx.queries.length, 0)
})

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.props?.children)
}
test('presentation archive rendering hides write actions for an author/moderator while preserving resources', () => {
  const item = { id: 'presentation', group_id: group, created_by: 'author', author_name: 'Автор', subject: 'Економіка', title: 'Стара презентація', lesson_date: '2025-10-01', description: '', links: [],
    attachments: [{ path: 'test.pdf', file_name: 'Тема.pdf', mime_type: 'application/pdf', file_size: 100 }], created_at: '2025-10-01T10:00:00Z', version: 1 }
  // The first five states represent fetched rows, subjects, moderator right and a completed load.
  const fx = fixture({ renderStates: [[item], ['Економіка'], true, false, ''] })
  const component = fx.load('src/components/GroupStudentPresentations.tsx').GroupStudentPresentations
  const archive = textOf(fx.render(component, { groupId: group, currentUserId: 'author', academicYearStart: 2025, archiveReadOnly: true }))
  assert.match(archive, /Стара презентація/)
  assert.match(archive, /Переглянути/)
  assert.match(archive, /Завантажити/)
  assert.doesNotMatch(archive, /Поділитися презентацією|Видалити|Оновити свою презентацію/)
  const current = textOf(fx.render(component, { groupId: group, currentUserId: 'author', academicYearStart: 2025, archiveReadOnly: false }))
  assert.match(current, /Поділитися презентацією/)
  assert.match(current, /Видалити/)
  const otherYear = textOf(fx.render(component, { groupId: group, currentUserId: 'author', academicYearStart: 2026, archiveReadOnly: true }))
  assert.doesNotMatch(otherYear, /Стара презентація/)
  assert.equal(fx.writes.length, 0)
})
