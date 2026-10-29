import catalogue from '../data/knuAcademicDepartments.json'

export type AcademicDepartment = { slug: string; name: string; source_url: string; source_verified_on?: string }

// Names and scope are taken only from the official source recorded per unit.
export const KNU_DEPARTMENTS_VERIFIED_ON = catalogue.verified_on
export const KNU_ECONOMICS_DEPARTMENTS_SOURCE = 'https://econom.knu.ua/departments/'
const normalizedScope = (value: string) => value.trim().toLocaleLowerCase('uk-UA').replace(/['’ʼ]/g, '’').replace(/\s+/g, ' ')
const optionsForUnit = (unit: typeof catalogue.units[number]): AcademicDepartment[] => unit.departments.map(department => ({
  ...department, source_url: unit.source_url, source_verified_on: catalogue.verified_on,
}))
export const KNU_ECONOMICS_DEPARTMENTS = optionsForUnit(catalogue.units.find(unit => unit.unit_slug === 'economics')!)

export function academicDepartmentsForScope(universitySlug: string, unitSlugOrName: string): AcademicDepartment[] {
  if (universitySlug !== 'knu') return []
  const key = normalizedScope(unitSlugOrName)
  const unit = catalogue.units.find(unit => normalizedScope(unit.unit_slug) === key || normalizedScope(unit.unit_name) === key)
  return unit ? optionsForUnit(unit) : []
}

export function academicDepartmentMatches(value: string, options: AcademicDepartment[]): boolean {
  return value.trim().length >= 2 && value.trim().length <= 180
    && (!options.length || options.some(option => option.name === value.trim()))
}
