// Synthetic component checks only. No browser, database, provider or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const selectedDate = '2025-10-27', groupId = 'group-a', currentUserId = 'student-a'
const props = { groupId, currentUserId, selectedDate, onDateChange() {}, canEdit: true, canParticipate: true,
  canManageResources: true, canModerateComments: true, canEditLongTermTasks: true, onManageLongTermTasks() {} }
const seminar = { id: 'seminar-a', group_id: groupId, subject_id: 'subject-a', schedule_id: 'schedule-a',
  lesson_date: selectedDate, starts_at: '08:00', ends_at: '09:20', title: 'Збережений семінар', instructions: 'Умови',
  format: 'questions', created_by: 'head-a', resource_links: ['https://example.com/material.pdf'], resource_attachments: [] }
const slot = { id: 'schedule-a', group_id: groupId, subject_id: 'subject-a', weekday: 1, starts_at: '08:00', ends_at: '09:20', valid_from: '2025-09-01', valid_until: '2026-08-31', created_by: 'head-a' }
const data = { supplement_capacity: 3, subjects: [{ id: 'subject-a', group_id: groupId, name: 'Економіка', created_by: 'head-a' }],
  schedule: [slot], seminars: [seminar], questions: [{ id: 'question-a', seminar_id: seminar.id, position: 1, body: 'Наше питання', primary_capacity: 1, supplement_capacity: 3 }],
  teams: [], reservations: [{ id: 'reservation-a', seminar_id: seminar.id, user_id: currentUserId, role: 'primary', question_id: 'question-a', team_id: null }],
  profiles: { [currentUserId]: { id: currentUserId, full_name: 'Студент Приклад' } }, streaks: {}, subjectStreaks: {} }

function fixture() {
  let stateIndex = 0, stateValues = [], effects = [], writes = 0
  const listeners = new Map()
  const jsx = (type, props, key) => ({ type, props: props || {}, key })
  const React = { useState(initial) { const i = stateIndex++; return [i in stateValues ? stateValues[i] : typeof initial === 'function' ? initial() : initial, () => {}] },
    useRef: value => ({ current: value }), useCallback: fn => fn, useMemo: fn => fn(), useEffect: fn => effects.push(fn), useId: () => 'fixture-id' }
  const component = name => Object.assign(() => null, { fixtureName: name })
  const chain = { on() { return chain }, subscribe() { return chain } }
  const supabase = { channel: () => chain, removeChannel: async () => {}, auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } }
  const resources = { cleanupPendingSeminarFiles: async () => { writes++; return true }, removeSeminarFiles: async () => { writes++ },
    uploadSeminarFiles: async () => { writes++; return [] }, updateSeminarResources: async () => { writes++ }, validateSeminarResources: () => ({ links: [], attachments: [] }), seminarResourceError: String }
  const seminarHelpers = { EMPTY_SEMINAR_DATA: data, SEMINAR_FORMATS: [{ id: 'questions', label: 'Питання', description: '' }], SEMINAR_WEEKDAYS: [], SEMINAR_MAX_SUPPLEMENT_CAPACITY: 30,
    addSeminarDays: value => value, formatSeminarDate: value => value, kyivToday: () => '2026-10-27', loadSeminars: async () => data,
    scheduleOnDate: () => true, seminarSlotsOnDate: () => [slot], seminarError: String, seminarHasStarted: () => true,
    seminarRpc: async () => { writes++ }, seminarStartMilliseconds: () => 0, seminarSupplementCapacity: value => value ?? 3,
    seminarWeek: value => Array.from({ length: 7 }, (_, i) => ({ id: i + 1, short: String(i + 1), date: value })) }
  const stubs = {
    react: React, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@tanstack/react-router': { Link: component('Link') },
    'lucide-react': new Proxy({}, { get: (_target, name) => component(String(name)) }),
    '../lib/supabase': { supabase }, '../context/ToastContext': { useToast: () => ({ notify() {} }) },
    './SeminarResources': { SeminarResourceFields: component('SeminarResourceFields'), SeminarResourceList: component('SeminarResourceList') },
    './SeminarComments': { SeminarComments: component('SeminarComments') }, './ShareStudyAssignment': { ShareStudyAssignment: component('ShareStudyAssignment') },
    './AddToOrganizer': { AddToOrganizer: component('AddToOrganizer') }, './StudyGroupLongTermTasks': { LongTermTaskList: component('LongTermTaskList') },
    './SeminarAiDraft': { SeminarAiDraft: component('SeminarAiDraft') }, '../lib/seminarResources': resources, '../lib/seminars': seminarHelpers,
    '../lib/seminarComments': { SEMINAR_COMMENT_MAX_LENGTH: 3000, loadSeminarComments: async () => ({ comments: [], profiles: {}, hasMore: false, membershipId: null }),
      seminarCommentAccessLost: () => false, seminarCommentError: String, addSeminarComment: async () => { writes++ }, deleteSeminarComment: async () => { writes++ }, updateSeminarComment: async () => { writes++ } },
  }
  const window = { addEventListener(name, fn) { listeners.set(name, fn) }, removeEventListener() {}, matchMedia: () => ({ matches: true }) }
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} }
  function load(file) {
    const module = { exports: {} }
    const source = ts.transpileModule(readFileSync(root + file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    vm.runInNewContext(source, { module, exports: module.exports, require(name) { if (!(name in stubs)) throw new Error('Unexpected dependency: ' + name); return stubs[name] },
      Date, Intl, Map, Set, Promise, window, document, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
      requestAnimationFrame: () => 0, cancelAnimationFrame() {} })
    return module.exports
  }
  function render(fn, props, values = []) { stateIndex = 0; stateValues = values; effects = []; return fn(props) }
  return { load, render, effects: () => effects, writes: () => writes, focus: () => listeners.get('focus')?.() }
}
function nodes(node) { return !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)] }
const name = node => node.type?.fixtureName

test('archive seminars override every write capability and remount existing editors', () => {
  const f = fixture(), { GroupSeminars } = f.load('src/components/GroupSeminars.tsx')
  const current = f.render(GroupSeminars, props), archived = f.render(GroupSeminars, { ...props, archiveReadOnly: true })
  assert.notEqual(current.key, archived.key)
  for (const permission of ['canEdit', 'canParticipate', 'canManageResources', 'canModerateComments', 'canEditLongTermTasks']) {
    assert.equal(current.props[permission], true)
    assert.equal(archived.props[permission], false)
  }
  assert.equal(archived.props.onManageLongTermTasks, undefined)
  assert.equal(current.props.onManageLongTermTasks, props.onManageLongTermTasks)
})

test('archive keeps seminar resources and historical reservations but removes side-effect entrypoints', async () => {
  const f = fixture(), { GroupSeminars } = f.load('src/components/GroupSeminars.tsx')
  const entry = f.render(GroupSeminars, { ...props, archiveReadOnly: true })
  const tree = f.render(entry.type, entry.props, [data, false, selectedDate]), all = nodes(tree)
  assert.ok(all.some(node => name(node) === 'SeminarResourceList'))
  assert.ok(all.some(node => node.props?.id === 'study-seminar-seminar-a'))
  assert.equal(all.some(node => ['ShareStudyAssignment', 'AddToOrganizer', 'SeminarAiDraft', 'SeminarResourceFields'].includes(name(node))), false)
  const comments = all.find(node => name(node) === 'SeminarComments')
  assert.equal(comments.props.canParticipate, false)
  assert.equal(comments.props.canModerate, false)
  assert.equal(comments.props.archiveReadOnly, true)
  for (const effect of f.effects()) effect()
  await f.focus()
  await Promise.resolve()
  assert.equal(f.writes(), 0, 'archive mount and focus must not clean up Storage or mutate data')
})

test('current-year seminar cleanup and independent student actions remain available', async () => {
  const f = fixture(), { GroupSeminars } = f.load('src/components/GroupSeminars.tsx')
  const entry = f.render(GroupSeminars, props), tree = f.render(entry.type, entry.props, [data, false, selectedDate]), all = nodes(tree)
  assert.ok(all.some(node => name(node) === 'ShareStudyAssignment'))
  assert.ok(all.some(node => name(node) === 'AddToOrganizer'))
  for (const effect of f.effects()) effect()
  await Promise.resolve()
  assert.ok(f.writes() > 0, 'current-year cleanup behavior is retained')
})

test('archive comments retain discussion and suppress even own edit/delete controls', () => {
  const f = fixture(), { SeminarComments } = f.load('src/components/SeminarComments.tsx')
  const scope = `${groupId}:seminar-a:${currentUserId}`
  const comments = { comments: [{ id: 'comment-own', author_id: currentUserId, body: 'Збережений коментар', created_at: '2025-10-27T08:00:00Z', updated_at: '2025-10-27T08:00:00Z' }],
    profiles: data.profiles, hasMore: false, membershipId: 'member-a' }
  const tree = f.render(SeminarComments, { seminarId: 'seminar-a', groupId, currentUserId, canParticipate: true, canModerate: true, archiveReadOnly: true }, [comments, scope, false])
  const all = nodes(tree)
  assert.equal(all.some(node => node.type === 'form' || node.type === 'textarea'), false)
  assert.equal(all.some(node => /Редагувати свій коментар|Видалити коментар/.test(node.props?.['aria-label'] || '')), false)
  assert.ok(JSON.stringify(tree).includes('Збережений коментар'))
})

test('current-year classmates keep their comment composer and own edit/delete controls', () => {
  const f = fixture(), { SeminarComments } = f.load('src/components/SeminarComments.tsx')
  const scope = `${groupId}:seminar-a:${currentUserId}`
  const comments = { comments: [{ id: 'comment-own', author_id: currentUserId, body: 'Поточний коментар', created_at: '2026-10-27T08:00:00Z', updated_at: '2026-10-27T08:00:00Z' }],
    profiles: data.profiles, hasMore: false, membershipId: 'member-a' }
  const tree = f.render(SeminarComments, { seminarId: 'seminar-a', groupId, currentUserId, canParticipate: true, canModerate: false }, [comments, scope, false])
  const all = nodes(tree)
  assert.ok(all.some(node => node.type === 'form'))
  assert.ok(all.some(node => node.type === 'textarea'))
  assert.ok(all.some(node => node.props?.['aria-label'] === 'Редагувати свій коментар'))
  assert.ok(all.some(node => (node.props?.['aria-label'] || '').startsWith('Видалити коментар:')))
})
