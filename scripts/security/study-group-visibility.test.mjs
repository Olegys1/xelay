import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const root = new URL('../../', import.meta.url)
const read = name => readFileSync(new URL(name, root), 'utf8')
function load(source, imports = {}, globals = {}) {
  const module = { exports: {} }
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(js, { module, exports: module.exports, Date, Intl, TextEncoder, structuredClone, queueMicrotask, ...globals,
    require(name) { if (typeof imports === 'function') return imports(name); assert.ok(name in imports, `Known import ${name}`); return imports[name] } })
  return module.exports
}
const visibility = load(read('src/lib/studyGroupVisibility.ts'))
const hidden = ['437c96ae-19d1-4bed-ae69-0b83ae9ec1b4', '445fcadc-95e2-4f8c-bfb3-6d0998030a01']
const real = 'd54d0a4e-eb72-4ac4-8f5f-cc0bcc3bcab4'
const actor = '11111111-1111-4111-8111-111111111111'

test('only the two verified immutable IDs are unlisted, not another EУБ-4 or a name match', () => {
  assert.deepEqual(Array.from(visibility.HIDDEN_TEST_STUDY_GROUP_IDS), hidden)
  for (const id of hidden) {
    assert.equal(visibility.isStudyGroupListed(id), false)
    assert.equal(visibility.isStudyGroupListed(` ${id.toUpperCase()} `), false)
  }
  assert.equal(visibility.isStudyGroupListed(real), true)
  assert.equal(visibility.isStudyGroupListed('ооо 1'), true)
  assert.equal(visibility.isStudyGroupListed('ЕУБ-4'), true)
})

test('my-groups view hides accepted and pending test memberships without offering to recreate an existing group', () => {
  const request = { id: 'existing-request', status: 'approved', group_name: 'ооо 1' }
  const groups = {
    [hidden[0]]: { id: hidden[0], representative_id: actor, representative_request_id: request.id, group_name: 'ооо 1' },
    [hidden[1]]: { id: hidden[1], representative_id: actor, group_name: 'Тестова ЕУБ-4' },
    [real]: { id: real, representative_id: 'other', group_name: 'ЕУБ-4' },
  }
  const memberships = [{ id: 'hidden-accepted', user_id: actor, group_id: hidden[0], status: 'accepted' },
    { id: 'hidden-pending', user_id: actor, group_id: hidden[1], status: 'pending' },
    { id: 'real', user_id: actor, group_id: real, status: 'accepted' }]
  const state = [false, false, '', request, memberships, groups, '']
  let hook = 0
  const hooks = { ...React, useState: initial => [hook < state.length ? state[hook++] : typeof initial === 'function' ? initial() : initial, () => {}], useRef: current => ({ current }), useCallback: fn => fn, useEffect: () => {} }
  const api = load(read('src/pages/StudyGroupsPage.tsx'), name => {
    if (name === 'react') return hooks
    if (name === 'react/jsx-runtime') return jsx
    if (name === '@tanstack/react-router') return { useNavigate: () => () => {} }
    if (name === 'lucide-react') return new Proxy({}, { get: () => () => null })
    if (name === '../context/AuthContext') return { useAuth: () => ({ authUser: { id: actor }, xelayUser: { studyGroupRepresentativeStatusSource: 'legacy' } }) }
    if (name === '../context/ToastContext') return { useToast: () => ({ notify: () => {} }) }
    if (name === '../lib/studyGroupVisibility') return visibility
    if (name === '../lib/studyGroupIdentity') return { studyGroupIdentityLabel: () => '1 курс' }
    if (name === '../components/StudyGroupCourseCard') return { StudyGroupCourseCard: props => jsx.jsx('div', { 'data-create': props.applicationId, 'data-group': props.groupId }) }
    if (name === '../components/halloween/HalloweenPumpkin') return { HalloweenPumpkin: () => null }
    return {}
  })
  const html = renderToStaticMarkup(jsx.jsx(api.StudyGroupsPage, {}))
  assert.match(html, /ЕУБ-4/)
  assert.doesNotMatch(html, /ооо 1|Тестова ЕУБ-4|Запрошення до групи|data-create=|data-group=/)
})

test('offline list omits test snapshots while direct reading retains their content', async () => {
  const owner = { id: actor, displayName: 'Synthetic student', sessionId: 'synthetic-session-123456789' }
  const now = Date.now(), deleted = []
  const snapshots = new Map([...hidden, real].map(groupId => {
    const row = { key: `${actor}:${groupId}`, schemaVersion: 1, ownerId: actor, sessionId: owner.sessionId, groupId, groupName: groupId === hidden[0] ? 'ооо 1' : 'ЕУБ-4',
      rangeStart: '2026-10-30', rangeEnd: '2026-11-01', savedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), lessons: [], homework: [], assignments: [] }
    return [row.key, row]
  }))
  const database = { close() {}, transaction() {
    let pending = 0, settled = false
    const tx = { abort() { settled = true; tx.onabort?.() }, objectStore(name) { return {
      get(key) { return request(name === 'meta' ? owner : snapshots.get(key)) },
      getAll() { return request([...snapshots.values()]) },
      delete(key) { deleted.push(key); snapshots.delete(key) },
    } } }
    function request(value) {
      pending++
      const request = {}
      queueMicrotask(() => { request.result = structuredClone(value); request.onsuccess?.(); pending--; if (!pending) queueMicrotask(() => { if (!pending && !settled) { settled = true; tx.oncomplete?.() } }) })
      return request
    }
    return tx
  } }
  const indexedDB = { open() { const request = {}; queueMicrotask(() => { request.result = database; request.onsuccess?.() }); return request } }
  const offline = load(read('src/lib/offlineStudy.ts'), { './studyGroupVisibility': visibility }, { indexedDB, localStorage: { length: 0, key: () => null } })
  assert.deepEqual(Array.from(await offline.listOfflineGroups(actor), row => row.groupId), [real])
  assert.equal((await offline.loadOfflineGroup(actor, hidden[0])).groupName, 'ооо 1')
  assert.equal(snapshots.size, 3)
  assert.deepEqual(deleted, [])
})
