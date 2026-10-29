// Render the real profile status card with controlled owner/request snapshots.
// No provider, Auth session, browser or database operation is executed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const source = await readFile(new URL('../../src/components/ClassRepresentativeRequestCard.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const requestId = '22222222-2222-4222-8222-222222222222'
const groupId = '11111111-1111-4111-8111-111111111111'
const oldApproval = { id: requestId, status: 'approved', group_name: 'Synthetic Group', created_at: '2026-10-29T12:00:00Z' }
function render({ request = null, owner = false, available = [], source = 'current', pending = false } = {}) {
  let state = 0
  const react = { ...React, useEffect() {}, useState(initial) {
    const current = state++
    return [current === 0 ? pending ? { ...oldApproval, status: 'pending' } : request : current === 1 ? false : initial, () => {}]
  } }
  const auth = { authUser: { id: 'synthetic-account' }, refreshUser: async () => {}, xelayUser: {
    name: 'Synthetic User', universityId: 'synthetic-university', academicUnitId: 'synthetic-faculty', specialty: 'Synthetic programme', studyYear: 1, experience: 'bachelor',
    studyGroupRepresentativeStatusSource: source,
    studyGroupRepresentativeStatus: { isRepresentative: owner || available.length > 0, ownedGroupIds: owner ? [groupId] : [], availableRequestIds: available, canCreateGroup: available.length > 0 },
  } }
  const module = { exports: {} }, dependencies = { react, 'react/jsx-runtime': jsx,
    '@tanstack/react-router': { useNavigate: () => () => {} }, 'lucide-react': { BadgeCheck: 'svg', Loader2: 'svg', ShieldQuestion: 'svg' },
    '../context/AuthContext': { useAuth: () => auth }, '../lib/supabase': { supabase: { from() { throw new Error('Live lookup forbidden') } } },
    '../lib/academicStatus': { academicStatusLabel: () => 'Synthetic status' }, '../lib/studyYearProgression': { isActiveStudentStatus: () => true },
    '../lib/telegram': { normalizeTelegramUsername: () => null } }
  vm.runInNewContext(compiled, { module, exports: module.exports, require(name) { assert.ok(Object.hasOwn(dependencies, name)); return dependencies[name] } })
  return renderToStaticMarkup(React.createElement(module.exports.ClassRepresentativeRequestCard, { onEditProfile() {} }))
}

test('an inherited owner without an application sees current ownership rather than an application prompt', () => {
  const html = render({ owner: true })
  assert.match(html, /Ви староста групи/)
  assert.match(html, /Поточні повноваження підтверджено за групою/)
  assert.doesNotMatch(html, /Подайте заявку|Подати заявку|очікує перевірки адміністратора|Статус підтверджено для групи/)
})
test('a transferred-away approved request remains truthful history without current authority or creation controls', () => {
  const html = render({ request: oldApproval })
  assert.match(html, /Історія заявки старости/)
  assert.match(html, /зараз не надає вам повноважень/)
  assert.match(html, /Synthetic Group/)
  assert.doesNotMatch(html, /Статус підтверджено для групи|Подати заявку|Уточніть дані профілю для створення/)
})
test('an available unused approval still permits the original creation path', () => {
  const html = render({ request: oldApproval, available: [requestId] })
  assert.match(html, /Статус підтверджено для групи/)
  assert.match(html, /Перейти до групи/)
  assert.doesNotMatch(html, /зараз не надає вам повноважень/)
})
test('pending details stay visible, including a separate pending request for an inherited owner', () => {
  assert.match(render({ pending: true }), /очікує перевірки адміністратора/)
  const html = render({ owner: true, pending: true })
  assert.match(html, /Ви староста групи/)
  assert.match(html, /Окрема заявка/)
  assert.match(html, /ще очікує перевірки адміністратора/)
})
test('a status denial cannot present an old approved request as current confirmation', () => {
  const html = render({ request: oldApproval, source: 'unavailable' })
  assert.match(html, /Не вдалося перевірити поточні повноваження/)
  assert.match(html, /Раніше заявку/)
  assert.doesNotMatch(html, /Статус підтверджено для групи|Ви зараз керуєте|Подати заявку/)
  assert.match(render({ pending: true, source: 'unavailable' }), /очікує перевірки адміністратора/)
})
