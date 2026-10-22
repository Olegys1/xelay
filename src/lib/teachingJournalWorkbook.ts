import type { TeachingSnapshot } from './teaching'
import { calculateTeachingBreakdown, teachingCoefficient, teachingRounding, TEACHING_ROUNDING_OPTIONS } from './teachingGrading'

// XLSX cells are explicitly strings, never formulas supplied by a user. Prefix
// spreadsheet formula markers as an extra safeguard for later copy/CSV export.
export function safeTeachingWorkbookText(value: unknown): string {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  return /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text
}

export async function exportTeachingJournalWorkbook(snapshot: TeachingSnapshot, groupId: string, isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) return
  if (!snapshot.course.permissions.includes('grades')) throw new Error('Для експорту потрібен доступ до журналу.')
  const group = snapshot.groups.find(group => group.group_id === groupId)
  if (!group) throw new Error('Оберіть групу для експорту.')
  const XLSX = await import('xlsx')
  if (!isCurrent()) return
  const activities = snapshot.activities.filter(activity => activity.group_id === groupId && activity.course_id === snapshot.course.id)
    .sort((a, b) => a.activity_date.localeCompare(b.activity_date) || a.title.localeCompare(b.title, 'uk'))
  const entries = snapshot.entries.filter(entry => entry.active && entry.group_id === groupId && entry.course_id === snapshot.course.id)
    .sort((a, b) => a.full_name.localeCompare(b.full_name, 'uk'))
  const grades = snapshot.grades.filter(grade => Boolean(grade.published_at) && entries.some(entry => entry.id === grade.entry_id)
    && activities.some(activity => activity.id === grade.activity_id))
  const rules = snapshot.course.grading_rules
  const totals = entries.map(entry => {
    const values = activities.map(activity => ({ category: activity.category, score: grades.find(grade => grade.entry_id === entry.id && grade.activity_id === activity.id)?.published_score }))
    return { entry, calculation: calculateTeachingBreakdown(rules, values) }
  })
  type Cell = string | number | null
  const journal: Cell[][] = [['Студент', ...activities.map(activity => `${activity.title} · ${activity.activity_date} · до ${activity.max_points}`), 'Підсумок за правилами']]
  for (const { entry, calculation } of totals) journal.push([entry.full_name, ...activities.map(activity => grades.find(grade => grade.entry_id === entry.id && grade.activity_id === activity.id)?.published_score ?? null), calculation.numericCount ? calculation.total : null])
  const ruleRows: Cell[][] = [
    ['Категорія', 'Коефіцієнт', 'Максимум після множення'],
    ...rules.categories.map(category => [category.name, teachingCoefficient(category.coefficient), category.max_points] as Cell[]),
    ['Без категорії', 1, 'Без окремого максимуму'],
    [], ['Загальний максимум', rules.total_max ?? 'Не задано'],
    ['Округлення підсумку', TEACHING_ROUNDING_OPTIONS.find(option => option.id === teachingRounding(rules.rounding))?.label || 'Без округлення'],
    ['Розрахунок', 'Кожна категорія: сума сирих балів × коефіцієнт, не більше максимуму категорії. Потім додаються роботи без категорії, округлюється підсумок і застосовується загальний максимум.'],
    ['Початкові оцінки', 'Збережені бали за роботи не змінюються. Коефіцієнти застосовані тільки до підсумку.'],
  ]
  const gradedTotals = totals.filter(total => total.calculation.numericCount > 0)
  const summary: Cell[][] = [
    ['Показник', 'Значення'], ['Предмет', snapshot.course.title], ['Група', group.group_name],
    ['Семестр', snapshot.course.semester], ['Дані', 'Тільки опубліковані бали. Порожня клітинка означає відсутність числової оцінки.'],
    ['Призначення', 'Робочий експорт журналу Xelay'], ['Активних студентів', entries.length],
    ['Студентів з числовими оцінками', gradedTotals.length], ['Студентів без числових оцінок', entries.length - gradedTotals.length],
    ['Робіт у журналі', activities.length], ['Опублікованих числових результатів', grades.filter(grade => grade.published_score !== null).length],
    ['Середній підсумок серед студентів з балами', gradedTotals.length ? gradedTotals.reduce((sum, total) => sum + total.calculation.total, 0) / gradedTotals.length : null],
  ]
  const workbook = XLSX.utils.book_new()
  for (const [name, rows, widths] of [
    ['Журнал', journal, [32, ...activities.map(() => 24), 25]],
    ['Правила', ruleRows, [36, 70, 28]],
    ['Підсумки', summary, [49, 76]],
  ] as const) {
    const sheet = XLSX.utils.aoa_to_sheet(rows.map(row => row.map(cell => typeof cell === 'string' ? safeTeachingWorkbookText(cell) : cell)))
    sheet['!cols'] = widths.map(width => ({ wch: width }))
    if (name === 'Журнал' && rows.length > 1) sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 }, { r: rows.length - 1, c: rows[0].length - 1 }) }
    XLSX.utils.book_append_sheet(workbook, sheet, name)
  }
  const safeName = `${snapshot.course.title}-${group.group_name}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100)
  if (isCurrent()) XLSX.writeFileXLSX(workbook, `Xelay-журнал-${safeName}.xlsx`, { compression: true })
}
