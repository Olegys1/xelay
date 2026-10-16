// Real UI/controller callbacks with synthetic browser objects; no provider traffic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as runtime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const root = new URL('../../', import.meta.url)
const notice = await readFile(new URL('src/components/StudyGroupJoinNotice.tsx', root), 'utf8')
const controller = await readFile(new URL('src/components/StudyGroupJoinReminder.tsx', root), 'utf8')
const helper = await readFile(new URL('src/lib/studyGroupJoinReminder.ts', root), 'utf8')
const css = await readFile(new URL('src/components/studyGroupJoinNotice.css', root), 'utf8')
const app = await readFile(new URL('src/App.tsx', root), 'utf8')
const parse = (name, source) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const noticeAst = parse('StudyGroupJoinNotice.tsx', notice)
const controllerAst = parse('StudyGroupJoinReminder.tsx', controller)
const compile = code => ts.transpileModule(code, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
} }).outputText
const icon = () => React.createElement('svg', { 'aria-hidden': true })
const ui = {}
vm.runInNewContext(compile(notice), {
  exports: ui, document: { body: {} },
  require(name) {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return runtime
    if (name === 'react-dom') return { createPortal: children => children }
    if (name === 'lucide-react') return new Proxy({}, { get: () => icon })
    if (name === './studyGroupJoinNotice.css') return {}
    throw new Error('Unexpected UI import ' + name)
  },
})

const props = {
  username: 'student', pendingInvites: false,
  onDisplayed() {}, onClose() {}, onOpenGroups() {}, onOpenProfile() {},
}
const html = overrides => renderToStaticMarkup(React.createElement(ui.StudyGroupJoinNotice, { ...props, ...overrides }))

function functionNode(ast, name) {
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(fn, 'Actual component exists: ' + name)
  return fn
}
function expression(ast, component, name) {
  const init = functionNode(ast, component).body.statements.filter(ts.isVariableStatement)
    .flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(ast) === name)?.initializer
  assert.ok(init, 'Actual callback exists: ' + component + '.' + name)
  return ts.isCallExpression(init) ? init.arguments[0] : init
}
function executeExpression(ast, expr, context) {
  return vm.runInNewContext(compile(`(context) => { const {${Object.keys(context).join(',')}} = context; return ${expr.getText(ast)} }`))(context)
}
function callback(ast, component, name, context) {
  return executeExpression(ast, expression(ast, component, name), context)
}
function copyFixture(overrides = {}) {
  const events = [], copied = []
  const context = {
    nickname: '@student', currentNickname: { current: '@student' },
    copyBusy: { current: false }, mounted: { current: true },
    setCopyState: value => events.push(value),
    nicknameRef: { current: { focus: () => events.push('focus'), select: () => events.push('select') } },
    navigator: { clipboard: { writeText: async text => { copied.push(text) } } }, ...overrides,
  }
  return { context, events, copied, copy: callback(noticeAst, 'StudyGroupJoinNotice', 'copyNickname', context) }
}

test('default notice explains the complete free group invitation flow and displays the normalized own nickname', () => {
  const result = html({ username: '  @@student.name  ' })
  assert.match(result, /Приєднайтеся до своєї навчальної групи/)
  assert.match(result, /Надішліть свій нік у Xelay старості/)
  assert.match(result, /прийміть запрошення в розділі «Мої групи»/)
  assert.match(result, /Розклад, домашні завдання, семінари й матеріали/)
  assert.match(result, /безкоштовно для всіх учасників/)
  assert.match(result, /value="@student\.name"/)
  assert.match(result, /Скопіювати нік/)
  assert.match(result, /Відкрити «Мої групи»/)
  assert.match(result, /Зрозуміло/)
  assert.doesNotMatch(result, /@{2,}student/)
})

test('pending invitation variant directs users to accept the existing invitation instead of resending their nickname', () => {
  const result = html({ pendingInvites: true })
  assert.match(result, /Вас уже запросили до навчальної групи/)
  assert.match(result, /прийміть запрошення від старости/)
  assert.match(result, /Відкрити «Мої групи»/)
  assert.doesNotMatch(result, /Скопіювати нік|Ваш нік для старости|Надішліть свій нік|<input/)
})

test('missing nickname offers the profile editor and never invents a nickname or exposes email as a fallback', () => {
  for (const username of ['', '   ', '@@@']) {
    const result = html({ username })
    assert.match(result, /Додайте нік у профілі/)
    assert.match(result, /Відкрити профіль/)
    assert.doesNotMatch(result, /Скопіювати нік|<input|mailto:|Електронна пошта/)
  }
  assert.doesNotMatch(notice, /\.email|execCommand|dangerouslySetInnerHTML/)
  const escaped = html({ username: '<script>alert(1)</script>' })
  assert.match(escaped, /&lt;script&gt;/)
  assert.doesNotMatch(escaped, /<script>/)
})

test('notice has an accessible name/description, clear dismissal and scrollable mobile layout', () => {
  const result = html()
  assert.match(result, /role="dialog"/)
  assert.match(result, /aria-modal="true"/)
  assert.match(result, /aria-labelledby="[^"]+"/)
  assert.match(result, /aria-describedby="[^"]+"/)
  assert.match(result, /aria-label="Закрити повідомлення"/)
  assert.match(result, /readOnly=""/i)
  assert.match(result, /role="status"/)
  assert.match(result, /overflow-y-auto/)
  assert.match(result, /my-auto w-full min-w-0 max-w-md/)
  assert.match(result, /bg-card.*text-foreground/)
  assert.match(result, /min-h-11/)
  assert.match(notice, /event\.target === event\.currentTarget\) onClose\(\)/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /animation: none/)
})

test('actual copy callback writes only the visible normalized nickname and acknowledges success', async () => {
  const fx = copyFixture()
  await fx.copy()
  assert.deepEqual(fx.copied, ['@student'])
  assert.deepEqual(fx.events, ['copied'])
  assert.equal(fx.context.copyBusy.current, false)
  assert.match(notice, /Нік скопійовано/)
})

test('clipboard rejection or unsupported API exposes selectable nickname and manual copy instructions', async () => {
  for (const navigator of [
    { clipboard: { writeText: async () => { throw new Error('Permission denied') } } }, {},
  ]) {
    const fx = copyFixture({ navigator })
    await fx.copy()
    assert.deepEqual(fx.events, ['failed', 'focus', 'select'])
    assert.equal(fx.context.copyBusy.current, false)
  }
  assert.match(notice, /Ctrl\+C або ⌘C/)
  assert.match(notice, /На телефоні затисніть нік/)
  assert.match(notice, /onFocus=\{\(event\) => event\.currentTarget\.select\(\)\}/)
})

test('empty or busy nickname copy is a no-op and concurrent clicks share the in-flight guard', async () => {
  for (const overrides of [{ nickname: '' }, { copyBusy: { current: true } }]) {
    const fx = copyFixture(overrides)
    await fx.copy()
    assert.deepEqual(fx.copied, [])
    assert.deepEqual(fx.events, [])
  }
  let finish, calls = 0
  const fx = copyFixture({ navigator: { clipboard: { writeText: () => { calls++; return new Promise(resolve => { finish = resolve }) } } } })
  const first = fx.copy()
  await fx.copy()
  assert.equal(calls, 1)
  finish(); await first
  assert.deepEqual(fx.events, ['copied'])
  assert.equal(fx.context.copyBusy.current, false)
})

test('late clipboard success/error cannot update a different nickname or a dismissed account modal', async () => {
  for (const transition of ['nickname', 'unmount']) for (const outcome of ['resolve', 'reject']) {
    let finish, fail
    const fx = copyFixture({ navigator: { clipboard: { writeText: () => new Promise((resolve, reject) => { finish = resolve; fail = reject }) } } })
    const pending = fx.copy()
    if (transition === 'nickname') fx.context.currentNickname.current = '@other'
    else fx.context.mounted.current = false
    if (outcome === 'resolve') finish()
    else fail(new Error('Clipboard failed'))
    await pending
    assert.deepEqual(fx.events, [], transition + '/' + outcome)
    assert.equal(fx.context.copyBusy.current, false)
  }
})

function mountEffect(context) {
  const effect = functionNode(noticeAst, 'StudyGroupJoinNotice').body.statements
    .filter(ts.isExpressionStatement).map(node => node.expression)
    .filter(ts.isCallExpression).find(node => node.expression.getText(noticeAst) === 'useEffect'
      && node.arguments[0].getText(noticeAst).includes('recordVisibleDisplay'))
  assert.ok(effect, 'Actual modal lifecycle effect exists')
  return executeExpression(noticeAst, effect.arguments[0], context)()
}
function modalFixture({ visibility = 'visible', visible = true } = {}) {
  const events = [], listeners = new Map(), frames = new Map()
  let frameId = 0
  class FakeNode {}
  class FakeHTMLElement extends FakeNode {
    isConnected = true
    visibility = 'visible'
    focus() { document.activeElement = this; events.push(['focus', this]) }
    getClientRects() { return [1] }
  }
  const previousFocus = new FakeHTMLElement(), first = new FakeHTMLElement(), last = new FakeHTMLElement()
  const dialog = new FakeHTMLElement()
  dialog.querySelectorAll = () => [first, last]
  dialog.contains = node => [dialog, first, last].includes(node)
  dialog.getClientRects = () => visible ? [1] : []
  const document = {
    body: { style: { overflow: 'auto' } }, activeElement: previousFocus, visibilityState: visibility,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name) },
  }
  const context = {
    document, Node: FakeNode, HTMLElement: FakeHTMLElement,
    getComputedStyle: element => ({ visibility: element.visibility }),
    requestAnimationFrame: fn => { const id = ++frameId; frames.set(id, fn); return id },
    cancelAnimationFrame: id => frames.delete(id),
    mounted: { current: false }, displayed: { current: false }, dialogRef: { current: dialog },
    callbacks: { current: { onDisplayed: () => events.push(['displayed']), onClose: () => events.push(['close']) } },
  }
  const cleanup = mountEffect(context)
  return {
    context, document, events, listeners, frames, previousFocus, dialog, first, last, FakeHTMLElement, cleanup,
    frame() { const ready = [...frames.values()]; frames.clear(); ready.forEach(fn => fn()) },
    visibility(value) { document.visibilityState = value; listeners.get('visibilitychange')?.() },
    key(key, shiftKey = false) {
      const event = { key, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
      listeners.get('keydown')?.(event)
      return event
    },
  }
}

test('actual lifecycle records one display only after two visible animation frames and never while hidden', () => {
  const fx = modalFixture()
  assert.equal(fx.context.mounted.current, true)
  assert.equal(fx.document.body.style.overflow, 'hidden')
  fx.frame(); assert.equal(fx.events.some(([name]) => name === 'displayed'), false)
  fx.frame(); assert.equal(fx.events.filter(([name]) => name === 'displayed').length, 1)
  fx.visibility('hidden'); fx.visibility('visible'); fx.frame(); fx.frame()
  assert.equal(fx.events.filter(([name]) => name === 'displayed').length, 1)
  fx.cleanup()
  const hidden = modalFixture({ visibility: 'hidden' })
  hidden.frame(); hidden.frame()
  assert.equal(hidden.events.some(([name]) => name === 'displayed'), false)
  hidden.visibility('visible'); hidden.frame(); hidden.visibility('hidden'); hidden.frame()
  assert.equal(hidden.events.some(([name]) => name === 'displayed'), false)
  hidden.visibility('visible'); hidden.frame(); hidden.frame()
  assert.equal(hidden.events.filter(([name]) => name === 'displayed').length, 1)
  hidden.cleanup()
})

test('unpainted, invisible or disconnected modal cannot be marked shown and cleanup restores browser state', () => {
  for (const transition of ['cleanup', 'disconnected', 'hiddenStyle']) {
    const fx = modalFixture()
    fx.frame()
    if (transition === 'cleanup') fx.cleanup()
    else if (transition === 'disconnected') fx.dialog.isConnected = false
    else fx.dialog.visibility = 'hidden'
    fx.frame()
    assert.equal(fx.events.some(([name]) => name === 'displayed'), false, transition)
    if (transition !== 'cleanup') fx.cleanup()
    assert.equal(fx.context.mounted.current, false)
    assert.equal(fx.document.body.style.overflow, 'auto')
    assert.equal(fx.listeners.size, 0)
    assert.equal(fx.frames.size, 0)
    assert.equal(fx.document.activeElement, fx.previousFocus)
  }
  const hidden = modalFixture({ visible: false })
  hidden.frame(); hidden.frame()
  assert.equal(hidden.events.some(([name]) => name === 'displayed'), false)
  hidden.cleanup()
})

test('actual keyboard trap cycles controls, captures outside focus and allows Escape dismissal', () => {
  const fx = modalFixture()
  assert.equal(fx.document.activeElement, fx.dialog)
  assert.equal(fx.key('Tab').prevented, true)
  assert.equal(fx.document.activeElement, fx.first)
  assert.equal(fx.key('Tab', true).prevented, true)
  assert.equal(fx.document.activeElement, fx.last)
  fx.key('Tab'); assert.equal(fx.document.activeElement, fx.first)
  fx.listeners.get('focusin')({ target: new fx.FakeHTMLElement() })
  assert.equal(fx.document.activeElement, fx.dialog)
  const escape = fx.key('Escape')
  assert.equal(escape.prevented, true); assert.equal(escape.stopped, true)
  assert.equal(fx.events.filter(([name]) => name === 'close').length, 1)
  fx.cleanup()
})

function wrapperFixture() {
  let auth = { authUser: { id: 'student' }, xelayUser: { id: 'student', username: 'nickname', studyGroupIds: [] }, isLoading: false, isPasswordRecovery: false }
  let suspended = false, location = { pathname: '/', searchStr: '' }, requests = 0
  const lib = {}, component = {}
  vm.runInNewContext(compile(helper), { exports: lib, require: name => {
    if (name === './supabase') return { supabase: { from() { throw new Error('No provider traffic') } } }
    throw new Error('Unexpected helper import ' + name)
  } })
  vm.runInNewContext(compile(controller), {
    exports: component, URLSearchParams,
    require(name) {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return runtime
      if (name === '@tanstack/react-router') return { useNavigate: () => () => {}, useRouterState: ({ select }) => select({ location }) }
      if (name === '../context/AuthContext') return { useAuth: () => auth }
      if (name === '../context/OnboardingContext') return { useOnboarding: () => ({ suspended }) }
      if (name === '../lib/studyGroupJoinReminder') return { ...lib, loadGroupJoinReminderState() { requests++; throw new Error('No provider traffic') } }
      if (name === '../lib/announcementSlot') return {}
      if (name === './StudyGroupJoinNotice') return { StudyGroupJoinNotice: ui.StudyGroupJoinNotice }
      throw new Error('Unexpected controller import ' + name)
    },
  })
  return {
    auth(value) { auth = value }, suspended(value) { suspended = value }, location(value) { location = value },
    render: props => component.StudyGroupJoinReminder(props || {}),
    ssr: () => renderToStaticMarkup(React.createElement(component.StudyGroupJoinReminder)),
    requests: () => requests,
  }
}

test('real wrapper hides guests, stale profiles, loading, recovery, teachers and platform administrators', () => {
  const fx = wrapperFixture()
  for (const auth of [
    { authUser: null, xelayUser: null },
    { authUser: { id: 'student' }, xelayUser: null },
    { authUser: { id: 'new' }, xelayUser: { id: 'old' } },
    { authUser: { id: 'student' }, xelayUser: { id: 'student' }, isLoading: true },
    { authUser: { id: 'student' }, xelayUser: { id: 'student' }, isPasswordRecovery: true },
    ...[{ accountType: 'teacher' }, { isTeacher: true }, { isPlatformAdmin: true }]
      .map(extra => ({ authUser: { id: 'student' }, xelayUser: { id: 'student', ...extra } })),
  ]) { fx.auth(auth); assert.equal(fx.render(), null) }
  assert.equal(fx.requests(), 0)
})

test('wrapper waits behind auth/onboarding/payment returns and keys eligible controller to the active account', () => {
  const fx = wrapperFixture()
  assert.equal(fx.render({ blocked: true }), null)
  fx.suspended(true); assert.equal(fx.render(), null); fx.suspended(false)
  for (const pathname of ['/support', '/subscription']) {
    fx.location({ pathname, searchStr: '?orderReference=synthetic-order' })
    assert.equal(fx.render(), null)
  }
  fx.location({ pathname: '/', searchStr: '' })
  const element = fx.render()
  assert.equal(element.key, 'student')
  assert.equal(element.props.userId, 'student')
  assert.equal(element.props.username, 'nickname')
  assert.equal(element.props.membershipKey, '')
  assert.equal(fx.ssr(), '')
  assert.equal(fx.requests(), 0, 'Rendering neither sends mail nor calls the backend')
  fx.auth({ authUser: { id: 'new' }, xelayUser: { id: 'new', studyGroupIds: ['one', 'two'] } })
  const switched = fx.render()
  assert.equal(switched.key, 'new')
  assert.equal(switched.props.userId, 'new')
  assert.equal(switched.props.username, '')
  assert.equal(switched.props.membershipKey, 'one,two')
})

test('actual onDisplayed callback records once per account and receipt failure does not break dismissal', async () => {
  for (const userId of ['first-account', 'second-account']) {
    const events = [], displayed = { current: false }
    const mark = callback(controllerAst, 'AccountGroupJoinReminder', 'onDisplayed', {
      userId, displayed,
      rememberGroupJoinReminder: id => events.push(['remember', id]),
      persistGroupJoinReminder: async id => { events.push(['persist', id]); throw new Error('Offline') },
    })
    assert.deepEqual(events, [])
    mark(); mark(); await Promise.resolve()
    assert.equal(displayed.current, true)
    assert.deepEqual(events, [['remember', userId], ['persist', userId]])
  }
  assert.match(controller, /<StudyGroupJoinNotice[\s\S]*onDisplayed=\{onDisplayed\}/)
  assert.match(controller, /onOpenGroups=\{\(\) => \{ setOpen\(false\); void navigate\(\{ to: '\/groups' \}\)/)
  assert.match(controller, /onOpenProfile=\{\(\) => \{ setOpen\(false\); void navigate\(\{ to: '\/profile' \}\)/)
})

test('controller rechecks authoritative membership before opening and cleans up request/dialog coordination', () => {
  const effects = functionNode(controllerAst, 'AccountGroupJoinReminder').body.statements
    .filter(ts.isExpressionStatement).map(node => node.expression).filter(ts.isCallExpression)
    .filter(node => node.expression.getText(controllerAst) === 'useEffect').map(node => node.arguments[0].getText(controllerAst))
  const opening = effects.find(body => body.includes('const canDisplay'))
  const checking = effects.find(body => body.includes('const check = async'))
  assert.ok(opening); assert.ok(checking)
  assert.match(opening, /!candidate \|\| open \|\| displayed\.current/)
  assert.match(opening, /document\.visibilityState === 'visible'/)
  assert.match(opening, /role="dialog".*role="alertdialog".*aria-modal="true"/)
  assert.match(opening, /acquireAnnouncementSlot\(slotOwner\)/)
  assert.ok(opening.indexOf('await loadGroupJoinReminderState') < opening.indexOf('setOpen(true)'))
  assert.ok(opening.indexOf('state.seen || state.inGroup') < opening.indexOf('setOpen(true)'))
  assert.match(opening, /if \(!current\) return/)
  assert.match(opening, /if \(!canDisplay\(\) \|\| hasSeenGroupJoinReminder\(userId\)\) return/)
  assert.match(opening, /request\?\.abort\(\)/)
  assert.match(opening, /observer\.disconnect\(\)/)
  assert.match(opening, /if \(!handedOff\) releaseAnnouncementSlot\(slotOwner\)/)
  assert.match(checking, /if \(!current \|\| busy \|\| document\.visibilityState !== 'visible'\) return/)
  assert.match(checking, /if \(state.seen \|\| state.inGroup\) \{ setCandidate\(null\); setOpen\(false\); return \}/)
  assert.match(checking, /controller\?\.abort\(\)/)
  assert.match(controller, /\[userId, membershipKey\]/)
  assert.doesNotMatch(controller, /setInterval|\.send\(|\.emails\./)
  assert.match(app, /import \{ StudyGroupJoinReminder \} from '\.\/components\/StudyGroupJoinReminder'/)
  assert.match(app, /<ApplicationOnboarding>[\s\S]*<StudyGroupJoinReminder blocked=\{showAuthModal\}/)
})
