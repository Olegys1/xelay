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
