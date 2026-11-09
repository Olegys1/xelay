import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const origin = 'https://fictional-xelay.example'

function workerFixture({ status, shell = true } = {}) {
  const listeners = new Map(), fetches = [], cacheReads = []
  const build = '1234567890abcdef12345678'
  runInNewContext(read('public/push-sw.js').replace('__XELAY_OFFLINE_SHELL_BUILD_ID__', build), {
    self: { location: new URL(origin + '/push-sw.js'), addEventListener: (name, handler) => listeners.set(name, handler) },
    URL, Request, Response, AbortController, setTimeout, clearTimeout,
    fetch: async request => {
      fetches.push(request.url)
      if (!status) throw new TypeError('Synthetic network failure')
      return new Response('Network response', { status })
    },
    caches: { async open() { return { async match(request) {
      const url = typeof request === 'string' ? request : request.url
      cacheReads.push(url)
      if (shell && url === origin + '/__xelay_public_shell_meta__') return Response.json({ version: build, urls: [origin + '/index.html'] })
      return shell && url === origin + '/index.html' ? new Response('Synthetic public shell') : undefined
    } } } },
  })
  function request(path, { method = 'GET', mode = 'navigate', headers } = {}) {
    let result
    listeners.get('fetch')({
      request: { url: new URL(path, origin).href, method, mode, headers: new Headers(headers) },
      respondWith: promise => { result = promise },
    })
    return result
  }
  return { request, fetches, cacheReads }
}

test('exact teaching navigation falls back to the saved teacher view without a redirect loop', async () => {
  const worker = workerFixture()
  const fallback = await worker.request('/teaching?home=calendar')
  assert.equal(fallback.status, 302)
  assert.equal(fallback.headers.get('location'), origin + '/offline?view=teaching')
  const reader = await worker.request(fallback.headers.get('location'))
  assert.equal(reader.status, 200)
  assert.equal(await reader.text(), 'Synthetic public shell')
  assert.equal(reader.headers.get('location'), null)
  assert.equal((await worker.request('/groups')).headers.get('location'), origin + '/offline')
  assert.ok(worker.cacheReads.includes(origin + '/index.html'))
  assert.ok(worker.cacheReads.every(url => [origin + '/index.html', origin + '/__xelay_public_shell_meta__'].includes(url)))
})

test('live responses are authoritative and only network or server failure can use the public shell', async () => {
  for (const status of [200, 401, 403, 404, 503]) {
    const worker = workerFixture({ status })
    const response = await worker.request('/teaching')
    assert.equal(response.status, status === 503 ? 302 : status)
    if (status === 503) assert.ok(worker.cacheReads.includes(origin + '/index.html'))
    else assert.deepEqual(worker.cacheReads, [])
  }
  const missing = workerFixture({ status: 503, shell: false })
  assert.equal((await missing.request('/teaching')).status, 503)
  await assert.rejects(workerFixture({ shell: false }).request('/teaching'), /Synthetic network failure/)
})

test('teaching fallback does not handle private APIs, document ranges, auth callbacks or adjacent routes', () => {
  const worker = workerFixture()
  for (const [path, options] of [
    ['/teaching/'], ['/teaching/private'], ['/teaching?code=fictional'], ['/teaching?access_token=fictional'],
    ['/teaching?STATE=fictional'], ['/offline?view=teaching&refresh_token=fictional'],
    ['/api/security/media-cleanup?xelay_media_route=teaching-material-view'],
    ['/api/security/media-cleanup?xelay_media_route=teaching-material-view', { method: 'POST', mode: 'cors' }],
    ['/teaching', { method: 'POST' }], ['/teaching', { mode: 'cors' }],
    ['/teaching', { headers: { Authorization: 'Bearer fictional' } }],
    ['/teaching', { headers: { Range: 'bytes=0-16' } }],
    ['https://fictional-other.example/teaching'],
  ]) assert.equal(worker.request(path, options), undefined, path)
  assert.deepEqual(worker.fetches, [])
  assert.deepEqual(worker.cacheReads, [])
})

const jsx = (type, props) => ({ type, props: props || {} })
const text = value => value == null || typeof value === 'boolean' ? '' : Array.isArray(value) ? value.map(text).join(' ') : typeof value === 'object' ? text(value.props?.children) : String(value)
const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]
function uiFixture(path, name, dependencies, props, extraExport = '') {
  const cells = [], effects = [], listeners = new Map()
  let index, dirty, tree
  const same = (a, b) => Boolean(a && b && a.length === b.length && a.every((value, key) => Object.is(value, b[key])))
  const react = {
    useState(initial) {
      const slot = index++
      const cell = cells[slot] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [cell.value, next => {
        const value = typeof next === 'function' ? next(cell.value) : next
        if (!Object.is(cell.value, value)) { cell.value = value; dirty = true }
      }]
    },
    useRef(initial) { const slot = index++; return cells[slot] ??= { current: initial } },
    useMemo(factory, dependencies) {
      const slot = index++
      if (!same(cells[slot]?.dependencies, dependencies)) cells[slot] = { dependencies, value: factory() }
      return cells[slot].value
    },
    useEffect(effect, dependencies) {
      const slot = index++
      const previous = cells[slot]
      if (!same(previous?.dependencies, dependencies)) {
        const current = { dependencies }
        cells[slot] = current
        effects.push(() => { previous?.cleanup?.(); current.cleanup = effect() })
      }
    },
  }
  const module = { exports: {} }
  const source = ts.transpileModule(read(path) + extraExport, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': new Proxy({}, { get: (_, key) => String(key) }),
    ...dependencies,
  }
  runInNewContext(source, {
    module, exports: module.exports, AbortController, Date, Intl, navigator: { onLine: true },
    window: {
      addEventListener(name, listener) {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name).add(listener)
      },
      removeEventListener: (name, listener) => listeners.get(name)?.delete(listener),
      setTimeout: () => 1,
      clearTimeout() {},
    },
    require(importName) { assert.ok(Object.hasOwn(imports, importName), 'Synthetic import: ' + importName); return imports[importName] },
  })
  const component = module.exports[name]
  function render() {
    for (let pass = 0; pass < 15; pass++) {
      index = 0; dirty = false
      tree = component(props)
      effects.splice(0).forEach(effect => effect())
      if (!dirty) return tree
    }
    throw Error('UI did not settle')
  }
  render()
  return {
    render, get tree() { return tree },
    dispatch(name) { for (const listener of listeners.get(name) || []) listener() },
    click(label) {
      const control = nodes(tree).find(node => ['TeachingButton', 'button'].includes(node.type) && text(node).trim() === label)
      assert.ok(control, 'Expected control: ' + label)
      return control.props.onClick()
    },
    async settle() { for (let pass = 0; pass < 10; pass++) { await Promise.resolve(); render() } },
    dispose() { for (const cell of cells) cell?.cleanup?.() },
  }
}

const changed = 'xelay:offline-study-changed'
const teacherOwner = { id: 'synthetic-teacher', sessionId: 'first-receipt', displayName: 'Вигадана викладачка' }
const now = new Date()
const rangeStart = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
const savedAt = now.toISOString()
const teacherCopy = {
  ownerId: teacherOwner.id, sessionId: teacherOwner.sessionId, savedAt,
  expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), rangeStart, rangeEnd: rangeStart,
  lessons: [{
    id: 'synthetic-lesson', groupId: 'synthetic-group', groupName: 'Вигадана група', subject: 'Вища математика',
    date: rangeStart, startsAt: '09:40', endsAt: '11:00', lessonType: 'seminar', location: 'Ауд. 4',
    conference_access_code: 'PRIVATE_CONFERENCE_CODE',
    homework: [{ title: 'Вигадане завдання', dueAt: savedAt, body: 'PRIVATE_HOMEWORK_BODY', attachments: ['PRIVATE_ATTACHMENTS'] }],
  }],
}

test('the calendar saves only after explicit device confirmation with the current owner receipt', async () => {
  let owner = teacherOwner
  const captures = []
  const pending = Promise.withResolvers()
  const ui = uiFixture('src/components/teaching/TeachingOfflineCalendar.tsx', 'TeachingOfflineCalendar', {
    '../../lib/offlineStudy': {
      getOfflineOwner: async () => owner, loadOfflineTeacherCalendar: async () => null,
      OFFLINE_STUDY_CHANGED: changed, OFFLINE_STUDY_DAYS: 14,
    },
    '../../lib/offlineTeacherCapture': {
      captureOfflineTeacherCalendar(input) { captures.push(input); return pending.promise },
      offlineTeacherCaptureError: error => error.message,
    },
    '../../lib/teaching': { teachingDate: value => value },
    './TeachingUI': { TeachingButton: 'TeachingButton' },
  }, { userId: teacherOwner.id })
  ui.click('Зберегти офлайн')
  ui.render()
  assert.match(text(ui.tree), /лише на своєму пристрої/)
  assert.equal(captures.length, 0)
  ui.click('Скасувати')
  ui.render()
  assert.equal(captures.length, 0)
  ui.click('Зберегти офлайн')
  ui.render()
  owner = { ...teacherOwner, id: 'other-synthetic-account' }
  ui.click('Зберегти на цьому пристрої')
  await ui.settle()
  assert.equal(captures.length, 0)
  assert.match(text(ui.tree), /OFFLINE_OWNER_CHANGED/)
  owner = teacherOwner
  ui.click('Зберегти на цьому пристрої')
  ui.click('Зберегти на цьому пристрої')
  await ui.settle()
  assert.equal(captures.length, 1)
  assert.equal(captures[0].userId, teacherOwner.id)
  assert.equal(captures[0].sessionId, teacherOwner.sessionId)
  pending.resolve(teacherCopy)
  await ui.settle()
  assert.match(text(ui.tree), /Офлайн-копію розкладу збережено/)
  assert.equal(nodes(ui.tree).find(node => node.type === 'a').props.href, '/offline?view=teaching')
  ui.dispose()
})

test('an in-flight teacher read cannot display the previous account copy after a session change', async () => {
  let owner = teacherOwner
  const pending = Promise.withResolvers()
  const ui = uiFixture('src/components/OfflineStudyReader.tsx', 'OfflineStudyReader', {
    '../lib/offlineStudy': {
      OFFLINE_STUDY_CHANGED: changed, OFFLINE_STUDY_DAYS: 14, getOfflineOwner: async () => owner,
      listOfflineGroups: async () => [], loadOfflineTeacherCalendar: () => pending.promise,
      offlineStudyError: error => error.message,
    },
  }, { ownerId: teacherOwner.id, initialView: 'teaching' })
  await ui.settle()
  owner = { ...teacherOwner, sessionId: 'new-receipt' }
  pending.resolve(teacherCopy)
  await ui.settle()
  const child = nodes(ui.tree).find(node => typeof node.type === 'function' && node.type.name === 'TeacherScheduleCopy')
  assert.ok(child)
  assert.equal(child.props.snapshot, null)
  assert.doesNotMatch(text(ui.tree), /Вигадана викладачка|Вигадана група/)
  ui.dispose()
})

test('the saved teacher view renders only lesson details, assignment title and deadline and asks before removal', () => {
  let deletes = 0
  const ui = uiFixture('src/components/OfflineStudyReader.tsx', 'TeacherScheduleCopy', {
    '../lib/offlineStudy': {},
  }, { snapshot: teacherCopy, online: false, clearing: false, onClear: async () => { deletes++ } }, '\nexport { TeacherScheduleCopy };')
  assert.match(text(ui.tree), /Вища математика/)
  assert.match(text(ui.tree), /Вигадана група/)
  assert.match(text(ui.tree), /Вигадане завдання/)
  assert.match(text(ui.tree), /Здати до/)
  assert.doesNotMatch(text(ui.tree), /PRIVATE_CONFERENCE_CODE|PRIVATE_HOMEWORK_BODY|PRIVATE_ATTACHMENTS/)
  assert.equal(nodes(ui.tree).some(node => node.type === 'a'), false)
  ui.click('Прибрати копію розкладу')
  ui.render()
  assert.equal(deletes, 0)
  ui.click('Прибрати копію')
  assert.equal(deletes, 1)
  ui.dispose()
})
