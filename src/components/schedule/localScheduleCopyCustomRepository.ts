import { firstShiftSlotTime } from '../../lib/scheduleCopyTimes'
import type { GroupScheduleCopyServices } from '../GroupScheduleCopy'
import type { ScheduleCopyLesson, ScheduleCopyPreview, ScheduleCopySettings, ScheduleCopySlotAssignment, ScheduleCopyTimeMode, ScheduleCopyTimeOptions } from '../../lib/studyGroupTimetable'
import type { ScheduleCopyPair, ScheduleCopySequencePreview } from '../../lib/studyGroupScheduleSequence'

export const LOCAL_COPY_GROUPS = [
  { id: 'local-schedule-group-1', name: 'Група 1 · Економіка', description: 'Початковий час · 08:00' },
  { id: 'local-schedule-group-2', name: 'Група 2 · Менеджмент', description: 'Раніше збережено · 08:30' },
] as const
export type LocalScheduleCopyRecord = { groupId: string; sourceDate: string; targetDate: string; sourceId: string; subject: string; startsAt: string; endsAt: string }
type LocalGroup = ScheduleCopySettings & { sourceRevision: number }
type Plan = { groupId: string; pairs: ScheduleCopyPair[]; mode: ScheduleCopyTimeMode; mappings: Record<string, ScheduleCopySlotAssignment[]>; options: ScheduleCopyTimeOptions }
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7
const time = (value: string) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value)) throw new Error('TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID')
  return value.slice(0, 5)
}
const intervalKey = (start: string, end: string) => `${time(start)}/${time(end)}`

/** A synthetic in-memory adapter for the real copy component. No provider/session/network imports. */
export function createLocalScheduleCopyCustomRepository({ latency = 0 }: { latency?: number } = {}) {
  const groups = new Map<string, LocalGroup>()
  const records: LocalScheduleCopyRecord[] = []
  const listeners = new Set<() => void>()
  const receipts = new Map<string, { signature: string; configuration: string; sourceRevision: number; previousRevision: number; revision: number; firstShiftStart: string }>()
  let changeNext = false
  let failNext = false
  let successfulCopies = 0
  let lastAction = 'Оберіть групу та відкрийте копіювання.'
  const emit = () => listeners.forEach(listener => listener())
  const pause = async () => { if (latency) await new Promise(resolve => setTimeout(resolve, latency)) }
  const group = (id: string) => { const result = groups.get(id); if (!result) throw new Error('LOCAL_PREVIEW_UNKNOWN_GROUP'); return result }
  const reset = () => {
    groups.clear()
    groups.set(LOCAL_COPY_GROUPS[0].id, { first_shift_start: '08:00', revision: 0, sourceRevision: 1 })
    groups.set(LOCAL_COPY_GROUPS[1].id, { first_shift_start: '08:30', revision: 1, sourceRevision: 1 })
    records.splice(0); receipts.clear(); changeNext = false; failNext = false; successfulCopies = 0
    lastAction = 'Приклад скинуто: група 1 — 08:00, група 2 — 08:30.'
    emit()
  }
  reset()

  function sourceLessons(groupId: string, sourceDate: string): ScheduleCopyLesson[] {
    const value = group(groupId)
    const day = weekday(sourceDate)
    if (day > 5) throw new Error('TIMETABLE_COPY_INVALID')
    const subjects = [
      ['Економічна теорія', 'Вища математика', 'Ділова українська'],
      ['Менеджмент', 'Статистика', 'Іноземна мова'],
      ['Мікроекономіка', 'Облік', 'Інформатика'],
      ['Макроекономіка', 'Фінанси', 'Правознавство'],
      ['Маркетинг', 'Аналітика даних', 'Соціологія'],
    ][day - 1]
    return [['14:30', '15:50'], ['16:10', '17:30'], ['17:40', '19:00']].map(([starts_at, ends_at], index) => ({
      id: `local-${groupId}-${day}-${index}`, group_id: groupId, weekday: day,
      starts_at: `${starts_at}:00`, ends_at: `${ends_at}:00`, subject: subjects[index] + (index === 0 && value.sourceRevision > 1 ? ' · оновлено' : ''),
      teacher_name: 'Викладач прикладу', lesson_type: index === 1 ? 'seminar' : 'lecture',
      lesson_number: index + 6, location: `${210 + index}`, online_url: null,
      valid_from: '2026-09-01', valid_until: '2027-01-31', created_by: 'local-preview-only', week_pattern: 'every',
    }))
  }

  function project(plan: Plan) {
    const days = plan.pairs.map(pair => {
      if (weekday(pair.target_date) < 6 || pair.target_date === pair.source_date) throw new Error('TIMETABLE_COPY_INVALID')
      const source = sourceLessons(plan.groupId, pair.source_date)
      const supplied = plan.mappings[pair.target_date] || []
      const keys = new Set(source.map(row => intervalKey(row.starts_at, row.ends_at)))
      const seenSources = new Set<string>(); const seenNumbers = new Set<number>()
      for (const row of supplied) {
        const key = intervalKey(row.source_starts_at, row.source_ends_at)
        if (!keys.has(key) || seenSources.has(key) || !Number.isInteger(row.target_lesson_number) || row.target_lesson_number < 1 || row.target_lesson_number > 5 || seenNumbers.has(row.target_lesson_number)
          || Boolean(row.target_starts_at) !== Boolean(row.target_ends_at)) throw new Error('TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID')
        seenSources.add(key); seenNumbers.add(row.target_lesson_number)
      }
      const assignments: ScheduleCopySlotAssignment[] = plan.mode === 'original' ? [] : source.map((row, index) => {
        const override = supplied.find(item => intervalKey(item.source_starts_at, item.source_ends_at) === intervalKey(row.starts_at, row.ends_at))
        const targetNumber = override?.target_lesson_number || index + 1
        const fallback = override?.target_starts_at && override?.target_ends_at ? { starts_at: override.target_starts_at, ends_at: override.target_ends_at } : firstShiftSlotTime(plan.options.firstShiftStart, targetNumber)
        return { source_starts_at: `${time(row.starts_at)}:00`, source_ends_at: `${time(row.ends_at)}:00`, target_lesson_number: targetNumber,
          target_starts_at: `${time(override?.target_starts_at || fallback.starts_at)}:00`, target_ends_at: `${time(override?.target_ends_at || fallback.ends_at)}:00` }
      })
      if (assignments.some(row => time(row.target_starts_at!) >= time(row.target_ends_at!))
        || new Set(assignments.map(row => row.target_lesson_number)).size !== assignments.length) throw new Error('TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID')
      const ordered = [...assignments].sort((left, right) => left.target_starts_at!.localeCompare(right.target_starts_at!))
      if (ordered.some((row, index) => index > 0 && row.target_starts_at! < ordered[index - 1].target_ends_at!)) throw new Error('TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID')
      const lessons = source.map((row, index): ScheduleCopyLesson => plan.mode === 'original' ? { ...row, weekday: weekday(pair.target_date), valid_from: pair.target_date, valid_until: pair.target_date } : {
        ...row, weekday: weekday(pair.target_date), valid_from: pair.target_date, valid_until: pair.target_date,
        source_starts_at: row.starts_at, source_ends_at: row.ends_at, source_lesson_number: row.lesson_number ?? null,
        starts_at: assignments[index].target_starts_at!, ends_at: assignments[index].target_ends_at!, lesson_number: assignments[index].target_lesson_number,
      })
      for (const lesson of lessons) for (const existing of records.filter(row => row.groupId === plan.groupId && row.targetDate === pair.target_date)) {
        if (lesson.starts_at < existing.endsAt && existing.startsAt < lesson.ends_at
          && !(existing.sourceId === lesson.id && existing.startsAt === lesson.starts_at && existing.endsAt === lesson.ends_at)) throw new Error('TIMETABLE_COPY_CONFLICT')
      }
      const skipped = lessons.filter(lesson => records.some(row => row.groupId === plan.groupId && row.targetDate === pair.target_date && row.sourceId === lesson.id && row.startsAt === lesson.starts_at && row.endsAt === lesson.ends_at)).length
      return { ...pair, copied: lessons.length - skipped, skipped, lessons, slot_assignments: assignments, empty: lessons.length === 0 }
    })
    return { days, copied: days.reduce((total, day) => total + day.copied, 0), skipped: days.reduce((total, day) => total + day.skipped, 0) }
  }

  async function execute(plan: Plan, preview: boolean, signature: string | null) {
    await pause()
    const current = group(plan.groupId)
    if (!preview && changeNext) { changeNext = false; current.sourceRevision += 1; lastAction = 'Джерело змінилося: потрібні новий перегляд і повторне підтвердження.'; emit() }
    if (!preview && failNext) { failNext = false; lastAction = 'Імітація помилки: розклад і збережений початок не змінено.'; emit(); throw new Error('TIMETABLE_COPY_CONFLICT') }
    const result = project(plan)
    const configuration = JSON.stringify([plan.groupId, plan.pairs, plan.mode, plan.mappings, plan.options])
    const signatureAtRevision = (revision: number) => JSON.stringify(['local-preview', configuration, current.sourceRevision, plan.mode === 'first_shift' ? revision : null])
    const receipt = receipts.get(plan.groupId)
    const exactLatestRetry = !preview && plan.mode === 'first_shift' && plan.options.rememberFirstShiftStart
      && receipt?.signature === signature && receipt.configuration === configuration && receipt.sourceRevision === current.sourceRevision
      && receipt.firstShiftStart === plan.options.firstShiftStart && current.first_shift_start === receipt.firstShiftStart
      && current.revision === receipt.revision && receipt.previousRevision + 1 === current.revision
      && signature === signatureAtRevision(receipt.previousRevision)
    const sourceSignature = signatureAtRevision(exactLatestRetry ? receipt.previousRevision : current.revision)
    if (!preview && signature !== sourceSignature) throw new Error('TIMETABLE_COPY_SOURCE_CHANGED')
    if (!preview) {
      if (plan.options.rememberFirstShiftStart && (plan.mode !== 'first_shift' || plan.pairs.some(pair => weekday(pair.target_date) !== 6))) throw new Error('TIMETABLE_COPY_SETTINGS_INVALID')
      for (const day of result.days) for (const lesson of day.lessons) {
        if (!records.some(row => row.groupId === plan.groupId && row.targetDate === day.target_date && row.sourceId === lesson.id && row.startsAt === lesson.starts_at && row.endsAt === lesson.ends_at)) records.push({ groupId: plan.groupId, sourceDate: day.source_date, targetDate: day.target_date, sourceId: lesson.id, subject: lesson.subject, startsAt: lesson.starts_at, endsAt: lesson.ends_at })
      }
      if (plan.options.rememberFirstShiftStart && (current.revision === 0 || current.first_shift_start !== plan.options.firstShiftStart)) {
        const previousRevision = current.revision
        current.first_shift_start = plan.options.firstShiftStart; current.revision += 1
        receipts.set(plan.groupId, { signature: sourceSignature, configuration, sourceRevision: current.sourceRevision, previousRevision, revision: current.revision, firstShiftStart: current.first_shift_start })
      }
      successfulCopies += 1
      lastAction = `Скопійовано лише в прикладі: ${result.copied} пар на ${result.days.length} дат.${plan.options.rememberFirstShiftStart ? ` Для цієї групи запам’ятовано ${current.first_shift_start}.` : ' Збережений початок не змінено.'}`
      emit()
    }
    return { ...result, source_signature: sourceSignature, first_shift_start: plan.options.firstShiftStart, settings_revision: current.revision,
      days: result.days.map(day => ({ ...day, lessons: preview ? day.lessons : [] })) }
  }

  const defaults = (options?: ScheduleCopyTimeOptions): ScheduleCopyTimeOptions => options || { firstShiftStart: '08:00', rememberFirstShiftStart: false }
  const services: GroupScheduleCopyServices = {
    async loadSettings(groupId) { await pause(); const value = group(groupId); return { first_shift_start: value.first_shift_start, revision: value.revision } },
    async copyDay(groupId, sourceDate, targetDate, preview, signature = null, mode = 'original', assignments = [], options) {
      const result = await execute({ groupId, pairs: [{ source_date: sourceDate, target_date: targetDate }], mode, mappings: { [targetDate]: assignments }, options: defaults(options) }, preview, signature)
      return { ...result.days[0], source_signature: result.source_signature, first_shift_start: result.first_shift_start, settings_revision: result.settings_revision } as ScheduleCopyPreview
    },
    async copySequence(groupId, pairs, preview, signature = null, mode = 'original', mappings = {}, options) {
      return await execute({ groupId, pairs, mode, mappings, options: defaults(options) }, preview, signature) as ScheduleCopySequencePreview
    },
  }
  return {
    services,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot() { return clone({ groups: LOCAL_COPY_GROUPS.map(row => ({ ...row, ...group(row.id) })), records, successfulCopies, lastAction, changeNext, failNext }) },
    armSourceChange() { changeNext = true; lastAction = 'Після перегляду, перед наступним копіюванням, джерело зміниться.'; emit() },
    armFailure() { failNext = true; lastAction = 'Наступне копіювання завершиться помилкою. Час групи не має зберегтися.'; emit() },
    reset,
  }
}
