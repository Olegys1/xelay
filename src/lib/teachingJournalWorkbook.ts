import type { TeachingSnapshot } from './teaching'
import { calculateTeachingBreakdown, teachingRulesForGroup, teachingCoefficient, teachingRounding, TEACHING_ROUNDING_OPTIONS } from './teachingGrading'
import { teachingStatementRows, TEACHING_JOURNAL_SORTS, type TeachingJournalSort } from './teachingSemesterJournal'

// XLSX cells are explicitly strings, never formulas supplied by a user. Prefix
// spreadsheet formula markers as an extra safeguard for later copy/CSV export.
export function safeTeachingWorkbookText(value: unknown): string {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  return /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text
}

export async function exportTeachingJournalWorkbook(snapshot: TeachingSnapshot, groupId: string, isCurrent: () => boolean = () => true, options: { sort?: TeachingJournalSort; statement?: boolean } = {}): Promise<void> {
  if (!isCurrent()) return
  if (!snapshot.course.permissions.includes('grades')) throw new Error('Для експорту потрібен доступ до журналу.')
  const group = snapshot.groups.find(group => group.group_id === groupId)
  if (!group) throw new Error('Оберіть групу для експорту.')
  const XLSX = await import('xlsx')
  if (!isCurrent()) return
  const activities = snapshot.activities.filter(activity => activity.group_id === groupId && activity.course_id === snapshot.course.id)
    .sort((a, b) => a.activity_date.localeCompare(b.activity_date) || a.title.localeCompare(b.title, 'uk'))
  const statement = teachingStatementRows(snapshot, groupId, options.sort)
  const entries = statement.map(row => row.entry)
  const grades = snapshot.grades.filter(grade => Boolean(grade.published_at) && entries.some(entry => entry.id === grade.entry_id)
    && activities.some(activity => activity.id === grade.activity_id))
  const rules = teachingRulesForGroup(snapshot, groupId)
  const totals = entries.map(entry => {
    const values = activities.map(activity => ({ category: activity.category, score: grades.find(grade => grade.entry_id === entry.id && grade.activity_id === activity.id)?.published_score }))
    return { entry, calculation: calculateTeachingBreakdown(rules, values) }
  })
  type Cell = string | number | null
  const journal: Cell[][] = [['Студент', ...activities.map(activity => `${activity.title} · ${activity.activity_date} · до ${activity.max_points}`), 'Підсумок за правилами']]
  for (const { entry, calculation } of totals) journal.push([entry.full_name, ...activities.map(activity => grades.find(grade => grade.entry_id === entry.id && grade.activity_id === activity.id)?.published_score ?? null), calculation.numericCount ? calculation.total : null])
  const statementRows: Cell[][] = [
    ['№', 'ПІБ студента', 'Підсумкові опубліковані бали', 'Оцінених робіт'],
    ...statement.map((row, index) => [index + 1, row.entry.full_name, row.total, row.assessed] as Cell[]),
  ]
  const ruleRows: Cell[][] = [
    ['Категорія', 'Коефіцієнт', 'Максимум після множення'],
    ...rules.categories.map(category => [category.name, teachingCoefficient(category.coefficient), category.max_points] as Cell[]),
    ['Без категорії', 1, 'Без окремого максимуму'],
    [], ['Загальний максимум', rules.total_max ?? 'Не задано'],
    ['Округлення підсумку', TEACHING_ROUNDING_OPTIONS.find(option => option.id === teachingRounding(rules.rounding))?.label || 'Без округлення'],
    ['Розрахунок', 'Кожна категорія: сума сирих балів × коефіцієнт, не більше максимуму категорії. Потім додаються роботи без категорії, округлюється підсумок і застосовується загальний максимум.'],
    ['Правила групи', group.grading_rules_override ? 'Окремі правила цієї групи' : 'Загальні правила предмета'],
    ...((rules.presets || []).map(preset => ['Шаблон: ' + preset.name, preset.work_type, preset.max_points] as Cell[])),
    ['Початкові оцінки', 'Збережені бали за роботи не змінюються. Коефіцієнти застосовані тільки до підсумку.'],
  ]
  const gradedTotals = totals.filter(total => total.calculation.numericCount > 0)
  const summary: Cell[][] = [
    ['Показник', 'Значення'], ['Предмет', snapshot.course.title], ['Група', group.group_name],
    ['Семестр', snapshot.course.semester], ['Дані', 'Тільки опубліковані бали. Порожня клітинка означає відсутність числової оцінки.'],
    ['Призначення', 'Робочий експорт журналу Xelay'], ['Активних студентів', entries.length],
    ['Порядок студентів', TEACHING_JOURNAL_SORTS.find(item => item.id === (options.sort || 'name'))?.label || 'За прізвищем'],
    ['Відомість', 'Робочий список Xelay. Офіційний шаблон кафедри можна підключити окремо. Чернетки не входять до підсумку.'],
    ['Студентів з числовими оцінками', gradedTotals.length], ['Студентів без числових оцінок', entries.length - gradedTotals.length],
    ['Робіт у журналі', activities.length], ['Опублікованих числових результатів', grades.filter(grade => grade.published_score !== null).length],
    ['Середній підсумок серед студентів з балами', gradedTotals.length ? gradedTotals.reduce((sum, total) => sum + total.calculation.total, 0) / gradedTotals.length : null],
  ]
  const workbook = XLSX.utils.book_new()
  const journalSheet = { name: 'Журнал', rows: journal, widths: [32, ...activities.map(() => 24), 25] }
  const statementSheet = { name: 'Для відомості', rows: statementRows, widths: [7, 36, 31, 20] }
  const sheets = [...(options.statement ? [statementSheet, journalSheet] : [journalSheet, statementSheet]),
    { name: 'Правила', rows: ruleRows, widths: [36, 70, 28] }, { name: 'Підсумки', rows: summary, widths: [49, 76] }]
  for (const { name, rows, widths } of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet(rows.map(row => row.map(cell => typeof cell === 'string' ? safeTeachingWorkbookText(cell) : cell)))
    sheet['!cols'] = widths.map(width => ({ wch: width }))
    if ((name === 'Журнал' || name === 'Для відомості') && rows.length > 1) sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 }, { r: rows.length - 1, c: rows[0].length - 1 }) }
    XLSX.utils.book_append_sheet(workbook, sheet, name)
  }
  const safeName = `${snapshot.course.title}-${group.group_name}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100)
  if (isCurrent()) XLSX.writeFileXLSX(workbook, `Xelay-${options.statement ? 'відомість' : 'журнал'}-${safeName}.xlsx`, { compression: true })
}
