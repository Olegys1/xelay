import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const module = { exports: {} }, events = []
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../src/lib/assistant-v2/pageContext.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports, window: { dispatchEvent(event) { events.push(event) } }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } }, require() { throw Error('No runtime imports') } })
const { publishAssistantPageContext, releaseAssistantPageContext, currentAssistantPageContext, validateAssistantPageContext, ASSISTANT_CONTEXT_EVENT } = module.exports
const USER = '10000000-0000-4000-8000-000000000001', OTHER = '10000000-0000-4000-8000-000000000002', GROUP = '20000000-0000-4000-8000-000000000001', COURSE = '30000000-0000-4000-8000-000000000001', SUBJECT = '40000000-0000-4000-8000-000000000001'
const catalog = () => ({ userId: USER, groups: [{ id: GROUP, learning: true }], subjects: [{ id: SUBJECT, groupId: GROUP }], courses: [{ id: COURSE, teaching: true, teachingGroupIds: [GROUP] }] })
const selected = () => ({ source: 'synthetic-selector', ownerId: USER, mode: 'learning', groupId: GROUP, subjectId: SUBJECT, date: '2026-11-02', topic: 'study' })
test('current page context is memory-only and isolated from another account', () => {
  publishAssistantPageContext(selected()); assert.equal(events.at(-1).type, ASSISTANT_CONTEXT_EVENT)
  assert.equal(currentAssistantPageContext(USER).date, '2026-11-02'); assert.equal(currentAssistantPageContext(OTHER), undefined)
  releaseAssistantPageContext('another-component'); assert.ok(currentAssistantPageContext(USER))
  releaseAssistantPageContext('synthetic-selector'); assert.equal(currentAssistantPageContext(USER), undefined)
})
test('selector changes are accepted only for the current owner and actual catalog grants', () => {
  assert.equal(validateAssistantPageContext(selected(), USER, catalog()).subjectId, SUBJECT)
  for (const update of [{ ownerId: OTHER }, { groupId: OTHER }, { courseId: OTHER }, { subjectId: OTHER }, { date: '2026-02-30' }, { mode: 'administrator' }]) assert.equal(validateAssistantPageContext({ ...selected(), ...update }, USER, catalog()), undefined)
})
test('teacher-only groups do not become learning memberships or expose internal seminars', () => {
  const value = catalog(); value.groups[0].learning = false
  assert.equal(validateAssistantPageContext(selected(), USER, value), undefined)
  const teaching = { ...selected(), mode: 'teaching', courseId: COURSE, topic: 'teaching' }
  assert.ok(validateAssistantPageContext(teaching, USER, value))
  assert.equal(validateAssistantPageContext({ ...teaching, topic: 'seminars' }, USER, value), undefined)
})
test('context projection does not accept posted role grants, private records or tokens', () => {
  const value = validateAssistantPageContext({ ...selected(), accessToken: 'not-copied', permissions: ['admin'], records: ['private'] }, USER, catalog())
  assert.equal('accessToken' in value, false); assert.equal('permissions' in value, false); assert.equal('records' in value, false)
})
