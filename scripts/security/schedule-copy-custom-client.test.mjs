import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const pureUrl = moduleUrl(compile(await readFile(new URL('src/lib/scheduleCopyTimes.ts', root), 'utf8')))
const calls = []
let response
globalThis.__customScheduleClient = { rpc: async (name, args) => { calls.push({ name, args: structuredClone(args) }); return { data: typeof response === 'function' ? response(args) : structuredClone(response), error: null } } }
const stubUrl = moduleUrl('export const supabase=globalThis.__customScheduleClient')
const timetableUrl = moduleUrl(compile(await readFile(new URL('src/lib/studyGroupTimetable.ts', root), 'utf8'))
  .replace(/from ['"]\.\/supabase['"]/g, 'from ' + JSON.stringify(stubUrl))
  .replace(/from ['"]\.\/scheduleCopyTimes['"]/g, 'from ' + JSON.stringify(pureUrl)))
const sequenceUrl = moduleUrl(compile(await readFile(new URL('src/lib/studyGroupScheduleSequence.ts', root), 'utf8'))
  .replace(/from ['"]\.\/supabase['"]/g, 'from ' + JSON.stringify(stubUrl))
  .replace(/from ['"]\.\/studyGroupTimetable['"]/g, 'from ' + JSON.stringify(timetableUrl)))
const { firstShiftSlotTime } = await import(pureUrl)
const { copyStudyGroupScheduleDay: day, validScheduleCopySlotAssignments: valid, loadStudyGroupScheduleCopySettings: settings } = await import(timetableUrl)
const { copyStudyGroupScheduleSequence: sequence } = await import(sequenceUrl)
const options = { firstShiftStart: '08:30', rememberFirstShiftStart: true }
const assignment = { source_starts_at: '14:30:00', source_ends_at: '15:50:00', target_lesson_number: 1, target_starts_at: '08:30:00', target_ends_at: '09:50:00' }
const lesson = { id: 'synthetic-lesson', subject: 'Синтетична математика', lesson_type: 'seminar', starts_at: '08:30:00', ends_at: '09:50:00', lesson_number: 1, source_starts_at: '14:30:00', source_ends_at: '15:50:00', source_lesson_number: 5 }
const preview = (isPreview = true) => ({ copied: 1, skipped: 0, source_signature: 'signed-preview', lessons: isPreview ? [lesson] : [], slot_assignments: [assignment], first_shift_start: '08:30', settings_revision: 2 })

test('08:30 shifts the real grid and preserves the shorter midday break', () => {
  assert.deepEqual(firstShiftSlotTime('08:30', 1), { starts_at: '08:30', ends_at: '09:50' })
  assert.deepEqual(firstShiftSlotTime('08:30', 2), { starts_at: '10:10', ends_at: '11:30' })
  assert.deepEqual(firstShiftSlotTime('08:30', 4), { starts_at: '13:20', ends_at: '14:40' })
  assert.deepEqual(firstShiftSlotTime('22:00', 1), { starts_at: '22:00', ends_at: '23:20' })
  assert.throws(() => firstShiftSlotTime('22:00', 2), /CUSTOM_TIME_INVALID/)
  for (const value of ['24:00', '8:30', '08:30:00', '08:60', '']) assert.throws(() => firstShiftSlotTime(value, 1))
})

test('manual intervals reject partial, inverted, overlapping or second-resolution destinations', () => {
  assert.equal(valid([assignment], true, '08:30'), true)
  assert.equal(valid([{ ...assignment, target_ends_at: undefined }], true), false)
  assert.equal(valid([{ ...assignment, target_ends_at: '08:20' }], true), false)
  assert.equal(valid([{ ...assignment, target_starts_at: '08:30:01' }], true), false)
  const second = { ...assignment, source_starts_at: '16:10', source_ends_at: '17:30', target_lesson_number: 2, target_starts_at: '09:40', target_ends_at: '11:00' }
  assert.equal(valid([assignment, second], true, '08:30'), false)
  assert.equal(valid([assignment, { ...second, target_starts_at: '09:50' }], true, '08:30'), true)
})

test('settings response is validated and bound to the requested group RPC', async () => {
  calls.length = 0; response = { first_shift_start: '08:30', revision: 3 }
  assert.deepEqual(await settings('group-b'), response)
  assert.deepEqual(calls[0], { name: 'xelay_schedule_copy_settings', args: { p_group_id: 'group-b' } })
  for (const value of [{ first_shift_start: '24:00', revision: 3 }, { first_shift_start: '08:30', revision: -1 }, []]) {
    response = value; await assert.rejects(settings('group-b'), /SETTINGS_RESPONSE_UNKNOWN/)
  }
})

test('preview and confirmation carry the same remember choice, exact reviewed signature and minute-normalized times', async () => {
  calls.length = 0; response = args => preview(args.p_preview)
  const result = await day('group-b', '2026-10-26', '2026-10-31', true, null, 'first_shift', [assignment], options)
  await day('group-b', '2026-10-26', '2026-10-31', false, result.source_signature, 'first_shift', result.slot_assignments, options)
  for (const call of calls) {
    assert.equal(call.name, 'xelay_copy_study_group_schedule_day_with_custom_times')
    assert.equal(call.args.p_first_shift_start, '08:30'); assert.equal(call.args.p_remember_first_shift_start, true)
    assert.equal(call.args.p_slot_assignments[0].target_starts_at, '08:30'); assert.equal(call.args.p_slot_assignments[0].target_ends_at, '09:50')
    assert.equal(call.args.p_slot_assignments[0].source_starts_at, '14:30:00')
  }
  assert.equal(calls[1].args.p_expected_signature, 'signed-preview')
  assert.equal(assignment.target_starts_at, '08:30:00')
})

test('a response cannot silently change the chosen start, a manual interval or the actual copied lesson time', async () => {
  for (const value of [
    { ...preview(), first_shift_start: '08:00' },
    { ...preview(), slot_assignments: [{ ...assignment, target_starts_at: '08:40' }], lessons: [{ ...lesson, starts_at: '08:40' }] },
    { ...preview(), lessons: [{ ...lesson, starts_at: '08:00' }] },
    { ...preview(), settings_revision: undefined },
  ]) {
    response = value
    await assert.rejects(day('group-b', '2026-10-26', '2026-10-31', true, null, 'first_shift', [assignment], options), /RESPONSE_UNKNOWN/)
  }
})

test('sequence custom overrides belong to destination dates and each date can have its own reviewed time', async () => {
  const pairs = [{ source_date: '2026-10-26', target_date: '2026-10-31' }, { source_date: '2026-10-26', target_date: '2026-11-07' }]
  calls.length = 0
  const later = { ...assignment, target_starts_at: '09:00:00', target_ends_at: '10:20:00' }
  response = args => ({ copied: 2, skipped: 0, source_signature: 'sequence-signature', first_shift_start: '08:30', settings_revision: 2,
    days: pairs.map((pair, index) => ({ ...pair, copied: 1, skipped: 0, empty: false, slot_assignments: [index ? later : assignment], lessons: args.p_preview ? [{ ...lesson, ...(index ? { starts_at: '09:00:00', ends_at: '10:20:00' } : {}) }] : [] })) })
  await sequence('group-b', pairs, true, null, 'first_shift', { '2026-10-31': [assignment], '2026-11-07': [later] }, options)
  assert.equal(calls[0].name, 'xelay_copy_study_group_schedule_sequence_with_custom_times')
  assert.equal(calls[0].args.p_slot_assignments['2026-11-07'][0].target_starts_at, '09:00')
  await assert.rejects(sequence('group-b', pairs, true, null, 'first_shift', { '2026-10-26': [assignment] }, options), /SLOT_ASSIGNMENTS_INVALID/)
})

test('remembering is Saturday-only and legacy original-time calls retain their original endpoint and data', async () => {
  calls.length = 0
  await assert.rejects(day('group-b', '2026-10-26', '2026-11-01', true, null, 'first_shift', [], options), /REMEMBER_SATURDAY_ONLY/)
  assert.equal(calls.length, 0)
  response = { copied: 1, skipped: 0, source_signature: 'legacy', lessons: [{ id: 'original', subject: 'Семінар', lesson_type: 'seminar', starts_at: '16:10', ends_at: '17:30' }] }
  const result = await day('group-b', '2026-10-26', '2026-10-31', true)
  assert.equal(calls[0].name, 'xelay_copy_study_group_schedule_day')
  assert.equal(result.lessons[0].starts_at, '16:10')
})
