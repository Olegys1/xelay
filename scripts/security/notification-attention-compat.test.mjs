import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
function load(path, imports = {}, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(compile(readFileSync(root + path, 'utf8')), { module, exports: module.exports, ...globals, require(name) { assert.ok(Object.hasOwn(imports, name), 'Unexpected dependency: ' + name); return imports[name] } })
  return module.exports
}
const policy = load('src/lib/notificationAttention.ts')
const defaults = () => ({ notificationsEnabled: true, emailNotificationsEnabled: true, categorySettings: { news: { in_app: true, email: 'immediate' }, organizer: { in_app: true, email: 'immediate' }, community: { in_app: true, email: 'immediate' } } })
const pending = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { resolve, promise } }
class CustomEventMock extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail } }
function fixture(kind, initialPreferences = defaults(), delayed = null) {
  let cursor = 0, dirty = false, tree, preferences = initialPreferences, authUser = { id: 'actor-a' }, timerId = 0, component
  const cells = [], effects = [], timers = new Map(), intervals = new Map(), toasts = [], calls = [], emitted = [], handlers = []
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
    useState(initial) { const i = cursor++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial } },
    useCallback(fn, deps) { const i = cursor++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: fn }; return cells[i].value },
    useMemo(fn, deps) { const i = cursor++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: fn() }; return cells[i].value },
    useEffect(fn, deps) { const i = cursor++; if (!cells[i] || !same(cells[i].deps, deps)) { const old = cells[i]; cells[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); cells[i].cleanup = fn() }) } },
  }
  const window = new EventTarget(), document = new EventTarget()
  document.visibilityState = 'visible'
  window.setTimeout = fn => { const id = ++timerId; timers.set(id, fn); return id }; window.clearTimeout = id => timers.delete(id)
  window.setInterval = fn => { const id = ++timerId; intervals.set(id, fn); return id }; window.clearInterval = id => intervals.delete(id)
  const dispatch = window.dispatchEvent.bind(window); window.dispatchEvent = event => { emitted.push(event); return dispatch(event) }
  const row = { id: 'fictional-notification', news_post_id: 'fictional-post', news_posts: { id: 'fictional-post', university_id: 'fictional-university', academic_unit_id: 'fictional-faculty', status: 'published' } }
  const notify = value => toasts.push(value), dismiss = () => {}
  const channel = { on(event, filter, fn) { handlers.push({ filter, fn }); return channel }, subscribe() { return channel } }
  const supabase = { channel: () => channel, removeChannel() {}, from() { const query = { then(resolve) { return Promise.resolve({ data: [row], error: null }).then(resolve) } }; for (const key of ['select', 'eq', 'is', 'order', 'limit', 'gt', 'in', 'update']) query[key] = () => query; return query } }
  const auth = { useAuth: () => ({ authUser, xelayUser: { userId: authUser?.id, universityId: 'fictional-university', academicUnitId: 'fictional-faculty' }, isLoading: false, isPasswordRecovery: false }) }
  const prefs = { useNotificationPreferences: () => ({ preferences, loading: false, error: null }) }, toast = { useToast: () => ({ notify, dismiss }) }
  const jsx = (type, props) => ({ type, props })
  const imports = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../lib/notificationAttention': policy }
  if (kind === 'news') {
    Object.assign(imports, { '../lib/supabase': { supabase }, './AuthContext': auth, './NotificationPreferencesContext': prefs, './ToastContext': toast })
    component = load('src/context/NewsUnreadContext.tsx', imports, { window, document }).NewsUnreadProvider
  } else {
    Object.assign(imports, { '../context/AuthContext': auth, '../context/NotificationPreferencesContext': prefs, '../context/ToastContext': toast, '../context/BillingContext': { useBilling: () => ({ isPremium: true, isLoading: false, error: null }) },
      '../lib/organizer': { announceOrganizerUpdate() { calls.push(['changed']) }, deliverOrganizerReminders(user) { calls.push(['deliver', user]); return delayed?.promise || Promise.resolve(1) } }, '../lib/organizerDraft': { clearOrganizerDraft(user) { calls.push(['clear', user]) } } })
    component = load('src/components/OrganizerReminders.tsx', imports, { window, document, Event, CustomEvent: CustomEventMock }).OrganizerReminders
  }
  function render() { for (let count = 0; count < 30; count++) { cursor = 0; dirty = false; tree = component({ children: null }); effects.splice(0).forEach(fn => fn()); if (!dirty) return tree } throw Error('Unsettled attention hooks') }
  render()
  return { calls, toasts, emitted, get value() { return tree?.props?.value }, async settle() { for (let count = 0; count < 20; count++) { await Promise.resolve(); render() } },
    change(next) { preferences = next; render() }, user(next) { authUser = next ? { id: next } : null; render() },
    insertNews() { for (const { filter, fn } of handlers) if (filter.table === 'notifications') fn({ eventType: 'INSERT', new: { id: row.id, recipient_id: authUser.id, type: 'news_published', news_post_id: row.news_post_id } }) },
    flushTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()) },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}

test('the real news provider mutes category attention and live toasts while retaining its accessible unread history', async () => {
  const preferences = defaults(); preferences.categorySettings.news.in_app = false
  const fx = fixture('news', preferences); await fx.settle()
  assert.equal(fx.value.hasUnread, false)
  assert.equal(Object.values(fx.value.unreadByScope).some(Boolean), false)
  assert.deepEqual([...fx.value.unreadPostIds], ['fictional-post'])
  fx.insertNews(); fx.flushTimers(); await fx.settle(); assert.equal(fx.toasts.length, 0)
  const enabled = defaults(); fx.change(enabled)
  assert.equal(fx.value.hasUnread, true)
  assert.equal(fx.value.unreadByScope.faculty, true)
  fx.insertNews(); fx.flushTimers(); await fx.settle(); assert.equal(fx.toasts.length, 1)
  enabled.notificationsEnabled = false; fx.change({ ...enabled })
  assert.equal(fx.value.hasUnread, false)
  assert.deepEqual([...fx.value.unreadPostIds], ['fictional-post'])
  fx.unmount()
})

test('the real organizer bridge emits an event for independent daily mail without an in-app toast', async () => {
  const preferences = defaults(); preferences.notificationsEnabled = false; preferences.categorySettings.organizer = { in_app: false, email: 'daily' }
  const fx = fixture('organizer', preferences); await fx.settle()
  assert.deepEqual(fx.calls.filter(row => row[0] === 'deliver'), [['deliver', 'actor-a']])
  assert.equal(fx.toasts.length, 0)
  assert.equal(fx.emitted.length, 1)
  assert.equal(fx.emitted[0].type, 'xelay-notifications-updated')
  assert.equal(fx.emitted[0].detail.userId, 'actor-a')
  fx.unmount()
})

test('organizer attention works with mail off, both muted channels stay quiet, and an old actor result cannot notify', async () => {
  const inapp = defaults(); inapp.emailNotificationsEnabled = false
  const shown = fixture('organizer', inapp); await shown.settle(); assert.equal(shown.toasts.length, 1); shown.unmount()
  const muted = defaults(); muted.categorySettings.organizer = { in_app: false, email: 'off' }
  const quiet = fixture('organizer', muted); await quiet.settle(); assert.equal(quiet.calls.length, 0); quiet.unmount()
  const waiting = pending(), stale = fixture('organizer', defaults(), waiting)
  stale.user('actor-b'); waiting.resolve(1); await stale.settle()
  assert.equal(stale.toasts.length, 0); assert.equal(stale.emitted.length, 0)
  stale.unmount()
})
