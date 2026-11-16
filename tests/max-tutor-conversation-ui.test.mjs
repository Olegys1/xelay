import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const content = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(content).join(' ') : typeof node === 'object' ? content(node.props?.children) : String(node)
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function moduleFor(source, imports = {}, globals = {}) {
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { module, exports: module.exports, Date, Math, Number, JSON, Set, Map, TextEncoder, TextDecoder, Promise, URL, AbortController, Blob, ...globals, require(name) { assert.ok(name in imports, 'Known dependency ' + name); return imports[name] } })
  return module.exports
}
const study = moduleFor(read('src/lib/maxTutorStudy.ts'))
const tutor = moduleFor(read('src/lib/maxTutor.ts'), { './maxTutorStudy.js': study })
const conversation = moduleFor(read('src/lib/maxTutorConversation.ts'))
const local = moduleFor(read('src/lib/maxTutorLocalClient.ts'), { './maxTutor': tutor }, { fetch() { throw Error('No network') } })
const ownScope = { userId: 'synthetic-owner', sessionId: 'synthetic-session' }
function bundleFor(request) {
  const source = request.sources[0], base = tutor.createTutorDemo(request.requestId, request.mode === 'chat' ? 'explain' : request.mode).bundle
  return { ...base, mode: request.mode, title: request.mode === 'quiz' ? 'Особистий тест' : 'Відповідь помічника', introduction: 'Давайте розберемо запитання по кроках.', steps: [{ title: 'Головна думка', body: 'Це перевірена за форматом синтетична відповідь.' }], questions: request.mode === 'quiz' ? base.questions.map(question => ({ ...question, sourceId: source.id })) : [], cards: request.mode === 'cards' ? base.cards.map(card => ({ ...card, sourceId: source.id })) : [], plan: request.mode === 'plan' ? base.plan : [], math: request.mode === 'math' ? base.math : null, citations: source ? [{ sourceId: source.id, quote: source.text.slice(0, 80) }] : [] }
}
function studyBundle(request) {
  const source = request.sources[0], format = request.studyFormat, base = tutor.createTutorDemo(request.requestId, 'explain').bundle
  const study = { format, gaps: [], reading: [], written: [], dialogue: [] }
  if (format === 'gap_fill') study.gaps = [{ id: 'gap-one', before: 'Проєкт має ', after: ' етапи.', acceptedAnswers: ['три'], explanation: 'У матеріалі названо три етапи.', sourceId: source.id }]
  if (format === 'smart_text') study.reading = [{ id: 'reading-one', text: 'Попит описує зв’язок між ціною товару та кількістю, яку готові придбати покупці.', terms: [{ term: 'Попит', explanation: 'Зв’язок між ціною й кількістю за інших рівних умов.' }], sourceId: source.id }, { id: 'reading-two', text: 'Зміна власної ціни спричиняє рух уздовж кривої попиту.', terms: [], sourceId: source.id }]
  if (format === 'written' || format === 'exercise') study.written = [{ id: 'written-one', prompt: 'Поясни різницю між рухом і зміщенням кривої.', criteria: ['Названо причину зміни', 'Наведено власний приклад'], modelAnswer: 'Зміна власної ціни означає рух уздовж кривої; зміна вподобань може змістити всю криву.', sourceId: source.id }]
  if (format === 'podcast') study.dialogue = [{ id: 'dialogue-one', speaker: 'student', text: 'Як змінюється попит?', sourceId: source.id }, { id: 'dialogue-two', speaker: 'tutor', text: 'Потрібно відрізняти зміну власної ціни від інших чинників.', sourceId: source.id }]
  return { ...base, version: 2, mode: request.mode, title: 'Мій навчальний матеріал', introduction: 'Працюємо за обраним власним конспектом.', steps: [{ title: 'Як працювати', body: 'Виконай особисте тренування та звір відповідь із джерелом.' }], questions: format === 'true_false' ? [{ id: 'true-false-one', text: 'Зміна власної ціни означає рух уздовж кривої.', options: ['Правда', 'Неправда'], correctIndex: 0, explanation: 'Так це описано у матеріалі.', sourceId: source.id }] : format === 'smart_text' ? [{ id: 'lesson-check-one', text: 'Що означає зміна власної ціни?', options: ['Рух уздовж кривої', 'Обов’язкове зміщення кривої'], correctIndex: 0, explanation: 'За інших рівних умов рухаємося вздовж кривої.', sourceId: source.id }] : [], cards: [], plan: [], math: null, citations: [{ sourceId: source.id, quote: source.text.slice(0, 80) }], study }
}
function savedStudyRun(id, format) {
  const sample = tutor.createTutorDemo(id, 'explain'), request = tutor.validateTutorRequest({ ...sample.request, mode: format === 'true_false' ? 'quiz' : 'explain', studyFormat: format }), bundle = tutor.validateTutorBundle(studyBundle(request), request)
  return { id, createdAt: '2026-11-16T10:00:00Z', demo: false, request, bundle, progress: tutor.emptyTutorProgress(bundle) }
}
function savedRun(id, mode = 'quiz', refs = [], createdAt = '2026-11-16T10:00:00Z') {
  const sample = tutor.createTutorDemo(id, mode)
  return { id, createdAt, demo: false, request: { ...sample.request, prompt: 'Мій попередній запит ' + id, ...(refs.length ? { conversationRunIds: refs } : {}) }, bundle: sample.bundle, progress: tutor.emptyTutorProgress() }
}
function harness(overrides = {}, attachments = {}) {
  const storage = attachments.storage || new Map(), listeners = new Map(), instances = new Map(), effects = [], events = [], changed = [], progress = []
  const props = { enabled: true, scope: ownScope, productionMode: true, initialState: { version: 1, runs: [], activeRunId: '' }, onStateChange: state => changed.push(plain(state)), onProgressChange: (id, value) => progress.push([id, plain(value)]), ...overrides }
  let current, dirty = false, tree, seen = new Set(), domSeen = new Set(), focused = null, timerId = 0
  const timers = new Map(), dom = new Map(), scrolls = [], scrollTargets = [], fakeDocument = { get activeElement() { return focused } }
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const hooks = {
    useState(initial) { const instance = current, at = instance.cursor++; instance.cells[at] ??= { value: typeof initial === 'function' ? initial() : initial }; return [instance.cells[at].value, next => { const old = instance.cells[at].value, value = typeof next === 'function' ? next(old) : next; if (!Object.is(value, old)) { instance.cells[at].value = value; dirty = true } }] },
    useRef(initial) { const at = current.cursor++; return current.cells[at] ??= { current: initial } },
    useMemo(fn, deps) { const at = current.cursor++; if (!current.cells[at] || !same(current.cells[at].deps, deps)) current.cells[at] = { deps, value: fn() }; return current.cells[at].value },
    useEffect(fn, deps) { const instance = current, at = instance.cursor++; if (!instance.cells[at] || !same(instance.cells[at].deps, deps)) { const previous = instance.cells[at]; instance.cells[at] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); instance.cells[at].cleanup = fn() }) } },
  }
  hooks.useLayoutEffect = hooks.useEffect
  const jsx = (type, props, key) => ({ type, props: props || {}, key })
  const imports = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => String(key) }), '../../lib/maxTutor': tutor, '../../lib/maxTutorLocalClient': local, '../../lib/maxTutorConversation': conversation, '../../lib/maxTutorCoach': { sendMaxTutorCoachEvent: (...args) => events.push(plain(args)) }, './MaxTutorVoiceControls': { MaxTutorVoiceControls: () => null }, './maxTutorAssistant.css': {}, '../../lib/maxTutorAttachments': { readMaxTutorAttachments: attachments.read || (async () => ({ sources: [], warnings: [] })) } }
  imports['./MaxTutorStudyActivity'] = moduleFor(read('src/components/student/MaxTutorStudyActivity.tsx'), { react: hooks, 'react/jsx-runtime': imports['react/jsx-runtime'], 'lucide-react': imports['lucide-react'], '../../lib/maxTutor': tutor, './MaxTutorVoiceControls': imports['./MaxTutorVoiceControls'] }, { document: fakeDocument })
  const ui = moduleFor(read('src/components/student/MaxTutorAssistant.tsx'), imports, { crypto: { randomUUID }, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, document: fakeDocument, window: { addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]) }, removeEventListener(name, callback) { listeners.set(name, (listeners.get(name) || []).filter(fn => fn !== callback)) } }, setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, callback); if (delay <= 400) void Promise.resolve().then(() => { if (timers.has(id)) { timers.delete(id); callback() } }); return id }, clearTimeout(id) { timers.delete(id) }, matchMedia: () => ({ matches: true }) })
  function expand(node, path = 'root') {
    if (node == null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((child, index) => expand(child, path + ':' + (child?.key ?? index)))
    if (typeof node.type === 'function') {
      const key = path + '/' + node.type.name + ':' + (node.key ?? ''), instance = instances.get(key) || { cells: [], cursor: 0 }
      instances.set(key, instance); seen.add(key); instance.cursor = 0; const previous = current; current = instance; const result = node.type(node.props); current = previous
      return expand(result, key)
    }
    domSeen.add(path)
    let element = dom.get(path)
    if (!element) { element = { type: node.type, props: node.props, path, open: false, value: '', style: { setProperty() {} }, getClientRects() { return this.props.hidden ? [] : [{}] }, getBoundingClientRect() { const canvas = [...dom.values()].find(candidate => this.path.startsWith(candidate.path) && candidate.props.className === 'mta-chat-stream'), top = this.props.className === 'mta-chat-stream' ? 100 : ['mta-quiz','mta-cards','mta-plan','mta-math'].includes(this.props.className) || String(this.props.className || '').includes('mta-study-artifact') ? 220 - (canvas?.scrollTop || 0) : 620; return { left: 150, top, bottom: top + 35 } }, scrollTop: 0, scrollHeight: 2000, scrollTo(options) { this.scrollTop = options.top; scrolls.push({ target: this.props.className, top: options.top, behavior: options.behavior }) }, scrollIntoView() {}, closest(selector) { return [...dom.values()].filter(candidate => this.path.startsWith(candidate.path) && String(candidate.props.className || '').split(' ').includes(selector.slice(1))).sort((a,b)=>b.path.length-a.path.length)[0] || null }, focus() { focused = this }, click() {}, showModal() { this.open = true }, close() { this.open = false }, querySelector(selector) { if (selector.startsWith('.')) scrollTargets.push(selector); return this.querySelectorAll(selector)[0] || null }, querySelectorAll(selector) { return [...dom.values()].filter(candidate => candidate.path.startsWith(path + '/') && !candidate.props.disabled && (selector.startsWith('.') ? String(candidate.props.className || '').split(' ').includes(selector.slice(1)) : selector === 'main' ? candidate.type === 'main' : ['button', 'input', 'textarea'].includes(candidate.type) && !candidate.props.hidden)) } }; dom.set(path, element) }
    element.props = node.props
    if (node.props?.ref && typeof node.props.ref === 'object') node.props.ref.current = element
    return { ...node, props: { ...node.props, children: expand(node.props?.children, path + '/' + node.type) } }
  }
  const render = () => { for (let attempt = 0; attempt < 30; attempt++) { dirty = false; seen = new Set(); domSeen = new Set(); tree = expand(jsx(ui.MaxTutorAssistant, props)); for (const [key, instance] of instances) if (!seen.has(key)) { instance.cells.forEach(cell => cell?.cleanup?.()); instances.delete(key) } for (const path of dom.keys()) if (!domSeen.has(path)) dom.delete(path); effects.splice(0).forEach(effect => effect()); if (!dirty) return tree } throw Error('Hooks did not settle') }
  render()
  return { props, storage, events, changed, progress, scrolls, scrollTargets, render, get tree() { return tree }, all: predicate => nodes(tree).filter(predicate), find: predicate => nodes(tree).find(predicate), activeElement: () => focused, button: label => nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || content(node).includes(label))), state: () => changed.at(-1), async settle() { for (let index = 0; index < 35; index++) { await Promise.resolve(); render() } }, unmount() { instances.forEach(instance => instance.cells.forEach(cell => cell?.cleanup?.())); instances.clear() } }
}
function ownNote(h) { let note = h.find(node => node.type === 'textarea' && node.props['aria-label'] === 'Власний текст для помічника'); if (note) return note; const describe = h.button('Описати'); if (describe) describe.props.onClick(); else { h.button('Додати матеріали до розмови').props.onClick(); h.render(); h.button('Написати конспект').props.onClick() } h.render(); return h.find(node => node.type === 'textarea' && node.props['aria-label'] === 'Власний текст для помічника') }
const input = h => h.find(node => node.type === 'textarea' && node.props['aria-label'] === 'Повідомлення навчальному помічнику')
async function send(h, prompt) { input(h).props.onChange({ target: { value: prompt } }); h.render(); h.button('Надіслати повідомлення').props.onClick(); await h.settle() }

test('Start opens real learning choices, conversation and exam preparation without making a model request', async()=>{
 let prepared=0,called=0
 const h=harness({startView:true,profileDisplayName:'Олег',onOpenPreparation:()=>prepared++,transport:async request=>{called++;return bundleFor(request)}})
 assert.match(content(h.tree),/Олег,/)
 assert.equal(h.all(node=>node.type==='textarea').length,1)
 h.button('Почати навчання з Максом').props.onClick({currentTarget:{focus(){}}});await h.settle()
 assert.equal(h.find(node=>node.type==='dialog').props['aria-label'],'Почати навчання з Максом')
 assert.match(content(h.tree),/Швидка допомога|Скоро іспит/)
 h.button('Розмова').props.onClick();await h.settle()
 assert.match(content(h.tree),/Файл не обов’язковий/)
 h.button('Скоро іспит?').props.onClick();await h.settle()
 h.button('Створити підготовку').props.onClick();await h.settle()
 assert.equal(prepared,1);assert.equal(called,0)
 h.unmount()
})

test('Start lesson choices prepare the actual format and explicit source consent without fabricated generation',async()=>{
 const requests=[],h=harness({startView:true,transport:async request=>{requests.push(plain(request));return studyBundle(request)}})
 h.button('Почати навчання з Максом').props.onClick({currentTarget:{focus(){}}});await h.settle()
 h.button('Пропуски').props.onClick();await h.settle()
 assert.ok(h.find(node=>node.type==='textarea'&&node.props['aria-label']==='Власний текст для помічника'))
 assert.ok(h.button('Прибрати формат Пропуски'))
 assert.equal(requests.length,0)
 h.unmount()
})

test('a pure greeting ignores an unconsented old source, while a substantive question remains consent protected',async()=>{
 const requests=[],h=harness({profileDisplayName:'Олег',transport:async request=>{requests.push(plain(request));return bundleFor(request)}})
 ownNote(h).props.onChange({target:{value:'Цей приватний уривок не треба надсилати для привітання.'}});await h.settle()
 await send(h,'Привіт!')
 assert.equal(requests.length,1);assert.equal(requests[0].mode,'chat');assert.deepEqual(requests[0].sources,[])
  await send(h,'Як справи?')
  assert.equal(requests.length,2);assert.equal(requests[1].mode,'chat');assert.deepEqual(requests[1].sources,[])
 await send(h,'Поясни саме цей уривок')
  assert.equal(requests.length,2)
 assert.match(content(h.tree),/Дозволь використати обрані матеріали/)
 h.unmount()
})

test('a social-looking message never silently overrides an explicitly selected study format',async()=>{
 const requests=[],h=harness({transport:async request=>{requests.push(plain(request));return bundleFor(request)}})
 ownNote(h).props.onChange({target:{value:'Попит залежить від власної ціни товару.'}});await h.settle()
 h.button('Додати матеріали до розмови').props.onClick();await h.settle()
 h.button('Створити матеріал').props.onClick();await h.settle()
 h.button('Тест').props.onClick();await h.settle()
 await send(h,'Як справи?')
 assert.equal(requests.length,0)
 assert.match(content(h.tree),/Дозволь використати обрані матеріали/)
 assert.ok(h.button('Прибрати формат Тест'))
 h.unmount()
})

test('a single chat composer answers an ordinary question without a file, mode picker or source consent, then carries its own previous turn', async () => {
  const requests = [], h = harness({ transport: async request => { requests.push(plain(request)); return bundleFor(request) } })
  assert.equal(h.all(node => node.type === 'textarea').length, 1); assert.equal(h.find(node => node.props?.className === 'mta-modes'), undefined)
  assert.equal(h.find(node => node.props?.className?.includes('mta-source-consent')), undefined)
  await send(h, 'Поясни інфляцію простими словами')
  assert.equal(requests.length, 1); assert.equal(requests[0].mode, 'chat'); assert.deepEqual(requests[0].sources, []); assert.equal(requests[0].conversationRunIds, undefined)
  assert.match(content(h.tree), /Поясни інфляцію|Давайте розберемо/); assert.equal(input(h).props.value, '')
  const firstId = h.state().activeRunId
  await send(h, 'А чому ціни можуть знижуватися?')
  assert.equal(requests.length, 2); assert.deepEqual(requests[1].conversationRunIds, [firstId]); assert.equal(h.all(node => node.props?.className === 'mta-chat-turn').length, 2)
  assert.equal(h.events.some(([, event]) => event.type === 'ready' && event.mode === 'chat'), false, 'Ordinary replies do not add redundant side notifications')
  h.unmount()
})

test('Start releases its native modal synchronously before preparation navigation can hide or clean up the assistant',async()=>{
 let prepared=0,modal
 const h=harness({startView:true,onOpenPreparation:()=>{assert.equal(modal.open,false,'the next view must not inherit an invisible modal top layer');prepared++;h.unmount()}})
 h.button('Почати навчання з Максом').props.onClick({currentTarget:{focus(){}}});await h.settle()
 h.button('Скоро іспит?').props.onClick();await h.settle()
 modal=h.find(node=>node.type==='dialog').props.ref.current
 assert.equal(modal.open,true)
 h.button('Створити підготовку').props.onClick()
 assert.equal(prepared,1);assert.equal(modal.open,false)
})

test('explicit training asks for an own source and consent once; answers from an earlier inline quiz keep their run ID after a follow-up', async () => {
  const requests = [], h = harness({ transport: async request => { requests.push(plain(request)); return bundleFor(request) } })
  await send(h, 'Створи тест за моїм конспектом')
  assert.equal(requests.length, 0); assert.match(content(h.tree), /додай конспект/)
  const note = ownNote(h); note.props.onChange({ target: { value: 'Проєкт має три етапи: підготовка, виконання та перевірка. Підготовка визначає мету.' } }); h.render()
  h.button('Надіслати повідомлення').props.onClick(); await h.settle(); assert.equal(requests.length, 0)
  const consent = h.find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === false); assert.ok(consent); consent.props.onChange({ target: { checked: true } }); h.render(); h.button('Надіслати повідомлення').props.onClick(); await h.settle()
  assert.equal(requests.length, 1); assert.equal(requests[0].mode, 'quiz'); const quizId = h.state().activeRunId
  await send(h, 'Дякую, тепер дай коротке пояснення')
  assert.equal(requests.length, 2, 'The unchanged selected sources retain consent across this conversation'); assert.equal(h.all(node => node.props?.className === 'mta-chat-turn').length, 2)
  for (let index = 0; index < 3; index++) { const options = h.find(node => node.props?.['aria-label'] === 'Варіанти тренувального запитання'); nodes(options).filter(node => node.type === 'button')[0].props.onClick(); h.render(); h.button('Перевірити відповідь').props.onClick(); h.render(); if (index < 2) { h.button('Далі').props.onClick(); h.render() } }
  h.button('Завершити й отримати фідбек').props.onClick(); await h.settle()
  assert.ok(h.find(node => node.props?.['aria-label'] === 'Підсумок тренування')); assert.ok(h.progress.length >= 6); assert.ok(h.progress.every(([id]) => id === quizId))
  const state = h.state(), quizRun = state.runs.find(run => run.id === quizId); assert.equal(quizRun.progress.submitted.length, 3); assert.ok(h.events.some(([, event]) => event.type === 'quiz' && event.runId === quizId && event.answered === 3))
  const restored = tutor.parseTutorState(JSON.stringify(state)); assert.equal(restored.runs.find(run => run.id === quizId).progress.submitted.length, 3)
  h.unmount()
})

test('history never imports another turn source, a new conversation preserves saved runs, and unsafe capture scopes remain empty', async () => {
  const one = savedRun('stored-one'), two = savedRun('stored-two', 'cards', [], '2026-11-16T10:05:00Z'), requests = []
  const h = harness({ initialState: { version: 1, runs: [two, one], activeRunId: one.id }, capturedSources: [{ id: 'foreign-source', quote: 'FOREIGN_PRIVATE_TEXT', title: 'Foreign capture', sourceTitle: 'Foreign material', page: null }], capturedSourcesScope: { userId: 'someone-else', sessionId: 'foreign-session' }, transport: async request => { requests.push(plain(request)); return bundleFor(request) } })
  h.button('Відкрити історію розмов').props.onClick(); h.render(); h.button(two.bundle.title).props.onClick(); await h.settle()
  await send(h, 'Маю ще одне запитання')
  assert.equal(requests[0].mode, 'chat'); assert.deepEqual(requests[0].sources, []); assert.deepEqual(requests[0].conversationRunIds, ['stored-two']); assert.doesNotMatch(JSON.stringify(requests[0]), /FOREIGN_PRIVATE_TEXT/)
  const before = h.state().runs.length; h.button('Нова розмова зі збереженням історії').props.onClick(); h.render(); assert.equal(h.state().runs.length, before)
  await send(h, 'Що таке попит?'); assert.equal(requests[1].conversationRunIds, undefined)
  h.unmount()
})

test('an account switch aborts an in-flight chat, rejects captured old submit handlers and never displays a late private reply', async () => {
  const pending = deferred(), requests = [], h = harness({ transport: request => { requests.push(request); return pending.promise } })
  input(h).props.onChange({ target: { value: 'OWNER_A_PRIVATE_QUESTION' } }); h.render(); const oldSend = h.button('Надіслати повідомлення').props.onClick; oldSend(); await h.settle(); assert.equal(requests.length, 1)
  h.props.scope = { userId: 'replacement-owner', sessionId: 'new-session' }; h.render(); await h.settle(); pending.resolve(bundleFor(requests[0])); await h.settle()
  assert.doesNotMatch(content(h.tree), /OWNER_A_PRIVATE_QUESTION|Давайте розберемо/); assert.equal(h.state().runs.length, 0); oldSend(); await h.settle(); assert.equal(requests.length, 1)
  h.unmount()
})

test('file excerpts expose cropping warnings and selected text before consent; merged notes and files cannot exceed transport bounds', async () => {
  const requests = [], excerpt = { id: 'file-own', title: 'Мій файл · початковий уривок', text: 'Підготовка, виконання й перевірка.', page: null, kind: 'own_excerpt' }
  const h = harness({ transport: async request => { requests.push(plain(request)); return bundleFor(request) } }, { read: async () => ({ sources: [excerpt], warnings: ['Вибрано лише початковий уривок. Повний файл не передається.'] }) })
  h.button('Додати матеріали до розмови').props.onClick(); h.render(); h.find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [{ name: 'own.txt' }], value: 'own.txt' } }); await h.settle()
  assert.match(content(h.tree), /Вибрано лише початковий уривок/); assert.match(content(h.tree), /Підготовка, виконання й перевірка/)
  await send(h, 'Поясни мій матеріал'); assert.equal(requests.length, 0)
  h.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); h.render(); h.button('Надіслати повідомлення').props.onClick(); await h.settle(); assert.equal(requests.length, 1)
  const note = ownNote(h); note.props.onChange({ target: { value: 'ї'.repeat(12000) } }); h.render(); h.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); h.render(); await send(h, 'Поясни обидва матеріали'); assert.equal(requests.length, 1, 'Merged UTF-8 source size must be validated before transport')
  h.unmount()
})

test('new conversation clears the unsent prompt and selected material instead of reusing the previous topic', async () => {
  const requests = [], excerpt = { id: 'file-old-topic', title: 'OLD_TOPIC_FILE', text: 'OLD_TOPIC_PRIVATE_TEXT', page: null, kind: 'own_excerpt' }
  const h = harness({ transport: async request => { requests.push(plain(request)); return bundleFor(request) } }, { read: async () => ({ sources: [excerpt], warnings: ['OLD_TOPIC_WARNING'] }) })
  h.button('Додати матеріали до розмови').props.onClick(); h.render()
  ownNote(h).props.onChange({ target: { value: 'OLD_TOPIC_NOTE' } }); h.render()
  h.find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [{ name: 'old.txt' }], value: 'old.txt' } }); await h.settle()
  input(h).props.onChange({ target: { value: 'OLD_TOPIC_UNSENT_PROMPT' } }); h.render()
  h.button('Нова розмова зі збереженням історії').props.onClick(); h.render()
  assert.equal(input(h).props.value, ''); assert.doesNotMatch(content(h.tree), /OLD_TOPIC/)
  await send(h, 'Що таке інфляція?'); assert.equal(requests.length, 1); assert.deepEqual(requests[0].sources, []); assert.equal(requests[0].conversationRunIds, undefined)
  h.unmount()
})

test('natural intent is read only from the message, while saved conversations are chronological, bounded and exclude demo context', () => {
  for (const message of ['Поясни, як створити тест за конспектом', 'Як створити тест?', 'Поясни фразу «створи тест»', 'Що таке команда «створи картки»?', 'Поясни, що таке інфляція', 'Що означає тестування гіпотез?', 'Не створюй тест, просто поясни']) assert.equal(conversation.inferTutorConversationMode(message, 0), 'chat')
  for (const [message, mode] of [['Зроби мені тест за конспектом', 'quiz'], ['Створи картки', 'cards'], ['Склади план до іспиту', 'plan']]) assert.equal(conversation.inferTutorConversationMode(message, 1), mode)
  assert.equal(conversation.inferTutorConversationMode('Розв’яжи 2x=8', 0), 'chat'); assert.equal(conversation.inferTutorConversationMode('Розв’яжи задачу за конспектом', 1), 'math')
  const runs = Array.from({ length: 7 }, (_, index) => savedRun('history-' + index, 'quiz', index ? ['history-' + (index - 1)] : [], new Date(Date.UTC(2026, 10, 16, 10, index)).toISOString()))
  runs[0].demo = true
  const state = { version: 1, runs: [...runs].reverse(), activeRunId: 'history-6' }
  assert.deepEqual(plain(conversation.tutorConversationRuns(state).map(run => run.id)), runs.map(run => run.id)); assert.deepEqual(plain(conversation.tutorConversationRunIds(state)), ['history-3', 'history-4', 'history-5', 'history-6'])
  runs[1].request.conversationRunIds = ['missing', 'history-6', 'history-1']; assert.equal(conversation.tutorConversationRuns({ ...state, activeRunId: 'history-1' }).length, 1)
})

test('inline flashcards and plan tasks retain progress for the original saved run, independently of the newest message', async () => {
  const original = savedRun('saved-interactive'), latest = savedRun('latest-message', 'explain', [original.id], '2026-11-16T10:05:00Z')
  const h = harness({ initialState: { version: 1, runs: [latest, original], activeRunId: latest.id } })
  const turn = () => h.find(node => node.props?.['data-tutor-run'] === original.id)
  nodes(turn()).find(node => node.props?.['aria-label'] === 'Показати відповідь картки').props.onClick(); h.render()
  assert.ok(nodes(turn()).find(node => node.props?.['aria-label'] === 'Показати запитання картки'))
  nodes(turn()).find(node => node.type === 'button' && content(node).includes('Пам’ятаю')).props.onClick(); h.render()
  nodes(turn()).find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange(); await h.settle()
  assert.equal(h.progress.length, 2); assert.ok(h.progress.every(([id]) => id === original.id))
  const restored = tutor.parseTutorState(JSON.stringify(h.state())), saved = restored.runs.find(run => run.id === original.id)
  assert.equal(saved.progress.cardRatings['card-demand'], 'known'); assert.deepEqual(plain(saved.progress.doneTasks), ['day-understand:0']); assert.equal(restored.runs.find(run => run.id === latest.id).progress.doneTasks.length, 0)
  h.unmount()
})

test('the actions sheet chooses only supported formats, returns to the composer with a removable chip and restores keyboard focus', async () => {
  const requests = [], h = harness({ transport: async request => { requests.push(plain(request)); return request.studyFormat ? studyBundle(request) : bundleFor(request) } })
  h.button('Додати матеріали до розмови').props.onClick(); await h.settle()
  assert.ok(h.find(node => node.type === 'dialog')); assert.equal(h.find(node => node.type === 'dialog').props.ref.current.open, true)
  h.button('Створити матеріал').props.onClick(); await h.settle()
  assert.doesNotMatch(content(h.tree), /Камера|Намалювати|Усний іспит|MP3/)
  h.button('Пропуски').props.onClick(); await h.settle()
  assert.equal(h.find(node => node.type === 'dialog'), undefined); assert.ok(h.button('Прибрати формат Пропуски')); assert.equal(h.activeElement(), input(h).props.ref.current)
  assert.equal(input(h).props.placeholder, 'З якої теми зробимо вправу з пропусками?')
  await send(h, 'Етапи проєкту'); assert.equal(requests.length, 0)
  ownNote(h).props.onChange({ target: { value: 'Проєкт має три етапи: підготовка, виконання й перевірка.' } }); h.render()
  h.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); h.render(); h.button('Готово').props.onClick(); await h.settle(); h.button('Надіслати повідомлення').props.onClick(); await h.settle()
  assert.equal(requests.length, 1); assert.equal(requests[0].studyFormat, 'gap_fill'); assert.equal(requests[0].mode, 'explain'); assert.ok(h.find(node => node.props?.['aria-label'] === 'Вправа з пропусками'))
  assert.equal(h.button('Прибрати формат Пропуски'), undefined, 'The next ordinary follow-up is not silently forced into another exercise')
  h.unmount()
})

test('the dialog traps Tab in both directions, closes on Escape/backdrop and restores the opening control', async () => {
  const h = harness()
  h.button('Додати матеріали до розмови').props.onClick(); await h.settle()
  let modal = h.find(node => node.type === 'dialog'), native = modal.props.ref.current, controls = native.querySelectorAll('button:not([disabled])'), prevented = false
  controls[controls.length - 1].focus(); modal.props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true } }); assert.equal(prevented, true); assert.equal(h.activeElement(), controls[0])
  controls[0].focus(); modal.props.onKeyDown({ key: 'Tab', shiftKey: true, preventDefault() {} }); assert.equal(h.activeElement(), controls[controls.length - 1])
  modal.props.onKeyDown({ key: 'Escape', preventDefault() {} }); await h.settle(); assert.equal(h.find(node => node.type === 'dialog'), undefined)
  assert.equal(h.activeElement(), h.button('Додати матеріали до розмови').props.ref.current)
  h.button('Додати матеріали до розмови').props.onClick(); await h.settle(); modal = h.find(node => node.type === 'dialog'); modal.props.onClick({ target: modal, currentTarget: modal }); await h.settle(); assert.equal(h.find(node => node.type === 'dialog'), undefined)
  h.unmount()
})

test('gap and written exercises save only the original run progress; written feedback remains an explicit self-assessment', async () => {
  const gap = savedStudyRun('gap-run', 'gap_fill'), written = savedStudyRun('written-run', 'written')
  for (const run of [gap, written]) {
    const h = harness({ initialState: { version: 1, runs: [run], activeRunId: run.id } })
    if (run === gap) { h.find(node => node.props?.['aria-label'] === 'Відповідь у пропуск').props.onChange({ target: { value: 'три' } }); h.render(); h.button('Перевірити').props.onClick(); await h.settle(); assert.match(content(h.tree), /Так, це підходить/); assert.deepEqual(h.state().runs[0].progress.studySubmitted, ['gap-one']) }
    else { assert.doesNotMatch(content(h.tree), /Зміна власної ціни означає рух уздовж кривої;/); h.find(node => node.props?.['aria-label'] === 'Моя письмова відповідь').props.onChange({ target: { value: 'Ціна змінює величину попиту, вподобання — сам попит.' } }); h.render(); h.button('Зберегти й порівняти').props.onClick(); h.render(); assert.match(content(h.tree), /автоматичної оцінки викладача тут немає/); h.button('Розібрався').props.onClick(); await h.settle(); assert.equal(h.state().runs[0].progress.studyRatings['written-one'], 'known') }
    assert.ok(h.progress.every(([id]) => id === run.id)); assert.equal(tutor.parseTutorState(JSON.stringify(h.state())).runs[0].progress.version, 2)
    h.unmount()
  }
})

test('SmartText opens a real paginated lesson, shows one paragraph and source at a time, then saves reading steps and the supplied final quiz', async () => {
  const run = savedStudyRun('reading-run', 'smart_text'), h = harness({ initialState: { version: 1, runs: [run], activeRunId: run.id } })
  assert.equal(h.find(node => node.props?.className === 'mta-lesson-paragraph'), undefined, 'The chat does not repeat the entire lesson as a wall of text')
  h.button('Відкрити урок').props.onClick(); await h.settle(); assert.ok(h.find(node => node.props?.className === 'mta-lesson-dialog'))
  h.button('Почати').props.onClick(); await h.settle(); assert.equal(h.all(node => node.props?.className === 'mta-lesson-paragraph').length, 1)
  assert.match(content(h.find(node => node.props?.className === 'mta-lesson-paragraph')), /Попит описує/)
  h.button('Попит').props.onClick(); await h.settle(); assert.ok(h.find(node => node.props?.role === 'note'))
  h.button('Далі').props.onClick(); await h.settle(); assert.deepEqual(h.state().runs[0].progress.studyDone, ['reading-one'])
  assert.match(content(h.find(node => node.props?.className === 'mta-lesson-paragraph')), /Зміна власної ціни/)
  h.button('Перевірити себе').props.onClick(); await h.settle(); assert.deepEqual(h.state().runs[0].progress.studyDone, ['reading-one', 'reading-two'])
  const options = h.find(node => node.props?.['aria-label'] === 'Запитання уроку'); nodes(options).filter(node => node.type === 'button')[0].props.onClick(); h.render(); h.button('Перевірити відповідь').props.onClick(); await h.settle(); assert.deepEqual(h.state().runs[0].progress.submitted, ['lesson-check-one'])
  h.button('До чату').props.onClick(); await h.settle(); assert.equal(h.find(node => node.props?.className === 'mta-lesson-dialog'), undefined)
  const restored = tutor.parseTutorState(JSON.stringify(h.state())); assert.equal(restored.runs[0].progress.studyDone.length, 2); assert.ok(h.progress.every(([id]) => id === run.id))
  h.unmount()
})

test('a fresh exam action resets the old thread and source selection, previews the new request and never auto-generates or auto-consents', async () => {
  const old = savedRun('prior-exam'), requests = [], workspaces = [], h = harness({ initialState: { version: 1, runs: [old], activeRunId: old.id }, transport: async request => { requests.push(plain(request)); return bundleFor(request) }, onWorkspaceState: state => workspaces.push(plain(state)) })
  ownNote(h).props.onChange({ target: { value: 'OLD_UNRELATED_NOTE' } }); h.render()
  h.props.coachAction = { id: 'fresh-plan-one', type: 'plan', fresh: true, prompt: 'Склади план до заліку з менеджменту.' }; h.render(); await h.settle()
  assert.equal(requests.length, 0); assert.equal(h.state().activeRunId, ''); assert.equal(h.state().runs.length, 1); assert.ok(h.button('Прибрати формат План підготовки')); assert.doesNotMatch(content(h.tree), /OLD_UNRELATED_NOTE/)
  h.button('Надіслати повідомлення').props.onClick(); await h.settle(); assert.equal(requests.length, 0); assert.equal(h.find(node => node.type === 'input' && node.props.type === 'checkbox'), undefined)
  h.props.coachAction = { id: 'fresh-plan-two', type: 'plan', fresh: true, prompt: 'Склади план за моїм конспектом.', source: { title: 'Мій новий конспект', text: 'Підготовка визначає мету, виконання створює результат, перевірка зіставляє результат із метою.' } }; h.render(); await h.settle(); assert.equal(requests.length, 0)
  const consent = h.find(node => node.type === 'input' && node.props.type === 'checkbox'); assert.ok(consent); assert.equal(consent.props.checked, false); consent.props.onChange({ target: { checked: true } }); h.render(); h.button('Готово').props.onClick(); await h.settle(); h.button('Надіслати повідомлення').props.onClick(); await h.settle()
  assert.equal(requests.length, 1); assert.equal(requests[0].conversationRunIds, undefined); assert.equal(requests[0].sources.length, 1); assert.doesNotMatch(JSON.stringify(requests[0]), /OLD_UNRELATED_NOTE/); assert.ok(workspaces.length > 0)
  h.unmount()
})

test('production actions never expose a prepared demo; the isolated preview opens it only after an explicit separate action', async () => {
  for (const productionMode of [true, false]) {
    const h = harness({ productionMode, transport: undefined })
    h.button('Додати матеріали до розмови').props.onClick(); await h.settle()
    const sample = h.button('Навчальний приклад')
    if (productionMode) assert.equal(sample, undefined)
    else { assert.ok(sample); assert.equal(h.state().runs.length, 0); sample.props.onClick(); await h.settle(); assert.equal(h.state().runs.length, 1); assert.equal(h.state().runs[0].demo, true) }
    h.unmount()
  }
})

test('all six new visible formats issue the correct validated request and render their actual supported activity', async () => {
  const cases = [['true_false', 'Правда чи неправда', 'Варіанти тренувального запитання'], ['gap_fill', 'Пропуски', 'Вправа з пропусками'], ['smart_text', 'Інтерактивний урок', 'Інтерактивний урок за матеріалами'], ['written', 'Письмове тренування', 'Письмове тренування'], ['exercise', 'Практична вправа', 'Практична вправа'], ['podcast', 'Навчальний діалог', 'Навчальний діалог для прослуховування']]
  for (const [format, label, widget] of cases) {
    const requests = [], h = harness({ transport: async request => { requests.push(plain(request)); return studyBundle(request) } })
    h.button('Додати матеріали до розмови').props.onClick(); await h.settle(); h.button('Створити матеріал').props.onClick(); await h.settle(); h.button(label).props.onClick(); await h.settle(); assert.ok(h.button('Прибрати формат ' + label))
    ownNote(h).props.onChange({ target: { value: tutor.DEMO_TUTOR_SOURCE.text } }); h.render(); h.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); h.render(); h.button('Готово').props.onClick(); await h.settle(); await send(h, 'Попит і ціна')
    assert.equal(requests.length, 1, format); assert.equal(requests[0].studyFormat, format); assert.equal(requests[0].mode, format === 'true_false' ? 'quiz' : 'explain'); assert.ok(h.find(node => node.props?.['aria-label'] === widget), format); assert.equal(h.state().runs[0].progress.version, 2)
    if (format === 'podcast') { h.button('Я прослухав або прочитав').props.onClick(); await h.settle(); assert.deepEqual(h.state().runs[0].progress.studyDone, ['dialogue-one', 'dialogue-two']); assert.doesNotMatch(content(h.tree), /готовий аудіофайл|завантажити MP3/iu) }
    h.unmount()
  }
})

test('opening an actual own run from the exam view is read-only navigation and an unknown run cannot replace the current conversation', async () => {
  const old = savedRun('own-plan-one', 'plan'), other = savedRun('own-plan-two', 'plan', [], '2026-11-16T10:05:00Z'), requests = []
  const h = harness({ initialState: { version: 1, runs: [other, old], activeRunId: other.id }, transport: async request => { requests.push(request); return bundleFor(request) } })
  h.props.coachAction = { id: 'open-own-plan', type: 'assistant', runId: old.id }; h.render(); await h.settle(); assert.equal(h.state().activeRunId, old.id); assert.equal(requests.length, 0)
  h.props.coachAction = { id: 'open-foreign-plan', type: 'assistant', runId: 'not-an-own-run' }; h.render(); await h.settle(); assert.equal(h.state().activeRunId, old.id); assert.equal(requests.length, 0); assert.equal(h.progress.length, 0)
  h.unmount()
})

test('production reload restores an explicit fresh chat pointer only, never old cloud context or local answers/content', async () => {
  const old = savedRun('cloud-old-run'), initialState = { version: 1, runs: [old], activeRunId: old.id }, storage = new Map(), requests = []
  const h = harness({ initialState, transport: async request => { requests.push(plain(request)); return bundleFor(request) } }, { storage })
  h.props.coachAction = { id: 'fresh-exam-reload', type: 'plan', fresh: true, prompt: 'Склади новий план за моїм конспектом.', source: { title: 'NEW_OWN_SOURCE', text: 'Підготовка визначає мету. Виконання створює результат. Перевірка зіставляє результат із метою.' } }; h.render(); await h.settle()
  assert.equal(h.state().activeRunId, ''); h.unmount()
  const reference = [...storage.entries()].find(([key]) => key.endsWith(':conversation')); assert.ok(reference); assert.deepEqual(Object.keys(JSON.parse(reference[1])).sort(), ['activeRunId', 'ownerId', 'version'])
  // The production wrapper still returns the newest old run from the server.
  const restored = harness({ initialState, transport: async request => { requests.push(plain(request)); return bundleFor(request) } }, { storage })
  assert.equal(restored.state().activeRunId, ''); assert.equal(restored.state().runs.length, 1); assert.equal(input(restored).props.value, 'Склади новий план за моїм конспектом.')
  ownNote(restored); restored.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); restored.render(); restored.button('Готово').props.onClick(); await restored.settle(); restored.button('Надіслати повідомлення').props.onClick(); await restored.settle()
  assert.equal(requests.length, 1); assert.equal(requests[0].conversationRunIds, undefined); assert.match(requests[0].sources[0].text, /NEW_OWN_SOURCE/)
  assert.deepEqual(restored.state().runs.find(run => run.id === old.id).progress, plain(old.progress))
  restored.unmount()
  for (const raw of [JSON.stringify({ version: 1, ownerId: ownScope.userId, activeRunId: 'unknown-run' }), JSON.stringify({ version: 1, ownerId: 'foreign-owner', activeRunId: old.id }), JSON.stringify({ version: 1, ownerId: ownScope.userId, activeRunId: '', runs: [{ prompt: 'MALICIOUS_LOCAL_CONTENT' }], progress: { answers: { 'q-price': 3 } } })]) {
    const selected = conversation.restoreTutorConversationReference(initialState, raw, ownScope.userId); assert.equal(selected, initialState); assert.doesNotMatch(JSON.stringify(selected), /MALICIOUS_LOCAL_CONTENT/)
  }
})

test('restored or reselected training scrolls the inner canvas to the activity start, never its finish controls, and answering does not move it', async () => {
  for (const mode of ['quiz', 'cards']) {
    const run = savedRun('visible-' + mode, mode), h = harness({ initialState: { version: 1, runs: [run], activeRunId: run.id } })
    assert.equal(conversation.tutorConversationScrollTarget(run), mode)
    assert.ok(h.scrollTargets.includes('.mta-' + mode)); assert.ok(h.scrolls.length > 0); assert.ok(h.scrolls.every(scroll => scroll.target === 'mta-chat-stream' && scroll.top < 1000), 'Opening a tall training must not reveal only its footer')
    const count = h.scrolls.length
    if (mode === 'quiz') { const options = h.find(node => node.props?.['aria-label'] === 'Варіанти тренувального запитання'); nodes(options).filter(node => node.type === 'button')[0].props.onClick() }
    else h.button('Показати відповідь картки').props.onClick()
    h.render(); assert.equal(h.scrolls.length, count, 'Progress rerenders keep the student’s current reading position')
    h.button('Відкрити історію розмов').props.onClick(); await h.settle(); h.button(run.bundle.title).props.onClick(); await h.settle(); assert.ok(h.scrolls.length > count); assert.ok(h.scrolls.at(-1).top < 1000)
    h.unmount()
  }
})

test('fullscreen test and cards keep the same original run, question/flip state and saved answers when returning to chat', async () => {
  for (const mode of ['quiz', 'cards']) {
    const run = savedRun('fullscreen-' + mode, mode), h = harness({ initialState: { version: 1, runs: [run], activeRunId: run.id } }); let returnedFocus = 0
    h.button(mode === 'quiz' ? 'Відкрити тест на весь екран' : 'Відкрити картки на весь екран').props.onClick({ currentTarget: { focus() { returnedFocus++ } } }); await h.settle()
    assert.ok(h.find(node => node.props?.className === 'mta-training-dialog')); assert.equal(h.find(node => node.props?.className === 'mta-training-dialog').props.ref.current.open, true)
    if (mode === 'quiz') { assert.equal(h.all(node => node.props?.['aria-label'] === 'Варіанти тренувального запитання').length, 1); const options = h.find(node => node.props?.['aria-label'] === 'Варіанти тренувального запитання'); nodes(options).filter(node => node.type === 'button')[0].props.onClick(); h.render(); h.button('Перевірити відповідь').props.onClick(); h.render(); h.button('Далі').props.onClick(); h.render(); assert.deepEqual(h.state().runs[0].progress.submitted, ['q-price']); assert.equal(h.scrolls.at(-1).top, 0) }
    else { h.button('Показати відповідь картки').props.onClick(); h.render(); assert.ok(h.button('Показати запитання картки')) }
    h.button('Повернутися до чату з тренування').props.onClick(); await h.settle(); assert.equal(h.find(node => node.props?.className === 'mta-training-dialog'), undefined); assert.equal(returnedFocus, 1)
    if (mode === 'quiz') { assert.match(content(h.tree), /Запитання\s+2\s*\/\s*3/); assert.ok(h.progress.every(([id]) => id === run.id)); assert.deepEqual(plain(tutor.parseTutorState(JSON.stringify(h.state())).runs[0].progress.submitted), ['q-price']) }
    else { assert.ok(h.button('Показати запитання картки')); h.button('Пам’ятаю').props.onClick(); await h.settle(); assert.equal(h.state().runs[0].progress.cardRatings['card-demand'], 'known'); assert.ok(h.progress.every(([id]) => id === run.id)) }
    h.unmount()
  }
})

test('every fullscreen activity exposes the real pending or failed save state inside its own dialog and keeps progress on recovery', async () => {
  for (const format of ['quiz', 'cards', 'smart_text']) {
    const run = format === 'smart_text' ? savedStudyRun('save-state-reading', format) : savedRun('save-state-' + format, format)
    const h = harness({ initialState: { version: 1, runs: [run], activeRunId: run.id }, saveState: { saving: true, error: '' } })
    h.button(format === 'quiz' ? 'Відкрити тест на весь екран' : format === 'cards' ? 'Відкрити картки на весь екран' : 'Відкрити урок').props.onClick({ currentTarget: { focus() {} } }); await h.settle()
    const dialogClass = format === 'smart_text' ? 'mta-lesson-dialog' : 'mta-training-dialog'
    let dialog = h.find(node => node.props?.className === dialogClass)
    assert.ok(dialog)
    assert.match(content(nodes(dialog).find(node => String(node.props?.className || '').includes('mta-native-save-state'))), /Зберігаємо/)
    if (format === 'quiz') { const options = nodes(dialog).find(node => node.props?.['aria-label'] === 'Варіанти тренувального запитання'); nodes(options).filter(node => node.type === 'button')[0].props.onClick(); h.render() }
    else if (format === 'cards') { h.button('Показати відповідь картки').props.onClick(); h.render(); h.button('Пам’ятаю').props.onClick(); h.render() }
    else { h.button('Почати').props.onClick(); h.render(); h.button('Далі').props.onClick(); h.render() }
    const priorProgress = plain(h.state().runs[0].progress)
    h.props.saveState = { saving: false, error: 'SYNTHETIC_SAVE_FAILURE' }; h.render()
    dialog = h.find(node => node.props?.className === dialogClass)
    const warning = nodes(dialog).find(node => node.props?.role === 'alert')
    assert.ok(warning, 'A save failure must remain visible while the outside chat is inert')
    assert.match(content(warning), /SYNTHETIC_SAVE_FAILURE/)
    assert.match(content(warning), /лише на цьому пристрої/)
    assert.doesNotMatch(content(dialog), /Прогрес зберігається|успішно збережено|Стан збереження — над чатом/iu)
    nodes(warning).find(node => node.type === 'button').props.onClick(); await h.settle()
    assert.equal(h.find(node => node.props?.className === dialogClass), undefined)
    assert.deepEqual(h.state().runs[0].progress, priorProgress)
    assert.ok(h.progress.every(([id]) => id === run.id))
    h.unmount()
  }
})
