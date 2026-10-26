import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import { readFile } from 'node:fs/promises'

const source = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
async function execute(path, dependencies) {
  const exports = {}
  const code = ts.transpileModule(await source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { exports, require: name => {
    if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const noProvider = { supabase: { rpc() { throw new Error('Provider use is not allowed in pure recurrence tests') } } }
const copyTimes = await execute('src/lib/scheduleCopyTimes.ts', {})
const timetable = await execute('src/lib/studyGroupTimetable.ts', { './supabase': noProvider, './scheduleCopyTimes': copyTimes })
const subjects = await execute('src/lib/scheduleSubjects.ts', {})
const seminarDependencies = {
  './supabase': noProvider, './profiles': { getPublicProfiles: async () => ({ data: [], error: null }) },
  './seminarResources': { getSeminarAttachments: value => value || [], getSeminarLinks: value => value || [] },
  './studyGroupTimetable': timetable, './scheduleSubjects': subjects,
}
const seminars = await execute('src/lib/seminars.ts', seminarDependencies)
const plain = value => JSON.parse(JSON.stringify(value))
const slot = (overrides = {}) => ({
  id: 'auto', group_id: 'group', subject_id: 'economics', weekday: 4, starts_at: '09:40:00', ends_at: '11:00:00',
  valid_from: '2026-10-01', valid_until: '2026-12-31', created_by: 'owner', source_schedule_id: 'main-lesson',
  source_managed: true, source_active: true, week_pattern: 'every', week_anchor_date: null, excluded_dates: [], ...overrides,
})
const assignment = (overrides = {}) => ({
  id: 'existing-assignment', group_id: 'group', subject_id: 'economics', schedule_id: 'auto', lesson_date: '2026-10-22',
  starts_at: '09:40:00', ends_at: '11:00:00', title: 'Existing manually entered questions', instructions: 'Keep this content',
  format: 'questions', created_by: 'owner', resource_links: ['https://example.test/existing'], resource_attachments: [], ...overrides,
})
const subjectRows = [{ id: 'economics', group_id: 'group', name: 'Економічна теорія', created_by: 'owner' }]

test('automatic seminar occurrences obey actual dates, parity, one-off bounds and date exclusions', () => {
  const upper = slot({ week_pattern: 'upper', week_anchor_date: '2026-10-19' })
  assert.equal(seminars.scheduleOnDate(upper, '2026-10-22'), true)
  assert.equal(seminars.scheduleOnDate(upper, '2026-10-29'), false)
  assert.equal(seminars.scheduleOnDate(slot({ week_pattern: 'lower', week_anchor_date: '2026-10-19' }), '2026-10-29'), true)
  assert.equal(seminars.scheduleOnDate(slot({ excluded_dates: ['2026-10-22'] }), '2026-10-22'), false)
  assert.equal(seminars.scheduleOnDate(slot({ source_active: false }), '2026-10-22'), false)
  assert.equal(seminars.scheduleOnDate(slot({ source_schedule_id: null, source_active: false }), '2026-10-22'), false)
  assert.equal(seminars.scheduleOnDate(slot({ valid_from: '2026-10-22', valid_until: '2026-10-22' }), '2026-10-22'), true)
  assert.equal(seminars.scheduleOnDate(slot({ valid_from: '2026-10-22', valid_until: '2026-10-22' }), '2026-10-29'), false)
  assert.equal(seminars.scheduleOnDate(upper, '2026-10-23'), false)
})

test('legacy manual recurrence behavior remains valid without source metadata', () => {
  const manual = slot({ source_managed: false, source_schedule_id: null, valid_from: '-infinity', valid_until: 'infinity' })
  assert.equal(seminars.scheduleOnDate(manual, '2026-10-22'), true)
  assert.equal(seminars.scheduleOnDate(manual, '2026-10-29'), true)
})

test('cancelled, moved or detached sources retain dated assignments and never create empty calendar placeholders', () => {
  for (const source of [slot({ source_active: false }), slot({ source_schedule_id: null, source_active: false }), slot({ excluded_dates: ['2026-10-22'] }), slot({ weekday: 5 })]) {
    const existing = assignment()
    const before = plain(existing)
    assert.deepEqual(plain(seminars.seminarSlotsOnDate([source], [], subjectRows, '2026-10-22')), [])
    assert.equal(seminars.seminarSlotsOnDate([source], [existing], subjectRows, '2026-10-22')[0].id, 'auto')
    assert.deepEqual(plain(existing), before)
    assert.equal(seminars.seminarSlotsOnDate([source], [existing], subjectRows, '2026-10-23').length,
      seminars.scheduleOnDate(source, '2026-10-23') ? 1 : 0)
  }
})

test('automatic placeholders do not duplicate equivalent manual slots; all dated manual assignments remain visible', () => {
  const manual = slot({ id: 'manual', source_managed: false, source_schedule_id: null, subject_id: 'legacy-subject' })
  const names = [...subjectRows, { ...subjectRows[0], id: 'legacy-subject', name: '  ЕКОНОМІЧНА   ТЕОРІЯ ' }]
  assert.deepEqual(plain(seminars.seminarSlotsOnDate([slot(), manual], [], names, '2026-10-22')).map(item => item.id), ['manual'])
  const existingAuto = assignment()
  const existingManual = assignment({ id: 'manual-assignment', schedule_id: 'manual', subject_id: 'legacy-subject' })
  assert.equal(seminars.seminarSlotsOnDate([slot(), manual], [existingAuto, existingManual], names, '2026-10-22').length, 2)
  assert.equal(seminars.seminarSlotsOnDate([slot(), slot({ id: 'second-auto' })], [], names, '2026-10-22').length, 1)
})

test('subject and source metadata are loaded while the postponed homework text import stays absent', async () => {
  const selections = []
  const supabase = {
    from(table) {
      const q = { select: selection => { selections.push([table, selection]); return q }, eq: () => q, order: () => q,
        single: async () => { assert.equal(table, 'study_groups'); return { data: { supplement_capacity: 2 }, error: null } },
        then: resolve => Promise.resolve({ data: table === 'study_group_seminar_subjects' ? [{ ...subjectRows[0], has_schedule_sources: true }]
          : table === 'study_group_seminar_schedule' ? [slot()] : [], error: null }).then(resolve) }
      return q
    }, rpc: async () => ({ data: 0, error: null }),
  }
  const module = await execute('src/lib/seminars.ts', { ...seminarDependencies, './supabase': { supabase } })
  const result = await module.loadSeminars('group', '2026-10-22')
  assert.equal(result.subjects[0].has_schedule_sources, true)
  assert.equal(result.schedule[0].source_schedule_id, 'main-lesson')
  assert.equal(result.seminars.length, 0)
  assert.ok(!selections.some(([table]) => table === 'study_group_homework'))
})

test('materials retain existing subjects and receive the source management flag without creating topics', async () => {
  const rows = [{ id: 'a', group_id: 'group', name: 'Економічна теорія', has_schedule_sources: true }, { id: 'b', group_id: 'group', name: 'Власний предмет' }]
  const supabase = { from(table) {
    let after = ''
    const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, gt: (_column, value) => { after = value; return q },
      then: resolve => Promise.resolve({ data: table === 'study_group_material_subjects' ? rows.filter(row => row.id > after) : [], error: null }).then(resolve) }
    return q
  } }
  const module = await execute('src/lib/studyGroupMaterials.ts', { './supabase': { supabase }, './studyGroupMaterialFiles': {
    getMaterialAttachments: value => value || [], getMaterialLinks: value => value || [],
  }, './teaching': { supabaseTeachingRepository: { groupMaterials: async () => ({ subjects: [], materials: [] }) } } })
  const result = await module.loadStudyGroupMaterials('group')
  assert.equal(result.subjects.find(row => row.id === 'a').has_schedule_sources, true)
  assert.equal(result.subjects.find(row => row.id === 'b').has_schedule_sources, false)
  assert.deepEqual(plain(result.materials), [])
  assert.match(module.materialError({ message: 'MATERIAL_SUBJECT_SOURCE_MANAGED' }), /Розклад і ДЗ/)
})

test('automatic source editing points back to the timetable while manual creation controls remain', async () => {
  const seminarUI = await source('src/components/GroupSeminars.tsx')
  const materialUI = await source('src/components/GroupMaterials.tsx')
  assert.match(seminarUI, /Змінити у розкладі/)
  assert.match(seminarUI, /Додати заняття вручну/)
  assert.match(seminarUI, /has_schedule_sources/)
  assert.match(materialUI, /has_schedule_sources/)
  assert.match(materialUI, /Предмети з розкладу й опубліковані матеріали викладачів додаються автоматично/)
  assert.match(seminarUI, /maxLength=\{180\} value=\{subjectEditor.name\}/)
})

test('the actual teacher editor permits existing dated work after source retirement without allowing new invalid dates or scopes', async () => {
  const path = 'src/components/teaching/TeachingClassroomSeminarsPanel.tsx'
  const text = await source(path)
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let initializer
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'validDate') initializer = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(initializer, 'The actual editor must retain its date validation')
  const compiled = ts.transpileModule(`(context) => {
    const { slot, date, snapshot, data, scheduleId, id, initial, groupId, scheduleOnDate } = context;
    return ${initializer.getText(file)};
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const validate = vm.runInNewContext(compiled)
  const initial = assignment()
  const scope = {
    slot: slot({ source_active: false }), date: initial.lesson_date,
    snapshot: { course: { starts_on: '2026-10-01', ends_on: '2026-12-31' } },
    data: { subject_id: 'economics', seminars: [initial] },
    scheduleId: initial.schedule_id, id: initial.id, initial, groupId: initial.group_id,
    scheduleOnDate: seminars.scheduleOnDate,
  }
  assert.equal(validate(scope), true, 'Existing work remains editable on a retired source')
  assert.equal(validate({ ...scope, slot: slot({ excluded_dates: [initial.lesson_date] }) }), true)
  assert.equal(validate({ ...scope, slot: slot({ weekday: 5 }) }), true, 'Moving the template must not move existing work')
  assert.equal(validate({ ...scope, slot: undefined }), true, 'A template moved outside the course may be absent from its schedule response')
  assert.equal(validate({ ...scope, initial: null }), false, 'A new seminar cannot use a retired date')
  assert.equal(validate({ ...scope, date: '2026-10-29' }), false, 'Changing an old seminar date still requires active recurrence')
  assert.equal(validate({ ...scope, scheduleId: 'other' }), false)
  assert.equal(validate({ ...scope, id: 'other' }), false)
  assert.equal(validate({ ...scope, initial: { ...initial, group_id: 'other' } }), false)
  assert.equal(validate({ ...scope, initial: { ...initial, subject_id: 'other' } }), false)
  assert.equal(validate({ ...scope, data: { ...scope.data, seminars: [...scope.data.seminars, { ...initial, id: 'duplicate' }] } }), false)
  assert.equal(validate({ ...scope, snapshot: { course: { starts_on: '2026-11-01', ends_on: '2026-12-31' } } }), false)
  assert.equal(validate({ ...scope, initial: null, slot: slot() }), true, 'New seminars on actual active occurrences remain supported')
  assert.equal(validate({ ...scope, initial: null, slot: slot({ group_id: 'other' }) }), false)
  assert.equal(validate({ ...scope, initial: null, slot: slot({ subject_id: 'other' }) }), false)
})
