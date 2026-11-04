import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../../', import.meta.url), read = path => readFileSync(new URL(path, root), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
function evaluate(source, imports, globals = {}) { const module = { exports: {} }; vm.runInNewContext(compile(source), { module, exports: module.exports, ...globals, require(name) { if (Object.hasOwn(imports, name)) return imports[name]; throw Error('Unexpected import ' + name) }, fetch() { throw Error('Network forbidden') } }); return module.exports }
const navigation = evaluate(read('src/lib/ownGradeNavigation.ts'), {})
const testRepository = evaluate(read('src/lib/teachingTests.ts'), { './supabase': { supabase: { rpc() { throw Error('Network forbidden') } } }, './teaching': { teachingError: error => error.message } })
const USER = '10000000-0000-4000-8000-000000000001', OTHER = '10000000-0000-4000-8000-000000000002', GROUP = '20000000-0000-4000-8000-000000000001', COURSE = '30000000-0000-4000-8000-000000000001', FOREIGN = '30000000-0000-4000-8000-000000000002'
function actualSearchValidator() {
  const source = read('src/App.tsx'), ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let validator
  const walk = node => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'studyGroupDetailRoute') validator = node.initializer.arguments[0].properties.find(property => property.name?.getText(ast) === 'validateSearch').initializer; ts.forEachChild(node, walk) }; walk(ast)
  assert.ok(validator)
  return evaluate('export const validate = ' + validator.getText(ast), {}, { parseOwnGradeSearch: navigation.parseOwnGradeSearch }).validate
}
test('the actual group route accepts only the own-grades view and cannot select another student', () => {
  const validate = actualSearchValidator(), value = validate({ grades: 'own', gradeCourse: COURSE, tab: 'seminars', userId: OTHER, studentId: OTHER })
  assert.equal(value.grades, 'own'); assert.equal(value.gradeCourse, COURSE); assert.equal(value.tab, 'schedule')
  assert.equal('userId' in value, false); assert.equal('studentId' in value, false)
  assert.equal(validate({ grades: 'another-student', gradeCourse: COURSE }).grades, undefined)
  assert.equal(validate({ grades: 'own', gradeCourse: '<script>' }).gradeCourse, undefined)
  const teacher = validate({ teaching: COURSE, home: 'journal', grades: 'own', gradeCourse: FOREIGN })
  assert.equal(teacher.home, 'journal'); assert.equal(teacher.grades, undefined)
})
test('the source URL opens the own-grade course and keeps a past semester date without adding teacher access', () => {
  const link = new URL(navigation.ownGradeSourcePath(GROUP, COURSE, '2025-09-01'), 'https://www.xelay.ink'), validate = actualSearchValidator(), search = validate(Object.fromEntries(link.searchParams))
  assert.equal(link.pathname, '/groups/' + GROUP); assert.equal(search.grades, 'own'); assert.equal(search.gradeCourse, COURSE); assert.equal(search.date, '2025-09-01'); assert.equal(search.teaching, undefined)
})
const fixture = () => ({ courses: [{ id: COURSE, title: 'Вища математика', semester: 'Осінь 2026' }], pending_invites: [], assignments: [], materials: [], grades: [{ id: 'own-grade', course_id: COURSE, group_id: GROUP, published_score: 4, published_at: '2026-11-02T10:00:00Z' }] })
function panelHarness({ requested = true, course = COURSE, deny = false } = {}) {
  const cells = []; let index = 0, dirty = false, effects = [], tree, props, block = false
  const same = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, offset) => Object.is(value, right[offset]))
  const hooks = {
    useState(initial) { const offset = index++; if (!cells[offset]) cells[offset] = { value: typeof initial === 'function' ? initial() : initial }; return [cells[offset].value, update => { const value = typeof update === 'function' ? update(cells[offset].value) : update; if (!Object.is(cells[offset].value, value)) { cells[offset].value = value; dirty = true } }] },
    useRef(initial) { const offset = index++; return (cells[offset] ||= { current: initial }) },
    useMemo(callback, deps) { const offset = index++; if (!cells[offset] || !same(cells[offset].deps, deps)) cells[offset] = { deps, value: callback() }; return cells[offset].value },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps) },
    useEffect(callback, deps) { const offset = index++, prior = cells[offset]; if (!prior || !same(prior.deps, deps)) { cells[offset] = { deps, cleanup: prior?.cleanup }; effects.push(() => { prior?.cleanup?.(); cells[offset].cleanup = callback() }) } },
  }
  const jsx = (type, props) => ({ type, props }), runtime = { jsx, jsxs: jsx, Fragment: 'Fragment' }, directory = { roster_claims: [], groups: [], teacher_directory: [] }, calls = []
  const repository = { mode: 'supabase', async group(groupId) { calls.push(groupId); if (block) return new Promise(() => {}); if (deny) throw Error('permission denied'); return fixture() }, async workspace() { return directory } }
  const source = read('src/components/teaching/GroupTeachingPanel.tsx'), imports = { react: hooks, 'react/jsx-runtime': runtime, 'lucide-react': new Proxy({}, { get: (_target, key) => String(key) }), '../../lib/ownGradeNavigation': navigation,
    '../../lib/teachingTests': testRepository, './TeachingTestRunner': { TeachingGroupTests: 'TeachingGroupTests' },
    '../../lib/teaching': { supabaseTeachingRepository: repository, teachingError: () => 'Немає доступу', teachingDate: value => value }, '../../lib/academicContacts': { supabaseAcademicContactRepository: {}, createLocalAcademicContactRepository: () => ({}) }, '../../lib/studyGroupTeachingYear': { groupTeachingDataForAcademicYear: value => value }, '../../lib/teachingAssignmentDeadline': { assignmentDeadlineLabel: () => '' } }
  const ast = ts.createSourceFile('GroupTeachingPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const statement of ast.statements.filter(ts.isImportDeclaration)) { const name = statement.moduleSpecifier.text; if (Object.hasOwn(imports, name) || statement.importClause?.isTypeOnly) continue; imports[name] = Object.fromEntries((statement.importClause?.namedBindings?.elements || []).filter(item => !item.isTypeOnly).map(item => [item.propertyName?.text || item.name.text, item.propertyName?.text || item.name.text])) }
  const component = evaluate(source, imports).GroupTeachingPanel
  props = { groupId: GROUP, userId: USER, canInvite: false, showAssignments: false, repository, openOwnGrades: requested, ownGradeCourseId: course }
  function render() { for (let pass = 0; pass < 20; pass++) { dirty = false; index = 0; tree = component(props); const pending = effects; effects = []; pending.forEach(effect => effect()); if (!dirty) return tree } throw Error('Render did not settle') }
  async function settle() { for (let turn = 0; turn < 8; turn++) { await Promise.resolve(); render() } return tree }
  const walk = (node, found = []) => { if (!node || typeof node !== 'object') return found; if (Array.isArray(node)) { node.forEach(item => walk(item, found)); return found } found.push(node); walk(node.props?.children, found); return found }
  return { render, settle, nodes: () => walk(tree), update(next) { props = { ...props, ...next }; render() }, blockNextOwner() { block = true }, calls }
}
test('actual group panel opens own grades only after caller-scoped data is loaded, and does not reopen after close', async () => {
  const panel = panelHarness(); assert.equal(panel.render(), null)
  await panel.settle(); const modal = panel.nodes().find(node => node.type === 'TeachingModal' && node.props.title === 'Мої бали'), grades = panel.nodes().find(node => node.type === 'TeachingMyGrades')
  assert.ok(modal); assert.equal(grades.props.groupId, GROUP); assert.equal(grades.props.initialCourseId, COURSE); assert.equal(grades.props.data.grades[0].id, 'own-grade')
  modal.props.onClose(); panel.render(); assert.equal(panel.nodes().some(node => node.type === 'TeachingModal'), false)
  await grades.props.onRefresh(); await panel.settle(); assert.equal(panel.nodes().some(node => node.type === 'TeachingModal'), false)
})
test('denied reads, unavailable courses and material views cannot auto-open own grades', async () => {
  for (const options of [{ deny: true }, { course: FOREIGN }, { requested: false }]) { const panel = panelHarness(options); panel.render(); await panel.settle(); assert.equal(panel.nodes().some(node => node.type === 'TeachingModal'), false) }
  const panel = panelHarness(); panel.update({ view: 'materials' }); await panel.settle(); assert.equal(panel.nodes().some(node => node.type === 'TeachingModal'), false)
})
test('account change hides the old owner grades before the next authorized read completes', async () => {
  const panel = panelHarness(); panel.render(); await panel.settle(); assert.ok(panel.nodes().some(node => node.type === 'TeachingMyGrades'))
  panel.blockNextOwner(); panel.update({ userId: OTHER }); assert.equal(panel.nodes().some(node => node.type === 'TeachingMyGrades'), false)
})
