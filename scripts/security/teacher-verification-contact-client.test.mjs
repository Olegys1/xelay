// Actual contact UI/validation/client code with synthetic values and inert RPCs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as runtime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const read = file => readFile(new URL('../../' + file, import.meta.url), 'utf8')
function load(source, imports) {
  const exports = {}
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports, URL, require(name) { assert.ok(name in imports, 'Unexpected provider/import: ' + name); return imports[name] } })
  return exports
}
const telegram = load(await read('src/lib/telegram.ts'), {})
const contact = load(await read('src/lib/teacherVerificationContact.ts'), { './telegram': telegram })
const icons = new Proxy({}, { get: () => () => React.createElement('svg') })
const telegramUi = load(await read('src/components/TelegramContact.tsx'), { react: React, 'react/jsx-runtime': runtime, 'lucide-react': icons, '../lib/telegram': telegram })
const ui = load(await read('src/components/TeacherVerificationContact.tsx'), { 'react/jsx-runtime': runtime, 'lucide-react': icons, '../lib/teacherVerificationContact': contact, './TelegramContact': telegramUi })
const plain = value => JSON.parse(JSON.stringify(value))
const nodes = function* (node) {
  if (!React.isValidElement(node)) return
  yield node
  for (const child of React.Children.toArray(node.props.children)) yield* nodes(child)
}

test('verification contacts accept only a usable Telegram identity or a bounded formatted phone', () => {
  for (const value of ['@teacher_demo', ' https://t.me/teacher_demo?from=profile ', 'telegram.me/teacher_demo']) {
    assert.deepEqual(plain(contact.normalizeTeacherVerificationContact({ kind: 'telegram', value })), { kind: 'telegram', value: 'teacher_demo' })
  }
  assert.deepEqual(plain(contact.normalizeTeacherVerificationContact({ kind: 'phone', value: ' +380 (50) 000-00-00 ' })), { kind: 'phone', value: '+380 (50) 000-00-00' })
  assert.ok(contact.normalizeTeacherVerificationContact({ kind: 'phone', value: '0123456' }))
  assert.ok(contact.normalizeTeacherVerificationContact({ kind: 'phone', value: '+123456789012345' }))
  for (const invalid of [undefined, { kind: 'email', value: 'teacher@example.test' }, { kind: 'telegram', value: '' },
    { kind: 'telegram', value: '@abcd' }, { kind: 'telegram', value: '@has space' }, { kind: 'telegram', value: 'https://example.test/teacher_demo' },
    { kind: 'telegram', value: 'javascript:alert(1)' }, { kind: 'telegram', value: 't.me/share' },
    { kind: 'phone', value: '123456' }, { kind: 'phone', value: '+1234567890123456' }, { kind: 'phone', value: '1234567 ext 1' },
    { kind: 'phone', value: '+380\n500000000' }, { kind: 'phone', value: '+380\t500000000' }, { kind: 'phone', value: '+'.repeat(41) },
  ]) assert.equal(contact.normalizeTeacherVerificationContact(invalid), null)
})

test('only an existing private application contact prefills verification; an old empty request stays readable', () => {
  assert.deepEqual(plain(contact.savedTeacherVerificationContact(null)), { kind: 'telegram', value: '' })
  assert.deepEqual(plain(contact.savedTeacherVerificationContact({ academic_profile: { contact_telegram: 'public_teacher' } })), { kind: 'telegram', value: '' })
  assert.deepEqual(plain(contact.savedTeacherVerificationContact({ contact_phone: '+380500000000' })), { kind: 'phone', value: '+380500000000' })
  assert.deepEqual(plain(contact.savedTeacherVerificationContact({ contact_telegram: '@private_teacher' })), { kind: 'telegram', value: '@private_teacher' })
})

function clientFixture() {
  const calls = []
  const api = load(awaitedClientSource, {
    './supabase': { supabase: { async rpc(name, args) { calls.push({ name, args }); return { data: { status: 'pending', request: { id: 'synthetic-request' } }, error: null } } } },
    './teacherAcademicProfile': { teacherAcademicProfilePayload: profile => ({ ...profile }), loadTeacherContacts: async () => { throw new Error('Unexpected public contact lookup') } },
    './teacherVerificationContact': contact,
  })
  return { api, calls }
}
const awaitedClientSource = await read('src/lib/teacherVerification.ts')

test('missing or invalid private contacts never call a submission RPC, even when a public profile contact exists', async () => {
  const { api, calls } = clientFixture()
  const profile = { user_id: 'synthetic', contact_telegram: 'public_teacher', telegram_visible_public: true }
  await assert.rejects(api.requestTeacherVerification('Кафедра', '', '', profile), /CONTACT_REQUIRED/)
  await assert.rejects(api.requestTeacherVerification('Кафедра', '', '', profile, { kind: 'phone', value: '123456' }), /CONTACT_INVALID/)
  assert.equal(calls.length, 0)
  assert.match(api.teacherVerificationError(new Error('TEACHER_REQUEST_CONTACT_REQUIRED')), /Додайте Telegram або номер телефону/)
  assert.match(api.teacherVerificationError(new Error('TEACHER_REQUEST_CONTACT_INVALID')), /контакт для адміністрації/)
})

test('new academic-profile request sends its independent private contact without changing profile contacts or visibility', async () => {
  const { api, calls } = clientFixture()
  const profile = { user_id: 'synthetic', contact_telegram: 'public_teacher', contact_phone: '+380500000000', telegram_visible_public: true, telegram_visible_to_groups: false, phone_visible_public: false }
  await api.requestTeacherVerification(' Кафедра ', ' Викладач ', ' Примітка ', profile, { kind: 'telegram', value: 'https://t.me/private_teacher' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'xelay_teacher_request_with_academic_profile')
  assert.deepEqual(plain(calls[0].args), { p_department: 'Кафедра', p_position: 'Викладач', p_note: 'Примітка', p_profile: profile, p_contact_telegram: 'private_teacher', p_contact_phone: '' })
  assert.equal(profile.contact_telegram, 'public_teacher'); assert.equal(profile.telegram_visible_public, true)
})

test('the plain request also uses the contact-aware overload and clears the unused method', async () => {
  const { api, calls } = clientFixture()
  await api.requestTeacherVerification('Кафедра', '', '', undefined, { kind: 'phone', value: ' +380 (50) 000-00-00 ' })
  assert.equal(calls[0].name, 'xelay_teacher_request')
  assert.deepEqual(plain(calls[0].args), { p_department: 'Кафедра', p_position: '', p_note: '', p_contact_telegram: '', p_contact_phone: '+380 (50) 000-00-00' })
})

test('legacy pending and approved responses without a contact are accepted without attempting to submit', async () => {
  for (const state of ['pending', 'approved']) {
    const api = load(awaitedClientSource, {
      './supabase': { supabase: { async rpc(name) { assert.equal(name, 'xelay_teacher_status'); return { data: { status: state, verified: state === 'approved', request: { id: 'legacy', status: state } }, error: null } } } },
      './teacherAcademicProfile': { teacherAcademicProfilePayload() {}, loadTeacherContacts() {} }, './teacherVerificationContact': contact,
    })
    const result = await api.loadTeacherVerification()
    assert.equal(result.status, state); assert.equal(result.request.id, 'legacy'); assert.equal(result.request.contact_phone, undefined)
  }
})

test('required field has one method selector and one input; reuse is an explicit action that changes only its value', () => {
  const changes = []
  const tree = ui.TeacherVerificationContactField({ id: 'test', value: { kind: 'telegram', value: '' }, onChange: value => changes.push(plain(value)), reusableValue: '@profile_teacher' })
  const list = [...nodes(tree)]
  const input = list.find(node => node.type === 'input')
  assert.equal(list.filter(node => node.type === 'input').length, 1)
  assert.equal(input.props.required, true); assert.equal(input.props.autoComplete, 'off')
  assert.equal(input.props.value, ''); assert.equal(changes.length, 0)
  list.find(node => node.type === 'button').props.onClick()
  assert.deepEqual(changes.pop(), { kind: 'telegram', value: '@profile_teacher' })
  list.find(node => node.type === 'select').props.onChange({ target: { value: 'phone' } })
  assert.deepEqual(changes.pop(), { kind: 'phone', value: '' })
  const html = renderToStaticMarkup(tree)
  assert.match(html, /лише ви та адміністратори/); assert.match(html, /у профілі та групах він не публікується/)
  const phone = [...nodes(ui.TeacherVerificationContactField({ id: 'phone', value: { kind: 'phone', value: '0123456' }, onChange() {} }))].find(node => node.type === 'input')
  assert.equal(phone.props.type, 'tel'); assert.equal(phone.props.value, '0123456')
})

test('admin display uses safe existing Telegram destinations, a safe tel link and a readable legacy empty state', () => {
  const html = renderToStaticMarkup(React.createElement(ui.TeacherVerificationContactDetails, { request: { contact_telegram: 'private_teacher', contact_phone: '+380 (50) 000-00-00' } }))
  assert.match(html, /Контакт для перевірки · приватно/)
  assert.match(html, /tg:\/\/resolve\?domain=private_teacher/)
  assert.match(html, /https:\/\/web\.telegram\.org\/k\/#@private_teacher/)
  assert.match(html, /href="tel:\+380500000000"/)
  const unsafe = renderToStaticMarkup(React.createElement(ui.TeacherVerificationContactDetails, { request: { contact_telegram: 'javascript:alert(1)', contact_phone: 'javascript:alert(2)' } }))
  assert.doesNotMatch(unsafe, /href=/)
  const legacy = renderToStaticMarkup(React.createElement(ui.TeacherVerificationContactDetails, { request: {} }))
  assert.match(legacy, /контакт для перевірки не вказано/)
})

const cardSource = await read('src/components/TeacherStatusCard.tsx')
function cardFixture({ status = 'none', privateContact = {} } = {}) {
  const cells = [], effects = [], writes = [], notices = []
  let index = 0, dirty = false, tree, account = 'synthetic-teacher'
  const academic = { user_id: account, position_code: '', contact_telegram: 'public_teacher', contact_phone: '+380500000000', telegram_visible_public: true, telegram_visible_to_groups: false }
  const statuses = {
    'synthetic-teacher': { status, verified: status === 'approved', scope_changed: false, academic_profile: academic, request: status === 'none' ? null : { id: 'old-request', department: 'Кафедра', position: '', note: '', university_id: 'u1', academic_unit_id: 'f1', ...privateContact } },
    'another-teacher': { status: 'none', verified: false, scope_changed: false, request: null, academic_profile: { ...academic, user_id: 'another-teacher' } },
  }
  const hooks = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = index++; return (cells[i] ??= { current: initial }) },
    useId() { const i = index++; return 'test-' + i },
    useEffect(effect, deps) { const i = index++, previous = cells[i]; if (!previous || deps.some((value, at) => !Object.is(value, previous.deps[at]))) { cells[i] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = effect() }) } },
  }
  const api = load(cardSource, {
    react: hooks, 'react/jsx-runtime': runtime, 'lucide-react': icons, '@tanstack/react-router': { useNavigate: () => () => {} },
    '../context/AuthContext': { useAuth: () => ({ authUser: { id: account, user_metadata: { teacher_department: 'Кафедра' } }, xelayUser: { universityId: 'u1', academicUnitId: 'f1' }, refreshUser: async () => {} }) },
    '../context/ToastContext': { useToast: () => ({ notify: value => notices.push(value) }) }, './BadgeInfo': { BadgeInfo: () => null },
    './TeacherAcademicSettings': { TeacherAcademicProfileEditor: 'TeacherAcademicProfileEditor', TeacherAcademicSettings: 'TeacherAcademicSettings' },
    './TeacherVerificationContact': { TeacherVerificationContactField: 'TeacherVerificationContactField' },
    '../lib/teacherAcademicProfile': { emptyTeacherAcademicProfile: () => ({ ...academic }), teacherPositionLabel: () => '', validateTeacherAcademicProfile: () => null },
    '../lib/teacherVerification': { ...contact, loadTeacherVerification: async () => plain(statuses[account]), requestTeacherVerification: async (...args) => { writes.push(plain(args)) }, teacherVerificationError: error => /CONTACT_REQUIRED/.test(error.message) ? 'Додайте Telegram або номер телефону.' : error.message },
  })
  function render() {
    for (let turn = 0; turn < 20; turn++) { dirty = false; index = 0; tree = api.TeacherStatusCard({}); while (effects.length) effects.shift()(); if (!dirty) return tree }
    throw new Error('Card did not settle')
  }
  const text = node => !node || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : text(node.props?.children)
  const nodeList = () => [...nodes(tree)]
  const field = () => nodeList().find(node => node.type === 'TeacherVerificationContactField')
  const button = label => nodeList().find(node => node.type === 'button' && text(node).trim() === label)
  async function flush() { for (let turn = 0; turn < 12; turn++) { await Promise.resolve(); render() } }
  render()
  return { writes, notices, academic, field, button, render, flush, text: () => text(tree), async open() { button('Підтвердити статус викладача').props.onClick(); render() }, async submit() { button('Надіслати заявку').props.onClick(); await flush() }, changeAccount() { account = 'another-teacher'; render() }, unmount() { for (const cell of cells) cell?.cleanup?.() } }
}

test('actual new-application form requires a private contact and sends it separately from optional profile contacts', async () => {
  const fx = cardFixture(); await fx.flush(); await fx.open()
  assert.equal(fx.field().props.value.value, '')
  assert.equal(fx.field().props.reusableValue, 'public_teacher')
  await fx.submit(); assert.equal(fx.writes.length, 0); assert.match(fx.text(), /Додайте Telegram або номер телефону/)
  fx.field().props.onChange({ kind: 'phone', value: '+380 (50) 000-00-00' }); fx.render()
  await fx.submit()
  assert.equal(fx.writes.length, 1)
  assert.deepEqual(fx.writes[0][4], { kind: 'phone', value: '+380 (50) 000-00-00' })
  assert.deepEqual(fx.writes[0][3], fx.academic)
  assert.equal(fx.notices.length, 1); fx.unmount()
})

test('resubmission prefills only its saved private contact and an account change removes it before reloading', async () => {
  const fx = cardFixture({ status: 'rejected', privateContact: { contact_phone: '+380990000000' } }); await fx.flush(); await fx.open()
  assert.deepEqual(plain(fx.field().props.value), { kind: 'phone', value: '+380990000000' })
  fx.changeAccount(); assert.equal(fx.field(), undefined)
  await fx.flush(); await fx.open()
  assert.deepEqual(plain(fx.field().props.value), { kind: 'telegram', value: '' })
  assert.equal(fx.writes.length, 0); fx.unmount()
})

test('actual old pending and approved cards need no contact and perform no submission', async () => {
  for (const status of ['pending', 'approved']) {
    const fx = cardFixture({ status }); await fx.flush()
    assert.equal(fx.field(), undefined); assert.equal(fx.writes.length, 0)
    assert.match(fx.text(), status === 'pending' ? /Заявка на перевірці/ : /Ваш статус викладача підтверджено/)
    fx.unmount()
  }
})
