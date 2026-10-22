export type TeachingRounding = 'none' | 'integer' | 'hundredth'
export type TeachingGradingRules = { categories: { id: string; name: string; max_points: number; coefficient?: number }[]; total_max?: number; rounding?: TeachingRounding }
export type TeachingGradingValue = { category: string; score: number | null | undefined }
export type TeachingCategoryCalculation = { id: string; name: string; raw: number; count: number; coefficient: number; weighted: number; capped: number; maximum: number }

export function teachingCoefficient(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : 1
}
export function teachingRounding(value: unknown): TeachingRounding {
  return value === 'integer' || value === 'hundredth' ? value : 'none'
}
export function roundTeachingTotal(value: number, rounding: TeachingRounding): number {
  if (rounding === 'integer') return Math.round(value + Number.EPSILON)
  if (rounding === 'hundredth') return Math.round((value + Number.EPSILON) * 100) / 100
  return value
}

/** The same calculation feeds the journal, own grades and workbook export.
 * Raw published/draft scores remain unchanged. Coefficients apply to category
 * sums before category caps; unclassified works have coefficient one. Only the
 * final sum is rounded, then the overall maximum is enforced.
 */
export function calculateTeachingBreakdown(rules: TeachingGradingRules, values: TeachingGradingValue[]) {
  const sums = new Map<string, { raw: number; count: number }>()
  let rawTotal = 0
  let numericCount = 0
  for (const value of values) {
    if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0) continue
    const current = sums.get(value.category) || { raw: 0, count: 0 }
    sums.set(value.category, { raw: current.raw + value.score, count: current.count + 1 })
    rawTotal += value.score
    numericCount++
  }
  const categories: TeachingCategoryCalculation[] = []
  const seen = new Set<string>()
  for (const rule of rules?.categories || []) {
    if (!rule.id || seen.has(rule.id)) continue
    seen.add(rule.id)
    const current = sums.get(rule.id) || { raw: 0, count: 0 }
    const coefficient = teachingCoefficient(rule.coefficient)
    const maximum = typeof rule.max_points === 'number' && Number.isFinite(rule.max_points) && rule.max_points > 0 ? rule.max_points : Infinity
    const weighted = current.raw * coefficient
    categories.push({ id: rule.id, name: rule.name, raw: current.raw, count: current.count, coefficient, weighted, capped: Math.min(weighted, maximum), maximum })
  }
  const uncategorized = [...sums.entries()].filter(([id]) => !seen.has(id)).reduce((sum, [, value]) => sum + value.raw, 0)
  const beforeRounding = categories.reduce((sum, category) => sum + category.capped, 0) + uncategorized
  const rounding = teachingRounding(rules?.rounding)
  const maximum = typeof rules?.total_max === 'number' && Number.isFinite(rules.total_max) && rules.total_max > 0 ? rules.total_max : Infinity
  const total = Math.min(roundTeachingTotal(beforeRounding, rounding), maximum)
  return { total, rawTotal, numericCount, categories, uncategorized, beforeRounding, rounding, maximum }
}

export function calculateTeachingTotal(rules: TeachingGradingRules, values: TeachingGradingValue[]): number {
  return calculateTeachingBreakdown(rules, values).total
}

export const TEACHING_ROUNDING_OPTIONS = [
  { id: 'none', label: 'Без округлення' },
  { id: 'integer', label: 'До цілого бала' },
  { id: 'hundredth', label: 'До сотих (0,01)' },
] as const

export function teachingGradingExample(coefficient: number, maximum: number, rounding: TeachingRounding): string {
  const number = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 6 })
  const weighted = 7.5 * coefficient
  const capped = Math.min(weighted, maximum)
  return `Наприклад: 7,5 сирих балів × ${number.format(coefficient)} = ${number.format(weighted)}; максимум категорії ${number.format(maximum)} → ${number.format(capped)}. Округлення підсумку: ${TEACHING_ROUNDING_OPTIONS.find(option => option.id === rounding)?.label.toLowerCase()}.`
}
