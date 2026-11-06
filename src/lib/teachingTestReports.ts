import type { TeachingTestAttempt, TeachingTestQuestion } from './teachingTests'
import { plainTeachingTestContent } from './teachingTestContent'
import { safeTeachingWorkbookText } from './teachingJournalWorkbook'

export const TEACHING_TEST_REPORTS = [
  { id: 'summary-pdf', label: 'Зведення результатів (.pdf)', scope: 'filtered' },
  { id: 'summary-xlsx', label: 'Зведення результатів (.xlsx)', scope: 'filtered' },
  { id: 'summary-csv', label: 'Зведення результатів (.csv)', scope: 'filtered' },
  { id: 'answers-matrix', label: 'Матриця відповідей (.xlsx)', scope: 'filtered' },
  { id: 'selected-answers', label: 'Відповіді вибраних студентів (.pdf)', scope: 'selected' },
  { id: 'selected-details', label: 'Деталі вибраних студентів (.pdf)', scope: 'selected' },
  { id: 'selected-workbook', label: 'Докладний звіт для вибраних (.xlsx)', scope: 'selected' },
] as const

export type TeachingTestReportId = typeof TEACHING_TEST_REPORTS[number]['id']
export type TeachingTestReportCell = string | number | null
export type TeachingTestReportSheet = { name: string; rows: TeachingTestReportCell[][]; widths: number[] }
export type TeachingTestReportData = {
  title: string
  courseTitle: string
  maxPoints: number
  finalized: boolean
  attempts: TeachingTestAttempt[]
  groupNames: ReadonlyMap<string, string>
}

const noAnswer = 'Без відповіді'
const notIssued = 'Не було у варіанті'
const noSnapshot = 'Немає збереженого варіанта'
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const dateFormat = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short' })

export function teachingTestReportDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : '—'
}

export function teachingTestOptionLabel(question: TeachingTestQuestion, optionId: string) {
  const index = question.options.findIndex(option => option.id === optionId)
  if (index < 0) return optionId === 'true' ? 'Так' : optionId === 'false' ? 'Ні' : 'Варіант недоступний'
  const option = question.options[index]
  const label = `Варіант ${alphabet[index] || index + 1}`
  const text = plainTeachingTestContent(option.text).trim()
  const photos = (option.images || []).map(image => image.alt.trim() || 'Фото').join(', ')
  return [label, text, photos].filter(Boolean).join(' · ')
}

export function formatTeachingTestAnswer(question: TeachingTestQuestion, answer: TeachingTestAttempt['answers'][string] | undefined) {
  if (answer == null || answer === '' || typeof answer === 'object' && !Object.values(answer).some(value => value !== '')) return noAnswer
  if (question.kind === 'cloze' && typeof answer === 'object' && !Array.isArray(answer)) {
    return (question.gaps || []).map(gap => `${gap.id}: ${answer[gap.id] || noAnswer}`).join('\n') || noAnswer
  }
  if (question.kind === 'sorting' && typeof answer === 'object' && !Array.isArray(answer)) {
    return question.options.map(option => {
      const bucket = question.buckets.find(bucket => bucket.id === answer[option.id])
      return `${teachingTestOptionLabel(question, option.id)} → ${bucket ? plainTeachingTestContent(bucket.text) : 'Не розміщено'}`
    }).join('\n') || noAnswer
  }
  if (Array.isArray(answer)) {
    if (question.kind === 'short_text') return answer.join(' / ')
    return answer.map((id, index) => `${question.kind === 'sequence' ? `${index + 1}. ` : ''}${teachingTestOptionLabel(question, id)}`).join('\n')
  }
  if (typeof answer === 'string') return ['choice', 'multiple', 'boolean'].includes(question.kind) ? teachingTestOptionLabel(question, answer) : answer
  return noAnswer
}

export function teachingTestCorrectAnswer(question: TeachingTestQuestion) {
  if (question.kind === 'essay') return question.rubric ? 'Перевірка за критеріями' : 'Ручна перевірка'
  const answer = question.kind === 'cloze' ? Object.fromEntries((question.gaps || []).map(gap => [gap.id, gap.answers.join(' / ')])) : question.answer
  return answer == null ? 'Ключ не збережено' : formatTeachingTestAnswer(question, answer)
}

export function teachingTestReportResultStatus(attempt: TeachingTestAttempt, finalized: boolean) {
  if (attempt.status !== 'submitted') return 'Виконує'
  if (attempt.review_note) return 'Потрібна перевірка складу групи'
  if (attempt.grade_published_at) return 'Бал опубліковано в журналі'
  if (finalized && attempt.reviewed_at) return 'Передано в журнал'
  if (finalized) return 'Затверджено'
  if (attempt.questions?.some(question => question.kind === 'essay' && !attempt.question_results?.some(result => result.question_id === question.id && result.manual))) return 'Очікує ручної перевірки'
  return 'Попередній результат'
}

function resultRows(data: TeachingTestReportData): TeachingTestReportCell[][] {
  const header = ['Студент', 'Група', 'Спроба №', 'Код спроби', 'Початок (Київ)', 'Здавання (Київ)', 'Тривалість, с', 'Автоматично', 'За перевіркою', 'Бонус', 'Затверджено, разом', 'Максимум', 'Стан']
  return [header, ...data.attempts.map(attempt => [
    attempt.student_name || 'Учасник групи', data.groupNames.get(attempt.group_id) || 'Група', attempt.attempt_number || 1,
    attempt.id.slice(-8).toUpperCase(), teachingTestReportDate(attempt.started_at), teachingTestReportDate(attempt.submitted_at),
    attempt.elapsed_seconds ?? null, attempt.auto_score ?? null, attempt.score ?? null,
    data.finalized ? attempt.bonus_score ?? null : null, data.finalized ? attempt.final_score ?? null : null, data.maxPoints,
    teachingTestReportResultStatus(attempt, data.finalized),
  ])]
}

function matrixSheets(data: TeachingTestReportData): TeachingTestReportSheet[] {
  const questions = new Map<string, TeachingTestQuestion>()
  for (const attempt of data.attempts) {
    for (const question of attempt.questions || []) if (!questions.has(question.id)) questions.set(question.id, question)
  }
  const allQuestions = Array.from(questions.values())
  const labels = allQuestions.map((_, index) => `Запитання ${index + 1}`)
  const matrix: TeachingTestReportCell[][] = [['Студент', 'Група', 'Код спроби', ...labels]]
  for (const attempt of data.attempts) {
    const issued = new Map(attempt.questions?.map(question => [question.id, question]))
    const answers = allQuestions.map(question => {
      const snapshot = issued.get(question.id)
      if (!attempt.questions) return noSnapshot
      return snapshot ? formatTeachingTestAnswer(snapshot, attempt.answers[question.id]) : notIssued
    })
    matrix.push([attempt.student_name || 'Учасник групи', data.groupNames.get(attempt.group_id) || 'Група', attempt.id.slice(-8).toUpperCase(), ...answers])
  }
  return [
    { name: 'Матриця відповідей', rows: matrix, widths: [28, 20, 14, ...labels.map(() => 34)] },
    { name: 'Запитання', rows: [['Колонка', 'Умова'], ...allQuestions.map((question, index) => [labels[index], plainTeachingTestContent(question.text)])], widths: [17, 82] },
  ]
}

function detailSheet(data: TeachingTestReportData): TeachingTestReportSheet {
  const rows: TeachingTestReportCell[][] = [['Студент', 'Група', 'Код спроби', 'Порядок у варіанті', 'Запитання', 'Видані варіанти', 'Відповідь студента', 'Ключ або спосіб оцінювання', 'Автоматично', 'За перевіркою', 'Максимум', 'Відкрито (Київ)', 'Причина зміни балів']]
  for (const attempt of data.attempts) {
    const student: TeachingTestReportCell[] = [attempt.student_name || 'Учасник групи', data.groupNames.get(attempt.group_id) || 'Група', attempt.id.slice(-8).toUpperCase()]
    if (!attempt.questions) rows.push([...student, null, noSnapshot])
    for (const [index, question] of (attempt.questions || []).entries()) {
      const result = attempt.question_results?.find(item => item.question_id === question.id)
      rows.push([...student, index + 1, plainTeachingTestContent(question.text), question.options.map(option => teachingTestOptionLabel(question, option.id)).join('\n'),
        formatTeachingTestAnswer(question, attempt.answers[question.id]), teachingTestCorrectAnswer(question), result?.automatic_points ?? null,
        question.kind === 'essay' && !result?.manual ? null : result?.points ?? null, question.points, teachingTestReportDate(attempt.opened_at?.[question.id]), result?.reason || null])
    }
  }
  return { name: 'Деталі відповідей', rows, widths: [27, 20, 14, 16, 55, 49, 46, 46, 15, 15, 13, 23, 40] }
}

export function buildTeachingTestReportSheets(format: TeachingTestReportId, data: TeachingTestReportData): TeachingTestReportSheet[] {
  if (format === 'answers-matrix') return matrixSheets(data)
  const summary = { name: 'Результати', rows: resultRows(data), widths: [27, 20, 11, 14, 22, 22, 16, 16, 16, 13, 20, 12, 27] }
  return format === 'selected-workbook' ? [summary, detailSheet(data)] : [summary]
}

export function teachingTestReportCsv(rows: TeachingTestReportCell[][]) {
  return '\uFEFF' + rows.map(row => row.map(value => `"${(typeof value === 'number' ? String(value) : safeTeachingWorkbookText(value)).replace(/"/g, '""')}"`).join(';')).join('\r\n')
}

export async function downloadTeachingTestReport(format: TeachingTestReportId, data: TeachingTestReportData, signal: AbortSignal) {
  signal.throwIfAborted()
  const attempts = data.attempts.filter(attempt => attempt.status === 'submitted')
  if (!attempts.length) throw new Error('Немає зданих робіт для експорту.')
  const report = { ...data, attempts }
  const basename = `Xelay-${data.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'тест'}-${format}`
  let file: Blob
  let extension: string
  if (format === 'summary-pdf' || format === 'selected-answers' || format === 'selected-details') {
    const { createTeachingTestReportPdf } = await import('./teachingTestReportPdf')
    file = await createTeachingTestReportPdf(format, report, signal)
    extension = 'pdf'
  } else {
    const sheets = buildTeachingTestReportSheets(format, report)
    if (format === 'summary-csv') {
      file = new Blob([teachingTestReportCsv(sheets[0].rows)], { type: 'text/csv;charset=utf-8' })
      extension = 'csv'
    } else {
      const XLSX = await import('xlsx')
      signal.throwIfAborted()
      const workbook = XLSX.utils.book_new()
      for (const sheet of sheets) {
        const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows.map(row => row.map(value => typeof value === 'string' ? safeTeachingWorkbookText(value).slice(0, 32767) : value)))
        worksheet['!cols'] = sheet.widths.map(wch => ({ wch }))
        if (worksheet['!ref']) worksheet['!autofilter'] = { ref: worksheet['!ref'] }
        XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name)
      }
      file = new Blob([XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      extension = 'xlsx'
    }
  }
  signal.throwIfAborted()
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = `${basename}.${extension}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
