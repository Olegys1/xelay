import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../../src/components/teaching/TeachingTestBuilder.tsx', import.meta.url), 'utf8')
const nodes = value => value == null || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : ''
const question = (id, prompt = 'Existing teacher question') => ({ id, kind: 'choice', text: prompt, points: 1, time_limit_seconds: 30, partial_credit: false, options: [{ id: 'a', text: prompt ? 'A' : '' }, { id: 'b', text: prompt ? 'B' : '' }], buckets: [], answer: 'a' })
function setup(initialQuestions, hasAttempts = false) {
  const cells = [], calls = []; let cursor = 0
  const react = { useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial; return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }] }, useRef(initial) { const index = cursor++; return cells[index] ||= { current: initial } },
    useEffect(callback) { const index = cursor++; if (!(index in cells)) cells[index] = { cleanup: callback() } } }
  const jsx = (type, props) => ({ type, props })
  const imports = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '../../lib/teaching': { localDeadline: value => value, kyivDeadline: value => value }, '../../lib/teachingTests': { teachingTestError: error => error.message },
    '../../lib/studyGroupVisibility': { isStudyGroupListed: () => true }, './TeachingAudienceFields': { TeachingAudienceFields: 'Audience' },
    './TeachingGradingRulesEditor': { TeachingWorkTypeField: 'WorkType' }, './TeachingUI': { TeachingButton: 'Button', TeachingField: 'Field', TeachingModal: 'Modal', teachingInput: 'input' },
    './TeachingQuestionEditor': { newTeachingQuestion: () => question('blank', ''), questionValidationMessage: () => null, TeachingQuestionEditor: 'Question', TEST_QUESTION_LABELS: {} },
    './TeachingQuestionBank': { TeachingQuestionBank: 'Bank' }, './TeachingQuestionImportPanel': { TeachingQuestionImportPanel: 'Importer' },
    './TeachingTestIntegritySettings': { TeachingTestIntegritySettings: 'IntegritySettings' }, './teaching-tests.css': {}, './teaching-assessment-phase1.css': {} }
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, Date, Set, Error, crypto: globalThis.crypto, require: name => { assert.ok(Object.hasOwn(imports, name), name); return imports[name] } })
  const props = { initial: { id: 'test', title: 'Draft', course_id: 'course', opens_at: '2026-11-04T10:00', closes_at: '2026-11-05T10:00', journal_date: '2026-11-04', work_type: 'Тест', max_points: 20,
    questions: initialQuestions, targets: [{ group_id: 'group', audience_mode: 'all', subgroup_ids: [] }], overrides: [], has_attempts: hasAttempts },
    snapshot: { course: { id: 'course', title: 'Course', permissions: ['assignments', 'grades'], grading_rules: { categories: [] } }, groups: [{ group_id: 'group', status: 'accepted', group_name: 'Demo' }], entries: [] },
    repository: { mutate: async (...args) => { calls.push(args); return {} } }, teachingRepository: {}, userId: 'teacher', onClose() {}, onSaved() {} }
  const render = () => { cursor = 0; return module.exports.TeachingTestBuilder(props) }
  return { render, calls }
}
function open(run) { const tree = run.render(), button = nodes(tree).find(node => node.type === 'Button' && /Імпортувати запитання з файлу/.test(text(node))); assert.ok(button); button.props.onClick(); return nodes(run.render()).find(node => node.type === 'Importer') }

test('direct import retains teacher questions, drops blank placeholder and changes only draft until separate save', async () => {
  const run = setup([question('old'), question('blank', '')]), importer = open(run)
  assert.equal(importer.props.destination, 'test')
  assert.equal(run.calls.length, 0)
  importer.props.onConfirm([question('new', 'Imported question')])
  const tree = run.render(), questions = nodes(tree).filter(node => node.type === 'Question')
  assert.deepEqual(questions.map(node => node.props.question.id), ['old', 'new'])
  assert.equal(run.calls.length, 0)
  nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0][0], 'save_test')
  assert.equal(run.calls[0][1].status, 'draft')
  assert.equal(run.calls[0][1].questions.length, 2)
})

test('over-capacity and locked tests refuse direct import without overwriting teacher content', () => {
  const full = setup(Array.from({ length: 100 }, (_, i) => question(`q${i}`))), importer = open(full)
  assert.throws(() => importer.props.onConfirm([question('overflow')]), /100/)
  assert.equal(nodes(full.render()).filter(node => node.type === 'Question').length, 100)
  assert.equal(full.calls.length, 0)
  const locked = setup([question('old')], true), lockedImporter = open(locked)
  assert.throws(() => lockedImporter.props.onConfirm([question('new')]), /не можна змінити/)
  assert.equal(locked.calls.length, 0)
})

test('duplicate, rename and import into a selected variant without changing the primary question set', async () => {
  const run = setup([question('old')])
  const copy = nodes(run.render()).find(node => node.type === 'Button' && text(node) === 'Копіювати варіант')
  copy.props.onClick()
  const variantTree = run.render()
  const copied = nodes(variantTree).find(node => node.type === 'Question').props.question
  assert.notEqual(copied.id, 'old')
  assert.equal(copied.text, 'Existing teacher question')
  const title = nodes(variantTree).find(node => node.type === 'Field' && node.props.label === 'Назва варіанта')
  title.props.children.props.onChange({ target: { value: 'Інший набір' } })
  open(run).props.onConfirm([question('second', 'New variant question')])
  const tree = run.render()
  const draw = nodes(tree).find(node => node.type === 'Field' && node.props.label === 'Випадково видати запитань кожному студенту')
  draw.props.children.props.onChange({ target: { value: '1' } })
  nodes(run.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await Promise.resolve(); await Promise.resolve()
  const payload = run.calls[0][1]
  assert.deepEqual(payload.questions.map(item => item.id), ['old'])
  assert.equal(payload.variants[0].title, 'Інший набір')
  assert.deepEqual(Array.from(payload.variants[0].questions, item => item.id), [copied.id, 'second'])
})
