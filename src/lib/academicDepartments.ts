export type AcademicDepartment = { slug: string; name: string; source_url: string }

// Verified 2026-10-27 against the faculty's current departments page.
export const KNU_ECONOMICS_DEPARTMENTS_SOURCE = 'https://econom.knu.ua/departments/'
export const KNU_ECONOMICS_DEPARTMENTS: AcademicDepartment[] = [
  ['ecological-management', 'Кафедра екологічного менеджменту та підприємництва'],
  ['enterprise-economics', 'Кафедра економіки підприємства'],
  ['economic-cybernetics', 'Кафедра економічної кібернетики'],
  ['economic-theory', 'Кафедра економічної теорії, макро- і мікроекономіки'],
  ['marketing-business-administration', 'Кафедра маркетингу і бізнес-адміністрування'],
  ['innovation-investment-management', 'Кафедра менеджменту інноваційної та інвестиційної діяльності'],
  ['international-economics', 'Кафедра міжнародної економіки'],
  ['accounting-audit', 'Кафедра обліку та аудиту'],
  ['statistics-information-demography', 'Кафедра статистики, інформаційно-аналітичних систем і демографії'],
  ['insurance-banking-risk-management', 'Кафедра страхування, банківської справи та ризик-менеджменту'],
  ['finance', 'Кафедра фінансів'],
  ['foreign-languages', 'Кафедра іноземних мов'],
].map(([slug, name]) => ({ slug, name, source_url: KNU_ECONOMICS_DEPARTMENTS_SOURCE }))

export function academicDepartmentsForScope(universitySlug: string, unitSlugOrName: string): AcademicDepartment[] {
  const unit = unitSlugOrName.trim().toLocaleLowerCase('uk-UA')
  return universitySlug === 'knu' && ['economics', 'економічний факультет'].includes(unit)
    ? KNU_ECONOMICS_DEPARTMENTS : []
}

export function academicDepartmentMatches(value: string, options: AcademicDepartment[]): boolean {
  return value.trim().length >= 2 && value.trim().length <= 180
    && (!options.length || options.some(option => option.name === value.trim()))
}
