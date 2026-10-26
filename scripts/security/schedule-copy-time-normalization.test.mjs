import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const moduleUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const calls = []
let response
globalThis.__scheduleTimeNormalization = {
  rpc: async (name, args) => {
    calls.push({ name, args })
    return { data: typeof response === 'function' ? response(args) : structuredClone(response), error: null }
  },
}
const supabaseUrl = moduleUrl('export const supabase=globalThis.__scheduleTimeNormalization')
const copyTimesUrl = moduleUrl(compile(await readFile(new URL('src/lib/scheduleCopyTimes.ts', root), 'utf8')))
const timetable = compile(await readFile(new URL('src/lib/studyGroupTimetable.ts', root), 'utf8'))
  .replace(/from ['"]\.\/supabase['"]/, 'from ' + JSON.stringify(supabaseUrl))
  .replace(/from ['"]\.\/scheduleCopyTimes['"]/g, 'from ' + JSON.stringify(copyTimesUrl))
const timetableUrl = moduleUrl(timetable)
const sequence = compile(await readFile(new URL('src/lib/studyGroupScheduleSequence.ts', root), 'utf8'))
  .replace(/from ['"]\.\/supabase['"]/, 'from ' + JSON.stringify(supabaseUrl))
  .replace(/from ['"]\.\/studyGroupTimetable['"]/, 'from ' + JSON.stringify(timetableUrl))
const { scheduleCopyTimeKey, validScheduleCopySlotAssignments, validFirstShiftCopyLessons, copyStudyGroupScheduleDay } = await import(timetableUrl)
const { copyStudyGroupScheduleSequence } = await import(moduleUrl(sequence))

const short = [{ source_starts_at: '16:10', source_ends_at: '17:30', target_lesson_number: 1 }]
const canonical = [{ source_starts_at: '16:10:00', source_ends_at: '17:30:00', target_lesson_number: 1 }]
const lesson = {
  id: 'synthetic-lesson', subject: 'Синтетичний предмет', lesson_type: 'lecture',
  starts_at: '08:00:00', ends_at: '09:20:00', lesson_number: 1,
  source_starts_at: '16:10:00', source_ends_at: '17:30:00', source_lesson_number: 6,
}
const dayResult = preview => ({ copied: 1, skipped: 0, source_signature: 'canonical-reviewed', lessons: preview ? [lesson] : [], slot_assignments: canonical })

test('short and PostgreSQL canonical times identify the same interval without merging different seconds', () => {
  assert.equal(scheduleCopyTimeKey('16:10', '17:30'), scheduleCopyTimeKey('16:10:00', '17:30:00'))
  assert.notEqual(scheduleCopyTimeKey('16:10', '17:30'), scheduleCopyTimeKey('16:10:01', '17:30:00'))
  assert.equal(validScheduleCopySlotAssignments(short), true)
  assert.equal(validScheduleCopySlotAssignments(canonical), true)
  assert.equal(validScheduleCopySlotAssignments([...short, { ...canonical[0], target_lesson_number: 2 }]), false)
  assert.equal(validScheduleCopySlotAssignments([{ ...short[0], source_ends_at: '16:10:00' }]), false)
})

test('canonical lesson times match short source assignments and predefined short target slots', () => {
  assert.equal(validFirstShiftCopyLessons([lesson], short, true), true)
  assert.equal(validFirstShiftCopyLessons([{ ...lesson, source_starts_at: '16:10', source_ends_at: '17:30', starts_at: '08:00', ends_at: '09:20' }], canonical, true), true)
  assert.equal(validFirstShiftCopyLessons([{ ...lesson, starts_at: '08:00:01' }], canonical, true), false)
})

test('day copy accepts short overrides with a canonical server response and confirms its reviewed mapping', async () => {
  calls.length = 0
  response = args => dayResult(args.p_preview)
  const preview = await copyStudyGroupScheduleDay('synthetic-group', '2026-10-12', '2026-10-17', true, null, 'first_shift', short)
  assert.deepEqual(calls[0].args.p_slot_assignments, short)
  assert.deepEqual(preview.slot_assignments, canonical)
  await copyStudyGroupScheduleDay('synthetic-group', '2026-10-12', '2026-10-17', false, preview.source_signature, 'first_shift', preview.slot_assignments)
  assert.equal(calls[1].args.p_expected_signature, 'canonical-reviewed')
  assert.deepEqual(calls[1].args.p_slot_assignments, canonical)
})

test('sequence copy preserves exact source dates across short requests and canonical responses', async () => {
  calls.length = 0
  const pairs = [{ source_date: '2026-10-12', target_date: '2026-10-17' }, { source_date: '2026-10-20', target_date: '2026-10-24' }]
  response = args => ({ copied: 2, skipped: 0, source_signature: 'canonical-sequence', days: pairs.map(pair => ({ ...pair, copied: 1, skipped: 0, empty: false, lessons: args.p_preview ? [lesson] : [], slot_assignments: canonical })) })
  const byDate = Object.fromEntries(pairs.map(pair => [pair.source_date, short]))
  const preview = await copyStudyGroupScheduleSequence('synthetic-group', pairs, true, null, 'first_shift', byDate)
  assert.deepEqual(calls[0].args.p_slot_assignments, byDate)
  const reviewed = Object.fromEntries(preview.days.map(day => [day.source_date, day.slot_assignments]))
  await copyStudyGroupScheduleSequence('synthetic-group', pairs, false, preview.source_signature, 'first_shift', reviewed)
  assert.deepEqual(calls[1].args.p_slot_assignments, Object.fromEntries(pairs.map(pair => [pair.source_date, canonical])))
  assert.equal(calls[1].args.p_expected_signature, 'canonical-sequence')
})

test('unsupported fractional source times fail closed rather than approving a different interval', async () => {
  const fractional = [{ ...canonical[0], source_starts_at: '16:10:00.5' }]
  assert.equal(validScheduleCopySlotAssignments(fractional), false)
  calls.length = 0
  await assert.rejects(copyStudyGroupScheduleDay('synthetic-group', '2026-10-12', '2026-10-17', true, null, 'first_shift', fractional), /SLOT_ASSIGNMENTS_INVALID/)
  assert.equal(calls.length, 0)
  response = { ...dayResult(true), slot_assignments: fractional, lessons: [{ ...lesson, source_starts_at: '16:10:00.5' }] }
  await assert.rejects(copyStudyGroupScheduleDay('synthetic-group', '2026-10-12', '2026-10-17', true, null, 'first_shift'), /RESPONSE_UNKNOWN/)
})
