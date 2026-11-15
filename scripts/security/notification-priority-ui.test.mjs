import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../../src/components/NotificationPanel.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('NotificationPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const namedFunction = (name) => parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
const declarations = (nodes) => nodes.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
const constant = declarations(parsed.statements).find(node => node.name.getText(parsed) === 'CONVERSATION_ID')
const open = declarations(namedFunction('NotificationPanel').body.statements).find(node => node.name.getText(parsed) === 'openNotification')
const module = { exports: {} }
const code = ts.transpileModule(`
  const ${constant.getText(parsed)};
  ${namedFunction('teacherAlertHome').getText(parsed)}
  export ${namedFunction('notificationPriority').getText(parsed)}
  export function createOpen(context: any) {
    const {navigate, onClose, refreshUser} = context;
    return ${open.initializer.getText(parsed)};
  }
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
runInNewContext(code, { module, exports: module.exports })

const { notificationPriority, createOpen } = module.exports
const course = '10000000-0000-0000-0000-000000000001'
const group = '20000000-0000-0000-0000-000000000001'

test('notification labels use trusted priority and exact legacy event categories', () => {
  for (const type of ['academic_deadline', 'teaching_followup']) {
    assert.equal(notificationPriority({ type }), 'attention')
    assert.equal(notificationPriority({ type, delivery_priority: 'normal' }), 'normal')
  }
  const legacyTeaching = (teaching_event_key) => notificationPriority({ type: 'teaching_update', teaching_event_key })
  assert.equal(legacyTeaching('classroom-submit:record:1'), 'attention')
  assert.equal(legacyTeaching('grade-request:record'), 'attention')
  assert.equal(legacyTeaching('teaching-extension:record:group:1'), 'urgent')
  for (const event of ['classroom-review:record:1', 'grade-request-resolved:record:1', 'teacher-request:record']) {
    assert.equal(legacyTeaching(event), 'normal')
  }
  assert.equal(notificationPriority({ type: 'group_homework', delivery_priority: 'urgent' }), 'urgent')
  assert.equal(notificationPriority({ type: 'message', message: 'Терміново', teaching_event_key: 'grade-request:record' }), 'normal')
})

test('teacher notices open the scoped teaching view while student and admin notices keep their routes', () => {
  const destinations = []
  let closes = 0
  const openNotification = createOpen({
    navigate: (value) => destinations.push(JSON.parse(JSON.stringify(value))),
    refreshUser() {},
    onClose: () => closes++,
  })
  const teaching = (teaching_event_key, fields = {}) => openNotification({
    type: 'teaching_update', teaching_course_id: course, study_group_id: group, teaching_event_key, ...fields,
  })
  teaching('classroom-submit:record:1')
  teaching('grade-request:record')
  teaching('grade-request:record', { teaching_course_id: '/another/path' })
  teaching('classroom-review:record:1')
  teaching('teacher-request:record')
  openNotification({ type: 'teaching_followup' })
  assert.deepEqual(destinations, [
    { to: '/teaching', search: { home: 'assignments', course, group } },
    { to: '/teaching', search: { home: 'requests', course, group } },
    { to: '/groups/$id', params: { id: group } },
    { to: '/groups/$id', params: { id: group } },
    { to: '/admin' },
    { to: '/teaching' },
  ])
  assert.equal(closes, destinations.length)
})
