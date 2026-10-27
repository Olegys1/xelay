import type { TeachingActivity, TeachingEntry, TeachingGrade, TeachingSnapshot } from './teaching'

/** Navigation context only. Access and writes are still checked by the repository. */
export type TeachingJournalFocus = {
  courseId: string
  groupId: string
  assignmentId?: string
  activityId?: string
  studentId?: string
  date?: string
  key?: string
}

export function resolveTeachingJournalFocus(snapshot: TeachingSnapshot, focus: TeachingJournalFocus) {
  const group = snapshot.groups.find(item => item.group_id === focus.groupId &&
    (item.status === 'accepted' || snapshot.entries.some(entry => entry.group_id === item.group_id)))
  if (focus.courseId !== snapshot.course.id || !snapshot.course.permissions.includes('grades') || !group) {
    return { groupId: '', activity: undefined, entry: undefined, problem: 'Немає доступу до журналу цієї групи й предмета.' }
  }
  const activities = snapshot.activities.filter(item => item.course_id === focus.courseId && item.group_id === focus.groupId)
  // Exact identities take precedence. Never replace a missing work with the first
  // work, a similarly named assignment, or another group's work on the same date.
  const activity = focus.activityId
    ? activities.find(item => item.id === focus.activityId && (!focus.assignmentId || item.item_id === focus.assignmentId))
    : focus.assignmentId
      ? activities.find(item => item.item_id === focus.assignmentId)
      : focus.date ? activities.find(item => item.activity_date === focus.date) : undefined
  const entry = focus.studentId ? snapshot.entries.find(item => item.course_id === focus.courseId &&
    item.group_id === focus.groupId && item.user_id === focus.studentId && item.active) : undefined
  const problem = (focus.activityId || focus.assignmentId || focus.date) && !activity
    ? 'Для цього завдання ще немає роботи в журналі. Додайте роботу або перевірте налаштування оцінювання завдання.'
    : focus.studentId && !entry
      ? 'Студента ще немає в журналі. Оновіть склад групи, щоб додати його без втрати попередніх результатів.'
      : ''
  return { groupId: group.group_id, activity, entry, problem }
}

export const teachingGradeDraftScore = (grade?: TeachingGrade) => grade && 'draft_score' in grade ? grade.draft_score : grade?.published_score

export function parseTeachingGradeScore(raw: string, maximum: number): number | null {
  const value = raw.trim()
  if (!value) return null
  const score = Number(value.replace(',', '.'))
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value) || !Number.isFinite(score) || !Number.isFinite(maximum) || maximum <= 0 || score < 0 || score > maximum) {
    throw new Error(`Вкажіть від 0 до ${maximum} балів, до двох знаків після коми, або залиште поле порожнім.`)
  }
  return score
}

export function teachingGradeEditScore(raw: string, activity: Pick<TeachingActivity, 'max_points'>, grade?: TeachingGrade, mode: 'replace' | 'add' = 'replace') {
  const score = parseTeachingGradeScore(raw, activity.max_points)
  if (mode === 'replace') return score
  const previous = teachingGradeDraftScore(grade)
  if (typeof previous !== 'number' || !Number.isFinite(previous)) throw new Error('Спочатку виставте основний бал. Додаткові бали можна додати до наявного результату.')
  if (score === null || score <= 0) throw new Error('Вкажіть, скільки балів додати після відповіді або захисту.')
  const result = Math.round((previous + score) * 100) / 100
  if (result > activity.max_points) throw new Error(`Разом виходить ${result} балів. Максимум цієї роботи — ${activity.max_points}; його та коефіцієнти не змінено.`)
  return result
}

export function teachingGradeDraftPayload(courseId: string, entry: TeachingEntry, activity: TeachingActivity, grade: TeachingGrade | undefined, input: { score: string; comment: string; reason: string; mode?: 'replace' | 'add' }) {
  if (entry.course_id !== courseId || activity.course_id !== courseId || entry.group_id !== activity.group_id || !entry.active ||
    (grade && (grade.activity_id !== activity.id || grade.entry_id !== entry.id))) throw new Error('Результат не належить цьому студенту, предмету й групі. Оновіть журнал.')
  const score = teachingGradeEditScore(input.score, activity, grade, input.mode)
  const comment = input.comment.trim(), reason = input.reason.trim()
  if (Array.from(comment).length > 2000 || Array.from(reason).length > 500) throw new Error('Скоротіть коментар до 2000 символів, а причину — до 500.')
  if ((input.mode === 'add' || grade?.published_at && (score !== grade.published_score || comment !== grade.published_comment)) && Array.from(reason).length < 2) {
    throw new Error('Вкажіть причину зміни результату — щонайменше два символи. Вона збережеться в історії журналу.')
  }
  return { course_id: courseId, activity_id: activity.id, entry_id: entry.id, score, comment, reason, version: grade?.version || 0 }
}
