import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../../src/pages/StudyGroupsPage.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'StudyGroupsPage')
const code = ts.transpileModule(declaration.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const actor = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', groupId = '33333333-3333-4333-8333-333333333333'
const group = { id: groupId, representative_id: actor, representative_request_id: 'application', group_name: 'ЕУБ-4', specialty: 'ЕУБ', cohort_start_year: null, study_level: null, created_at: '2026-10-29' }
const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]
const text = value => value == null || typeof value === 'boolean' ? '' : typeof value !== 'object' ? String(value) : Array.isArray(value) ? value.map(text).join('') : text(value.props?.children)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(t) {
  const cells = [], effects = [], reads = [], mutations = [], navigations = [], notifications = [], refreshes = []
  let index = 0, dirty = false, tree, alive = true, auth = { authUser: { id: actor }, xelayUser: { studyGroupRepresentativeStatusSource: 'current', studyGroupRepresentativeStatus: { canCreateGroup: true, availableRequestIds: ['application'] } } }
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    useState(initial) { const at = index++; cells[at] ||= { value: typeof initial === 'function' ? initial() : initial }; return [cells[at].value, value => { cells[at].value = typeof value === 'function' ? value(cells[at].value) : value; dirty = true }] },
    useRef(value) { const at = index++; cells[at] ||= { current: value }; return cells[at] },
    useCallback(value, deps) { const at = index++; if (!cells[at] || !equal(cells[at].deps, deps)) cells[at] = { value, deps }; return cells[at].value },
    useEffect(callback, deps) { const at = index++; if (!cells[at] || !equal(cells[at].deps, deps)) { const old = cells[at]; cells[at] = { deps }; effects.push(() => { old?.cleanup?.(); cells[at].cleanup = callback() }) } },
  }
  const supabase = { from(table) {
    const pending = deferred(), row = { table, pending, filters: [] }; reads.push(row)
    const builder = { select: () => builder, eq: (...args) => { row.filters.push(args); return builder }, in: () => builder, order: () => builder, limit: () => builder, maybeSingle: () => builder, then: (yes, no) => pending.promise.then(yes, no) }; return builder
  }, rpc(name, args) { const pending = deferred(); mutations.push({ name, args, pending }); return pending.promise } }
  const module = { exports: {} }, jsx = (type, props, key) => ({ type, props, key })
  const globals = { module, exports: module.exports, Error, Object, Boolean, String, Set, console: { error() {} }, ...react, supabase,
    useAuth: () => ({ ...auth, refreshUser: async () => refreshes.push(auth.authUser?.id) }), useToast: () => ({ notify: value => notifications.push(value) }), useNavigate: () => value => navigations.push(value),
    studyGroupIdentityLabel: () => 'Курс не уточнено', StudyGroupCourseCard: 'CourseCard', AuthModal: 'AuthModal', HalloweenPumpkin: 'Pumpkin',
    require(name) { assert.equal(name, 'react/jsx-runtime'); return { jsx, jsxs: jsx } },
  }
  for (const name of ['UsersRound', 'Loader2', 'ChevronRight', 'Check', 'X', 'CalendarDays']) globals[name] = name
  vm.runInNewContext(code, globals)
  const render = () => { if (!alive) return tree; for (let turn = 0; turn < 25; turn++) { index = 0; dirty = false; tree = module.exports.StudyGroupsPage(); effects.splice(0).forEach(effect => effect()); if (!dirty) return tree } throw Error('Render loop') }
  async function flush() { for (let i = 0; i < 16; i++) { await Promise.resolve(); render() } }
  const unmount = () => { cells.forEach(cell => cell?.cleanup?.()); alive = false }
  t.after(unmount); render()
  return { reads, mutations, navigations, notifications, refreshes, get tree() { return render() }, get text() { return text(render()) }, flush, update(value) { auth = value; render() }, unmount,
    async initial(request = null, memberships = [], owned = []) { reads[0].pending.resolve({ data: request, error: null }); reads[1].pending.resolve({ data: memberships, error: null }); reads[2].pending.resolve({ data: owned, error: null }); await flush(); if (memberships.length) { reads[3].pending.resolve({ data: [group], error: null }); await flush() } },
  }
}
test('old owned group without membership remains accessible and requires owner course confirmation', async t => {
  const fx = fixture(t); await fx.initial(null, [], [group])
  assert.match(fx.text, /ЕУБ-4/)
  const cards = nodes(fx.tree).filter(node => node.type === 'CourseCard')
  assert.equal(cards.length, 1); assert.equal(cards[0].props.groupId, groupId); assert.equal(cards[0].props.actorId, actor)
  assert.equal(fx.mutations.length, 0)
})
test('approved new group uses explicit course creation component and never auto-calls old creation RPC', async t => {
  const fx = fixture(t); await fx.initial({ id: 'application', status: 'approved', group_name: 'ЕУБ-4', cohort_start_year: null, study_level: null })
  const card = nodes(fx.tree).find(node => node.type === 'CourseCard')
  assert.equal(card.props.applicationId, 'application'); assert.equal(card.props.initialCohort, null); assert.equal(card.props.initialLevel, null)
  assert.equal(fx.mutations.length, 0)
})
test('late group reads from another account never repopulate its groups or course controls', async t => {
  const fx = fixture(t); fx.update({ authUser: { id: other }, xelayUser: {} })
  fx.reads[0].pending.resolve({ data: { id: 'application', status: 'approved' }, error: null }); fx.reads[1].pending.resolve({ data: [], error: null }); fx.reads[2].pending.resolve({ data: [group], error: null })
  fx.reads[3].pending.resolve({ data: null, error: null }); fx.reads[4].pending.resolve({ data: [], error: null }); fx.reads[5].pending.resolve({ data: [], error: null }); await fx.flush()
  assert.doesNotMatch(fx.text, /ЕУБ-4/); assert.equal(nodes(fx.tree).filter(node => node.type === 'CourseCard').length, 0)
})
test('invitation double-click runs once; late success after account switch never navigates or refreshes another profile', async t => {
  const membership = { id: 'member', group_id: groupId, user_id: actor, status: 'pending' }
  const fx = fixture(t); await fx.initial(null, [membership])
  const button = nodes(fx.tree).find(node => node.type === 'button' && text(node).trim() === 'Прийняти')
  button.props.onClick(); button.props.onClick(); assert.equal(fx.mutations.length, 1)
  fx.update({ authUser: { id: other }, xelayUser: {} }); fx.mutations[0].pending.resolve({ data: groupId, error: null }); await fx.flush()
  assert.equal(fx.navigations.length, 0); assert.equal(fx.notifications.length, 0); assert.equal(fx.refreshes.length, 0)
})
test('network rejection leaves readable retry guidance instead of permanent loading', async t => {
  const fx = fixture(t); fx.reads[0].pending.reject(new Error('RAW_PROVIDER')); await fx.flush()
  assert.match(fx.text, /Не вдалося завантажити групи/); assert.doesNotMatch(fx.text, /RAW_PROVIDER/)
})
