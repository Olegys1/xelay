import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = new URL('../../', import.meta.url)
const dataModule = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const calls = []
let rpcResult
globalThis.__scheduleSequenceClient = { rpc: async (name, args) => { calls.push({ name, args }); return typeof rpcResult === 'function' ? rpcResult(name, args) : rpcResult } }
let source = compile(await readFile(new URL('src/lib/studyGroupScheduleSequence.ts', root), 'utf8'))
source = source.replace(/from ['"]\.\/supabase['"]/, 'from ' + JSON.stringify(dataModule('export const supabase=globalThis.__scheduleSequenceClient')))
let timetable = compile(await readFile(new URL('src/lib/studyGroupTimetable.ts', root), 'utf8'))
timetable = timetable.replace(/from ['"]\.\/supabase['"]/, 'from ' + JSON.stringify(dataModule('export const supabase=globalThis.__scheduleSequenceClient')))
source = source.replace(/from ['"]\.\/studyGroupTimetable['"]/, 'from ' + JSON.stringify(dataModule(timetable)))
const { buildScheduleCopySequence, scheduleCopyCycle, copyStudyGroupScheduleSequence } = await import(dataModule(source))
const { copyStudyGroupScheduleDay, validScheduleCopySlotAssignments, validFirstShiftCopyLessons, DEFAULT_TIMETABLE_SLOTS, scheduleCopyTimeKey } = await import(dataModule(timetable))
const addDays = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const pairs = buildScheduleCopySequence('2026-10-17', '2026-11-21', [1, 2, 3, 4, 5], 1)
const lesson = { id: 'lesson', subject: 'Економіка', starts_at: '09:40', ends_at: '11:00', lesson_type: 'seminar' }
const response = input => ({ copied: input.length, skipped: 0, source_signature: 'approved-signature', days: input.map(pair => ({ ...pair, copied: 1, skipped: 0, lessons: [lesson], empty: false })) })

test('weekly targets rotate selected source weekdays in each target’s own actual week', () => {
  assert.deepEqual(pairs, [
    { source_date: '2026-10-12', target_date: '2026-10-17' },
    { source_date: '2026-10-20', target_date: '2026-10-24' },
    { source_date: '2026-10-28', target_date: '2026-10-31' },
    { source_date: '2026-11-05', target_date: '2026-11-07' },
    { source_date: '2026-11-13', target_date: '2026-11-14' },
    { source_date: '2026-11-16', target_date: '2026-11-21' },
  ])
  assert.deepEqual(scheduleCopyCycle([5, 1, 3, 3], 3), [3, 5, 1])
  assert.deepEqual(buildScheduleCopySequence('2026-10-18', '2026-11-01', [1, 3, 5], 3), [
    { source_date: '2026-10-14', target_date: '2026-10-18' },
    { source_date: '2026-10-23', target_date: '2026-10-25' },
    { source_date: '2026-10-26', target_date: '2026-11-01' },
  ])
})

test('planner rejects invalid dates and empty weekdays and enforces exactly 26 weekly targets', () => {
  assert.equal(buildScheduleCopySequence('2026-10-17', addDays('2026-10-17', 175), [1], 1).length, 26)
  assert.throws(() => buildScheduleCopySequence('2026-10-17', addDays('2026-10-17', 182), [1], 1), /26/)
  for (const [first, until, weekdays, start] of [
    ['2026-10-16', '2026-11-01', [1], 1], ['2026-02-30', '2026-11-01', [1], 1],
    ['2026-10-17', '2026-10-01', [1], 1], ['2026-10-17', '2026-11-01', [], 1],
    ['2026-10-17', '2026-11-01', [1, 6], 1], ['2026-10-17', '2026-11-01', [1, 3], 2],
  ]) assert.throws(() => buildScheduleCopySequence(first, until, weekdays, start))
})

test('client sends one atomic RPC for all dates and sends the reviewed signature on save', async () => {
  calls.length = 0
  rpcResult = { data: response(pairs), error: null }
  const preview = await copyStudyGroupScheduleSequence('group', pairs, true)
  await copyStudyGroupScheduleSequence('group', pairs, false, preview.source_signature)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { name: 'xelay_copy_study_group_schedule_sequence', args: { p_group_id: 'group', p_pairs: pairs, p_preview: true, p_expected_signature: null } })
  assert.equal(calls[1].args.p_preview, false)
  assert.equal(calls[1].args.p_expected_signature, 'approved-signature')
  assert.deepEqual(calls[1].args.p_pairs, pairs)
  assert.equal(Object.keys(calls[1].args).length, 4)
})

test('client accepts individual empty days but rejects stale or malformed response mappings', async () => {
  const empty = response(pairs)
  empty.copied -= 1; empty.days[1] = { ...pairs[1], copied: 0, skipped: 0, lessons: [], empty: true }
  rpcResult = { data: empty, error: null }
  assert.equal((await copyStudyGroupScheduleSequence('group', pairs, true)).days[1].empty, true)
  for (const broken of [
    { ...empty, copied: 100 }, { ...empty, days: empty.days.slice(1) },
    { ...empty, source_signature: '' }, { ...empty, days: empty.days.map((day, i) => i === 0 ? { ...day, target_date: '2027-01-02' } : day) },
  ]) { rpcResult = { data: broken, error: null }; await assert.rejects(copyStudyGroupScheduleSequence('group', pairs, true), /RESPONSE_UNKNOWN/) }
  calls.length = 0
  await assert.rejects(copyStudyGroupScheduleSequence('group', [...pairs].reverse(), true), /INVALID_INPUT/)
  assert.equal(calls.length, 0)
})

const componentSource = await readFile(new URL('src/components/GroupScheduleCopy.tsx', root), 'utf8')
const parsed = ts.createSourceFile('GroupScheduleCopy.tsx', componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const workspace = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'CopyWorkspace')
const declaration = name => workspace.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(parsed) === name).initializer.getText(parsed)
const names = ['activePreview','previewKey','configuration','baseConfiguration','timeMode','slotAssignments','setMappingWorkspace','canEdit','current','saveLock','loading','request','setSaving','setError','setLoading','mode','copyStudyGroupScheduleDay','copyStudyGroupScheduleSequence','groupId','sourceDate','targetDate','buildScheduleCopySequence','firstTarget','until','sourceWeekdays','firstWeekday','alive','setOpen','setPreview','setSequencePreview','setPreviewKey','onCopied','notify','dateLabel','sequencePreview','explain','errorMessage','isTimetableDate']
const harness = await import(dataModule(compile(`export function createActions(context:any) { const {${names.join(',')}}=context; return {copy:${declaration('copy')},refresh:${declaration('refresh')}}; }`)))
function actionFixture(overrides = {}) {
  const events = []; const state = {}
  const preview = response(pairs)
  const context = {
    activePreview: preview, previewKey: 'config', configuration: 'config', baseConfiguration: 'base', timeMode: 'original', slotAssignments: {}, canEdit: true, current: { current: { configuration: 'config', canEdit: true, open: true } }, saveLock: { current: false }, loading: false, request: { current: 0 }, mode: 'sequence', groupId: 'group', sourceDate: '2026-10-12', targetDate: '2026-10-17', firstTarget: '2026-10-17', until: '2026-11-21', sourceWeekdays: [1, 2, 3, 4, 5], firstWeekday: 1, alive: { current: true }, sequencePreview: preview,
    buildScheduleCopySequence, isTimetableDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value), dateLabel: value => value,
    copyStudyGroupScheduleDay: async (...args) => { events.push(['day', args]); return preview },
    copyStudyGroupScheduleSequence: async (...args) => { events.push(['sequence', args]); return preview },
    onCopied: async () => { events.push(['reload']); return true }, notify: value => events.push(['toast', value]), explain: error => { state.error = error.message }, errorMessage: error => error.message,
    ...overrides,
  }
  for (const name of ['setSaving','setError','setLoading','setOpen','setPreview','setSequencePreview','setPreviewKey','setMappingWorkspace']) context[name] = value => { state[name] = value }
  return { context, events, state, actions: harness.createActions(context) }
}

test('actual copy action prevents duplicate clicks and refuses stale, empty, or revoked approvals', async () => {
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  let requests = 0
  const fx = actionFixture({ copyStudyGroupScheduleSequence: async () => { requests++; return pending } })
  const first = fx.actions.copy(); await fx.actions.copy()
  assert.equal(requests, 1)
  complete(response(pairs)); await first
  assert.equal(fx.events.filter(event => event[0] === 'reload').length, 1)
  for (const override of [{ previewKey: 'old' }, { canEdit: false }, { loading: true }, { activePreview: { copied: 0, skipped: 0 } }, { current: { current: { configuration: 'new', canEdit: true, open: true } } }, { current: { current: { configuration: 'config', canEdit: false, open: true } } }]) {
    const blocked = actionFixture(override); await blocked.actions.copy(); assert.equal(blocked.events.length, 0)
  }
})

test('actual preview ignores responses after configuration changes and save uses the original single-day path when selected', async () => {
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  const fx = actionFixture({ copyStudyGroupScheduleSequence: () => pending })
  const first = fx.actions.refresh()
  fx.context.current.current.configuration = 'newer-config'
  complete(response(pairs)); await first
  assert.equal(fx.state.setSequencePreview, null)
  assert.equal(fx.state.setPreviewKey, '')
  const single = actionFixture({ mode: 'day' }); await single.actions.copy()
  assert.equal(single.events[0][0], 'day')
  assert.deepEqual(single.events[0][1], ['group', '2026-10-12', '2026-10-17', false, 'approved-signature', 'original', []])
  assert.equal(single.events.some(event => event[0] === 'sequence'), false)
})

test('source-change rejection clears the approval and never reloads as a successful copy', async () => {
  const fx = actionFixture({ copyStudyGroupScheduleSequence: async () => { throw new Error('STUDY_GROUP_TIMETABLE_COPY_SOURCE_CHANGED') } })
  await fx.actions.copy()
  assert.equal(fx.state.setSequencePreview, null)
  assert.equal(fx.state.setPreviewKey, '')
  assert.equal(fx.events.some(event => event[0] === 'reload'), false)
  assert.equal(fx.events.at(-1)[1].tone, 'error')
})

const assignments = [{ source_starts_at: '16:10:00', source_ends_at: '17:30:00', target_lesson_number: 1 }]
const shiftedLesson = { ...lesson, starts_at: '08:00:00', ends_at: '09:20:00', lesson_number: 1,
  source_starts_at: '16:10:00', source_ends_at: '17:30:00', source_lesson_number: 6 }
const shiftedResponse = input => ({ copied: input.length, skipped: 0, source_signature: 'shift-approved', days: input.map(pair => ({ ...pair, copied: 1, skipped: 0, lessons: [shiftedLesson], empty: false, slot_assignments: assignments })) })

test('first-shift assignments reject equal normalized times, duplicate slots, invalid times, and arbitrary target times', () => {
  assert.equal(validScheduleCopySlotAssignments(assignments), true)
  for (const invalid of [null, {}, [{ ...assignments[0], source_starts_at: null }], [{ ...assignments[0], source_starts_at: '25:00' }],
    [{ ...assignments[0], source_starts_at: '08:00', source_ends_at: '08:00:00' }], [{ ...assignments[0], target_lesson_number: 6 }],
    [assignments[0], { source_starts_at: '17:50', source_ends_at: '19:10', target_lesson_number: 1 }],
    [assignments[0], { ...assignments[0], source_starts_at: '16:10', source_ends_at: '17:30', target_lesson_number: 2 }],
  ]) assert.equal(validScheduleCopySlotAssignments(invalid), false)
  assert.equal(validFirstShiftCopyLessons([shiftedLesson, { ...shiftedLesson, id: 'parallel' }], assignments, true), true)
  assert.equal(validFirstShiftCopyLessons([{ ...shiftedLesson, starts_at: '08:10:00' }], assignments, true), false)
  assert.equal(validFirstShiftCopyLessons([{ ...shiftedLesson, source_starts_at: undefined }], assignments, true), false)
  assert.equal(validFirstShiftCopyLessons([], assignments, false), true)
  assert.equal(validFirstShiftCopyLessons([shiftedLesson], assignments, false), false)
})

test('single-day first-shift sends the exact mapping and reviewed signature while original retains the legacy endpoint', async () => {
  calls.length = 0
  rpcResult = (_name, args) => ({ data: { copied: 1, skipped: 0, source_signature: 'shift-approved', lessons: args.p_preview ? [shiftedLesson] : [], slot_assignments: assignments }, error: null })
  const result = await copyStudyGroupScheduleDay('group', '2026-10-12', '2026-10-17', true, null, 'first_shift', assignments)
  await copyStudyGroupScheduleDay('group', '2026-10-12', '2026-10-17', false, result.source_signature, 'first_shift', assignments)
  assert.equal(calls[0].name, 'xelay_copy_study_group_schedule_day_with_time_mode')
  assert.deepEqual(calls[0].args.p_slot_assignments, assignments)
  assert.equal(calls[1].args.p_expected_signature, 'shift-approved')
  assert.equal(calls[1].args.p_time_mode, 'first_shift')
  await copyStudyGroupScheduleDay('group', '2026-10-12', '2026-10-17', true)
  assert.equal(calls[2].name, 'xelay_copy_study_group_schedule_day')
  assert.equal(Object.keys(calls[2].args).length, 5)
  rpcResult = { data: { copied: 1, skipped: 0, source_signature: 'wrong', lessons: [{ ...shiftedLesson, ends_at: '10:00' }], slot_assignments: assignments }, error: null }
  await assert.rejects(copyStudyGroupScheduleDay('group', '2026-10-12', '2026-10-17', true, null, 'first_shift'), /RESPONSE_UNKNOWN/)
})

test('sequence first-shift keeps mappings per exact source date and rejects unrelated dates or incomplete projections', async () => {
  calls.length = 0
  const perDate = { [pairs[0].source_date]: assignments, [pairs[1].source_date]: [{ source_starts_at: '08:00', source_ends_at: '09:20', target_lesson_number: 1 }] }
  rpcResult = { data: shiftedResponse(pairs), error: null }
  await copyStudyGroupScheduleSequence('group', pairs, true, null, 'first_shift', perDate)
  assert.equal(calls[0].name, 'xelay_copy_study_group_schedule_sequence_with_time_mode')
  assert.deepEqual(calls[0].args.p_slot_assignments, perDate)
  assert.equal(Object.keys(calls[0].args).length, 6)
  await assert.rejects(copyStudyGroupScheduleSequence('group', pairs, true, null, 'first_shift', { '2026-01-01': assignments }), /SLOT_ASSIGNMENTS_INVALID/)
  const malformed = shiftedResponse(pairs)
  malformed.days[2].lessons = [{ ...shiftedLesson, source_lesson_number: undefined }]
  rpcResult = { data: malformed, error: null }
  await assert.rejects(copyStudyGroupScheduleSequence('group', pairs, true, null, 'first_shift'), /RESPONSE_UNKNOWN/)
  assert.equal(calls.length, 2)
})

test('actual preview caches editable time mappings and save sends the same mode/mapping without changing sources', async () => {
  const planned = shiftedResponse(pairs)
  const byDate = { [pairs[0].source_date]: assignments }
  const fx = actionFixture({ timeMode: 'first_shift', slotAssignments: byDate, activePreview: planned, sequencePreview: planned,
    copyStudyGroupScheduleSequence: async (...args) => { fx.events.push(['sequence', args]); return planned } })
  await fx.actions.refresh()
  assert.equal(fx.state.setMappingWorkspace.base, 'base')
  assert.equal(fx.state.setMappingWorkspace.days[0].source_date, pairs[0].source_date)
  assert.deepEqual(fx.state.setMappingWorkspace.days[0].slot_assignments, assignments)
  await fx.actions.copy()
  const save = fx.events.filter(event => event[0] === 'sequence').at(-1)[1]
  assert.equal(save[3], 'shift-approved')
  assert.equal(save[4], 'first_shift')
  assert.deepEqual(save[5], byDate)
  assert.deepEqual(save[1], pairs)
  assert.equal(fx.events.filter(event => event[0] === 'sequence').length, 2)
})

test('changing any time mapping invalidates approval; late first-shift preview cannot replace a newer configuration', async () => {
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  const fx = actionFixture({ timeMode: 'first_shift', copyStudyGroupScheduleSequence: () => pending })
  const loading = fx.actions.refresh()
  fx.context.current.current.configuration = 'different-slot'
  complete(shiftedResponse(pairs)); await loading
  assert.equal(fx.state.setMappingWorkspace, undefined)
  assert.equal(fx.state.setPreviewKey, '')
  await fx.actions.copy()
  assert.equal(fx.events.length, 0)
  const configModule = await import(dataModule(compile(`export function config(context:any) { const {mode,sourceDate,firstTarget,until,sourceWeekdays,firstWeekday,timeMode,overrideState}=context; const baseConfiguration=${declaration('baseConfiguration')}; const slotAssignments=${declaration('slotAssignments')}; const configuration=${declaration('configuration')}; return {baseConfiguration,configuration,slotAssignments}; }`)))
  const base = { ...actionFixture().context, overrideState: { base: '', assignments: {} } }
  const initial = configModule.config(base)
  const custom = configModule.config({ ...base, overrideState: { base: initial.baseConfiguration, assignments: { '2026-10-12': assignments } } })
  assert.notEqual(initial.configuration, custom.configuration)
  assert.deepEqual(configModule.config({ ...base, sourceDate: '2026-10-13', overrideState: { base: initial.baseConfiguration, assignments: byDateForTest() } }).slotAssignments, {})
  assert.notEqual(initial.configuration, configModule.config({ ...base, timeMode: 'first_shift' }).configuration)
  function byDateForTest() { return { '2026-10-12': assignments } }
})

globalThis.__firstShiftRendering = { React, DEFAULT_TIMETABLE_SLOTS, scheduleCopyTimeKey }
const mappingFunctions = ['LessonCopyTime', 'FirstShiftMapping'].map(name => parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(parsed)).join('\n')
const mappingCode = ts.transpileModule(`const {React,DEFAULT_TIMETABLE_SLOTS,scheduleCopyTimeKey}=globalThis.__firstShiftRendering; const useId=()=> 'mapping'; const dateLabel=(value:string)=>value; ${mappingFunctions}; export {LessonCopyTime,FirstShiftMapping}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText
const { LessonCopyTime, FirstShiftMapping } = await import(dataModule(mappingCode))
test('actual mapping controls show exact source/target dates, predefined times and accessible slot names; only selected mapping is edited', () => {
  let selected
  const props = { sourceDate: '2026-10-12', targetDate: '2026-10-17', lessons: [shiftedLesson], assignments, disabled: false, onChange: value => { selected = value } }
  const html = renderToStaticMarkup(React.createElement(FirstShiftMapping, props))
  assert.match(html, /2026-10-12/); assert.match(html, /2026-10-17/)
  assert.match(html, /16:10–17:30/); assert.match(html, /08:00–09:20/)
  assert.match(html, /Номер пари для 2026-10-12/)
  assert.equal((html.match(/<option/g) || []).length, 5)
  const rendered = FirstShiftMapping(props)
  const find = node => node?.type === 'select' ? node : React.Children.toArray(node?.props?.children).map(find).find(Boolean)
  find(rendered).props.onChange({ target: { value: '3' } })
  assert.deepEqual(selected, [{ ...assignments[0], target_lesson_number: 3 }])
  assert.deepEqual(assignments, [{ source_starts_at: '16:10:00', source_ends_at: '17:30:00', target_lesson_number: 1 }])
  const times = renderToStaticMarkup(React.createElement(LessonCopyTime, { lesson: shiftedLesson, shifted: true }))
  assert.match(times, /16:10–17:30/); assert.match(times, /08:00–09:20/); assert.match(times, /перенесено на/)
})
