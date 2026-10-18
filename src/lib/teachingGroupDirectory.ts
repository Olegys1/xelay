import type { TeachingDirectoryGroup } from './teaching'

const levels: Record<string, string> = {
  bachelor: 'Бакалаврат',
  master: 'Магістратура',
  postgraduate: 'Аспірантура',
}

/** Academic identity comes from the group's cohort, never the teacher's profile. */
export function teachingGroupDirectoryLabel(group: TeachingDirectoryGroup, includeName = true): string {
  const year = Number.isInteger(group.study_year) && Number(group.study_year) >= 1 && Number(group.study_year) <= 6
    ? `${group.study_year} курс` : 'Курс не уточнено'
  return [
    includeName ? group.group_name : null,
    year,
    levels[group.study_level || ''] || 'Рівень не уточнено',
    group.academic_unit_name,
    group.specialty,
    group.representative_name ? `Староста: ${group.representative_name}` : null,
  ].filter(Boolean).join(' · ')
}

export function teachingGroupDirectoryMatches(group: TeachingDirectoryGroup, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase('uk-UA')
  return !normalized || teachingGroupDirectoryLabel(group).toLocaleLowerCase('uk-UA').includes(normalized)
}
