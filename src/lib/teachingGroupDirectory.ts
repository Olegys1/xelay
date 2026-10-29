import type { TeachingDirectoryGroup } from './teaching'

export type TeachingGroupDirectoryFilters = { query: string; program: string; course: string; level: string }
export const emptyTeachingGroupFilters = (): TeachingGroupDirectoryFilters => ({ query: '', program: '', course: '', level: '' })
const levels: Record<string, string> = { bachelor: 'бак.', master: 'маг.', postgraduate: 'асп.' }
const levelSearch: Record<string, string> = {
  bachelor: 'бак бакалавр бакалаврат bachelor bak bac', master: 'маг магістр магістратура master mag', postgraduate: 'асп аспірант аспірантура postgraduate phd',
}
const normalized = (value = '') => value.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[’ʼ`']/g, '').replace(/[^\p{L}\p{N}@]+/gu, ' ').trim().replace(/\s+/g, ' ')
const truncate = (value: string, length: number) => Array.from(value).length > length ? Array.from(value).slice(0, length - 1).join('') + '…' : value
const currentCourse = (group: TeachingDirectoryGroup) => Number.isInteger(group.study_year) && Number(group.study_year) >= 1 && Number(group.study_year) <= 6 ? Number(group.study_year) : null
const businessPrograms = new Set(['економіка бізнесу', 'економіка та управління бізнесом', 'економіка бізнесу еб', 'економіка та управління бізнесом еуб', 'еб', 'еуб'])
// Fold homoglyphs only in these known OP abbreviations. Never transliterate
// personal names, another programme, a faculty or a group's stored identity.
const businessAlias = (value: string): string | null => {
  const alias = value.replace(/e/g, 'е').replace(/u/g, 'у').replace(/b/g, 'б')
  return alias === 'еб' || alias === 'еуб' ? alias : null
}
const businessSearch = (value: string): string => normalized(value).split(' ').map(word => businessAlias(word) || word).join(' ')

/** Related search names only. Never rename an OP, join cohorts or change a group.
 * Official KNU economics catalogue lists both titles:
 * https://econom.knu.ua/en/departments/enterprise_economics/educ_programs/
 * https://econom.knu.ua/educational-programs/undergraduate_courses/eb/
 */
function isKnuBusinessProgram(group: TeachingDirectoryGroup): boolean {
  return group.university_slug === 'knu' && (group.academic_unit_slug === 'economics' || normalized(group.academic_unit_name || '') === 'економічний факультет')
    && businessPrograms.has(businessSearch(group.specialty || ''))
}
export function teachingGroupProgramKey(group: TeachingDirectoryGroup): string {
  const scope = `${group.university_slug || ''}:${group.academic_unit_slug || normalized(group.academic_unit_name || '')}`
  return `${scope}:${isKnuBusinessProgram(group) ? 'knu-business-program-family' : normalized(group.specialty || '')}`
}
export function teachingGroupProgramOptions(groups: TeachingDirectoryGroup[]): { value: string; label: string }[] {
  const rows = new Map<string, string>()
  for (const group of groups) if (group.specialty?.trim()) rows.set(teachingGroupProgramKey(group), isKnuBusinessProgram(group)
    ? 'ЕБ / ЕУБ · пошук за обома назвами' : group.specialty.trim())
  return [...rows].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'uk-UA'))
}
function programShort(group: TeachingDirectoryGroup): string {
  const raw = group.specialty?.trim() || ''
  const match = raw.match(/\(([\p{L}\d-]{2,12})\)\s*$/u)
  if (match) return isKnuBusinessProgram(group) ? (businessAlias(normalized(match[1])) || match[1]).toLocaleUpperCase('uk-UA') : match[1]
  if (isKnuBusinessProgram(group)) return businessSearch(raw).includes('управління') || businessSearch(raw).includes('еуб') ? 'ЕУБ' : 'ЕБ'
  const words = raw.split(/\s+/).filter(word => !['і', 'й', 'та', 'з', 'у', 'в', 'для'].includes(word.toLocaleLowerCase('uk-UA')))
  return words.length > 1 ? words.slice(0, 7).map(word => Array.from(word)[0]).join('').toLocaleUpperCase('uk-UA') : truncate(raw, 18)
}
export function teachingGroupUnitShort(name = ''): string {
  if (normalized(name) === 'економічний факультет') return 'ЕФ'
  return truncate(name.replace(/Навчально-науковий інститут/gi, 'ННІ').replace(/Навчально-науковий центр/gi, 'ННЦ')
    .replace(/Факультет/gi, 'ф-т').replace(/інститут/gi, 'ін-т').replace(/імені\s+.+$/i, '').trim(), 34)
}
/** Full identity is available under the selector; options stay compact. */
export function teachingGroupDirectoryLabel(group: TeachingDirectoryGroup, includeName = true): string {
  const code = programShort(group), name = group.group_name.trim()
  const showCode = code && !normalized(name).startsWith(normalized(code))
  return [includeName ? name : null, showCode ? code : null, currentCourse(group) ? `${group.study_year} курс` : 'Курс ?',
    levels[group.study_level || ''] || 'Рівень ?', teachingGroupUnitShort(group.academic_unit_name || ''),
    group.representative_name ? `Ст.: ${truncate(group.representative_name.trim(), 38)}` : null].filter(Boolean).join(' · ')
}
export function teachingGroupDirectoryFullLabel(group: TeachingDirectoryGroup): string {
  const fullLevel: Record<string, string> = { bachelor: 'Бакалаврат', master: 'Магістратура', postgraduate: 'Аспірантура' }
  return [group.group_name, currentCourse(group) ? `${group.study_year} курс` : 'Курс не уточнено', fullLevel[group.study_level || ''] || 'Рівень не уточнено',
    group.academic_unit_name, group.specialty, group.representative_name ? `Староста: ${group.representative_name}` : null].filter(Boolean).join(' · ')
}
export function teachingGroupIdentityReady(group: TeachingDirectoryGroup): boolean {
  return currentCourse(group) !== null && Boolean(levels[group.study_level || '']) && group.identity_confirmed !== false && group.identity_ready !== false
}
export function teachingGroupDirectoryMatches(group: TeachingDirectoryGroup, query: string): boolean {
  const raw = query.normalize('NFKC').toLocaleLowerCase('uk-UA').trim()
  if (!raw) return true
  // A group number such as ЕУБ-4 is not a request for the fourth course.
  let codesMatch = true
  let remainder = raw.replace(/(^|[^\p{L}\p{N}])([\p{L}]{1,10})\s*\p{Pd}\s*(\d{1,3})(?=$|[^\p{L}\p{N}])/gu, (_, prefix: string, code: string, number: string) => {
    const desired = normalized(`${code}-${number}`), actual = normalized(group.group_name)
    const desiredParts = desired.split(' '), actualParts = actual.split(' ')
    const related = isKnuBusinessProgram(group) && actualParts.length === 2
      && businessAlias(desiredParts[0]) !== null && businessAlias(actualParts[0]) !== null
      && desiredParts.slice(-1)[0] === actualParts.slice(-1)[0]
    if (actual !== desired && !related) codesMatch = false
    return prefix + ' '
  })
  if (!codesMatch) return false
  remainder = remainder.replace(/\b(eub|eb)(\d)/g, '$1 $2').replace(/(еуб|еб)(\d)/g, '$1 $2')
  const courses: number[] = []
  remainder = remainder.replace(/(?:курс|course|рік)\s*(\d{1,2})|(\d{1,2})\s*(?:курс(?:у)?|к\.?|course|рік)(?=\s|$)/gu,
    (_, before: string, after: string) => { courses.push(Number(before || after)); return ' ' })
  const family = isKnuBusinessProgram(group)
  const tokens = (family ? businessSearch(remainder) : normalized(remainder)).split(' ').filter(Boolean).filter(token => {
    if (/^\d{1,2}$/.test(token)) { courses.push(Number(token)); return false }
    return !['оп', 'op'].includes(token)
  })
  if (courses.some(course => course !== currentCourse(group))) return false
  const businessAliases = family ? 'ЕБ ЕУБ EB EUB Економіка бізнесу Економіка та управління бізнесом' : ''
  const unitAliases = normalized(group.academic_unit_name || '') === 'економічний факультет' ? 'ЕФ EF econom economics економ фак' : ''
  const searchText = [teachingGroupDirectoryFullLabel(group), programShort(group), teachingGroupUnitShort(group.academic_unit_name || ''),
    levelSearch[group.study_level || ''], businessAliases, unitAliases].filter(Boolean).join(' ')
  const words = (family ? businessSearch(searchText) : normalized(searchText)).split(' ')
  return tokens.every(token => words.some(word => word === token || token.length >= 3 && word.startsWith(token)))
}
export function teachingGroupMatchesFilters(group: TeachingDirectoryGroup, filters: TeachingGroupDirectoryFilters): boolean {
  return (!filters.program || teachingGroupProgramKey(group) === filters.program)
    && (!filters.course || currentCourse(group) === Number(filters.course)) && (!filters.level || group.study_level === filters.level)
    && teachingGroupDirectoryMatches(group, filters.query)
}
