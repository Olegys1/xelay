// Execute actual announcement React handlers with fictional identities only.
// No accounts, production data, email delivery, RPC or network are involved.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function load(path, imports, extra = {}) {
  const module = { exports: {} }
  const source = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  runInNewContext(source, { module, exports: module.exports, Promise, Map, Set, Array, Object, JSON, Number, String, Error, ...extra, require(name) { assert.ok(name in imports, 'Explicit announcement dependency ' + name); return imports[name] } })
  return module.exports
}
const audience = load('src/lib/teachingAudience.ts', { './supabase': { supabase: { rpc() { throw Error('No network in handler tests') } } } })
const announcement = changes => ({ id: 'message-one', course_id: 'course-one', course_title: 'Тестовий предмет', title: 'Перевірка повідомлення', body: 'Сьогодні самостійна робота.', version: 2, author_name: 'Тестовий викладач', created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-05T10:00:00Z', created_by: 'actor-one', targets: [audience.ALL_TEACHING_AUDIENCE('group-one')], requires_acknowledgement: true, notification_id: 'notification-one', acknowledged_at: null, ...changes })
const snapshot = () => ({ course: { id: 'course-one', permissions: ['assignments'] }, groups: [{ group_id: 'group-one', group_name: 'ТЕСТ-1', status: 'accepted' }, { group_id: 'group-two', group_name: 'ТЕСТ-2', status: 'accepted', permissions: ['assignments'] }, { group_id: 'unavailable', group_name: 'PRIVATE_UNAVAILABLE_GROUP', status: 'pending' }, { group_id: 'readonly', group_name: 'PRIVATE_READONLY_GROUP', status: 'accepted', permissions: ['grades'] }] })
const recipients = () => ({ recipient_count: 7, group_counts: [{ group_id: 'group-one', count: 7 }] })
const receipts = changes => ({ id: 'message-one', version: 2, total: 2, acknowledged: 1, recipients: [{ user_id: 'student-one', full_name: 'FICTIONAL_RECIPIENT_ONE', group_id: 'group-one', acknowledged_at: '2026-11-05T11:00:00Z' }, { user_id: 'student-two', full_name: 'FICTIONAL_RECIPIENT_TWO', group_id: 'group-one', acknowledged_at: null }], ...changes })
function fixture(name, override = {}) {
  const cells = [], effects = [], dispatched = [], calls = { preview: [], mutate: [], saved: 0, messages: [], ack: [], receipts: [] }
  let index = 0, dirty = false, mounted = true, tree
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { if (!mounted) return; const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial } },
    useCallback(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: fn }; return cells[i].value },
    useEffect(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const old = cells[i]; cells[i] = { deps, cleanup: old?.cleanup, effect: fn }; effects.push(() => { old?.cleanup?.(); cells[i].cleanup = fn() }) } },
  }
  const source = {
    previewRecipients: async (...args) => { calls.preview.push(plain(args)); return recipients() },
    mutate: async (...args) => { calls.mutate.push(plain(args)); return {} },
    receipts: async (...args) => { calls.receipts.push(plain(args)); return receipts() },
    messages: async (...args) => { calls.messages.push(plain(args)); return { announcements: [announcement()] } },
    acknowledge: async (...args) => { calls.ack.push(plain(args)); return {} },
  }
  const jsx = (type, props) => ({ type, props: props || {} })
  const api = load(`src/components/teaching/${name}.tsx`, {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, name) => String(name) }),
    '../../lib/teaching': { teachingError: error => error?.message || 'Не вдалося виконати дію.', teachingDate: value => value }, '../../lib/teachingAudience': audience,
    './TeachingUI': { TeachingButton: 'TeachingButton', TeachingField: 'TeachingField', TeachingModal: 'TeachingModal', teachingInput: 'input' }, './TeachingAudienceFields': { TeachingAudienceFields: 'TeachingAudienceFields' },
  }, { crypto: { randomUUID: () => 'new-message' }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail } }, window: { dispatchEvent: event => { dispatched.push(event) } } })
  const props = { initial: null, announcement: announcement(), repository: { audiences: source }, snapshot: snapshot(), groupId: 'group-one', courseId: 'course-one', userId: 'actor-one', onClose() {}, onSaved: async () => { calls.saved++ }, ...override }
  const render = (commit = true) => { for (let pass = 0; pass < 30; pass++) { index = 0; dirty = false; tree = api[name](props); if (!commit) return tree; effects.splice(0).forEach(fn => fn()); if (!dirty) return tree } throw Error('Announcement hooks did not settle') }
  render()
  return { props, source, calls, dispatched, render, get tree() { return tree },
    find(predicate) { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected announcement element'); return node },
    button(label) { return this.find(node => ['button', 'TeachingButton'].includes(node.type) && text(node).replace(/\s+/g, ' ').trim() === label) },
    field(label) { return nodes(this.find(node => node.type === 'TeachingField' && node.props.label === label)).find(node => ['input', 'textarea'].includes(node.type)) },
    change(label, value) { this.field(label).props.onChange({ target: { value } }); render() },
    submit() { this.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); render() },
    click(label) { this.button(label).props.onClick(); render() },
    async settle() { for (let pass = 0; pass < 25; pass++) { await Promise.resolve(); render() } },
    strictRemount() { cells.forEach(cell => { if (cell?.effect) { cell.cleanup?.(); cell.cleanup = cell.effect() } }); render() },
    unmount() { cells.forEach(cell => cell?.cleanup?.()); mounted = false },
  }
}
function fill(f) { f.change('Тема', 'Зміна заняття'); f.change('Повідомлення', 'Виконайте завдання самостійно.') }

test('composer previews recipient counts without writing, then only a distinct explicit confirmation saves one mandatory message', async () => {
  const f = fixture('TeachingAnnouncementComposer'), preview = deferred(), save = deferred()
  f.source.previewRecipients = (...args) => { f.calls.preview.push(plain(args)); return preview.promise }
  f.source.mutate = (...args) => { f.calls.mutate.push(plain(args)); return save.promise }
  fill(f); f.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); f.render()
  const first = f.find(node => node.type === 'form').props.onSubmit
  first({ preventDefault() {} }); first({ preventDefault() {} }); f.render()
  assert.equal(f.calls.preview.length, 1); assert.equal(f.calls.mutate.length, 0)
  preview.resolve(recipients()); await f.settle()
  assert.match(text(f.tree), /Одержувачів зараз:.*7/); assert.equal(f.calls.mutate.length, 0); assert.equal(f.calls.saved, 0)
  const confirm = f.find(node => node.type === 'form').props.onSubmit
  confirm({ preventDefault() {} }); confirm({ preventDefault() {} }); f.render()
  assert.equal(f.calls.mutate.length, 1)
  const [action, payload] = f.calls.mutate[0]
  assert.equal(action, 'save_announcement'); assert.equal(payload.expected_user_id, 'actor-one'); assert.equal(payload.requires_acknowledgement, true)
  assert.equal(payload.title, 'Зміна заняття'); assert.equal(payload.course_id, 'course-one'); assert.equal(payload.version, 0)
  assert.deepEqual(payload.targets, [plain(audience.ALL_TEACHING_AUDIENCE('group-one'))]); assert.equal(f.calls.saved, 0)
  save.resolve({}); await f.settle(); assert.equal(f.calls.saved, 1); f.unmount()
})

test('editing content, requirement or selected audience invalidates review and requires another preview before saving', async () => {
  const f = fixture('TeachingAnnouncementComposer'); fill(f); f.submit(); await f.settle(); assert.equal(f.calls.preview.length, 1)
  f.change('Повідомлення', 'Змінений текст.'); assert.doesNotMatch(text(f.tree), /Одержувачів зараз/)
  f.submit(); await f.settle(); assert.equal(f.calls.preview.length, 2); assert.equal(f.calls.mutate.length, 0)
  f.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); f.render(); f.submit(); await f.settle()
  assert.equal(f.calls.preview.length, 3); assert.equal(f.calls.mutate.length, 0)
  f.find(node => node.type === 'TeachingAudienceFields').props.onChange({ group_id: 'group-one', audience_mode: 'subgroups', subgroup_ids: ['subgroup-one'], team_ids: [] }); f.render(); f.submit(); await f.settle()
  assert.equal(f.calls.preview.length, 4); assert.equal(f.calls.preview[3][1][0].audience_mode, 'subgroups'); assert.equal(f.calls.mutate.length, 0)
  assert.doesNotMatch(text(f.tree), /PRIVATE_UNAVAILABLE_GROUP|PRIVATE_READONLY_GROUP/)
  f.unmount()
})

test('blank or malformed audiences never invoke preview or save, and unavailable preview cannot fall through to mutation', async () => {
  const f = fixture('TeachingAnnouncementComposer'); f.submit(); await f.settle(); assert.equal(f.calls.preview.length, 0)
  fill(f); f.find(node => node.type === 'TeachingAudienceFields').props.onChange({ group_id: 'group-one', audience_mode: 'subgroups', subgroup_ids: [] }); f.render(); f.submit(); await f.settle(); assert.equal(f.calls.preview.length, 0)
  f.find(node => node.type === 'TeachingAudienceFields').props.onChange(audience.ALL_TEACHING_AUDIENCE('group-one')); f.render()
  f.source.previewRecipients = undefined; f.submit(); await f.settle(); assert.match(text(f.tree), /Перевірка одержувачів ще не підключена/); assert.equal(f.calls.mutate.length, 0); f.unmount()
})

test('composer rejects captured actions and late previews after account, repository, course or group switches', async () => {
  for (const changed of ['account', 'repository', 'course', 'group']) {
    const f = fixture('TeachingAnnouncementComposer'), pending = deferred()
    f.source.previewRecipients = (...args) => { f.calls.preview.push(args); return pending.promise }
    fill(f); const old = f.find(node => node.type === 'form').props.onSubmit; old({ preventDefault() {} }); f.render()
    if (changed === 'account') f.props.userId = 'actor-two'
    if (changed === 'repository') f.props.repository = { audiences: { ...f.source } }
    if (changed === 'course') f.props.snapshot = { ...f.props.snapshot, course: { ...f.props.snapshot.course, id: 'course-two' } }
    if (changed === 'group') f.props.groupId = 'group-two'
    f.render(); old({ preventDefault() {} }); pending.resolve(recipients()); await f.settle()
    assert.match(text(f.tree), /Повторно відкрийте повідомлення/); assert.equal(f.calls.preview.length, 1); assert.equal(f.calls.mutate.length, 0); assert.equal(f.calls.saved, 0); f.unmount()
  }
})

test('a late successful save never refreshes another teacher account or an unmounted composer', async () => {
  for (const unmount of [false, true]) {
    const f = fixture('TeachingAnnouncementComposer'), pending = deferred(); f.source.mutate = () => pending.promise
    fill(f); f.submit(); await f.settle(); f.submit()
    if (unmount) f.unmount(); else { f.props.userId = 'actor-two'; f.render() }
    pending.resolve({}); await f.settle(); assert.equal(f.calls.saved, 0); if (!unmount) f.unmount()
  }
})

test('receipts read current counts without acknowledging and immediately hide old recipients before a new account effect', async () => {
  const f = fixture('TeachingAnnouncementReceipts'); await f.settle()
  assert.deepEqual(f.calls.receipts, [['message-one', 'actor-one']]); assert.match(text(f.tree), /1\s+із\s+2/); assert.match(text(f.tree), /FICTIONAL_RECIPIENT_ONE/); assert.equal(f.calls.ack.length, 0)
  f.props.userId = 'actor-two'; f.render(false); assert.doesNotMatch(text(f.tree), /FICTIONAL_RECIPIENT/)
  f.source.receipts = (...args) => { f.calls.receipts.push(args); return new Promise(() => {}) }; f.render(); assert.equal(f.calls.receipts.length, 2); assert.equal(f.calls.ack.length, 0); f.unmount()
})

test('late receipt names and errors from an old account, source or message version are never displayed', async () => {
  for (const change of ['account', 'source', 'version']) for (const failure of [false, true]) {
    const first = deferred(), second = deferred(), oldSource = { receipts: () => first.promise }
    const f = fixture('TeachingAnnouncementReceipts', { repository: { audiences: oldSource } })
    if (change === 'account') { oldSource.receipts = () => second.promise; f.props.userId = 'actor-two' }
    if (change === 'source') f.props.repository = { audiences: { receipts: () => second.promise } }
    if (change === 'version') { oldSource.receipts = () => second.promise; f.props.announcement = announcement({ version: 3 }) }
    f.render()
    if (failure) first.reject(Error('PRIVATE_OLD_SCOPE_FAILURE'))
    else first.resolve(receipts({ recipients: [{ user_id: 'old', group_id: 'old', full_name: 'PRIVATE_OLD_SCOPE_RECIPIENT' }] }))
    await f.settle(); assert.doesNotMatch(text(f.tree), /PRIVATE_OLD_SCOPE_RECIPIENT|PRIVATE_OLD_SCOPE_FAILURE/)
    second.resolve(receipts({ total: 0, acknowledged: 0, recipients: [] })); await f.settle(); assert.match(text(f.tree), /немає одержувачів/); assert.doesNotMatch(text(f.tree), /PRIVATE_OLD_SCOPE_RECIPIENT/); f.unmount()
  }
})

test('ordinary, already acknowledged and recipient-less messages have no acknowledgement action', async () => {
  const f = fixture('TeachingGroupAnnouncements', { repository: { audiences: { messages: async () => ({ announcements: [announcement({ requires_acknowledgement: false }), announcement({ id: 'already', acknowledged_at: '2026-11-05T11:00:00Z' }), announcement({ id: 'not-recipient', notification_id: null })] }), acknowledge() { throw Error('No implicit acknowledgement') } } } })
  await f.settle(); assert.equal(nodes(f.tree).some(node => node.type === 'TeachingButton' && text(node).trim() === 'Ознайомився'), false)
  assert.match(text(f.tree), /Ознайомлення підтверджено/); assert.match(text(f.tree), /для одержувачів обраних груп/); f.unmount()
})

test('strict effect remount keeps current message reads alive and ignores the obsolete first result', async () => {
  const first = deferred(), second = deferred(); let reads = 0
  const f = fixture('TeachingGroupAnnouncements', { repository: { audiences: { messages: () => (++reads === 1 ? first.promise : second.promise) } } })
  f.strictRemount(); assert.equal(reads, 2)
  first.resolve({ announcements: [announcement({ title: 'OBSOLETE_STRICT_READ' })] }); await f.settle(); assert.doesNotMatch(text(f.tree), /OBSOLETE_STRICT_READ/)
  second.resolve({ announcements: [announcement({ title: 'CURRENT_STRICT_READ' })] }); await f.settle(); assert.match(text(f.tree), /CURRENT_STRICT_READ/); f.unmount()
})

test('reading or refreshing announcements never acknowledges; explicit acknowledgement serializes and uses the current student', async () => {
  const f = fixture('TeachingGroupAnnouncements'), pending = deferred(); await f.settle()
  assert.equal(f.calls.ack.length, 0); f.click('Оновити'); await f.settle(); assert.equal(f.calls.ack.length, 0)
  f.source.acknowledge = (...args) => { f.calls.ack.push(plain(args)); return pending.promise }
  const ack = f.button('Ознайомився').props.onClick; ack(); ack(); f.render(); assert.deepEqual(f.calls.ack, [['notification-one', 'actor-one']]); assert.equal(f.dispatched.length, 0)
  f.source.messages = async () => ({ announcements: [announcement({ acknowledged_at: '2026-11-05T12:00:00Z' })] })
  pending.resolve({}); await f.settle(); assert.equal(f.dispatched.length, 1); assert.equal(f.dispatched[0].detail.userId, 'actor-one'); assert.match(text(f.tree), /Ознайомлення підтверджено/)
  assert.equal(nodes(f.tree).some(node => node.type === 'TeachingButton' && text(node).trim() === 'Ознайомився'), false); f.unmount()
})

test('captured acknowledgement callbacks cannot act after student, repository, group or course switches', async () => {
  for (const change of ['account', 'source', 'group', 'course']) {
    const f = fixture('TeachingGroupAnnouncements'); await f.settle(); const ack = f.button('Ознайомився').props.onClick
    if (change === 'account') f.props.userId = 'actor-two'
    if (change === 'source') f.props.repository = { audiences: { ...f.source } }
    if (change === 'group') f.props.groupId = 'group-two'
    if (change === 'course') f.props.courseId = 'course-two'
    f.render(); ack(); await f.settle(); assert.equal(f.calls.ack.length, 0, 'Old acknowledgement is invalid after ' + change); f.unmount()
  }
})

test('late acknowledgement after account change or unmount neither dispatches events nor starts another read', async () => {
  for (const unmount of [false, true]) {
    const f = fixture('TeachingGroupAnnouncements'), pending = deferred(); await f.settle(); f.source.acknowledge = () => pending.promise
    f.click('Ознайомився')
    if (unmount) f.unmount(); else { f.props.userId = 'actor-two'; f.render() }
    const before = f.calls.messages.length; pending.resolve({}); await f.settle()
    assert.equal(f.dispatched.length, 0, 'No obsolete event after ' + (unmount ? 'unmount' : 'account switch')); assert.equal(f.calls.messages.length, before); if (!unmount) f.unmount()
  }
})

test('old refresh callbacks cannot start an obsolete read or displace the new account response', async () => {
  const f = fixture('TeachingGroupAnnouncements'); await f.settle(); const refresh = f.button('Оновити').props.onClick, next = deferred()
  f.source.messages = (...args) => { f.calls.messages.push(args); return next.promise }
  f.props.userId = 'actor-two'; f.render(); const before = f.calls.messages.length
  refresh(); f.render(); assert.equal(f.calls.messages.length, before, 'Captured old refresh must not start a request')
  next.resolve({ announcements: [announcement({ title: 'CURRENT_ACCOUNT_MESSAGE' })] }); await f.settle(); assert.match(text(f.tree), /CURRENT_ACCOUNT_MESSAGE/); f.unmount()
})

test('pending announcement loads from another group never leak rows and course filtering does not acknowledge hidden messages', async () => {
  const first = deferred(), second = deferred()
  const f = fixture('TeachingGroupAnnouncements', { repository: { audiences: { messages: () => first.promise, acknowledge: () => { throw Error('No implicit ACK') } } } })
  f.props.repository = { audiences: { messages: () => second.promise } }; f.props.groupId = 'group-two'; f.render()
  first.resolve({ announcements: [announcement({ title: 'PRIVATE_OLD_GROUP' })] }); await f.settle(); assert.doesNotMatch(text(f.tree), /PRIVATE_OLD_GROUP/)
  second.resolve({ announcements: [announcement({ title: 'CURRENT_GROUP' }), announcement({ id: 'other-course', course_id: 'course-two', title: 'PRIVATE_OTHER_COURSE' })] }); await f.settle()
  assert.match(text(f.tree), /CURRENT_GROUP/); assert.doesNotMatch(text(f.tree), /PRIVATE_OTHER_COURSE/); f.unmount()
})
