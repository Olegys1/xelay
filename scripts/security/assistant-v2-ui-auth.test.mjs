import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Execute the actual outer React component and its effect with a synthetic auth
// provider. The drawer is not rendered and no account, session or network exists.
const componentSource = readFileSync(new URL('../../src/components/assistant-v2/XelayAssistant.tsx', import.meta.url), 'utf8')
const helperSource = readFileSync(new URL('../../src/lib/assistant-v2/workspaceTools.ts', import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
function harness() {
  const effects = [], entries = new Map([['xelay:assistant:offline:v1:synthetic-owner', 'private-schedule'], ['unrelated-setting', 'keep']]); let listener, unsubscribed = false
  const storage = { get length() { return entries.size }, key(index) { return [...entries.keys()][index] || null }, getItem(key) { return entries.get(key) || null }, setItem(key, value) { entries.set(key, value) }, removeItem(key) { entries.delete(key) } }
  const helperModule = { exports: {} }; vm.runInNewContext(compile(helperSource), { module: helperModule, exports: helperModule.exports, URL, URLSearchParams })
  const authState = { authUser: { id: 'synthetic-owner' }, isAuthenticated: true, isLoading: false, isPasswordRecovery: false, googleRegistrationStatus: 'ready' }
  const componentModule = { exports: {} }
  vm.runInNewContext(compile(componentSource), { module: componentModule, exports: componentModule.exports, window: { localStorage: storage, location: { pathname: '/' } }, require(name) {
    if (name === 'react') return { useEffect(callback) { effects.push(callback) } }
    if (name === 'react/jsx-runtime') return { jsx(type, props) { return { type, props } }, jsxs(type, props) { return { type, props } } }
    if (name.endsWith('context/AuthContext')) return { useAuth() { return authState } }
    if (name.endsWith('lib/supabase')) return { supabase: { auth: { onAuthStateChange(callback) { listener = callback; return { data: { subscription: { unsubscribe() { unsubscribed = true } } } } } } } }
    if (name.endsWith('assistant-v2/workspaceTools')) return helperModule.exports
    if (name === 'lucide-react' || name.endsWith('.css') || name.endsWith('assistant-v2/cloudClient') || name.endsWith('assistant-v2/pageContext')) return {}
    throw new Error('Unexpected import ' + name)
  }, fetch() { throw new Error('Networking forbidden') } })
  return { render: componentModule.exports.default, recurrenceReview: componentModule.exports.RecurringScheduleReview, manualContext: componentModule.exports.ManualTeachingContext, manualCourse: componentModule.exports.manualTeachingCourse, effects, entries, emit: event => listener(event), unsubscribed: () => unsubscribed, authState }
}

function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(9).flatMap(nodes)] }
const componentAst = ts.createSourceFile('XelayAssistant.tsx', componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function findNode(predicate, node = componentAst) { if (predicate(node)) return node; return ts.forEachChild(node, child => findNode(predicate, child)) }
test('sole authorized teaching course is selected only for manual controls without changing calendar state', () => {
  const value = harness(), courses = [{ id: 'allowed-course', name: 'Математика', permissions: ['assignments', 'materials', 'grades', 'manage'] }]; let changed = ''
  const calendarSelection = '', tree = value.manualContext({ courses, selectedId: calendarSelection, onChange(id) { changed = id } }), selector = nodes(tree).find(node => node.type === 'select')
  assert.equal(selector.props.value, 'allowed-course'); assert.equal(calendarSelection, ''); assert.equal(changed, '')
  assert.equal(value.manualCourse(courses, calendarSelection).id, 'allowed-course')
  const actionExpression = findNode(node => ts.isVariableDeclaration(node) && node.name.getText(componentAst) === 'availableActions').initializer.getText(componentAst)
  const available = vm.runInNewContext(actionExpression, { mode: 'teaching', selectedGroup: undefined, canHomework: false, manualTeacherPermissions: courses[0].permissions })
  for (const action of ['teaching.assignment.upsert', 'teaching.publication.schedule', 'teaching.material.upsert', 'teaching.material.collaborators', 'teaching.grades.save', 'teaching.grading.save']) assert.ok(available.includes(action), action)
  const request = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === 'requestActionForm'), scopeExpression = request.parameters[2].initializer.getText(componentAst)
  const scope = vm.runInNewContext('(' + scopeExpression + ')', { groupId: 'allowed-group', mode: 'teaching', nextAction: 'teaching.assignment.upsert', manualCourse: courses[0], date: '2026-11-02' })
  assert.equal(scope.courseId, 'allowed-course'); assert.equal(scope.groupId, 'allowed-group')
})
test('multiple teaching courses require explicit choice and cannot invent permissions or an unavailable scope', () => {
  const value = harness(), courses = [{ id: 'first', name: 'Математика', permissions: ['assignments'] }, { id: 'second', name: 'Історія', permissions: ['grades'] }]; let choice = ''
  assert.equal(value.manualCourse(courses, ''), undefined); assert.equal(value.manualCourse(courses, 'not-authorized'), undefined)
  const tree = value.manualContext({ courses, selectedId: '', onChange(id) { choice = id } }), selector = nodes(tree).find(node => node.type === 'select')
  assert.equal(selector.props.value, ''); selector.props.onChange({ target: { value: 'second' } }); assert.equal(choice, 'second')
  assert.equal(value.manualCourse(courses, choice).permissions[0], 'grades')
  const actionExpression = findNode(node => ts.isVariableDeclaration(node) && node.name.getText(componentAst) === 'availableActions').initializer.getText(componentAst)
  const available = vm.runInNewContext(actionExpression, { mode: 'teaching', selectedGroup: undefined, canHomework: false, manualTeacherPermissions: [] })
  assert.deepEqual([...available], ['organizer.task.create'])
})
test('real recurring draft editor exposes and applies period and week corrections, preserving original metadata', () => {
  const value = harness(); let payload = { date: '2026-11-02', weekday: 1, recurring: true, validFrom: '2026-11-02', validUntil: '2026-12-31', weekPattern: 'upper', weekAnchorDate: '2026-11-02', links: [{ url: 'https://zoom.us/j/123' }], accessCode: 'synthetic' }
  const render = () => value.recurrenceReview({ payload, onChange(next) { payload = next } })
  const control = label => nodes(render()).find(node => node.props?.['aria-label'] === label)
  for (const label of ['Дата першої пари', 'Початок періоду', 'Кінець періоду', 'Чергування тижнів', 'Понеділок верхнього тижня', 'Повторювати пару']) assert.ok(control(label), label)
  control('Чергування тижнів').props.onChange({ target: { value: 'lower' } }); assert.equal(payload.date, '2026-11-09')
  control('Дата першої пари').props.onChange({ target: { value: '2026-11-11' } }); assert.equal(payload.weekday, 3); assert.equal(payload.validFrom, '2026-11-11')
  assert.equal(payload.accessCode, 'synthetic'); assert.equal(payload.links[0].url, 'https://zoom.us/j/123')
  control('Кінець періоду').props.onChange({ target: { value: '2026-11-01' } }); assert.ok(nodes(render()).some(node => node.props?.role === 'alert'))
  control('Повторювати пару').props.onChange({ target: { checked: false } }); assert.equal(payload.weekPattern, 'every'); assert.equal(payload.weekAnchorDate, undefined)
  assert.equal(control('Чергування тижнів'), undefined)
})
test('real outer assistant subscribes to logout before App removes its authenticated component tree', () => {
  const value = harness(); assert.ok(value.render({ pathname: '/' }))
  const cleanup = value.effects[0](); value.emit('SIGNED_OUT')
  assert.equal(value.entries.has('xelay:assistant:offline:v1:synthetic-owner'), false)
  assert.equal(value.entries.get('unrelated-setting'), 'keep')
  cleanup(); assert.equal(value.unsubscribed(), true)
})
test('token refresh does not erase offline copies and signed-out UI remains hidden', () => {
  const value = harness(); value.render({ pathname: '/' }); value.effects[0](); value.emit('TOKEN_REFRESHED')
  assert.equal(value.entries.has('xelay:assistant:offline:v1:synthetic-owner'), true)
  value.authState.isAuthenticated = false; value.authState.authUser = null
  assert.equal(value.render({ pathname: '/' }), null)
})
