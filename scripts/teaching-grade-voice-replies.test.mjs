// Voice reply integration against actual teaching UI/repository source.
// All identities, storage bytes and React hooks are local synthetic fixtures.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url)), native = createRequire(import.meta.url)
const plain = value => JSON.parse(JSON.stringify(value))
const jsx = (type, props, key) => ({ type, props, key })
const runtime = { jsx, jsxs: jsx, Fragment: 'fragment' }
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
const text = tree => tree == null || typeof tree === 'boolean' ? '' : Array.isArray(tree) ? tree.map(text).join('') : typeof tree === 'object' ? text(tree.props?.children) : String(tree)
const source = readFileSync(resolve(root, 'src/components/teaching/TeachingGradeRequests.tsx'), 'utf8') + '\nexport { GradeRequestReply };\n'
const request = { id: randomUUID(), course_id: randomUUID(), course_title: 'Математика', group_id: randomUUID(), group_name: 'Тестова група', activity_id: randomUUID(), activity_title: 'Семінар', user_id: randomUUID(), student_name: 'Тестова студентка', message: 'Прошу уточнити бали', status: 'open', response: '', version: 1, created_at: '2026-10-28T08:00:00Z', can_manage: true, can_resolve: true }
const teacher = randomUUID()
const recording = () => ({ file: new File([new Uint8Array(16)], 'voice.webm', { type: 'audio/webm' }), durationSeconds: 5 })
const descriptor = (row = request) => ({ storage_path: `${row.id}/${teacher}/${randomUUID()}.webm`, mime_type: 'audio/webm', size: 16, duration_seconds: 5 })

function runner() {
  let index = 0, dirty = false, component, props, tree
  const cells = [], effects = []
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = index++; cells[i] ??= { current: initial }; return cells[i] },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const prior = cells[i]; cells[i] = { deps }; effects.push(() => { prior?.cleanup?.(); cells[i].cleanup = callback() }) } },
    useCallback(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, callback }; return cells[i].callback },
  }
  const render = () => {
    for (let pass = 0; pass < 25; pass++) { index = 0; dirty = false; tree = component(props); effects.splice(0).forEach(effect => effect()); if (!dirty) return tree }
    throw Error('Unstable fixture render')
  }
  return { react, start(next, input) { component = next; props = input; return render() }, render,
    get tree() { return tree }, get props() { return props },
    async settle() { for (let pass = 0; pass < 12; pass++) { await Promise.resolve(); render() } },
    find(predicate) { const value = nodes(tree).find(predicate); assert.ok(value, 'Expected rendered element'); return value },
    button(label) { return this.find(node => ['TeachingButton', 'button'].includes(node.type) && text(node) === label) },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}

function uiFixture(component = 'TeachingGradeRequests', overrides = {}) {
  const run = runner(), writes = [], uploads = [], discards = [], saved = []
  const repository = {
    mode: 'local', gradeRequests: async () => ({ requests: [request], available_activities: [] }),
    async resolveGradeRequest(...args) { writes.push(args); return { id: request.id, version: 2 } },
    async uploadGradeVoice(...args) { uploads.push(args); args[3]?.(100); return descriptor() },
    async discardGradeVoice(...args) { discards.push(args) },
    ...overrides.repository,
  }
  const imports = {
    react: run.react, 'react/jsx-runtime': runtime,
    'lucide-react': new Proxy({}, { get: (_, name) => String(name) }),
    '../../lib/teaching': { teachingDate: value => value || '—', teachingError: error => error.message },
    '../../lib/useTeachingVisibilityRefresh': { useTeachingVisibilityRefresh() {} },
    './TeachingUI': { TeachingButton: 'TeachingButton', TeachingEmpty: 'TeachingEmpty', TeachingField: 'TeachingField', TeachingModal: 'TeachingModal', teachingInput: 'input' },
    './TeachingVoiceRecorder': { TeachingVoiceRecorder: 'TeachingVoiceRecorder' },
    './TeachingGradeVoicePlayer': { TeachingGradeVoicePlayer: 'TeachingGradeVoicePlayer' },
    './teaching-workflow.css': {},
  }
  const module = { exports: {} }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, crypto: { randomUUID }, AbortController, DOMException,
    require(name) { assert.ok(name in imports, `Known offline import ${name}`); return imports[name] } })
  const props = { repository, userId: teacher, mode: 'teacher', request, isCurrent: () => true, onSaved: async () => saved.push(true), onClose() {}, ...overrides.props }
  run.start(module.exports[component], props)
  return { ...run, get tree() { return run.tree }, get props() { return run.props }, writes, uploads, discards, saved, repository,
    api: module.exports, run,
    setText(value) { run.find(node => node.type === 'textarea').props.onChange({ target: { value } }); run.render() },
    setRecording(value = recording()) { run.find(node => node.type === 'TeachingVoiceRecorder').props.onChange(value); run.render(); return value },
    async send() { const pending = run.button('Надіслати відповідь').props.onClick(); await pending; await run.settle() },
  }
}

function localFixture() {
  const modules = new Map(), storage = new Map(), events = new EventTarget()
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-28T10:00:00Z'])) } static now() { return Date.parse('2026-10-28T10:00:00Z') } }
  Object.assign(events, { setTimeout, clearTimeout, setInterval, clearInterval })
  function load(path) {
    const filename = resolve(root, path)
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    const code = ts.transpileModule(readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    vm.runInNewContext(code, { module, exports: module.exports, structuredClone, crypto, Date: ClockDate, URL, Blob, File,
      AbortController, DOMException, TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval, window: events,
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
      fetch() { throw Error('No provider traffic allowed') },
      require(name) {
        if (name.endsWith('/supabase') || name === './supabase') return { supabase: new Proxy({}, { get() { throw Error('No provider traffic allowed') } }) }
        if (name.startsWith('.')) return load(resolve(dirname(filename), name + (name.endsWith('.ts') || name.endsWith('.tsx') ? '' : '.ts')))
        return native(name)
      },
    }, { filename })
    return module.exports
  }
  const api = load('src/lib/localTeachingRepository.ts')
  const owner = api.createLocalTeachingRepository('teacher'), student = api.createLocalTeachingRepository('student'), head = api.createLocalTeachingRepository('head')
  const prior = api.LOCAL_TEACHING_IDENTITIES.head
  api.LOCAL_TEACHING_IDENTITIES.head = { userId: '00000000-0000-4000-8000-000000000005', fullName: 'Other synthetic student' }
  const otherStudent = api.createLocalTeachingRepository('head')
  api.LOCAL_TEACHING_IDENTITIES.head = prior
  return { api, owner, student, head, otherStudent, ownerId: api.LOCAL_TEACHING_IDENTITIES.teacher.userId,
    cleanup() { api.resetLocalTeachingPreview() } }
}

test('only the teacher reply composer contains a recorder; student mode ignores even forged can_resolve flags', async () => {
  const teacherList = uiFixture(); await teacherList.settle()
  assert.ok(!nodes(teacherList.tree).some(node => node.type === 'TeachingVoiceRecorder'))
  teacherList.button('Відповісти').props.onClick(); teacherList.render()
  assert.ok(nodes(teacherList.tree).some(node => typeof node.type === 'function' && node.type.name === 'GradeRequestReply'))
  const reply = uiFixture('GradeRequestReply')
  assert.ok(nodes(reply.tree).some(node => node.type === 'TeachingVoiceRecorder'))
  const studentList = uiFixture('TeachingGradeRequests', { props: { mode: 'student', userId: request.user_id } }); await studentList.settle()
  assert.ok(!nodes(studentList.tree).some(node => node.type === 'TeachingVoiceRecorder' || typeof node.type === 'function' && node.type.name === 'GradeRequestReply'))
  assert.ok(!nodes(studentList.tree).some(node => ['TeachingButton', 'button'].includes(node.type) && text(node) === 'Відповісти'))
  assert.equal(studentList.writes.length, 0)
})

test('voice-only UI reply uploads once, uses the current version and preserves the ordinary text-only path', async () => {
  const fx = uiFixture('GradeRequestReply'), audio = fx.setRecording()
  await fx.send()
  assert.equal(fx.uploads.length, 1); assert.equal(fx.uploads[0][0], request.id); assert.equal(fx.uploads[0][1], teacher); assert.equal(fx.uploads[0][2], audio)
  assert.equal(fx.writes.length, 1); assert.equal(fx.writes[0][0], request.id); assert.equal(fx.writes[0][1], 1); assert.equal(fx.writes[0][2], ''); assert.ok(fx.writes[0][3].storage_path)
  assert.equal(fx.saved.length, 1)
  fx.unmount(); assert.equal(fx.discards.length, 0, 'Confirmed sent voice is retained')
  const textOnly = uiFixture('GradeRequestReply', { repository: { uploadGradeVoice: undefined } })
  assert.ok(!nodes(textOnly.tree).some(node => node.type === 'TeachingVoiceRecorder'))
  textOnly.setText('Бали враховано.'); await textOnly.send()
  assert.deepEqual(plain(textOnly.writes[0]), [request.id, 1, 'Бали враховано.', null]); assert.equal(textOnly.uploads.length, 0)
})

test('recording in progress blocks submission and an uncertain reply reuses its uploaded voice', async () => {
  const busy = uiFixture('GradeRequestReply'); busy.setRecording()
  busy.find(node => node.type === 'TeachingVoiceRecorder').props.onRecordingChange(true); busy.render()
  assert.equal(busy.button('Надіслати відповідь').props.disabled, true)
  await busy.send(); assert.equal(busy.uploads.length, 0); assert.equal(busy.writes.length, 0)
  const attempts = []
  const fx = uiFixture('GradeRequestReply', { repository: { async resolveGradeRequest(...args) { attempts.push(args); if (attempts.length === 1) throw Error('Uncertain reply receipt'); return {} } } })
  fx.setRecording(); await fx.send(); await fx.send()
  assert.equal(fx.uploads.length, 1); assert.equal(attempts.length, 2)
  assert.deepEqual(plain(attempts[0]), plain(attempts[1])); assert.equal(fx.saved.length, 1)
})

test('account and repository changes during an upload abort the old composer and prevent resolution', async () => {
  for (const change of ['account', 'repository']) {
    let finishUpload, observedSignal
    const list = uiFixture(); await list.settle()
    list.button('Відповісти').props.onClick(); list.render()
    const node = nodes(list.tree).find(node => typeof node.type === 'function' && node.type.name === 'GradeRequestReply')
    const reply = uiFixture('GradeRequestReply', { props: { isCurrent: node.props.isCurrent }, repository: {
      async uploadGradeVoice(_id, _user, _recording, _progress, signal) { observedSignal = signal; return new Promise(resolve => { finishUpload = resolve }) },
    } })
    reply.setRecording(); reply.button('Надіслати відповідь').props.onClick(); await reply.settle()
    if (change === 'account') list.props.userId = randomUUID()
    else list.props.repository = { ...list.repository }
    list.render(); reply.unmount(); assert.equal(observedSignal.aborted, true)
    finishUpload(descriptor()); await reply.settle()
    assert.equal(reply.writes.length, 0, `Stale ${change} composer cannot resolve`)
  }
})

test('actual local voice reply is private, versioned and cannot be deleted after attachment', async () => {
  const fx = localFixture()
  try {
    const row = (await fx.owner.gradeRequests()).requests.find(row => row.status === 'open')
    assert.ok(row)
    const voice = await fx.owner.uploadGradeVoice(row.id, fx.ownerId, recording())
    const first = await fx.owner.resolveGradeRequest(row.id, row.version, '', voice)
    assert.equal(first.version, row.version + 1)
    const saved = (await fx.student.gradeRequests()).requests.find(item => item.id === row.id)
    assert.equal(saved.status, 'resolved'); assert.equal(saved.response, ''); assert.deepEqual(plain(saved.response_voice), plain(voice))
    assert.match(await fx.student.gradeVoiceUrl(row.id, voice), /^blob:/)
    await assert.rejects(fx.head.gradeVoiceUrl(row.id, voice), /FORBIDDEN/)
    await assert.rejects(fx.otherStudent.gradeVoiceUrl(row.id, voice), /FORBIDDEN/)
    await assert.rejects(fx.owner.discardGradeVoice(row.id, voice), /FORBIDDEN/)
    const replay = await fx.owner.resolveGradeRequest(row.id, row.version, '', voice)
    assert.deepEqual(plain(replay), plain(first))
    await assert.rejects(fx.owner.resolveGradeRequest(row.id, row.version, 'Changed reply', voice), /CONFLICT/)
  } finally { fx.cleanup() }
})

test('actual local repository denies student/head voice mutations and retains text-only replies', async () => {
  const fx = localFixture()
  try {
    const row = (await fx.owner.gradeRequests()).requests.find(row => row.status === 'open')
    for (const [repository, actor] of [[fx.student, fx.api.LOCAL_TEACHING_IDENTITIES.student.userId], [fx.head, fx.api.LOCAL_TEACHING_IDENTITIES.head.userId]]) {
      await assert.rejects(repository.uploadGradeVoice(row.id, actor, recording()), /FORBIDDEN/)
      await assert.rejects(repository.resolveGradeRequest(row.id, row.version, 'Forged teacher answer'), /FORBIDDEN/)
    }
    await fx.owner.resolveGradeRequest(row.id, row.version, 'Ваші бали враховано.')
    const saved = (await fx.student.gradeRequests()).requests.find(item => item.id === row.id)
    assert.equal(saved.response, 'Ваші бали враховано.'); assert.equal(saved.response_voice, null)
  } finally { fx.cleanup() }
})
