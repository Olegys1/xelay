// Existing-route destination selection only; no session, server or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTeachingHomeTarget, teachingHomeDate, teachingHomePlacement, teachingHomeSelectionTab, canOpenTeachingHomeTarget, canUseTeachingHomePermissions } from '../src/lib/teachingHomeNavigation.ts'

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const course = id(1), group = id(2), foreign = id(3)
const workspace = permissions => ({ courses: [{ id: course, permissions }], classrooms: [{ group_id: group, courses: [{ course_id: course, status: 'accepted' }] }], groups: [{ id: foreign }] })

test('destination parser accepts only existing teacher views, exact UUIDs and real calendar dates', () => {
  assert.deepEqual(parseTeachingHomeTarget({ home: 'calendar', course, group, date: '2026-10-31', item: foreign }), { home: 'calendar', courseId: course, groupId: group, date: '2026-10-31' })
  for (const home of ['seminars', 'teams', 'questions', 'https://example.test', ['requests']]) assert.equal(parseTeachingHomeTarget({ home }).home, undefined)
  for (const date of ['2026-02-30', '2026-13-01', '2026-1-01', '2026-10-28T00:00Z', '2026-10-28<script>', null]) assert.equal(teachingHomeDate(date), undefined)
  assert.equal(teachingHomeDate('2028-02-29'), '2028-02-29')
  assert.equal(parseTeachingHomeTarget({ course: 'not-an-id', group: `${group}/../${foreign}` }).groupId, undefined)
})

test('journal and group materials preserve the intended teacher facade tab', () => {
  assert.deepEqual(teachingHomePlacement('journal', true), { view: 'groups', tab: 'grades' })
  assert.deepEqual(teachingHomePlacement('assignments', true), { view: 'groups', tab: 'assignments' })
  assert.deepEqual(teachingHomePlacement('materials', true), { view: 'groups', tab: 'materials' })
  assert.deepEqual(teachingHomePlacement('materials'), { view: 'materials', tab: 'assignments' })
  assert.deepEqual(teachingHomePlacement('calendar'), { view: 'calendar', tab: 'assignments' })
})

test('selecting a group or course from the journal landing keeps grades and does not change ordinary navigation', () => {
  assert.equal(teachingHomeSelectionTab('journal'), 'grades')
  for (const home of [undefined, 'assignments', 'calendar', 'materials', 'requests', 'scheduled']) assert.equal(teachingHomeSelectionTab(home), 'assignments')
  assert.equal(canUseTeachingHomePermissions(['assignments'], 'journal'), false)
  assert.equal(canUseTeachingHomePermissions(['materials'], 'journal'), false)
  assert.equal(canUseTeachingHomePermissions(['grades'], 'journal'), true)
})

test('an explicit classroom is an exact accepted course/group pair, never a directory or name match', () => {
  const data = workspace(['assignments', 'grades'])
  assert.equal(canOpenTeachingHomeTarget(data, { courseId: course, groupId: group, home: 'journal' }), true)
  assert.equal(canOpenTeachingHomeTarget(data, { courseId: course, groupId: foreign, home: 'journal' }), false)
  assert.equal(canOpenTeachingHomeTarget(data, { courseId: foreign, groupId: group, home: 'journal' }), false)
  assert.equal(canOpenTeachingHomeTarget(data, { groupId: group, home: 'journal' }), false)
  data.classrooms[0].courses[0].status = 'pending_teacher'
  assert.equal(canOpenTeachingHomeTarget(data, { courseId: course, groupId: group, home: 'assignments' }), false)
})

test('home destinations retain existing granular permissions instead of silently changing the requested view', () => {
  const target = home => ({ courseId: course, groupId: group, home })
  assert.equal(canOpenTeachingHomeTarget(workspace(['assignments']), target('journal')), false)
  assert.equal(canOpenTeachingHomeTarget(workspace(['assignments']), target('requests')), false)
  assert.equal(canOpenTeachingHomeTarget(workspace(['grades']), target('assignments')), true)
  assert.equal(canOpenTeachingHomeTarget(workspace(['materials']), target('assignments')), false)
  assert.equal(canOpenTeachingHomeTarget(workspace(['materials']), target('materials'), true), true)
  assert.equal(canOpenTeachingHomeTarget(workspace(['grades']), target('scheduled')), false)
  assert.equal(canOpenTeachingHomeTarget(workspace(['materials']), target('scheduled')), true)
  assert.equal(canOpenTeachingHomeTarget(workspace(['materials']), target('calendar')), true)
  assert.equal(canOpenTeachingHomeTarget(workspace([]), target('calendar')), false)
  assert.equal(canUseTeachingHomePermissions(['assignments'], 'journal', true), false, 'A narrowed snapshot must be checked again')
})

test('revoking the group or a permission immediately invalidates the same link without selecting a replacement', () => {
  const data = workspace(['grades']), target = { courseId: course, groupId: group, home: 'journal', date: '2026-10-31' }
  const original = structuredClone(data)
  assert.equal(canOpenTeachingHomeTarget(data, target), true)
  assert.deepEqual(data, original)
  data.courses[0].permissions = ['materials']
  assert.equal(canOpenTeachingHomeTarget(data, target), false)
  data.courses[0].permissions = ['grades']
  data.classrooms[0].group_id = foreign
  assert.equal(canOpenTeachingHomeTarget(data, target), false)
})

test('global existing views keep their overview and legacy material-only course links still work', () => {
  assert.equal(canOpenTeachingHomeTarget(workspace([]), { home: 'materials' }), true)
  assert.equal(canOpenTeachingHomeTarget(workspace(['materials']), { courseId: course, groupId: group }), true)
  assert.equal(canOpenTeachingHomeTarget(workspace(['grades']), { courseId: course, groupId: group, home: 'journal', date: '2026-02-30' }), false)
})
