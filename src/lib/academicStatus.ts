export const ACADEMIC_STATUS_OPTIONS = [
  { value: 'bachelor', label: 'Студент бакалаврату' },
  { value: 'master', label: 'Студент магістратури' },
  { value: 'postgraduate', label: 'Аспірант / аспірантка' },
  { value: 'graduate', label: 'Випускник / випускниця' },
] as const

export function isAcademicStatus(value: string) {
  return ACADEMIC_STATUS_OPTIONS.some((option) => option.value === value)
}

export function academicStatusLabel(value: string) {
  const option = ACADEMIC_STATUS_OPTIONS.find((item) => item.value === value)
  if (option) return option.label
  // Old profiles combined students and graduates. Work experience cannot tell
  // us someone's study status, so those values are not reinterpreted.
  return value === 'Student / Fresh Graduate' ? 'Студент / випускник' : ''
}
