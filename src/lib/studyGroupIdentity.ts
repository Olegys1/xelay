import { currentAcademicYear } from './studyYearProgression'

export type StudyGroupIdentityFields = {
  cohort_start_year?: number | null
  study_level?: string | null
}

const STUDY_LEVEL_LABELS: Readonly<Record<string, string>> = {
  bachelor: 'Бакалаврат',
  master: 'Магістратура',
  postgraduate: 'Аспірантура',
}

export function studyGroupIdentityLabel(identity: StudyGroupIdentityFields, date: Date = new Date()): string {
  const cohort = identity.cohort_start_year
  const hasCohort = typeof cohort === 'number' && Number.isInteger(cohort) && cohort >= 1900 && cohort <= 2199
  const course = hasCohort ? currentAcademicYear(date) - cohort + 1 : null
  const courseLabel = course !== null && course >= 1 && course <= 6
    ? `${course} курс`
    : hasCohort ? `Набір ${cohort}` : 'Курс уточнюється'
  const levelLabel = identity.study_level ? STUDY_LEVEL_LABELS[identity.study_level] : null
  return [courseLabel, levelLabel].filter(Boolean).join(' · ')
}

export function studyGroupCreationError(error: { code?: string; message?: string; details?: string | null }): string {
  const message = error.message || ''
  if (/\bGROUP_COHORT_REQUIRED\b/.test(message)) {
    return 'Уточніть курс і навчальний статус у профілі, потім повторіть створення групи.'
  }
  if (/\bGROUP_IDENTITY_NEEDS_REVIEW\b/.test(message)) {
    return 'Знайдено групу з такою назвою, але її курс ще не уточнено. Зверніться до адміністратора для перевірки.'
  }
  if (/\bGROUP_ALREADY_EXISTS\b/.test(message)
    || (error.code === '23505' && /\bstudy_groups_academic_cohort_unique_idx\b/.test(`${message} ${error.details || ''}`))) {
    return 'Група цього набору та рівня навчання вже існує. Зверніться до адміністратора, щоб перевірити старосту та доступ.'
  }
  return 'Не вдалося створити групу. Оновіть сторінку та спробуйте ще раз.'
}
