import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
function load(path, imports, globals = {}) { const module = { exports: {} }; runInNewContext(ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { module, exports: module.exports, Set, Map, Math, Intl, Date, Number, JSON, Error, URLSearchParams, structuredClone, AbortController, crypto: { randomUUID }, ...globals, require(name) { assert.ok(name in imports, 'Known dependency ' + name); return imports[name] } }); return module.exports }
const presentation = load('src/lib/teacherLearningPresentation.ts', {})
const status = { userId: 'owner-a', audience: 'teacher', planId: 'teacher_plus', canGenerate: true, canEdit: true, available: true, budget: { limitMicros: 4_000_000, spentMicros: 0, reservedMicros: 0 }, allowedModes: ['chat', 'questions', 'tasks', 'variants', 'rubric_review'], courses: [{ id: 'course-a', title: 'Synthetic course', groups: [{ id: 'group-a', name: 'Synthetic group A' }] }] }
function draft(request) { return { id: request.requestId, request, bundle: { version: 1, kind: request.kind, title: 'Synthetic draft', summary: 'Not an official grade', questions: ['rubric_review','chat'].includes(request.kind) ? [] : [{ id: 'question-a', text: 'Synthetic question', choices: ['A', 'B'], correctIndex: 0, points: 1, variant: 0, explanation: 'Synthetic explanation' }], tasks: [], review: request.kind !== 'rubric_review' ? null : { criteria: [{ title: 'Criterion', points: 2, maxPoints: 4, comment: 'Synthetic comment', evidence: [] }], suggestedScore: 2, maxScore: 4, feedback: 'Synthetic feedback' }, quality: [], warnings: [] }, status: 'draft', revision: 1, teacherNotes: '', createdAt: '2026-11-17T12:00:00Z', updatedAt: '2026-11-17T12:00:00Z' } }
function harness(overrides = {}) {
  const cells = [], effects = [], generations = [], saves = [], copies = []
  let cursor = 0, tree, dirty = false, closed = false
  const same = (a, b) => a && b && a.length === b.length && a.every((value, at) => Object.is(value, b[at]))
  const hooks = {
    useState(initial) { const at = cursor++; cells[at] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[at].value, next => { const value = typeof next === 'function' ? next(cells[at].value) : next; if (!Object.is(cells[at].value, value)) { cells[at].value = value; dirty = true } }] },
    useRef(initial) { return cells[cursor++] ??= { current: initial } },
    useMemo(fn, deps) { const at = cursor++; if (!cells[at] || !same(cells[at].deps, deps)) cells[at] = { deps, value: fn() }; return cells[at].value },
    useEffect(fn, deps) { const at = cursor++, old = cells[at]; if (!old || !same(old.deps, deps)) { cells[at] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); cells[at].cleanup = fn() }) } },
  }
  const jsx = (type, props) => ({ type, props: props || {} })
  const client = { status: async () => structuredClone(status), history: async () => ({ drafts: [] }), candidates: async () => ({ submissions: [{ id: 'sub-a', label: 'Work A' }, { id: 'sub-b', label: 'Work B' }], tests: [] }), generate: async request => draft(request), saveDraft: async save => ({ ...draft({ requestId: save.id, kind: 'questions', courseId: 'course-a', groupIds: ['group-a'] }), ...save, revision: save.expectedRevision + 1 }), ...overrides }
  const wrapped = { ...client, generate: async (request, signal) => { generations.push(structuredClone(request)); return client.generate(request, signal) }, saveDraft: async (save, signal) => { saves.push(structuredClone(save)); return client.saveDraft(save, signal) } }
  const component = load('src/components/teaching/TeacherAssistant.tsx', { react: hooks, 'react-dom': { createPortal: node => node }, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => key }), '../../lib/teacherLearningPresentation': presentation, '../../lib/teacherLearningClient': { createTeacherLearningClient() { throw Error('No extra client') } }, '../../lib/supabase': { supabase: {} }, './teacherAssistant.css': {}, './TeacherAssistantTools': { TeacherInsightsPanel: () => null, TeacherRemindersPanel: () => null, TeacherTestSavePanel: () => null } }, { window: { addEventListener() {}, removeEventListener() {}, confirm: () => true }, navigator: { clipboard: { writeText: async value => copies.push(value) } } }).TeacherAssistantWorkspace
  function expand(node) { if (node == null || typeof node !== 'object') return node; if (Array.isArray(node)) return node.map(expand); if (typeof node.type === 'function') return expand(node.type(node.props)); return { ...node, props: { ...node.props, children: expand(node.props.children) } } }
  function render() { for (let turn = 0; turn < 25; turn++) { dirty = false; cursor = 0; tree = expand(component({ userId: 'owner-a', context: { courseId: 'course-a', groupId: 'group-a' }, client: wrapped, onClose() { closed = true } })); effects.splice(0).forEach(fn => fn()); if (!dirty) return } throw Error('Hooks did not settle') }
  render()
  return { generations, saves, copies, render, get tree() { return tree }, get closed() { return closed }, all: fn => nodes(tree).filter(fn), field: label => nodes(tree).find(node => node.props['aria-label'] === label), button: label => nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node).trim() === label)), prompt: () => nodes(tree).find(node => node.props.id === 'teacher-assistant-prompt'), consent: () => nodes(tree).find(node => node.type === 'label' && node.props.className === 'tla-consent'), async settle() { for (let turn = 0; turn < 20; turn++) { await Promise.resolve(); render() } }, change(field, value, checked) { field.props.onChange({ target: { value, checked } }); render() }, async submit() { const result = nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await result; await this.settle() }, check(label, checked = true) { const row = nodes(tree).find(node => node.type === 'label' && text(node).includes(label)); assert.ok(row, label); this.change(nodes(row).find(node => node.type === 'input'), undefined, checked) }, unmount() { for (const cell of cells) cell?.cleanup?.() } }
}

test('topic generation needs explicit consent, failed request keeps the prompt and manual retry reuses its request ID', async () => {
  let failed = false
  const h = harness({ async generate(request) { if (!failed) { failed = true; throw Error('Synthetic network failure') } return draft(request) } }); await h.settle()
  h.change(h.field('Завдання помічника'), 'questions')
  h.change(h.prompt(), 'Make a topic test without materials')
  assert.equal(h.button('Підготувати').props.disabled, true)
  h.check('Дозволяю передати'); await h.submit()
  assert.equal(h.generations.length, 1); assert.equal(h.prompt().props.value, 'Make a topic test without materials')
  assert.match(text(h.tree), /Synthetic network failure/)
  await h.button('Продовжити незавершені').props.onClick(); await h.settle()
  assert.equal(h.generations.length, 2); assert.equal(h.generations[0].requestId, h.generations[1].requestId)
  assert.match(text(h.tree), /Synthetic draft/); assert.equal(h.saves.length, 0)
})

test('a sequential review queue keeps completed drafts and never publishes a grade', async () => {
  const h = harness(); await h.settle()
  h.change(h.field('Завдання помічника'), 'rubric_review'); await h.settle()
  h.check('Work A'); h.check('Work B')
  h.change(h.prompt(), 'Give preliminary feedback')
  const rubric = h.field('Уточнення критеріїв')
  h.change(rubric, 'Criterion: 4 points'); h.check('Дозволяю передати'); await h.submit()
  assert.deepEqual(h.generations.map(item => item.submissionId), ['sub-a', 'sub-b'])
  assert.ok(h.generations.every(item => item.groupIds.length === 1 && item.groupIds[0] === 'group-a'))
  assert.match(text(h.tree), /Готово\s+2\s+з\s+2/); assert.equal(h.saves.length, 0)
  h.check('Я перевірив/-ла критерії'); await h.button('Зберегти перевірену чернетку').props.onClick(); await h.settle()
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0].status, 'accepted'); assert.match(text(h.tree), /У журнал нічого не записано/)
})

test('a failed save preserves edited answers, revision and notes; editing clears the acceptance checkbox', async () => {
  const h = harness({ async saveDraft() { throw Error('Synthetic conflict') } }); await h.settle()
  h.change(h.field('Завдання помічника'), 'questions')
  h.change(h.prompt(), 'Prepare a test'); h.check('Дозволяю передати'); await h.submit()
  h.change(h.field('Запитання 1'), 'Edited question still here')
  h.change(h.field('Правильна відповідь 2 запитання 1'), undefined, true)
  assert.equal(h.button('Зберегти перевірену чернетку').props.disabled, true)
  await h.button('Зберегти зміни').props.onClick(); await h.settle()
  assert.equal(h.saves[0].expectedRevision, 1); assert.equal(h.saves[0].bundle.questions[0].correctIndex, 1)
  assert.equal(h.field('Запитання 1').props.value, 'Edited question still here'); assert.equal(h.field('Правильна відповідь 2 запитання 1').props.checked, true)
  assert.match(text(h.tree), /Synthetic conflict/)
})

test('a confirmed terminal model failure needs an explicit new request and never regenerates completed queue items', async () => {
  let failed = false, active = 0, maximumActive = 0
  const h = harness({ async generate(request) {
    active++; maximumActive = Math.max(maximumActive, active); await Promise.resolve(); active--
    if (request.submissionId === 'sub-b' && !failed) { failed = true; throw Object.assign(Error('Confirmed model failure'), { code: 'generation_failed' }) }
    return draft(request)
  } }); await h.settle()
  h.change(h.field('Завдання помічника'), 'rubric_review'); await h.settle()
  h.check('Work A'); h.check('Work B'); h.change(h.prompt(), 'Preliminary review by the saved rubric'); h.check('Дозволяю передати'); await h.submit()
  assert.equal(h.generations.length, 2); assert.equal(maximumActive, 1)
  assert.match(text(h.tree), /Готово\s+1\s+з\s+2/)
  assert.match(text(h.tree), /Новий запит для невдалої відповіді використовує ліміт ШІ/)
  assert.equal(h.button('Продовжити незавершені'), undefined)
  await h.button('Новий запит для невдалих').props.onClick(); await h.settle()
  assert.equal(h.generations.length, 3); assert.equal(h.generations.filter(item => item.submissionId === 'sub-a').length, 1)
  assert.equal(h.generations[1].submissionId, h.generations[2].submissionId)
  assert.notEqual(h.generations[1].requestId, h.generations[2].requestId)
  assert.match(text(h.tree), /Готово\s+2\s+з\s+2/); assert.equal(h.saves.length, 0)
})

test('a foreign status fails closed and an unmounted old account cannot display a late generated draft', async () => {
  const foreign = harness({ async status() { return { ...status, userId: 'other-owner' } } }); await foreign.settle()
  assert.match(text(foreign.tree), /Акаунт змінився/); assert.equal(foreign.prompt(), undefined)
  let finish
  const old = harness({ generate: request => new Promise(resolve => { finish = () => resolve(draft(request)) }) }); await old.settle()
  old.change(old.prompt(), 'Owner A only'); old.check('Дозволяю передати'); void old.submit(); await old.settle(); old.unmount()
  finish(); await old.settle(); assert.doesNotMatch(text(old.tree), /Synthetic draft/)
})

test('chat needs no group, shows the sent message immediately and continues only its selected conversation', async () => {
  let finish
  const h = harness({ status: async () => ({ ...status, courses: [] }), generate: request => new Promise(resolve => { finish = () => resolve(draft(request)) }) })
  await h.settle()
  assert.equal(h.field('Завдання помічника').props.value, 'chat')
  assert.equal(h.field('Предмет помічника'), undefined)
  h.change(h.prompt(), 'Привіт! Просто хочу поговорити.'); h.check('Дозволяю передати')
  void h.submit(); await h.settle()
  assert.equal(h.generations.length, 1)
  assert.equal(h.generations[0].courseId, '')
  assert.deepEqual(h.generations[0].groupIds, [])
  assert.equal(h.prompt().props.value, '')
  assert.match(text(h.tree), /Привіт! Просто хочу поговорити\./)
  assert.match(text(h.tree), /Готую відповідь/)
  assert.equal(h.button('Закрити помічника').props.disabled, true)
  finish(); await h.settle()
  h.change(h.prompt(), 'А тепер уточню.'); void h.submit(); await h.settle()
  assert.equal(h.generations[1].parentId, h.generations[0].requestId)
  finish(); await h.settle()
  h.button('Нова розмова').props.onClick(); await h.settle()
  h.change(h.prompt(), 'Нова тема.'); h.check('Дозволяю передати'); void h.submit(); await h.settle()
  assert.equal(h.generations[2].parentId, undefined)
  finish(); await h.settle()
})

test('failed chat restores unsent text, preserves request identity on retry, and saved history reopens', async () => {
  let failed = false
  const h = harness({ generate: async request => { if (!failed) { failed = true; throw Error('Offline') } return draft(request) } })
  await h.settle(); h.change(h.prompt(), 'My conversation'); h.check('Дозволяю передати'); await h.submit()
  assert.equal(h.prompt().props.value, 'My conversation')
  assert.equal(h.button('Надіслати').props.disabled, true)
  await h.button('Продовжити незавершені').props.onClick(); await h.settle()
  assert.equal(h.generations[0].requestId, h.generations[1].requestId)
  const saved = draft(h.generations[0])
  const restored = harness({ history: async () => ({ drafts: [saved] }) }); await restored.settle()
  restored.button('Synthetic draft').props.onClick(); await restored.settle()
  assert.match(text(restored.tree), /My conversation/)
  assert.match(text(restored.tree), /Not an official grade/)
  assert.equal(restored.generations.length, 0)
})
