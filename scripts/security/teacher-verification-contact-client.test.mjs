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
const departments = load(await read('src/lib/academicDepartments.ts'), { '../data/knuAcademicDepartments.json': JSON.parse(await read('src/data/knuAcademicDepartments.json')) })
const academicProfile = load(await read('src/lib/teacherAcademicProfile.ts'), {
  './supabase': { supabase: { rpc() { throw Error('Unexpected provider request') } } },
})
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
function cardFixture({ status = 'none', privateContact = {}, academicOverrides = {}, metadataDepartment = 'Кафедра',
  profileScope = { universityId: 'u1', academicUnitId: 'f1' }, request = async () => {} } = {}) {
  const cells = [], effects = [], writes = [], notices = []
  let index = 0, dirty = false, tree, account = 'synthetic-teacher'
  const academic = { ...academicProfile.emptyTeacherAcademicProfile(account), contact_telegram: 'public_teacher', contact_phone: '+380500000000', telegram_visible_public: true, telegram_visible_to_groups: false, ...academicOverrides }
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
    '../context/AuthContext': { useAuth: () => ({ authUser: { id: account, user_metadata: { teacher_department: metadataDepartment } }, xelayUser: profileScope, refreshUser: async () => {} }) },
    '../context/ToastContext': { useToast: () => ({ notify: value => notices.push(value) }) }, './BadgeInfo': { BadgeInfo: () => null },
    './TeacherAcademicSettings': { TeacherAcademicProfileEditor: 'TeacherAcademicProfileEditor', TeacherAcademicSettings: 'TeacherAcademicSettings' },
    './TeacherVerificationContact': { TeacherVerificationContactField: 'TeacherVerificationContactField' },
    './AcademicDepartmentSelect': { AcademicDepartmentSelect: 'AcademicDepartmentSelect' },
    '../lib/academicDepartments': departments,
    '../lib/teacherAcademicProfile': { ...academicProfile, emptyTeacherAcademicProfile: () => ({ ...academic }) },
    '../lib/teacherVerification': { ...contact, loadTeacherVerification: async () => plain(statuses[account]), requestTeacherVerification: async (...args) => { writes.push(plain(args)); return request(...args) }, teacherVerificationError: clientFixture().api.teacherVerificationError },
  })
  function render() {
    for (let turn = 0; turn < 20; turn++) { dirty = false; index = 0; tree = api.TeacherStatusCard({}); while (effects.length) effects.shift()(); if (!dirty) return tree }
    throw new Error('Card did not settle')
  }
  const text = node => !node || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : text(node.props?.children)
  const nodeList = () => [...nodes(tree)]
  const field = () => nodeList().find(node => node.type === 'TeacherVerificationContactField')
  const departmentField = () => nodeList().find(node => node.type === 'AcademicDepartmentSelect')
  const academicEditor = () => nodeList().find(node => node.type === 'TeacherAcademicProfileEditor')
  const button = label => nodeList().find(node => node.type === 'button' && text(node).trim() === label)
  async function flush() { for (let turn = 0; turn < 12; turn++) { await Promise.resolve(); render() } }
  render()
  return { writes, notices, academic, field, departmentField, academicEditor, button, render, flush, nodes: nodeList, tree: () => tree, text: () => text(tree), async open() { button('Підтвердити статус викладача').props.onClick(); render() }, async submit() { button('Надіслати заявку').props.onClick(); await flush() }, changeAccount() { account = 'another-teacher'; render() }, unmount() { for (const cell of cells) cell?.cleanup?.() } }
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
  assert.deepEqual(fx.writes[0][3], { ...fx.academic, department: 'Кафедра' })
  assert.equal(fx.notices.filter(notice => notice.tone === 'success').length, 1); fx.unmount()
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

test('new application validates the selected official department with the actual academic validator instead of its empty saved profile', async () => {
  const options = departments.KNU_ECONOMICS_DEPARTMENTS
  const fx = cardFixture({ academicOverrides: { department: '', department_options: options }, metadataDepartment: '' })
  await fx.flush(); await fx.open()
  assert.equal(fx.departmentField().props.value, '')
  assert.equal(fx.departmentField().props.options.length, options.length)
  fx.field().props.onChange({ kind: 'telegram', value: 'demo_teacher' }); fx.render()
  await fx.submit()
  assert.equal(fx.writes.length, 0, 'A blank department is still rejected')
  assert.match(fx.text(), /Оберіть кафедру свого факультету/)

  const selected = options[0].name
  fx.departmentField().props.onChange(selected); fx.render()
  assert.equal(fx.departmentField().props.value, selected)
  assert.equal(fx.academicEditor().props.value.department, '', 'Reproduces a previously empty saved academic profile')
  fx.academicEditor().props.onChange({ ...fx.academicEditor().props.value,
    position_code: 'associate_professor', contact_email: 'teacher-demo@example.test', email_visible_public: false })
  fx.render()
  assert.equal(fx.field().props.value.value, 'demo_teacher', 'Optional profile edits preserve the private verification contact')
  await fx.submit()
  assert.equal(fx.writes.length, 1)
  const [department, position, , profile, contact] = fx.writes[0]
  assert.equal(department, selected)
  assert.equal(profile.department, selected, 'Both validations and the RPC use the selected department')
  assert.equal(position, 'Доцент')
  assert.equal(profile.position_code, 'associate_professor')
  assert.equal(profile.contact_email, 'teacher-demo@example.test')
  assert.equal(profile.email_visible_public, false)
  assert.deepEqual(contact, { kind: 'telegram', value: 'demo_teacher' })
  assert.equal(fx.academic.department, '', 'Submitting never mutates the loaded profile snapshot')
  assert.equal(fx.notices.filter(notice => notice.tone === 'success').length, 1)
  fx.unmount()
})

test('resubmission rejects a department outside the faculty and submits a new selected department rather than the old saved one', async () => {
  const options = departments.KNU_ECONOMICS_DEPARTMENTS
  const fx = cardFixture({ status: 'rejected', privateContact: { contact_telegram: 'demo_teacher' },
    academicOverrides: { department: options[0].name, department_options: options } })
  await fx.flush(); await fx.open()
  assert.equal(fx.departmentField().props.value, options[0].name)
  fx.departmentField().props.onChange('Кафедра іншого тестового факультету'); fx.render()
  await fx.submit()
  assert.equal(fx.writes.length, 0, 'The official faculty catalogue check remains mandatory')
  assert.match(fx.text(), /Оберіть кафедру свого факультету/)
  fx.departmentField().props.onChange(options[1].name); fx.render()
  await fx.submit()
  assert.equal(fx.writes.length, 1)
  assert.equal(fx.writes[0][0], options[1].name)
  assert.equal(fx.writes[0][3].department, options[1].name)
  assert.equal(fx.academic.department, options[0].name)
  fx.unmount()
})

function assertSubmissionErrorAtButton(fx, pattern) {
  const alerts = fx.nodes().filter(node => node.props.role === 'alert')
  assert.equal(alerts.length, 1, 'The form shows one error, not a second message above the long editor')
  const alert = alerts[0], submit = fx.button('Надіслати заявку')
  assert.match(renderToStaticMarkup(alert), pattern)
  assert.equal(submit.props['aria-describedby'], alert.props.id)
  const parent = fx.nodes().find(node => React.Children.toArray(node.props.children)
    .some(child => React.isValidElement(child) && child.props.id === alert.props.id))
  const siblings = React.Children.toArray(parent.props.children)
  assert.equal(siblings.at(-2).props.id, alert.props.id, 'The error is immediately before the submit button')
  assert.equal(siblings.at(-1).type, 'button')
  assert.equal(submit.props.disabled, false, 'The user can correct the form and retry')
  assert.equal(fx.notices.at(-1).tone, 'warning')
  assert.match(fx.notices.at(-1).description, pattern)
  assert.equal(fx.notices.filter(notice => notice.tone === 'success').length, 0)
}

test('missing department and missing or invalid contacts give visible feedback at submit without an RPC', async () => {
  for (const scenario of [
    { options: { metadataDepartment: '' }, contact: { kind: 'telegram', value: 'demo_teacher' }, error: /Оберіть кафедру свого факультету/ },
    { options: {}, contact: { kind: 'telegram', value: '' }, error: /Додайте Telegram або номер телефону/ },
    { options: {}, contact: { kind: 'phone', value: '123' }, error: /Перевірте контакт для адміністрації/ },
  ]) {
    const fx = cardFixture(scenario.options); await fx.flush(); await fx.open()
    assert.equal(fx.button('Надіслати заявку').props.disabled, false, 'An incomplete department has actionable feedback instead of an inert button')
    fx.field().props.onChange(scenario.contact); fx.render()
    await fx.submit()
    assert.equal(fx.writes.length, 0)
    assertSubmissionErrorAtButton(fx, scenario.error)
    fx.unmount()
  }
})

test('invalid optional academic contact also appears at the bottom and reuses the same form warning', async () => {
  const fx = cardFixture(); await fx.flush(); await fx.open()
  fx.field().props.onChange({ kind: 'telegram', value: 'demo_teacher' }); fx.render()
  fx.academicEditor().props.onChange({ ...fx.academicEditor().props.value, contact_email: 'invalid-address' }); fx.render()
  await fx.submit()
  assert.equal(fx.writes.length, 0)
  assertSubmissionErrorAtButton(fx, /Перевірте контактну електронну пошту/)
  const warningId = fx.notices.at(-1).id
  await fx.submit()
  assert.equal(fx.notices.at(-1).id, warningId, 'The toast provider replaces the same form warning instead of stacking it')
  assert.equal(fx.writes.length, 0)
  fx.unmount()
})

test('missing academic scope explains the disabled submit button next to it', async () => {
  const fx = cardFixture({ profileScope: {} }); await fx.flush(); await fx.open()
  const submit = fx.button('Надіслати заявку')
  assert.equal(submit.props.disabled, true)
  const reason = fx.nodes().find(node => node.props.id === submit.props['aria-describedby'])
  assert.match(renderToStaticMarkup(reason), /Оберіть університет і факультет у профілі, щоб надіслати заявку/)
  assert.equal(fx.writes.length, 0)
  fx.unmount()
})

test('a failed submission shows an inline error and restores the button for one successful retry', async () => {
  let attempts = 0
  const fx = cardFixture({ request: async () => { if (++attempts === 1) throw Error('offline') } })
  await fx.flush(); await fx.open()
  fx.field().props.onChange({ kind: 'telegram', value: 'demo_teacher' }); fx.render()
  await fx.submit()
  assert.equal(fx.writes.length, 1)
  assertSubmissionErrorAtButton(fx, /Не вдалося зберегти заявку/)
  await fx.submit()
  assert.equal(fx.writes.length, 2)
  assert.equal(fx.notices.filter(notice => notice.tone === 'success').length, 1)
  assert.equal(fx.nodes().some(node => node.props.role === 'alert'), false)
  fx.unmount()
})

test('an in-flight submission has a visible saving state and rejects duplicate sends', async () => {
  let resolve
  const pending = new Promise(done => { resolve = done })
  const fx = cardFixture({ request: () => pending }); await fx.flush(); await fx.open()
  fx.field().props.onChange({ kind: 'telegram', value: 'demo_teacher' }); fx.render()
  const staleButton = fx.button('Надіслати заявку')
  staleButton.props.onClick(); staleButton.props.onClick(); fx.render()
  assert.equal(fx.writes.length, 1)
  assert.equal(fx.button('Надсилаємо…').props.disabled, true)
  resolve(); await fx.flush()
  assert.equal(fx.notices.filter(notice => notice.tone === 'success').length, 1)
  fx.unmount()
})

test('a late submission failure after switching accounts creates no warning in the next account', async () => {
  let reject
  const pending = new Promise((_, fail) => { reject = fail })
  const fx = cardFixture({ request: () => pending }); await fx.flush(); await fx.open()
  fx.field().props.onChange({ kind: 'telegram', value: 'demo_teacher' }); fx.render()
  await fx.submit()
  fx.changeAccount(); await fx.flush()
  reject(Error('offline')); await fx.flush()
  assert.equal(fx.notices.length, 0)
  assert.equal(fx.nodes().some(node => node.props.role === 'alert'), false)
  assert.equal(fx.writes.length, 1)
  fx.unmount()
})
