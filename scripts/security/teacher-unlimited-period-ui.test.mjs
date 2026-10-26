// Actual UI components, synthetic profiles and inert save callbacks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
const settingsSource = await read('src/components/TeacherAcademicSettings.tsx')
const panelSource = await read('src/components/TeacherVerificationPanel.tsx')
const jsx = (type, props, key) => ({ type, props, key })
const runtime = { jsx, jsxs: jsx, Fragment: 'fragment' }
const icons = new Proxy({}, { get: (_target, name) => String(name) })
const text = node => node == null || typeof node === 'boolean' ? '' : ['string', 'number'].includes(typeof node) ? String(node)
  : Array.isArray(node) ? node.map(text).join(' ') : text(node.props?.children)
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
function load(source, imports) {
  const module = { exports: {} }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, require(name) { assert.ok(name in imports, name); return imports[name] } })
  return module.exports
}
function runner() {
  const cells = [], effects = []
  let index = 0, dirty = false, component, props, tree
  const hooks = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, update => { const value = typeof update === 'function' ? update(cells[i].value) : update; if (!Object.is(cells[i].value, value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial } },
    useId() { return 'period-field-' + index++ },
    useEffect(effect, deps) { const i = index++, previous = cells[i]; if (!previous || deps.some((value, at) => !Object.is(value, previous.deps[at]))) { cells[i] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = effect() }) } },
  }
  const render = () => {
    for (let turn = 0; turn < 25; turn++) {
      index = 0; dirty = false; tree = component(props)
      while (effects.length) effects.shift()()
      if (!dirty) return tree
    }
    throw new Error('UI did not settle')
  }
  return { hooks, render, start(next, nextProps = {}) { component = next; props = nextProps; return render() },
    get tree() { return tree }, find(predicate) { return nodes(tree).find(predicate) },
    button(label) { const button = nodes(tree).find(node => node.type === 'button' && text(node).trim() === label); assert.ok(button, label); return button },
    async flush() { for (let turn = 0; turn < 15; turn++) { await Promise.resolve(); render() } },
    unmount() { for (const cell of cells) cell?.cleanup?.() },
  }
}
const academicImports = {
  emptyTeacherAcademicProfile: () => ({}), supabaseTeacherAcademicRepository: {}, teacherAcademicProfileError: error => error.message,
  TEACHER_POSITION_OPTIONS: [{ value: '', label: 'Не вказано' }], validateTeacherAcademicProfile: () => null,
}
const settings = run => load(settingsSource, { react: run.hooks, 'react/jsx-runtime': runtime, 'lucide-react': icons,
  '../lib/teacherAcademicProfile': academicImports })

test('teacher explicitly selects unlimited without changing optional contacts, and can still choose a date', () => {
  const run = runner(), ui = settings(run), changes = []
  let value = { user_id: 'synthetic-teacher', position_code: '', position_other: '', is_postgraduate: false,
    requested_valid_until: '2030-06-30', approved_valid_until: null, access_period_pending: false,
    contact_phone: '+380500000000', phone_visible_public: false, contact_telegram: 'synthetic_teacher', telegram_visible_to_groups: true }
  const original = { ...value }
  run.start(() => ui.TeacherAcademicProfileEditor({ value, showContacts: false, onChange(next) { changes.push(next); value = next } }))
  assert.equal(run.button('Без обмеження строку').props['aria-pressed'], false)
  run.button('Без обмеження строку').props.onClick(); run.render()
  assert.equal(value.requested_valid_until, null)
  assert.deepEqual({ ...value, requested_valid_until: original.requested_valid_until }, original)
  assert.equal(run.button('Без обмеження строку').props['aria-pressed'], true)
  assert.match(text(run.tree), /Обрано:\s+без обмеження строку/)
  const date = () => run.find(node => node.type === 'input' && node.props.type === 'date')
  assert.equal(date().props.value, ''); assert.equal(date().props.disabled, false)
  date().props.onChange({ target: { value: '2031-01-31' } }); run.render()
  assert.equal(value.requested_valid_until, '2031-01-31')
  assert.equal(run.button('Без обмеження строку').props['aria-pressed'], false)
  assert.match(text(run.tree), /Обрано:\s+до 2031-01-31/)
  assert.equal(changes.length, 2); run.unmount()
})

test('admin period choice clears a requested deadline and sends null only when explicitly saved', async () => {
  const run = runner(), ui = settings(run), saves = []
  const props = { requestedUntil: '2030-06-30', approvedUntil: '2029-12-31', pending: true, onApprove: async value => saves.push(value) }
  run.start(ui.TeacherAcademicApproval, props)
  assert.equal(run.find(node => node.type === 'input' && node.props.type === 'date').props.value, '2030-06-30')
  run.button('Без обмеження строку').props.onClick(); run.render()
  assert.equal(saves.length, 0)
  assert.match(text(run.tree), /Обрано:\s+без обмеження строку/)
  await run.button('Погодити строк').props.onClick()
  assert.deepEqual(saves, [null])
  run.find(node => node.type === 'input' && node.props.type === 'date').props.onChange({ target: { value: '2031-08-31' } }); run.render()
  await run.button('Погодити строк').props.onClick()
  assert.deepEqual(saves, [null, '2031-08-31'])
  run.start(ui.TeacherAcademicApproval, { ...props, saving: true })
  assert.equal(run.button('Без обмеження строку').props.disabled, true)
  assert.equal(run.find(node => node.type === 'input' && node.props.type === 'date').props.disabled, true)
  run.unmount()
})

test('new teacher approval can explicitly override a requested deadline with unlimited, preserving private contact display', async () => {
  const run = runner(), reviews = []
  const request = { id: 'synthetic-request', user_id: 'synthetic-teacher', full_name: 'Synthetic teacher', university_id: 'u1', academic_unit_id: 'f1',
    department: 'Synthetic department', position: '', note: '', status: 'pending', created_at: '2026-10-01T12:00:00Z',
    contact_telegram: 'synthetic_teacher', academic_profile: { requested_valid_until: '2030-06-30', approved_valid_until: null, access_period_pending: true, updated_at: 'synthetic-version' } }
  const ui = load(panelSource, { react: run.hooks, 'react/jsx-runtime': runtime, 'lucide-react': icons, '@tanstack/react-router': { Link: 'Link' },
    '../context/AuthContext': { useAuth: () => ({ authUser: { id: 'synthetic-admin' }, xelayUser: { isPlatformAdmin: true }, refreshUser: async () => {} }) },
    '../context/ToastContext': { useToast: () => ({ notify() {} }) },
    '../lib/supabase': { supabase: { from: () => ({ select: () => ({ in: async () => ({ data: [] }) }) }) } },
    '../lib/teacherVerification': { loadTeacherVerification: async () => ({ requests: [request] }), reviewTeacherVerification: async (...args) => { reviews.push(args); request.status = 'approved'; request.academic_profile.approved_valid_until = args[3] }, teacherVerificationError: error => error.message },
    '../lib/teacherAcademicProfile': { reviewTeacherAcademicPeriod: async () => { throw new Error('Unexpected period update') }, teacherPositionLabel: () => '' },
    './TeacherAcademicSettings': { TeacherAcademicApproval: 'TeacherAcademicApproval' },
    './TeacherVerificationContact': { TeacherVerificationContactDetails: 'TeacherVerificationContactDetails' },
  })
  run.start(ui.TeacherVerificationPanel); await run.flush()
  assert.equal(run.find(node => node.type === 'TeacherVerificationContactDetails').props.request, request)
  run.button('Підтвердити').props.onClick(); run.render()
  assert.equal(run.find(node => node.type === 'input' && node.props.type === 'date').props.value, '2030-06-30')
  run.button('Без обмеження строку').props.onClick(); run.render()
  assert.equal(reviews.length, 0)
  assert.equal(run.find(node => node.type === 'input' && node.props.type === 'date').props.value, '')
  assert.match(text(run.tree), /Обрано:\s+без обмеження строку/)
  run.button('Зберегти рішення').props.onClick(); await run.flush()
  assert.equal(reviews.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(reviews[0])), ['synthetic-request', 'approved', '', null, 'synthetic-version', 'synthetic-admin'])
  run.button('Підтверджені').props.onClick(); run.render()
  assert.match(text(run.tree), /Погоджений строк:\s+Без обмеження строку/)
  assert.equal(run.find(node => node.type === 'input' && node.props.type === 'date'), undefined)
  request.academic_profile.approved_valid_until = '2020-06-30'; request.academic_profile.access_expired = true
  run.button('Оновити').props.onClick(); await run.flush()
  assert.match(text(run.tree), /Погоджений строк:\s+до 2020-06-30/)
  assert.match(text(run.tree), /Погоджений строк завершився/)
  assert.equal(reviews.length, 1)
  run.unmount()
})
