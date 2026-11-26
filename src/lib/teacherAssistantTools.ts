export type TeacherInsights = {
  checkedAt: string; courseId: string; courseTitle: string; notice: string
  groups: { id: string; name: string; students: number; publishedGrades: number; averagePercent: number | null; pendingReviews: number; upcoming: { title: string; dueAt: string }[] }[]
  test: null | { id: string; title: string; ready: boolean; submitted: number }
  questions: { key: string; text: string; kind: string; responses: number; mistakes: number; pendingReview: number }[]
  learners: { code: string; name: string; groupId: string; weak: string[]; pendingReview: number }[]
}
export type TeacherReminder = { id: string; title: string; dueAt: string; state: 'pending' | 'sent' | 'cancelled' }
export type TeacherTestConditions = { opensAt: string; closesAt: string; durationSeconds: number; allowSkip: boolean; allowReturn: boolean; restrictTabSwitch: boolean; requireAccessCode: boolean; shuffleQuestions: boolean; shuffleAnswers: boolean }
export type TeacherInsightsScope = { courseId: string; groupIds: string[]; testId: string | null }

/** Suggestions come only from the caller's already-authorized report; saving is a separate action. */
export function teacherReminderSuggestions(report: TeacherInsights, now = Date.now()) {
 const result: { id: string; title: string; dueAt: string; reason: string }[] = []
 for (const group of report.groups) {
  if (group.pendingReviews > 0) result.push({ id: group.id + ':review', title: ('Перевірити роботи: ' + group.name).slice(0, 180), dueAt: new Date(now + 3600000).toISOString(), reason: `Чекають перевірки: ${group.pendingReviews}` })
  for (const item of group.upcoming) {
   const deadline = Date.parse(item.dueAt)
   if (!Number.isFinite(deadline) || deadline <= now + 60000) continue
   const id = group.id + ':' + item.title + ':' + item.dueAt
   if (result.some(value => value.id === id)) continue
   result.push({ id, title: (item.title + ' · ' + group.name).slice(0, 180), dueAt: new Date(Math.max(now + 60000, deadline - 3600000)).toISOString(), reason: 'Перед завершенням прийому робіт' })
  }
 }
 return result.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)).slice(0, 20)
}
