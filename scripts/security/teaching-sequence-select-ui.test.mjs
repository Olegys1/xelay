import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
const label = node => text(node).replace(/\s+/g, ' ').trim()
const jsx = (type, props) => ({ type, props: props || {} })
const hooks = { useRef: value => ({ current: value }), useState: value => [value, () => {}] }
const ui = { TeachingButton: 'TeachingButton', TeachingField: 'TeachingField', teachingInput: 'input' }
function evaluate(path, imports, suffix = '') {
  const module = { exports: {} }
  const source = ts.transpileModule(read(path) + suffix, { fileName: path, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  runInNewContext(source, { module, exports: module.exports, crypto: { randomUUID }, structuredClone, console,
    require: name => { assert.ok(name in imports, 'Known import ' + name); return imports[name] } })
  return module.exports
}
const question = {
  id: 'subset', kind: 'sequence_select', text: 'Оберіть три елементи.', points: 3, partial_credit: true, time_limit_seconds: null,
  options: ['a','b','c','d','e'].map(id => ({ id, text: 'Елемент ' + id })), buckets: [], selection_count: 3, answer: ['b','d','a'],
}
const baseImports = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, name) => String(name) }), './TeachingUI': ui }

test('the author explicitly selects the ordered subset and an imported missing key stays unset', () => {
  const editor = evaluate('src/components/teaching/TeachingQuestionEditor.tsx', { ...baseImports,
    './TeachingRubrics': { TeachingRubricEditor: 'TeachingRubricEditor' },
    './TeachingTestQuestionImages': { TeachingTestQuestionImageEditor: 'TeachingTestQuestionImageEditor' },
    './TeachingTestRichField': { TeachingTestRichField: 'TeachingTestRichField' },
  })
  assert.equal(editor.questionValidationMessage(question), null)
  assert.match(editor.questionValidationMessage({ ...question, answer: ['b','d'] }), /правильний порядок/)
  assert.match(editor.questionValidationMessage({ ...question, selection_count: 5 }), /зайвий/)
  let change
  const tree = editor.TeachingQuestionEditor({ question: { ...question, answer: undefined }, onChange: value => { change = value } })
  const keyBoxes = nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox' && /Варіант/.test(node.props['aria-label'] || ''))
  assert.equal(keyBoxes.length, 5)
  assert.ok(keyBoxes.every(node => node.props.checked === false))
  keyBoxes[1].props.onChange({ target: { checked: true } })
  assert.deepEqual(plain(change.answer), ['b'])
  nodes(tree).find(node => node.type === 'TeachingButton' && label(node) === 'Додати елемент').props.onClick()
  assert.equal(change.answer, undefined)
  const booleanTree = editor.TeachingQuestionEditor({ question: { ...question, kind: 'boolean', options: [{ id: 'true', text: 'Так' }, { id: 'false', text: 'Ні' }], answer: undefined }, onChange() {} })
  const keySelect = nodes(booleanTree).filter(node => node.type === 'select')[1]
  assert.equal(keySelect.props.value, '')
  const withPhotos = { ...question, kind: 'choice', answer: undefined, options: question.options.map((option, i) => i === 0 ? { ...option, images: [{ id: 'photo', url: '/photo' }] } : option) }
  const photoTree = editor.TeachingQuestionEditor({ question: withPhotos, onChange: value => { change = value } })
  nodes(photoTree).find(node => node.type === 'select').props.onChange({ target: { value: 'multiple' } })
  assert.deepEqual(plain(change.options), plain(withPhotos.options))
  assert.equal(change.answer, undefined)
  nodes(tree).find(node => node.type === 'select').props.onChange({ target: { value: 'sequence' } })
  assert.deepEqual(plain(change.options), plain(question.options))
  assert.equal(change.answer, undefined)
  nodes(photoTree).find(node => node.type === 'select').props.onChange({ target: { value: 'essay' } })
  assert.deepEqual(plain(change.options), [])
  nodes(photoTree).find(node => node.type === 'select').props.onChange({ target: { value: 'sequence_select' } })
  const converted = { ...withPhotos, ...change, answer: ['b','d','a'] }
  assert.match(editor.questionValidationMessage(converted), /Фото у варіантах/)
  const convertedTree = editor.TeachingQuestionEditor({ question: converted, onChange: value => { change = value } })
  nodes(convertedTree).find(node => node.type === 'TeachingButton' && label(node) === 'Прибрати фото з елемента').props.onClick()
  assert.equal(change.options[0].images, undefined)
  assert.equal('images' in plain(change.options[0]), false)
  assert.equal(editor.questionValidationMessage({ ...converted, ...change }), null)
})

test('student selection supports adding, ordering, returning and incomplete autosaves without revealing the key', () => {
  const student = evaluate('src/components/teaching/TeachingTestRunner.tsx', { ...baseImports,
    '../../lib/teaching': {}, '../../lib/teachingTests': {}, '../../lib/teachingTestPractice': {},
    './TeachingRubrics': {}, './TeachingTestQuestionImages': {}, './TeachingTestContent': { TeachingTestContent: 'TeachingTestContent' },
    './useTeachingTestTabGuard': {}, './teaching-tests.css': {}, './teaching-assessment-phase1.css': {},
  }, '\nexport { QuestionAnswer };')
  let answer = []
  const shown = { ...question, answer: undefined }
  const render = (disabled = false) => student.QuestionAnswer({ question: shown, answer, disabled, allowExternalLinks: false, onChange: next => { answer = plain(next) } })
  const add = id => nodes(render()).find(node => node.type === 'TeachingButton' && label(node) === 'Додати Елемент ' + id).props.onClick()
  add('b'); add('a'); add('d')
  assert.deepEqual(answer, ['b','a','d'])
  assert.ok(nodes(render()).filter(node => node.type === 'TeachingButton').every(node => node.props.disabled))
  nodes(render()).find(node => node.props['aria-label'] === 'Елемент 3 вище').props.onClick()
  assert.deepEqual(answer, ['b','d','a'])
  nodes(render()).find(node => node.props['aria-label'] === 'Прибрати елемент 2').props.onClick()
  assert.deepEqual(answer, ['b','a'])
  const before = [...answer]
  nodes(render(true)).find(node => node.props['aria-label'] === 'Прибрати елемент 1').props.onClick()
  assert.deepEqual(answer, before)
  assert.doesNotMatch(text(render()), /Правильна відповідь/)
})

test('practice saves and resumes partial selections with the same scoring as the server', async () => {
  const { createTeachingTestPracticeRepository } = evaluate('src/lib/teachingTestPractice.ts', {})
  const values = new Map()
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const definition = { id: 'practice-subset', course_id: 'course', version: 1, title: 'Subset', questions: [question], duration_seconds: 1200, max_points: 3,
    allow_skip: true, allow_return: true, question_timer_policy: 'continue', targets: [{ group_id: 'group' }] }
  const make = () => createTeachingTestPracticeRepository(definition, 'teacher', 'group', storage)
  const repository = make()
  let detail = await repository.mutate('start', { id: definition.id, expected_user_id: 'teacher', group_id: 'group' })
  const id = detail.attempt.id
  const options = plain(detail.attempt.current_question.options)
  assert.equal(detail.attempt.current_question.answer, undefined)
  assert.equal(detail.attempt.current_question.selection_count, 3)
  for (const invalid of [['b','b'], ['foreign'], ['b','d','a','e']]) {
    await assert.rejects(repository.mutate('save_answer', { id: definition.id, expected_user_id: 'teacher', question_id: question.id, version: detail.attempt.version, answer: invalid }), /TEST_INVALID_INPUT/)
  }
  detail = await repository.mutate('save_answer', { id: definition.id, expected_user_id: 'teacher', question_id: question.id, version: detail.attempt.version, answer: ['b'] })
  const restored = make()
  const resumed = await restored.detail(definition.id)
  assert.equal(resumed.attempt.id, id)
  assert.deepEqual(plain(resumed.attempt.current_question.options), options)
  detail = await restored.mutate('finish', { id: definition.id, expected_user_id: 'teacher', version: detail.attempt.version })
  assert.equal(detail.attempt.practice_score, 1)
})
