import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const native = createRequire(import.meta.url)
function load(relative, mocks = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, window: undefined,
    require(name) { if (mocks[name]) return mocks[name]; if (name === 'react') return { useId: () => 'deadline-test' }; if (name === 'react/jsx-runtime') return native(name); throw new Error(`Unexpected module: ${name}`) },
  })
  return module.exports
}
const deadline = load('../src/lib/teachingAssignmentDeadline.ts')
const targets = load('../src/lib/teachingMultiAssignments.ts')
const drafts = load('../src/lib/teachingPublicationDraft.ts', { './teaching': { TEACHING_MAX_FILE_BYTES: 50 * 1024 * 1024 } })
const fields = load('../src/components/teaching/TeachingAssignmentDeadlineFields.tsx', {
  './TeachingUI': { TeachingField: 'label', teachingInput: 'field' },
}).TeachingAssignmentDeadlineFields
const plain = value => JSON.parse(JSON.stringify(value))
function inputs(node) { if (!node || typeof node !== 'object') return []; return [...(node.type === 'input' ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(inputs)] }

test('opening an existing publication infers its actual deadline without clearing final closure', () => {
  assert.equal(deadline.assignmentDeadlineMode('2026-11-03T18:00'), 'fixed')
  assert.equal(deadline.assignmentDeadlineMode(''), 'free')
  const state = { deadline: '', closesAt: '2026-11-08T18:00' }
  assert.equal(deadline.assignmentDeadlineMode(state.deadline), 'free')
  assert.equal(state.closesAt, '2026-11-08T18:00')
  assert.equal(deadline.assignmentDeadlineMode('', 'fixed'), 'fixed')
})

test('explicit fixed date cannot silently publish a flexible deadline; unfinished drafts remain possible', () => {
  assert.throws(() => deadline.validateAssignmentDeadline('fixed', '', true), /дату й час/)
  assert.doesNotThrow(() => deadline.validateAssignmentDeadline('fixed', '', false))
  assert.doesNotThrow(() => deadline.validateAssignmentDeadline('free', '', true))
  assert.throws(() => deadline.validateAssignmentDeadline('free', '2026-11-03T18:00', true), /приберіть дату/)
})

test('deadline choices have separate input names and free selection changes no closing time', () => {
  let state = { mode: 'fixed', deadline: '2026-11-03T18:00', closesAt: '2026-11-08T18:00' }
  const tree = fields({ mode: state.mode, deadline: state.deadline, name: 'group-a', min: '2026-09-01T00:00',
    onMode(mode) { state = { ...state, mode, ...(mode === 'free' ? { deadline: '' } : {}) } },
    onDeadline(value) { state = { ...state, deadline: value } },
  })
  const elements = inputs(tree)
  assert.equal(elements.filter(input => input.props.type === 'radio').length, 2)
  assert.ok(elements.filter(input => input.props.type === 'radio').every(input => input.props.name === 'group-a-deadline-mode'))
  assert.equal(elements.find(input => input.props.type === 'datetime-local').props.min, '2026-09-01T00:00')
  elements.find(input => input.props.value === 'free').props.onChange()
  assert.deepEqual(state, { mode: 'free', deadline: '', closesAt: '2026-11-08T18:00' })
  assert.equal(inputs(fields({ mode: state.mode, deadline: '', onMode() {}, onDeadline() {} })).filter(input => input.props.type === 'datetime-local').length, 0)
})

test('multiple-group assignments keep independent due and final closing dates, free deadlines are null', () => {
  const first = { ...targets.emptyMultiAssignmentTarget('a'), lessonDate: '2026-11-02', deadlineMode: 'free' }
  const other = { ...targets.emptyMultiAssignmentTarget('b'), deadline: '2026-11-04T12:00', deadlineMode: 'fixed', closesAt: '2026-11-09T12:00' }
  const result = plain(targets.multiAssignmentTargets(first, [other], value => value || null))
  assert.equal(result[0].due_at, null)
  assert.equal(result[0].closes_at, null)
  assert.equal(result[1].due_at, '2026-11-04T12:00')
  assert.equal(result[1].closes_at, '2026-11-09T12:00')
  assert.equal(targets.validMultiAssignmentTargets([{ ...other, deadlineMode: 'unlimited-by-server' }]), false)
})

test('recovered editor draft retains an explicit empty fixed-date choice and rejects invalid mode', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const value = { version: 1, source_version: 2, editor_id: '11111111-1111-4111-8111-111111111111', pending_file_names: [], fields: {
    selectedGroup: 'a', title: 'Робота', body: '', links: [''], linkTitles: [''], attachments: [], deadline: '', deadlineMode: 'fixed',
    assessed: false, maxPoints: '10', category: '', closesAt: '2026-11-09T12:00',
  } }
  assert.equal(drafts.writeTeachingPublicationDraft('key', value, storage), true)
  assert.equal(drafts.readTeachingPublicationDraft('key', 2, storage).fields.deadlineMode, 'fixed')
  assert.equal(drafts.readTeachingPublicationDraft('key', 2, storage).fields.closesAt, '2026-11-09T12:00')
  value.fields.deadlineMode = 'invalid'
  drafts.writeTeachingPublicationDraft('key', value, storage)
  assert.equal(drafts.readTeachingPublicationDraft('key', 2, storage), null)
})

test('student labels distinguish a flexible deadline from an actual due date', () => {
  assert.equal(deadline.assignmentDeadlineLabel(null, value => value), 'Вільний термін здачі')
  assert.equal(deadline.assignmentDeadlineLabel('2026-11-03', value => value), 'Здати до 2026-11-03')
})
