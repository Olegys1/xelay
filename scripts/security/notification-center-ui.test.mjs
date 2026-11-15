// Actual notification handlers, fake time and fictional records; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
function load(source, imports, environment = {}) {
  const module = { exports: {} }
  runInNewContext(compile(source), { module, exports: module.exports, Date, JSON, Set, Map, AbortController, Error, ...environment, require(name) { assert.ok(name in imports, 'Explicit dependency ' + name); return imports[name] } })
  return module.exports
}
const events = () => {
  const listeners = new Map(), timers = new Map(); let next = 0
  class Event { constructor(type, value) { this.type = type; this.detail = value?.detail } }
  const window = { location: { href: 'https://xelay.example/profile?notifications=1&other=keep#section' }, setTimeout(fn) { const id = ++next; timers.set(id, fn); return id }, clearTimeout(id) { timers.delete(id) }, setInterval() { return ++next }, clearInterval() {}, addEventListener(type, fn) { const list = listeners.get(type) || new Set(); list.add(fn); listeners.set(type, list) }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn) }, dispatchEvent(event) { listeners.get(event.type)?.forEach(fn => fn(event)) } }
  return { window, document: { visibilityState: 'visible', addEventListener: window.addEventListener, removeEventListener: window.removeEventListener }, CustomEvent: Event }
}
const environment = events()
const helper = load(read('src/lib/notificationCenter.ts'), { './supabase': { supabase: {} } }, environment)
const categorySettings = helper.notificationCategorySettings
const item = (id, extra = {}) => ({ id, actor_name: 'Тестова викладачка', message: 'Перенесено вигадане заняття', created_at: '2026-11-05T10:00:00Z', is_read: false, category_key: 'schedule', ...extra })
const required = item('required-one', { acknowledgement_required: true, acknowledged_at: null })
const ordinary = item('ordinary-one', { message: 'Опубліковано вигадану оцінку', category_key: 'grades' })
const feed = extra => ({ items: [ordinary], required_items: [required], unread_count: 2, required_count: 1, badge_count: 2, has_more: false, next_cursor: null, groups: [{ id: 'group-one', name: 'ТЕСТ-1' }], courses: [{ id: 'course-one', title: 'Тестовий предмет' }], ...extra })
const preferences = () => ({ notificationsEnabled: true, emailNotificationsEnabled: true, categorySettings: categorySettings() })
function mount({ filename = 'src/components/NotificationCenterContent.tsx', exported = 'NotificationCenterContent', props, imports = {}, sourceSuffix = '\nexport { NotificationCenterSettings };' }) {
  let cursor = 0, dirty = false, tree, mounted = true
  const cells = [], effects = []
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useState(initial) { const index = cursor++; cells[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[index].value, next => { if (!mounted) return; const value = typeof next === 'function' ? next(cells[index].value) : next; if (!Object.is(value, cells[index].value)) { cells[index].value = value; dirty = true } }] },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial } },
    useCallback(fn, deps) { const index = cursor++; if (!cells[index] || !same(cells[index].deps, deps)) cells[index] = { deps, value: fn }; return cells[index].value },
    useEffect(fn, deps) { const index = cursor++; if (!cells[index] || !same(cells[index].deps, deps)) { const old = cells[index]; cells[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); cells[index].cleanup = fn() }) } },
    createContext() { return { Provider: 'Provider' } }, useContext: context => context.value,
  }
  const jsx = (type, props) => ({ type, props: props || {} })
  const api = load(read(filename) + sourceSuffix, { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, key) => String(key) }),
    'date-fns': { formatDistanceToNow: () => 'щойно' }, 'date-fns/locale': { uk: {} }, '../lib/notificationCenter': helper,
    './notification-center.css': {}, ...imports }, { ...environment, URL, URLSearchParams })
  function render() { for (let count = 0; count < 30; count++) { cursor = 0; dirty = false; tree = api[exported](props); effects.splice(0).forEach(fn => fn()); if (!dirty) return tree } throw Error('Unsettled actual notification hooks') }
  render()
  return { props, render, get tree() { return tree }, nodes: () => nodes(tree), button(label) { const found = nodes(tree).find(node => node.type === 'button' && text(node).trim() === label); assert.ok(found, 'Button ' + label); return found }, field(label) { const found = nodes(tree).find(node => node.props?.['aria-label'] === label); assert.ok(found, 'Control ' + label); return found }, card(id) { const found = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'NotificationCard' && node.props.item.id === id); assert.ok(found, 'Card ' + id); return found }, async settle() { for (let count = 0; count < 16; count++) { await Promise.resolve(); render() } }, unmount() { mounted = false; cells.forEach(cell => cell?.cleanup?.()) } }
}
function fixture({ delayed = false } = {}) {
  const calls = { feeds: [], reads: [], acknowledgements: [], opens: [], settings: [] }
  let data = feed()
  const repository = { feed: async (user, filters, cursor, signal) => { const waiting = deferred(); calls.feeds.push({ user, filters: plain(filters), cursor: plain(cursor), signal, ...waiting }); return delayed ? waiting.promise : plain(data) }, markRead: async (user, ids) => { calls.reads.push([user, plain(ids)]); data = { ...data, items: data.items.map(row => ids.includes(row.id) ? { ...row, is_read: true } : row), required_items: data.required_items.map(row => ids.includes(row.id) ? { ...row, is_read: true } : row) } }, acknowledge: async (user, id) => { calls.acknowledgements.push([user, id]); const current = data.required_items.find(row => row.id === id); data = { ...data, required_items: data.required_items.filter(row => row.id !== id), required_count: 0, items: [...data.items, { ...current, is_read: true, acknowledged_at: '2026-11-05T11:00:00Z' }] } } }
  const props = { userId: 'actor-one', repository, preferences: preferences(), emailState: 'ready', updatePreferences: async value => { calls.settings.push(value); return true }, onOpen: row => calls.opens.push(row.id) }
  return Object.assign(mount({ props }), { calls, repository, setData(next) { data = next } })
}

test('opening the center never marks a page read or acknowledges mandatory notices; source open marks only that item', async () => {
  const f = fixture(); await f.settle()
  assert.equal(f.calls.feeds.length, 1); assert.equal(f.calls.reads.length, 0); assert.equal(f.calls.acknowledgements.length, 0)
  f.card('ordinary-one').props.onOpen(); await f.settle()
  assert.deepEqual(f.calls.reads, [['actor-one', ['ordinary-one']]])
  assert.deepEqual(f.calls.opens, ['ordinary-one']); assert.equal(f.calls.acknowledgements.length, 0)
  f.unmount()
})

test('mandatory messages remain pinned under unrelated filters and read-all never substitutes for explicit acknowledgement', async () => {
  const f = fixture(); await f.settle()
  f.field('Категорія сповіщень').props.onChange({ target: { value: 'grades' } }); f.render(); await f.settle()
  assert.equal(f.calls.feeds.at(-1).filters.category, 'grades'); assert.ok(f.card('required-one'))
  f.button('Прочитано').props.onClick(); await f.settle()
  assert.deepEqual(f.calls.reads.at(-1), ['actor-one', ['required-one', 'ordinary-one']]); assert.equal(f.calls.acknowledgements.length, 0)
  assert.ok(f.card('required-one')); f.card('required-one').props.onAcknowledge(); await f.settle()
  assert.deepEqual(f.calls.acknowledgements, [['actor-one', 'required-one']])
  assert.equal(f.card('required-one').props.item.acknowledged_at, '2026-11-05T11:00:00Z')
  assert.equal(nodes(f.tree).some(node => node.props?.['aria-label'] === 'Потрібно підтвердити ознайомлення'), false)
  f.unmount()
})

test('server pagination uses the cursor, deduplicates rows and drops stale pages after filters change', async () => {
  const f = fixture({ delayed: true }); f.calls.feeds[0].resolve(feed({ has_more: true, next_cursor: { created_at: '2026-11-05T10:00:00Z', id: 'ordinary-one' } })); await f.settle()
  f.button('Показати ще').props.onClick(); f.render(); assert.equal(f.calls.feeds.length, 2)
  assert.equal(f.calls.feeds[1].cursor.id, 'ordinary-one')
  f.field('Категорія сповіщень').props.onChange({ target: { value: 'tests' } }); f.render()
  assert.equal(f.calls.feeds[1].signal.aborted, true); assert.equal(f.calls.feeds[2].cursor, null)
  f.calls.feeds[2].resolve(feed({ items: [item('new-filter', { category_key: 'tests' })] })); await f.settle()
  f.calls.feeds[1].resolve(feed({ items: [item('stale-page')] })); await f.settle()
  assert.ok(f.card('new-filter')); assert.equal(nodes(f.tree).some(node => node.props?.item?.id === 'stale-page'), false)
  const merged = helper.mergeNotificationPage(feed({ items: [ordinary] }), feed({ items: [ordinary, item('second'), required] }), true)
  assert.deepEqual(Array.from(merged.items, row => row.id), ['ordinary-one', 'second']); f.unmount()
})

test('an empty filtered mandatory view keeps the outstanding count and offers one action to clear its filters', async () => {
  const f = fixture(); await f.settle()
  f.field('Категорія сповіщень').props.onChange({ target: { value: 'grades' } }); f.render(); await f.settle()
  f.setData(feed({ items: [], required_items: [], required_count: 1 }))
  f.button('Обов’язкові 1').props.onClick(); f.render(); await f.settle()
  assert.equal(f.calls.feeds.at(-1).filters.view, 'required', JSON.stringify(f.calls.feeds.map(row => row.filters)))
  assert.match(text(f.tree), /Потребують ознайомлення:\s+1/)
  f.button('Показати всі обов’язкові').props.onClick(); f.render(); await f.settle()
  const applied = f.calls.feeds.at(-1).filters
  assert.equal(applied.view, 'required'); assert.equal(applied.category, 'all'); assert.equal(applied.group_id, null); assert.equal(applied.search, '')
  f.unmount()
})

test('account and repository changes hide old content immediately and invalidate captured action callbacks', async () => {
  const f = fixture(); await f.settle(); const oldOpen = f.card('ordinary-one').props.onOpen, oldAck = f.card('required-one').props.onAcknowledge
  f.props.userId = 'actor-two'; f.render(); oldOpen(); oldAck(); await f.settle()
  assert.deepEqual(f.calls.opens, []); assert.deepEqual(f.calls.reads, []); assert.deepEqual(f.calls.acknowledgements, [])
  const currentAck = f.card('required-one').props.onAcknowledge
  f.props.repository = { ...f.repository }; f.render(); currentAck(); await f.settle()
  assert.equal(f.calls.acknowledgements.length, 0); f.unmount()
})

test('a late acknowledgement response cannot update a replacement account', async () => {
  const f = fixture(), waiting = deferred(); f.repository.acknowledge = (user, id) => { f.calls.acknowledgements.push([user, id]); return waiting.promise }
  await f.settle(); f.card('required-one').props.onAcknowledge(); f.render()
  f.props.userId = 'replacement'; f.render(); await f.settle(); waiting.resolve({}); await f.settle()
  assert.equal(text(f.tree).includes('Ознайомлення підтверджено.'), false)
  assert.deepEqual(f.calls.acknowledgements, [['actor-one', 'required-one']]); f.unmount()
})

test('settings save independent channels and daily mail only after an explicit save while mandatory delivery has no off switch', async () => {
  const saved = [], props = { preferences: preferences(), loading: false, saving: false, emailState: 'ready', update: async value => { saved.push(plain(value)); return true }, isCurrent: () => true }
  const f = mount({ props, exported: 'NotificationCenterSettings' }); await f.settle()
  const global = f.nodes().filter(node => node.type === 'input' && node.props.type === 'checkbox')[0]
  global.props.onChange({ target: { checked: false } }); f.render()
  f.field('Листи: Оцінки й перевірка').props.onChange({ target: { value: 'daily' } }); f.render()
  assert.equal(saved.length, 0); assert.match(text(f.tree), /Обов’язкові повідомлення надходять завжди/)
  props.preferences = plain(props.preferences); f.render(); await f.settle()
  f.button('Зберегти налаштування').props.onClick(); await f.settle()
  assert.equal(saved.length, 1); assert.equal(saved[0].notificationsEnabled, false); assert.equal(saved[0].emailNotificationsEnabled, true)
  assert.equal(saved[0].categorySettings.grades.email, 'daily')
  assert.equal(f.nodes().filter(node => node.type === 'input' && node.props.type === 'checkbox').length, helper.NOTIFICATION_CATEGORIES.length + 2)
  f.unmount()
})

test('withdrawn settings scope and unmounted windows cannot save through old callbacks', async () => {
  let active = true; const saved = [], props = { preferences: preferences(), loading: false, saving: false, emailState: 'ready', update: async value => { saved.push(value); return true }, isCurrent: () => active }
  const f = mount({ props, exported: 'NotificationCenterSettings' }); await f.settle()
  f.field('Листи: Оцінки й перевірка').props.onChange({ target: { value: 'off' } }); f.render()
  const save = f.button('Зберегти налаштування').props.onClick; active = false; save(); await f.settle(); assert.equal(saved.length, 0)
  active = true; f.unmount(); save(); await Promise.resolve(); assert.equal(saved.length, 0)
})

test('category defaults and normalization do not accept unknown delivery modes or phantom categories', () => {
  const normalized = categorySettings({ grades: { in_app: false, email: 'daily' }, news: { email: 'unbounded' }, unknown: { in_app: false, email: 'off' } })
  assert.equal(normalized.grades.in_app, false); assert.equal(normalized.grades.email, 'daily')
  assert.equal(normalized.news.email, 'immediate'); assert.equal(Object.hasOwn(normalized, 'unknown'), false)
  assert.equal(helper.outstandingNotification({ acknowledgement_required: true, is_read: true }), true)
  assert.equal(helper.outstandingNotification({ acknowledgement_required: true, acknowledged_at: '2026-11-05' }), false)
})

test('the real header retains mandatory attention with ordinary notifications off and preserves other deep-link parameters', async () => {
  const counts = [], routes = [], tableReads = []
  const result = value => Object.assign(Promise.resolve(value), { abortSignal() { return Promise.resolve(value) } })
  const supabase = { rpc(name, args) { if (name === 'xelay_notification_counts') { counts.push([name, args]); return result({ data: { badge_count: 2, required_count: 2, unread_count: 0 }, error: null }) } return result({ data: 0, error: null }) },
    from(table) { tableReads.push(table); const query = { select() { return query }, eq() { return query }, is() { return result({ count: 0, error: null }) } }; return query },
    channel() { const channel = { on() { return channel }, subscribe() { return channel } }; return channel }, removeChannel: async () => {} }
  const imports = { '@tanstack/react-router': { useNavigate: () => value => routes.push(plain(value)), useRouterState: () => '?notifications=1&other=keep' },
    './BurgerMenu': { BurgerMenu: 'BurgerMenu' }, './NotificationPanel': { NotificationPanel: 'NotificationPanel' }, './ThemeToggle': { ThemeToggle: 'ThemeToggle' }, './XelayLogo': { XelayLogo: 'XelayLogo' }, './halloween/HalloweenHat': { HalloweenHat: 'HalloweenHat' },
    '../context/AuthContext': { useAuth: () => ({ isAuthenticated: true, authUser: { id: 'actor', email: 'fictional@example.invalid' }, xelayUser: { name: 'Вигадана людина', has_seen_onboarding: false } }) },
    '../context/BillingContext': { useBilling: () => ({ isPremium: false }) }, '../lib/supabase': { supabase }, '../hooks/useTranslation': { useTranslation: () => ({ t: value => value }) },
    '../context/NotificationPreferencesContext': { useNotificationPreferences: () => ({ loading: false, preferences: { notificationsEnabled: false, emailNotificationsEnabled: false, categorySettings: categorySettings() } }) },
    '../lib/onboarding': { guideKey: () => '', hasSeenGuide: () => true, rememberGuide() {} },
    '../lib/notificationUnreadRefresh': { notificationChangeAffectsRecipient: () => true, createNotificationUnreadRefresher(options) { let active = true; const refresh = () => { void options.fetchCount(new AbortController().signal).then(count => { if (active) options.onCount(count) }) }; refresh(); return { refresh, invalidate: refresh, visibilityChanged() {}, realtimeStatus() {}, dispose() { active = false } } } },
    '../lib/birthdayGifts': { BIRTHDAY_REFRESH_EVENT: 'birthday' }, '../lib/appreciationGifts': { APPRECIATION_REFRESH_EVENT: 'appreciation' },
  }
  const f = mount({ filename: 'src/components/Header.tsx', exported: 'Header', props: {}, imports, sourceSuffix: '' }); await f.settle()
  assert.equal(counts[0][0], 'xelay_notification_counts'); assert.equal(counts[0][1].p_expected_user_id, 'actor')
  assert.equal(tableReads.includes('notifications'), false)
  const bell = f.field('Сповіщення')
  assert.equal(nodes(bell).some(node => node.type === 'div' && String(node.props.className).includes('bg-red-500')), true)
  assert.deepEqual(routes[0], { href: '/profile?other=keep#section', replace: true })
  assert.equal(f.nodes().find(node => node.type === 'NotificationPanel').props.initialTab, 'inbox')
  f.unmount()
})

test('preference persistence uses the actor-checked server API and ignores stale account callbacks and responses', async () => {
  let auth = { authUser: { id: 'actor-a' }, isLoading: false }
  const reads = [], saves = []
  const supabase = { from(table) { assert.equal(table, 'notification_preferences'); const waiting = deferred(), record = { ...waiting, user: null, columns: null }; reads.push(record); const query = { select(columns) { record.columns = columns; return query }, eq(key, user) { assert.equal(key, 'user_id'); record.user = user; return query }, maybeSingle() { return waiting.promise } }; return query },
    rpc(name, args) { const waiting = deferred(); saves.push({ name, args: plain(args), ...waiting }); return waiting.promise } }
  const f = mount({ filename: 'src/context/NotificationPreferencesContext.tsx', exported: 'NotificationPreferencesProvider', props: { children: null }, sourceSuffix: '', imports: { './AuthContext': { useAuth: () => auth }, '../lib/supabase': { supabase } } })
  reads[0].resolve({ data: { notifications_enabled: true, email_notifications_enabled: true, category_settings: {} }, error: null }); await f.settle()
  const oldSave = f.tree.props.value.updatePreferences
  auth = { authUser: { id: 'actor-b' }, isLoading: false }; f.render(); await oldSave({ emailNotificationsEnabled: false }); assert.equal(saves.length, 0)
  assert.equal(reads.at(-1).user, 'actor-b'); assert.match(reads.at(-1).columns, /category_settings/)
  reads.at(-1).resolve({ data: { notifications_enabled: false, email_notifications_enabled: true, category_settings: { grades: { in_app: true, email: 'daily' } } }, error: null }); await f.settle()
  const pending = f.tree.props.value.updatePreferences({ categorySettings: categorySettings({ news: { in_app: false, email: 'off' } }) })
  assert.equal(saves.length, 1); assert.equal(saves[0].name, 'xelay_notification_preferences_save'); assert.equal(saves[0].args.p_expected_user_id, 'actor-b')
  assert.equal(saves[0].args.p_settings.notifications_enabled, false); assert.equal(saves[0].args.p_settings.email_notifications_enabled, true)
  auth = { authUser: { id: 'actor-c' }, isLoading: false }; f.render()
  saves[0].resolve({ data: { notifications_enabled: true, email_notifications_enabled: false, category_settings: {} }, error: null }); assert.equal(await pending, false); await f.settle()
  assert.equal(f.tree.props.value.loading, true); assert.equal(f.tree.props.value.preferences.emailNotificationsEnabled, true)
  f.unmount()
})
