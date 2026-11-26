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
const local = moduleFor(read('src/lib/maxTutorLocalClient.ts'), { './maxTutor': tutor, './maxTutorProgress': moduleFor(read('src/lib/maxTutorProgress.ts')) }, { fetch() { throw Error('No network') } })
const ownScope = { userId: 'synthetic-owner', sessionId: 'synthetic-session' }
function bundleFor(request) {
  const source = request.sources[0], base = tutor.createTutorDemo(request.requestId, request.mode === 'chat' ? 'explain' : request.mode).bundle
  return { ...base, mode: request.mode, title: request.mode === 'quiz' ? 'Особистий тест' : 'Відповідь помічника', introduction: 'Давайте розберемо запитання по кроках.', steps: [{ title: 'Головна думка', body: 'Це перевірена за форматом синтетична відповідь.' }], questions: request.mode === 'quiz' ? base.questions.map(question => ({ ...question, sourceId: source?.id || '' })) : [], cards: request.mode === 'cards' ? base.cards.map(card => ({ ...card, sourceId: source?.id || '' })) : [], plan: request.mode === 'plan' ? base.plan : [], math: request.mode === 'math' ? base.math : null, citations: source ? [{ sourceId: source?.id || '', quote: source?.text.slice(0, 80) }] : [] }
}
function studyBundle(request) {
  const source = request.sources[0], format = request.studyFormat, base = tutor.createTutorDemo(request.requestId, 'explain').bundle
  const study = { format, gaps: [], reading: [], written: [], dialogue: [] }
  if (format === 'gap_fill') study.gaps = [{ id: 'gap-one', before: 'Проєкт має ', after: ' етапи.', acceptedAnswers: ['три'], explanation: 'У матеріалі названо три етапи.', sourceId: source?.id || '' }]
  if (format === 'smart_text') study.reading = [{ id: 'reading-one', text: 'Попит описує зв’язок між ціною товару та кількістю, яку готові придбати покупці.', terms: [{ term: 'Попит', explanation: 'Зв’язок між ціною й кількістю за інших рівних умов.' }], sourceId: source?.id || '' }, { id: 'reading-two', text: 'Зміна власної ціни спричиняє рух уздовж кривої попиту.', terms: [], sourceId: source?.id || '' }]
  if (format === 'written' || format === 'exercise') study.written = [{ id: 'written-one', prompt: 'Поясни різницю між рухом і зміщенням кривої.', criteria: ['Названо причину зміни', 'Наведено власний приклад'], modelAnswer: 'Зміна власної ціни означає рух уздовж кривої; зміна вподобань може змістити всю криву.', sourceId: source?.id || '' }]
  if (format === 'podcast') study.dialogue = [{ id: 'dialogue-one', speaker: 'student', text: 'Як змінюється попит?', sourceId: source?.id || '' }, { id: 'dialogue-two', speaker: 'tutor', text: 'Потрібно відрізняти зміну власної ціни від інших чинників.', sourceId: source?.id || '' }]
  return { ...base, version: 2, mode: request.mode, title: 'Мій навчальний матеріал', introduction: 'Працюємо за обраним власним конспектом.', steps: [{ title: 'Як працювати', body: 'Виконай особисте тренування та звір відповідь із джерелом.' }], questions: format === 'true_false' ? [{ id: 'true-false-one', text: 'Зміна власної ціни означає рух уздовж кривої.', options: ['Правда', 'Неправда'], correctIndex: 0, explanation: 'Так це описано у матеріалі.', sourceId: source?.id || '' }] : format === 'smart_text' ? [{ id: 'lesson-check-one', text: 'Що означає зміна власної ціни?', options: ['Рух уздовж кривої', 'Обов’язкове зміщення кривої'], correctIndex: 0, explanation: 'За інших рівних умов рухаємося вздовж кривої.', sourceId: source?.id || '' }] : [], cards: [], plan: [], math: null, citations: source ? [{ sourceId: source.id, quote: source.text.slice(0, 80) }] : [], study }
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
  const timers = new Map(), dom = new Map(), scrolls = [], scrollTargets = [], animationFrames = [], fakeDocument = { get activeElement() { return focused }, documentElement: {style: {overflow: 'auto'}}, fullscreenElement: null, addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]) }, removeEventListener(name, callback) { listeners.set(name, (listeners.get(name) || []).filter(fn => fn !== callback)) }, async exitFullscreen() { this.fullscreenElement = null; (listeners.get('fullscreenchange') || []).forEach(fn => fn()) } }
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const hooks = {
    useState(initial) { const instance = current, at = instance.cursor++; instance.cells[at] ??= { value: typeof initial === 'function' ? initial() : initial }; return [instance.cells[at].value, next => { const old = instance.cells[at].value, value = typeof next === 'function' ? next(old) : next; if (!Object.is(value, old)) { instance.cells[at].value = value; dirty = true } }] },
    useRef(initial) { const at = current.cursor++; return current.cells[at] ??= { current: initial } },
    useMemo(fn, deps) { const at = current.cursor++; if (!current.cells[at] || !same(current.cells[at].deps, deps)) current.cells[at] = { deps, value: fn() }; return current.cells[at].value },
    useEffect(fn, deps) { const instance = current, at = instance.cursor++; if (!instance.cells[at] || !same(instance.cells[at].deps, deps)) { const previous = instance.cells[at]; instance.cells[at] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); instance.cells[at].cleanup = fn() }) } },
  }
  hooks.useLayoutEffect = hooks.useEffect
  const jsx = (type, props, key) => ({ type, props: props || {}, key })
  const imports = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => String(key) }), '../../lib/maxTutor': tutor, '../../lib/maxTutorLocalClient': local, '../../lib/maxTutorConversation': conversation, '../../lib/maxTutorCoach': { sendMaxTutorCoachEvent: (...args) => events.push(plain(args)) }, './MaxTutorVoiceControls': { MaxTutorVoiceControls: () => null }, '../XelayMini': { XelayMini: () => null }, './MaxTutorWelcomeScene': { MaxTutorWelcomeScene: ({children}) => children }, './maxTutorAssistant.css': {}, '../../lib/maxTutorAttachments': { readMaxTutorAttachments: attachments.read || (async () => ({ sources: [], warnings: [] })) } }
  imports['./MaxTutorQuizWorkspace'] = moduleFor(read('src/components/student/MaxTutorQuizWorkspace.tsx'), { react: hooks, 'react/jsx-runtime': imports['react/jsx-runtime'], 'lucide-react': imports['lucide-react'], '../../lib/maxTutor': tutor, '../../lib/maxTutorQuizWorkspace': moduleFor(read('src/lib/maxTutorQuizWorkspace.ts'), {'./maxTutor': tutor}), './maxTutorQuizWorkspace.css': {} }, {document: fakeDocument, requestAnimationFrame: callback => animationFrames.push(callback), matchMedia: () => ({matches: true})})
  imports['./MaxTutorStudyActivity'] = moduleFor(read('src/components/student/MaxTutorStudyActivity.tsx'), { react: hooks, 'react/jsx-runtime': imports['react/jsx-runtime'], 'lucide-react': imports['lucide-react'], '../../lib/maxTutor': tutor, './MaxTutorVoiceControls': imports['./MaxTutorVoiceControls'] }, { document: fakeDocument })
  imports['./MaxTutorPlanActivity'] = moduleFor(read('src/components/student/MaxTutorPlanActivity.tsx'), { react: hooks, 'react/jsx-runtime': imports['react/jsx-runtime'], 'lucide-react': imports['lucide-react'], '../../lib/maxTutor': tutor, '../../lib/maxTutorPlan': moduleFor(read('src/lib/maxTutorPlan.ts')), './MaxTutorQuizWorkspace': imports['./MaxTutorQuizWorkspace'], './maxTutorPlanActivity.css': {} }, { document: fakeDocument, requestAnimationFrame: callback => callback() })
  imports['./StudentGroupMaterialPicker'] = moduleFor(read('src/components/student/StudentGroupMaterialPicker.tsx'), { ...imports, './studentGroupMaterialPicker.css': {} });
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
    if (!element) { element = { type: node.type, props: node.props, path, isConnected: true, open: false, value: '', style: { setProperty() {} }, getClientRects() { return this.props.hidden ? [] : [{}] }, getBoundingClientRect() { const canvas = [...dom.values()].find(candidate => this.path.startsWith(candidate.path) && candidate.props.className === 'mta-chat-stream'), top = this.props.className === 'mta-chat-stream' ? 100 : ['mta-quiz-launcher','mta-cards','mtp','mta-math'].includes(this.props.className) || String(this.props.className || '').includes('mta-study-artifact') ? 220 - (canvas?.scrollTop || 0) : 620; return { left: 150, top, bottom: top + 35 } }, scrollTop: 0, scrollHeight: 2000, scrollTo(options) { this.scrollTop = options.top; scrolls.push({ target: this.props.className, top: options.top, behavior: options.behavior }) }, scrollIntoView() {}, closest(selector) { return [...dom.values()].filter(candidate => this.path.startsWith(candidate.path) && String(candidate.props.className || '').split(' ').includes(selector.slice(1))).sort((a,b)=>b.path.length-a.path.length)[0] || null }, focus() { focused = this }, click() {}, showModal() { this.open = true }, close() { this.open = false }, querySelector(selector) { if (selector.startsWith('.')) scrollTargets.push(selector); return this.querySelectorAll(selector)[0] || null }, querySelectorAll(selector) { return [...dom.values()].filter(candidate => candidate.path.startsWith(path + '/') && !candidate.props.disabled && (selector.startsWith('.') ? String(candidate.props.className || '').split(' ').includes(selector.slice(1)) : selector === 'main' ? candidate.type === 'main' : selector === 'h2' ? candidate.type === 'h2' : selector === '[data-quiz-autofocus]' ? candidate.props['data-quiz-autofocus'] !== undefined : ['button', 'input', 'textarea'].includes(candidate.type) && !candidate.props.hidden)) } }; dom.set(path, element) }
    element.props = node.props
    if (typeof node.props?.ref === 'function') node.props.ref(element); else if (node.props?.ref && typeof node.props.ref === 'object') node.props.ref.current = element
    return { ...node, __domPath: path, props: { ...node.props, children: expand(node.props?.children, path + '/' + node.type) } }
  }
  const render = () => { for (let attempt = 0; attempt < 30; attempt++) { dirty = false; seen = new Set(); domSeen = new Set(); tree = expand(jsx(ui.MaxTutorAssistant, props)); for (const [key, instance] of instances) if (!seen.has(key)) { instance.cells.forEach(cell => cell?.cleanup?.()); instances.delete(key) } for (const [path, element] of dom) if (!domSeen.has(path)) { element.isConnected = false; if (typeof element.props.ref === 'function') element.props.ref(null); dom.delete(path) } effects.splice(0).forEach(effect => effect()); animationFrames.splice(0).forEach(callback => callback()); if (!dirty) return tree } throw Error('Hooks did not settle') }
  render()
  return { props, storage, events, changed, progress, scrolls, scrollTargets, render, get tree() { return tree }, all: predicate => nodes(tree).filter(predicate), find: predicate => nodes(tree).find(predicate), activeElement: () => focused, focus(node) { dom.get(node.__domPath)?.focus() }, button: label => nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || content(node).includes(label))), state: () => changed.at(-1), async settle() { for (let index = 0; index < 35; index++) { await Promise.resolve(); render() } }, unmount() { instances.forEach(instance => instance.cells.forEach(cell => cell?.cleanup?.())); instances.clear() } }
}
function ownNote(h) { let note = h.find(node => node.type === 'textarea' && node.props['aria-label'] === 'Власний текст для помічника'); if (note) return note; const describe = h.button('Описати'); if (describe) describe.props.onClick(); else { h.button('Додати матеріали до розмови').props.onClick(); h.render(); h.button('Написати конспект').props.onClick() } h.render(); return h.find(node => node.type === 'textarea' && node.props['aria-label'] === 'Власний текст для помічника') }
const input = h => h.find(node => node.type === 'textarea' && node.props['aria-label'] === 'Повідомлення навчальному помічнику')
async function send(h, prompt) { input(h).props.onChange({ target: { value: prompt } }); h.render(); h.button('Надіслати повідомлення').props.onClick(); await h.settle() }
const quizGroups = h => h.all(node => node.props?.role === 'group' && String(node.props['aria-label'] || '').startsWith('Варіанти відповіді на запитання'))
async function openQuiz(h) { const button = h.find(node => node.props?.['data-training-open'] === 'quiz'); assert.ok(button); h.focus(button); button.props.onClick(); await h.settle(); return h.find(node => node.props?.className === 'mqq-dialog') }
function chooseQuiz(h, questionIndex, optionIndex) { const button = nodes(quizGroups(h)[questionIndex]).filter(node => node.type === 'button')[optionIndex]; assert.ok(button); assert.equal(!!button.props.disabled, false); button.props.onClick(); h.render() }
function checkQuiz(h, questionIndex) { const question = h.all(node => node.props?.['data-quiz-question'])[questionIndex], button = nodes(question).find(node => node.type === 'button' && content(node).includes('Перевірити відповідь')); assert.ok(button); button.props.onClick(); h.render() }


test('Plus has its own label, basic formats and rejects advanced plan generation', async () => {
 const requests=[],h=harness({planId:'plus',transport:async request=>{requests.push(plain(request));return bundleFor(request)}})
 assert.match(content(h.tree),/Плюс/)
 await send(h,'Привіт');assert.equal(requests[0].mode,'chat')
 await send(h,'Склади план підготовки до іспиту');assert.equal(requests.length,1);assert.match(content(h.tree),/доступні у Максі/)
 h.button('Додати матеріали до розмови').props.onClick();await h.settle();h.button('Створити матеріал').props.onClick();await h.settle()
 assert.ok(h.button('Тест'));assert.ok(h.button('Картки'))
 assert.equal(h.all(node=>node.type==='button'&&content(node).includes('Інтерактивний урок')).length,0)
 h.unmount()
})

test('a sent user message immediately leaves the composer and real request events drive its visible progress', async () => {
  const pending = deferred(), requests = []; let notify
  const h = harness({ transport: (request, options) => { requests.push(plain(request)); notify = options.onProgress; return pending.promise } })
  await send(h, 'Привіт, мені хочеться просто поговорити')
  assert.equal(input(h).props.value, ''); assert.equal(requests.length, 1)
  assert.equal(h.all(node => node.props?.['data-tutor-request']).length, 1)
  assert.match(content(h.tree), /Привіт, мені хочеться просто поговорити/)
  assert.match(content(h.tree), /Надсилаємо повідомлення/)
  assert.doesNotMatch(content(h.tree), /Xelay Mini готує відповідь|Перевіряємо формат відповіді|Зберігаємо розмову/)
  notify('preparing'); await h.settle(); assert.match(content(h.tree), /Готуємо запит і перевіряємо доступ/)
  notify('generating'); await h.settle(); assert.match(content(h.tree), /Xelay Mini готує відповідь/)
  assert.doesNotMatch(content(h.tree), /Перевіряємо формат відповіді|Зберігаємо розмову/)
  notify('validating'); notify('saving'); await h.settle(); assert.match(content(h.tree), /Перевіряємо формат відповіді|Зберігаємо розмову/)
  pending.resolve(bundleFor(requests[0])); await h.settle()
  assert.equal(h.all(node => node.props?.['data-tutor-request']).length, 0)
  assert.equal(h.all(node => node.props?.['data-tutor-run']).length, 1)
  assert.equal(h.all(node => node.props?.className === 'mta-user-message').length, 1)
  h.unmount()
})

test('group picker searches metadata, blocks author-disabled material and requires explicit text consent',async()=>{
 const group='22222222-2222-4222-8222-222222222222',id='gm_s_'+group+'_33333333-3333-4333-8333-333333333333'
 const source={id,title:'Попит з групи',text:'Попит залежить від ціни.',kind:'own_excerpt',page:null},requests=[],reads=[]
 const groupMaterials={groups:async()=>[{id:group,name:'Економіка'}],list:async()=>({items:[{id,title:source.title,subject:'Економічна теорія',allowAi:true},{id:'locked',title:'Закритий матеріал',subject:'',allowAi:false}],truncated:false}),preview:async ref=>{reads.push(ref);return{source,truncated:true}}}
 const h=harness({groupMaterials,transport:async request=>{requests.push(plain(request));return bundleFor(request)}})
 h.button('Додати матеріали до розмови').props.onClick();h.render();h.button('Матеріали групи').props.onClick();await h.settle()
 assert.equal(h.button('Закритий матеріал').props.disabled,true);assert.match(content(h.tree),/Автор ще не дозволив/)
 const search=h.find(n=>n.props?.['aria-label']==='Пошук матеріалів групи');search.props.onChange({target:{value:'поп'}});h.render()
 assert.equal(h.button('Закритий матеріал'),undefined);h.button('Попит з групи').props.onClick();await h.settle()
 assert.equal(reads.length,1);assert.match(content(h.tree),/Попит залежить від ціни/);assert.match(content(h.tree),/лише доступний фрагмент/)
 await send(h,'Створи тест за матеріалом');assert.equal(requests.length,0)
 h.find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});h.render()
 h.button('Надіслати повідомлення').props.onClick();await h.settle();assert.equal(requests.length,1);assert.deepEqual(requests[0].sources,[source])
 h.unmount()
})
test('closing the picker or switching account aborts extraction and never attaches a late result',async()=>{
 const wait=deferred(),group='22222222-2222-4222-8222-222222222222';let signal
 const h=harness({groupMaterials:{groups:async()=>[{id:group,name:'Група'}],list:async()=>({items:[{id:'material',title:'Приватний файл',subject:'',allowAi:true}],truncated:false}),preview:async(_id,s)=>{signal=s;return wait.promise}}})
 h.button('Додати матеріали до розмови').props.onClick();h.render();h.button('Матеріали групи').props.onClick();await h.settle()
 h.button('Приватний файл').props.onClick();await h.settle();assert.equal(signal.aborted,false)
 h.props.scope={userId:'other-owner',sessionId:'other-session'};h.render();assert.equal(signal.aborted,true)
 wait.resolve({source:{id:'private',title:'OLD_PRIVATE_FILE',text:'OLD_PRIVATE_TEXT',kind:'own_excerpt',page:null},truncated:false});await h.settle()
 assert.doesNotMatch(content(h.tree),/OLD_PRIVATE/);h.unmount()
})

test('a failed or cancelled turn keeps its message and retry uses the same immutable request identity', async () => {
  const first = deferred(), second = deferred(), requests = []
  const h = harness({ transport: request => { requests.push(plain(request)); return requests.length === 1 ? first.promise : second.promise } })
  await send(h, 'Створи тест про попит і пропозицію')
  assert.equal(requests[0].mode, 'quiz'); assert.deepEqual(requests[0].sources, [])
  first.reject(Error('synthetic network failure')); await h.settle()
  assert.equal(input(h).props.value, ''); assert.match(content(h.tree), /Створи тест про попит і пропозицію/)
  assert.ok(h.button('Повторити запит')); assert.equal(h.state().runs.length, 0)
  const retry = h.button('Повторити запит').props.onClick; retry(); retry(); await h.settle()
  assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]); assert.equal(h.all(node => node.props?.['data-tutor-request']).length, 1)
  h.button('Зупинити відповідь помічника').props.onClick(); await h.settle()
  assert.ok(h.button('Редагувати повідомлення')); assert.match(content(h.tree), /Очікування зупинено/)
  second.resolve(bundleFor(requests[1])); await h.settle(); assert.equal(h.state().runs.length, 0)
  h.button('Редагувати повідомлення').props.onClick(); await h.settle()
  assert.equal(input(h).props.value, requests[0].prompt); assert.ok(h.button('Прибрати формат Тест'))
  assert.equal(h.all(node => node.props?.['data-tutor-request']).length, 0)
  h.unmount()
})

test('a topic alone creates quiz and flashcards without inventing files or citations', async () => {
  for (const [message, mode] of [['Створи тест про попит і пропозицію', 'quiz'], ['Створи картки про інфляцію', 'cards']]) {
    const requests = [], h = harness({ transport: async request => { requests.push(plain(request)); return bundleFor(request) } })
    await send(h, message)
    assert.equal(requests.length, 1); assert.equal(requests[0].mode, mode); assert.deepEqual(requests[0].sources, [])
    assert.equal(h.state().runs.length, 1); assert.deepEqual(h.state().runs[0].bundle.citations, [])
    assert.doesNotMatch(content(h.tree), /Дозволь використати|Перевірити за моїми матеріалами/)
    assert.ok(h.button(mode === 'quiz' ? 'Зроби картки' : 'Створи тест'))
    h.unmount()
  }
})

test('a student can leave an own material draft aside and just talk without sending or deleting it', async () => {
  const requests = [], h = harness({ transport: async request => { requests.push(plain(request)); return bundleFor(request) } })
  ownNote(h).props.onChange({ target: { value: 'PRIVATE_NOTE_NOT_NEEDED_FOR_CONVERSATION' } }); await h.settle()
  h.button('Готово').props.onClick(); await h.settle()
  h.button('Не використовувати матеріали в повідомленні').props.onClick(); await h.settle()
  await send(h, 'Мені сьогодні самотньо, давай поговоримо')
  assert.equal(requests.length, 1); assert.equal(requests[0].mode, 'chat'); assert.deepEqual(requests[0].sources, [])
  assert.doesNotMatch(JSON.stringify(requests[0]), /PRIVATE_NOTE/)
  h.button('Додати мої матеріали').props.onClick(); await h.settle()
  assert.equal(ownNote(h).props.value, 'PRIVATE_NOTE_NOT_NEEDED_FOR_CONVERSATION')
  const consent = h.find(node => node.props?.className === 'mta-source-consent')
  assert.ok(consent); assert.equal(nodes(consent).find(node => node.type === 'input').props.checked, false)
  h.unmount()
})

test('Start opens real learning choices, conversation and exam preparation without making a model request', async()=>{
 let prepared=0,called=0
 const h=harness({startView:true,profileDisplayName:'Олег',onOpenPreparation:()=>prepared++,transport:async request=>{called++;return bundleFor(request)}})
 assert.match(content(h.tree),/Олег,/)
 assert.equal(h.all(node=>node.type==='textarea').length,1)
 h.button('Почати навчання з Xelay Mini').props.onClick({currentTarget:{focus(){}}});await h.settle()
 assert.equal(h.find(node=>node.type==='dialog').props['aria-label'],'Почати навчання з Xelay Mini')
 assert.match(content(h.tree),/Швидка допомога|Скоро іспит/)
 h.button('Розмова').props.onClick();await h.settle()
 assert.match(content(h.tree),/Файл не обов’язковий/)
 h.button('Скоро іспит?').props.onClick();await h.settle()
 h.button('Створити підготовку').props.onClick();await h.settle()
 assert.equal(prepared,1);assert.equal(called,0)
 h.unmount()
})

test('Start lesson choices prepare the actual format without requiring an attachment or fabricated generation',async()=>{
 const requests=[],h=harness({startView:true,transport:async request=>{requests.push(plain(request));return studyBundle(request)}})
 h.button('Почати навчання з Xelay Mini').props.onClick({currentTarget:{focus(){}}});await h.settle()
 h.button('Пропуски').props.onClick();await h.settle()
 assert.equal(h.find(node=>node.type==='dialog'),undefined);assert.ok(input(h))
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
 h.button('Почати навчання з Xelay Mini').props.onClick({currentTarget:{focus(){}}});await h.settle()
 h.button('Скоро іспит?').props.onClick();await h.settle()
 modal=h.find(node=>node.type==='dialog').props.ref.current
 assert.equal(modal.open,true)
 h.button('Створити підготовку').props.onClick()
 assert.equal(prepared,1);assert.equal(modal.open,false)
})

test('explicit training asks for an own source and consent once; answers from an earlier dedicated quiz keep their run ID after a follow-up', async () => {
  const requests = [], h = harness({ transport: async request => { requests.push(plain(request)); return bundleFor(request) } })
  await send(h, 'Створи тест за моїм конспектом')
  assert.equal(requests.length, 0); assert.match(content(h.tree), /додай конспект/)
  const note = ownNote(h); note.props.onChange({ target: { value: 'Проєкт має три етапи: підготовка, виконання та перевірка. Підготовка визначає мету.' } }); h.render()
  h.button('Надіслати повідомлення').props.onClick(); await h.settle(); assert.equal(requests.length, 0)
  const consent = h.find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === false); assert.ok(consent); consent.props.onChange({ target: { checked: true } }); h.render(); h.button('Надіслати повідомлення').props.onClick(); await h.settle()
  assert.equal(requests.length, 1); assert.equal(requests[0].mode, 'quiz'); const quizId = h.state().activeRunId
  await send(h, 'Дякую, тепер дай коротке пояснення')
  assert.equal(requests.length, 2, 'The unchanged selected sources retain consent across this conversation'); assert.equal(h.all(node => node.props?.className === 'mta-chat-turn').length, 2)
  await openQuiz(h); assert.equal(quizGroups(h).length, 3)
  for (let index = 0; index < 3; index++) { chooseQuiz(h, index, 0); checkQuiz(h, index) }
  h.button('Показати підсумок').props.onClick(); await h.settle()
  assert.ok(h.find(node => node.props?.['aria-label'] === 'Підсумок особистого тесту')); assert.ok(h.progress.length >= 6); assert.ok(h.progress.every(([id]) => id === quizId))
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

test('the requested artifact governs mixed plan-and-test prompts in Ukrainian, Russian and English', () => {
  for (const [plan, quiz] of [
    ['Зроби план підготовки за п’ятьма темами з тестом до кожного кроку', 'Створи тест про план підготовки до заліку'],
    ['Сделай план подготовки по пяти темам с тестом к каждому шагу', 'Сделай тест про план подготовки по пяти темам'],
    ['Make a preparation plan for five topics with a quiz at each step', 'Create a quiz about a preparation plan for five topics'],
  ]) for (const sources of [0, 1]) {
    assert.equal(conversation.inferTutorConversationMode(plan, sources), 'plan', plan)
    assert.equal(conversation.inferTutorConversationMode(quiz, sources), 'quiz', quiz)
  }
})

test('natural intent is read only from the message, while saved conversations are chronological, bounded and exclude demo context', () => {
  for (const message of ['Поясни, як створити тест за конспектом', 'Як створити тест?', 'Поясни фразу «створи тест»', 'Що таке команда «створи картки»?', 'Поясни, що таке інфляція', 'Що означає тестування гіпотез?', 'Не створюй тест, просто поясни']) assert.equal(conversation.inferTutorConversationMode(message, 0), 'chat')
  for (const [message, mode] of [['Зроби мені тест за конспектом', 'quiz'], ['Створи картки', 'cards'], ['Склади план до іспиту', 'plan']]) assert.equal(conversation.inferTutorConversationMode(message, 1), mode)
  assert.equal(conversation.inferTutorConversationMode('Розв’яжи 2x=8', 0), 'math'); assert.equal(conversation.inferTutorConversationMode('Розв’яжи задачу за конспектом', 1), 'math')
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
  await send(h, 'Етапи проєкту'); assert.equal(requests.length, 1); assert.deepEqual(requests[0].sources, []); h.button('Додати матеріали до розмови').props.onClick(); await h.settle(); h.button('Створити матеріал').props.onClick(); await h.settle(); h.button('Пропуски').props.onClick(); await h.settle()
  ownNote(h).props.onChange({ target: { value: 'Проєкт має три етапи: підготовка, виконання й перевірка.' } }); h.render()
  h.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); h.render(); h.button('Готово').props.onClick(); await h.settle(); await send(h, 'Етапи проєкту з конспекту');
  assert.equal(requests.length, 2); assert.equal(requests[1].studyFormat, 'gap_fill'); assert.equal(requests[1].mode, 'explain'); assert.ok(h.find(node => node.props?.['aria-label'] === 'Вправа з пропусками'))
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
  h.button('Надіслати повідомлення').props.onClick(); await h.settle(); assert.equal(requests.length, 1); assert.deepEqual(requests[0].sources, []); assert.equal(h.find(node => node.props?.className === 'mta-source-consent'), undefined)
  h.props.coachAction = { id: 'fresh-plan-two', type: 'plan', fresh: true, prompt: 'Склади план за моїм конспектом.', source: { title: 'Мій новий конспект', text: 'Підготовка визначає мету, виконання створює результат, перевірка зіставляє результат із метою.' } }; h.render(); await h.settle(); assert.equal(requests.length, 1); ownNote(h); await h.settle()
  const consent = h.find(node => node.type === 'input' && node.props.type === 'checkbox'); assert.ok(consent); assert.equal(consent.props.checked, false); consent.props.onChange({ target: { checked: true } }); h.render(); h.button('Готово').props.onClick(); await h.settle(); h.button('Надіслати повідомлення').props.onClick(); await h.settle()
  assert.equal(requests.length, 2); assert.equal(requests[1].conversationRunIds, undefined); assert.equal(requests[1].sources.length, 1); assert.doesNotMatch(JSON.stringify(requests[1]), /OLD_UNRELATED_NOTE/); assert.ok(workspaces.length > 0)
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
  const cases = [['true_false', 'Правда чи неправда', 'Тренувальний тест'], ['gap_fill', 'Пропуски', 'Вправа з пропусками'], ['smart_text', 'Інтерактивний урок', 'Інтерактивний урок за матеріалами'], ['written', 'Письмове тренування', 'Письмове тренування'], ['exercise', 'Практична вправа', 'Практична вправа'], ['podcast', 'Навчальний діалог', 'Навчальний діалог для прослуховування']]
  for (const [format, label, widget] of cases) {
    const requests = [], h = harness({ transport: async request => { requests.push(plain(request)); return studyBundle(request) } })
    h.button('Додати матеріали до розмови').props.onClick(); await h.settle(); h.button('Створити матеріал').props.onClick(); await h.settle(); h.button(label).props.onClick(); await h.settle(); assert.ok(h.button('Прибрати формат ' + label))
    ownNote(h).props.onChange({ target: { value: tutor.DEMO_TUTOR_SOURCE.text } }); h.render(); h.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); h.render(); h.button('Готово').props.onClick(); await h.settle(); await send(h, 'Попит і ціна')
    assert.equal(requests.length, 1, format); assert.equal(requests[0].studyFormat, format); assert.equal(requests[0].mode, format === 'true_false' ? 'quiz' : 'explain'); assert.ok(h.find(node => node.props?.['aria-label'] === widget), format); assert.equal(h.state().runs[0].progress.version, 2)
    if (format === 'true_false') { await openQuiz(h); assert.equal(quizGroups(h).length, 1); assert.equal(nodes(quizGroups(h)[0]).filter(node => node.type === 'button').length, 2) }
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
  for (const mode of ['quiz', 'cards', 'plan']) {
    const run = savedRun('visible-' + mode, mode), h = harness({ initialState: { version: 1, runs: [run], activeRunId: run.id } })
    assert.equal(conversation.tutorConversationScrollTarget(run), mode)
    assert.ok(h.scrollTargets.includes(mode === 'plan' ? '.mtp' : mode === 'quiz' ? '.mta-quiz-launcher' : '.mta-' + mode)); assert.ok(h.scrolls.length > 0); assert.ok(h.scrolls.every(scroll => scroll.target === 'mta-chat-stream' && scroll.top < 1000), 'Opening a tall training must not reveal only its footer')
    const count = h.scrolls.length
    if (mode === 'quiz') { await openQuiz(h); chooseQuiz(h, 0, 0); h.button('Закрити вікно тесту').props.onClick(); await h.settle() }
    else if (mode === 'cards') h.button('Показати відповідь картки').props.onClick(); else h.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange()
    h.render(); assert.equal(h.scrolls.length, count, 'Progress rerenders keep the student’s current reading position')
    h.button('Відкрити історію розмов').props.onClick(); await h.settle(); h.button(run.bundle.title).props.onClick(); await h.settle(); assert.ok(h.scrolls.length > count); assert.ok(h.scrolls.at(-1).top < 1000)
    h.unmount()
  }
})


test('dedicated test and fullscreen cards keep their original run and saved draft when returning to chat', async () => {
  for (const mode of ['quiz', 'cards']) {
    const run = savedRun('fullscreen-' + mode, mode), h = harness({ initialState: { version: 1, runs: [run], activeRunId: run.id } }); let returnedFocus = 0
    if (mode === 'quiz') {
      const launcher = h.find(node => node.props?.['data-training-open'] === 'quiz'); h.focus(launcher); const initialFocus = h.activeElement(); await openQuiz(h)
      assert.equal(h.find(node => node.props?.className === 'mqq-dialog').props.ref.current.open, true); assert.equal(quizGroups(h).length, 3)
      chooseQuiz(h, 0, 0); checkQuiz(h, 0); chooseQuiz(h, 1, 0)
      h.button('Закрити вікно тесту').props.onClick(); await h.settle(); assert.equal(h.find(node => node.props?.className === 'mqq-dialog'), undefined); assert.equal(h.activeElement(), initialFocus)
      assert.ok(h.progress.every(([id]) => id === run.id)); const restored = tutor.parseTutorState(JSON.stringify(h.state())).runs[0]; assert.deepEqual(plain(restored.progress.submitted), ['q-price']); assert.equal(restored.progress.answers['q-value'], 0)
      await openQuiz(h); assert.equal(quizGroups(h).length, 3); assert.equal(nodes(quizGroups(h)[1]).filter(node => node.type === 'button')[0].props['aria-pressed'], true)
    } else {
      h.button('Відкрити картки на весь екран').props.onClick({ currentTarget: { focus() { returnedFocus++ } } }); await h.settle()
      assert.equal(h.find(node => node.props?.className === 'mta-training-dialog').props.ref.current.open, true); h.button('Показати відповідь картки').props.onClick(); h.render(); assert.ok(h.button('Показати запитання картки'))
      h.button('Повернутися до чату з тренування').props.onClick(); await h.settle(); assert.equal(h.find(node => node.props?.className === 'mta-training-dialog'), undefined); assert.equal(returnedFocus, 1)
      assert.ok(h.button('Показати запитання картки')); h.button('Пам’ятаю').props.onClick(); await h.settle(); assert.equal(h.state().runs[0].progress.cardRatings['card-demand'], 'known'); assert.ok(h.progress.every(([id]) => id === run.id))
    }
    h.unmount()
  }
})

test('every fullscreen activity exposes pending or failed saves inside its own dialog and keeps progress on recovery', async () => {
  for (const format of ['quiz', 'cards', 'smart_text']) {
    const run = format === 'smart_text' ? savedStudyRun('save-state-reading', format) : savedRun('save-state-' + format, format)
    const h = harness({ initialState: { version: 1, runs: [run], activeRunId: run.id }, saveState: { saving: true, error: '' } })
    if (format === 'quiz') await openQuiz(h); else { h.button(format === 'cards' ? 'Відкрити картки на весь екран' : 'Відкрити урок').props.onClick({ currentTarget: { focus() {} } }); await h.settle() }
    const dialogClass = format === 'quiz' ? 'mqq-dialog' : format === 'smart_text' ? 'mta-lesson-dialog' : 'mta-training-dialog'
    let dialog = h.find(node => node.props?.className === dialogClass); assert.ok(dialog)
    assert.match(content(nodes(dialog).find(node => String(node.props?.className || '').includes(format === 'quiz' ? 'mqq-save' : 'mta-native-save-state'))), /Зберігаємо/)
    if (format === 'quiz') chooseQuiz(h, 0, 0)
    else if (format === 'cards') { h.button('Показати відповідь картки').props.onClick(); h.render(); h.button('Пам’ятаю').props.onClick(); h.render() }
    else { h.button('Почати').props.onClick(); h.render(); h.button('Далі').props.onClick(); h.render() }
    const priorProgress = plain(h.state().runs[0].progress)
    h.props.saveState = { saving: false, error: 'SYNTHETIC_SAVE_FAILURE' }; h.render(); dialog = h.find(node => node.props?.className === dialogClass)
    const warning = nodes(dialog).find(node => node.props?.role === 'alert'); assert.ok(warning, 'A save failure remains visible while the outside chat is inert'); assert.match(content(warning), /SYNTHETIC_SAVE_FAILURE/)
    assert.match(content(warning), format === 'quiz' ? /Не закривай вкладку/ : /лише на цьому пристрої/)
    assert.doesNotMatch(content(dialog), /Прогрес зберігається|успішно збережено|Стан збереження — над чатом/iu)
    nodes(warning).find(node => node.type === 'button').props.onClick(); await h.settle(); assert.equal(h.find(node => node.props?.className === dialogClass), undefined)
    assert.deepEqual(h.state().runs[0].progress, priorProgress); assert.ok(h.progress.every(([id]) => id === run.id)); h.unmount()
  }
})

test('each preparation step opens its three actual questions in the shared workspace and saves to the original plan without model calls', async () => {
 const run=savedRun('dedicated-plan-steps','plan'),original=run.bundle.questions
 run.bundle.questions=[...original,...original.map(question=>({...question,id:question.id+'-second'}))]
 run.bundle.plan=run.bundle.plan.slice(0,2).map((step,index)=>({...step,questionIds:run.bundle.questions.slice(index*3,index*3+3).map(question=>question.id)}))
 let calls=0;const h=harness({initialState:{version:1,runs:[run],activeRunId:run.id},transport:async()=>{calls++;throw Error('No generation expected')}})
 h.button('Почати тест кроку').props.onClick();await h.settle();assert.equal(quizGroups(h).length,3)
 assert.deepEqual(h.all(node=>node.props?.['data-quiz-question']).map(node=>node.props['data-quiz-question']),Array.from(original,question=>question.id))
 chooseQuiz(h,0,0);checkQuiz(h,0);h.button('Закрити вікно тесту').props.onClick();await h.settle()
 assert.deepEqual(h.state().runs[0].progress.submitted,['q-price']);assert.ok(h.progress.every(([id])=>id===run.id));assert.ok(h.find(node=>node.type==='input'&&node.props.type==='checkbox'),'plan task controls stay available')
 h.button(run.bundle.plan[1].label).props.onClick();await h.settle();h.button('Почати тест кроку').props.onClick();await h.settle()
 assert.equal(quizGroups(h).length,3);assert.deepEqual(h.all(node=>node.props?.['data-quiz-question']).map(node=>node.props['data-quiz-question']),Array.from(original,question=>question.id+'-second'))
 assert.equal(nodes(quizGroups(h)[0]).filter(node=>node.type==='button'&&node.props['aria-pressed']).length,0);assert.equal(calls,0);h.unmount()
})
