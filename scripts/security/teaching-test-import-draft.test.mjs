import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../../src/components/teaching/TeachingTestBuilder.tsx', import.meta.url), 'utf8')
const nodes = value => value == null || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : ''
const question = (id, prompt = 'Existing teacher question') => ({ id, kind: 'choice', text: prompt, points: 1, time_limit_seconds: 30, partial_credit: false, options: [{ id: 'a', text: prompt ? 'A' : '' }, { id: 'b', text: prompt ? 'B' : '' }], buckets: [], answer: 'a' })
function setup(initialQuestions, hasAttempts = false, extraProps = {}, validateQuestion = () => null) {
  const cells = [], calls = [], effects = [], focusedErrors = [], scrolledErrors = []; let cursor = 0
  const react = { useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial; return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }] }, useRef(initial) { const index = cursor++; return cells[index] ||= { current: initial } },
    useEffect(callback, deps) { const index = cursor++, prior = cells[index]; if (!prior || !deps || !prior.deps || deps.length !== prior.deps.length || deps.some((value, i) => !Object.is(value, prior.deps[i]))) { const cell = { deps }; cells[index] = cell; effects.push(() => { prior?.cleanup?.(); cell.cleanup = callback() }) } } }
  const jsx = (type, props) => ({ type, props })
  const imports = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '../../lib/teaching': { localDeadline: value => value, kyivDeadline: value => value }, '../../lib/teachingTests': { teachingTestError: error => error.message },
    '../../lib/studyGroupVisibility': { isStudyGroupListed: () => true }, './TeachingAudienceFields': { TeachingAudienceFields: 'Audience' },
    './TeachingGradingRulesEditor': { TeachingWorkTypeField: 'WorkType' }, './TeachingUI': { TeachingButton: 'Button', TeachingField: 'Field', TeachingModal: 'Modal', teachingInput: 'input' },
    './TeachingQuestionEditor': { newTeachingQuestion: () => question('blank', ''), questionValidationMessage: validateQuestion, TeachingQuestionEditor: 'Question', TEST_QUESTION_LABELS: {} },
    './TeachingQuestionBank': { TeachingQuestionBank: 'Bank' }, './TeachingQuestionImportPanel': { TeachingQuestionImportPanel: 'Importer' },
    './TeachingTestIntegritySettings': { TeachingTestIntegritySettings: 'IntegritySettings' }, './teaching-tests.css': {}, './teaching-assessment-phase1.css': {} }
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, Date, Set, Error, structuredClone, crypto: globalThis.crypto, require: name => { assert.ok(Object.hasOwn(imports, name), name); return imports[name] } })
  const props = { initial: { id: 'test', title: 'Draft', course_id: 'course', opens_at: '2026-11-04T10:00', closes_at: '2026-11-05T10:00', journal_date: '2026-11-04', work_type: 'Тест', max_points: 20,
    questions: initialQuestions, targets: [{ group_id: 'group', audience_mode: 'all', subgroup_ids: [] }], overrides: [], has_attempts: hasAttempts },
    snapshot: { course: { id: 'course', title: 'Course', permissions: ['assignments', 'grades'], grading_rules: { categories: [] } }, groups: [{ group_id: 'group', status: 'accepted', group_name: 'Demo' }], entries: [] },
    repository: { mutate: async (...args) => { calls.push(args); return {} } }, teachingRepository: {}, userId: 'teacher', onClose() {}, onSaved() {}, ...extraProps }
  const render = () => { cursor = 0; const tree = module.exports.TeachingTestBuilder(props); for (const node of nodes(tree)) if (node.props?.role === 'alert' && node.props.ref) node.props.ref.current = { focus: () => focusedErrors.push(text(node)), scrollIntoView: () => scrolledErrors.push(text(node)) }; effects.splice(0).forEach(effect => effect()); return tree }
  return { render, calls, props, focusedErrors, scrolledErrors }
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
  const locked = setup([question('old')], true)
  const lockedButton = nodes(locked.render()).find(node => node.type === 'Button' && /Імпортувати запитання з файлу/.test(text(node)))
  assert.equal(lockedButton.props.disabled, true)
  lockedButton.props.onClick()
  assert.equal(nodes(locked.render()).some(node => node.type === 'Importer'), false)
  assert.equal(locked.calls.length, 0)
})

test('separate named variant import is confirmed into its captured destination and remaps colliding question IDs', async () => {
  const run = setup([question('old')])
  const field = label => nodes(run.render()).find(node => node.type === 'Field' && node.props.label === label).props.children
  field('Назва варіанта').props.onChange({ target: { value: 'Основний набір' } })
  field('Куди імпортувати запитання').props.onChange({ target: { value: 'new' } })
  field('Назва нового варіанта').props.onChange({ target: { value: 'Варіант Б із файлу' } })
  nodes(run.render()).find(node => node.type === 'Button' && /Імпортувати окремий варіант/.test(text(node))).props.onClick()
  let importer = nodes(run.render()).find(node => node.type === 'Importer')
  importer.props.onCancel()
  assert.equal(field('Редагувати варіант').props.children.length, 2)
  nodes(run.render()).find(node => node.type === 'Button' && /Імпортувати окремий варіант/.test(text(node))).props.onClick()
  importer = nodes(run.render()).find(node => node.type === 'Importer')
  importer.props.onConfirm([question('old', 'Imported variant question'), question('old', 'Another imported question')])
  const newQuestions = nodes(run.render()).filter(node => node.type === 'Question').map(node => node.props.question)
  assert.equal(newQuestions.length, 2)
  assert.equal(new Set(newQuestions.map(q => q.id)).size, 2)
  assert.ok(newQuestions.every(q => q.id !== 'old'))
  field('Куди імпортувати запитання').props.onChange({ target: { value: 'current' } })
  // A modal retains its destination even if the selection changes underneath it.
  importer = open(run)
  field('Редагувати варіант').props.onChange({ target: { value: '' } })
  importer.props.onConfirm([question('third', 'Imported third question')])
  assert.deepEqual(nodes(run.render()).filter(node => node.type === 'Question').map(node => node.props.question.id), ['old'])
  field('Випадково видати запитань кожному студенту').props.onChange({ target: { value: '1' } })
  nodes(run.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await Promise.resolve(); await Promise.resolve()
  const payload = run.calls[0][1]
  assert.equal(payload.base_variant_title, 'Основний набір')
  assert.equal(payload.variants.length, 1)
  assert.equal(payload.variants[0].title, 'Варіант Б із файлу')
  assert.equal(payload.variants[0].questions.length, 3)
  assert.equal(payload.questions.length, 1)
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

test('a retake draft copies question content into a new test only after an explicit subgroup and date selection', async () => {
  const primary = { ...question('original'), images: [{ id: 'image', mime_type: 'image/jpeg', alt: 'Графік' }] }
  const source = { id: 'closed-original', course_id: 'course', status: 'closed', title: 'Контрольна', max_points: 10, version: 7,
    questions: [primary], variants: [{ id: 'variant', title: 'Другий набір', questions: [question('alternative')] }],
    targets: [{ group_id: 'group', audience_mode: 'all', subgroup_ids: [] }], overrides: [{ user_id: 'other' }], has_attempts: true,
    opens_at: '2026-01-01T10:00', closes_at: '2026-01-01T12:00', results_finalized_at: '2026-01-01T12:00', approved_revision: 2 }
  const run = setup([], false, { initial: null, retakeFrom: source, groupId: 'group' })
  const find = (type, predicate = () => true) => nodes(run.render()).find(node => node.type === type && predicate(node))
  const submit = () => find('form').props.onSubmit({ preventDefault() {} })
  const dates = label => find('Field', node => node.props.label === label).props.children
  assert.equal(find('Modal').props.title, 'Нова перездача')
  assert.equal(find('Audience'), undefined)
  assert.equal(dates('Відкрити тест').props.value, '')
  assert.equal(dates('Закрити тест').props.value, '')
  assert.equal(run.calls.length, 0)
  submit()
  assert.equal(run.calls.length, 0)
  find('label', node => text(node) === 'Demo').props.children[0].props.onChange({ target: { checked: true } })
  assert.equal(find('Audience').props.subgroupsOnly, true)
  assert.deepEqual(Array.from(find('Audience').props.value.subgroup_ids), [])
  find('Audience').props.onChange({ group_id: 'group', audience_mode: 'all', subgroup_ids: [] })
  submit()
  assert.equal(run.calls.length, 0)
  find('Audience').props.onChange({ group_id: 'group', audience_mode: 'subgroups', subgroup_ids: ['retake-subgroup'] })
  submit()
  assert.equal(run.calls.length, 0)
  dates('Відкрити тест').props.onChange({ target: { value: '2099-01-01T10:00' } })
  dates('Закрити тест').props.onChange({ target: { value: '2099-01-01T12:00' } })
  submit()
  await Promise.resolve()
  assert.equal(run.calls.length, 1)
  const [action, draft] = run.calls[0]
  assert.equal(action, 'save_test')
  assert.equal(draft.status, 'draft')
  assert.equal(draft.version, 0)
  assert.notEqual(draft.id, source.id)
  assert.equal(draft.has_attempts, false)
  assert.equal(draft.results_finalized_at, null)
  assert.equal(draft.overrides.length, 0)
  assert.deepEqual(Array.from(draft.targets[0].subgroup_ids), ['retake-subgroup'])
  assert.equal(draft.targets[0].audience_mode, 'subgroups')
  assert.equal(draft.questions[0].images[0].id, 'image')
  assert.equal(draft.variants[0].questions[0].id, 'alternative')
  assert.equal(source.status, 'closed')
  assert.equal(source.targets[0].audience_mode, 'all')
})

test('a disabled bonus is saved as zero below the configured amount and preserves that amount when re-enabled', async () => {
  const run = setup([question('one')])
  const field = label => nodes(run.render()).find(node => node.type === 'Field' && node.props.label === label).props.children
  const submit = () => nodes(run.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  field('Хто отримує бонус').props.onChange({ target: { value: '10' } })
  field('Додаткових балів').props.onChange({ target: { value: '2' } })
  field('Хто отримує бонус').props.onChange({ target: { value: '0' } })
  field('Максимальний результат').props.onChange({ target: { value: '1' } })
  submit(); await new Promise(setImmediate)
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0][1].max_points, 1)
  assert.equal(run.calls[0][1].bonus_percent, 0)
  assert.equal(run.calls[0][1].bonus_points, 0)
  assert.equal(field('Додаткових балів').props.value, 2, 'disabling the bonus must not erase the authored amount')
  field('Максимальний результат').props.onChange({ target: { value: '5' } })
  field('Хто отримує бонус').props.onChange({ target: { value: '10' } })
  submit(); await new Promise(setImmediate)
  assert.equal(run.calls.length, 2)
  assert.equal(run.calls[1][1].bonus_points, 2)
})

test('an enabled bonus above the new maximum is explained and focused before any write', async () => {
  const run = setup([question('one')])
  const field = label => nodes(run.render()).find(node => node.type === 'Field' && node.props.label === label).props.children
  field('Хто отримує бонус').props.onChange({ target: { value: '20' } })
  field('Додаткових балів').props.onChange({ target: { value: '2' } })
  field('Максимальний результат').props.onChange({ target: { value: '1' } })
  for (let attempt = 1; attempt <= 2; attempt++) {
    nodes(run.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    const alert = nodes(run.render()).find(node => node.props?.role === 'alert')
    assert.match(text(alert), /Додаткові бали мають бути від 0 до 1/)
    assert.equal(alert.props.tabIndex, -1)
    assert.equal(run.focusedErrors.length, attempt, 'repeating the same failure still brings its message into view')
    assert.equal(run.scrolledErrors.length, attempt)
    assert.equal(run.calls.length, 0)
  }
})

test('QA drafts normalize hidden bonuses without changing other settings', async () => {
  const initial = { id: 'qa', title: 'QA', course_id: 'course', opens_at: '2026-11-04T10:00', closes_at: '2026-11-05T10:00', max_points: 1,
    questions: [question('one')], targets: [{ group_id: 'group', audience_mode: 'all', subgroup_ids: [] }], qa_own_attempt: true,
    bonus_percent: 20, bonus_points: 2, has_attempts: false, overrides: [] }
  const run = setup([], false, { initial })
  nodes(run.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await Promise.resolve()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0][1].bonus_percent, 0)
  assert.equal(run.calls[0][1].bonus_points, 0)
  assert.equal(run.calls[0][1].qa_own_attempt, true)
  assert.equal(initial.bonus_points, 2)
})

test('an invalid question in another variant selects that variant and identifies its question without saving', () => {
  const run = setup([question('one')], false, {}, value => value.answer === undefined ? 'Позначте правильну відповідь.' : null)
  const field = label => nodes(run.render()).find(node => node.type === 'Field' && node.props.label === label).props.children
  nodes(run.render()).find(node => node.type === 'Button' && text(node) === 'Копіювати варіант').props.onClick()
  field('Назва варіанта').props.onChange({ target: { value: 'Другий набір' } })
  nodes(run.render()).find(node => node.type === 'Question').props.onChange({ answer: undefined })
  field('Редагувати варіант').props.onChange({ target: { value: '' } })
  nodes(run.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const tree = run.render()
  assert.match(text(nodes(tree).find(node => node.props?.role === 'alert')), /«Другий набір», запитання 1\. Позначте правильну відповідь/)
  assert.equal(field('Назва варіанта').props.value, 'Другий набір')
  assert.equal(run.calls.length, 0)
  assert.equal(run.focusedErrors.length, 1)
})

test('native required validation reports the field and question in the visible error summary', () => {
  const run = setup([question('one')])
  const field = { getAttribute: () => 'Елемент 3', validity: { valueMissing: true }, closest: selector => selector === '.teaching-test-question-editor' ? { querySelector: () => ({ textContent: 'Запитання 2' }) } : null }
  let prevented = false
  const form = nodes(run.render()).find(node => node.type === 'form')
  form.props.onInvalid({ preventDefault() { prevented = true }, target: field, currentTarget: { querySelector: selector => { assert.equal(selector, 'input:invalid, textarea:invalid, select:invalid'); return field } } })
  const alert = nodes(run.render()).find(node => node.props?.role === 'alert')
  assert.equal(prevented, true)
  assert.match(text(alert), /«Варіант 1», запитання 2\. Заповніть поле «Елемент 3»/)
  assert.equal(run.calls.length, 0)
  assert.equal(run.focusedErrors.length, 1)
})

test('a changed repository stops a draft instead of sending it under a stale scope', () => {
  const run = setup([question('one')])
  run.render()
  run.props.repository = { mutate: async () => { throw new Error('stale save must not run') } }
  const tree = run.render()
  assert.equal(nodes(tree).find(node => node.type === 'Modal').props.title, 'Редагування призупинено')
  assert.equal(nodes(tree).some(node => node.type === 'form'), false)
  assert.equal(run.calls.length, 0)
})

test('native numeric validation explains the current maximum instead of silently preventing submission', () => {
  const run = setup([question('one')])
  const field = { getAttribute: () => 'Додаткових балів', validity: { valueMissing: false, rangeOverflow: true }, max: '1', closest: () => null }
  nodes(run.render()).find(node => node.type === 'form').props.onInvalid({ preventDefault() {}, target: field, currentTarget: { querySelector: () => field } })
  assert.match(text(nodes(run.render()).find(node => node.props?.role === 'alert')), /Перевірте поле «Додаткових балів»\. Значення має бути не більше 1\./)
  assert.equal(run.calls.length, 0)
  assert.equal(run.focusedErrors.length, 1)
})
