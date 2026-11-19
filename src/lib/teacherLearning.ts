export type TeacherPlanId = 'teacher_start' | 'teacher_plus' | 'teacher_max'
export type TeacherLearningKind = 'chat' | 'insights' | 'questions' | 'variants' | 'tasks' | 'rubric_review' | 'quality' | 'error_practice'
export type TeacherLearningGroup = { id: string; name: string; permissions: string[] }
export type TeacherLearningCourse = { id: string; title: string; permissions: string[]; groups: TeacherLearningGroup[] }
export type TeacherLearningStatus = {
  userId: string; audience: 'student' | 'teacher' | 'unresolved'; planId: TeacherPlanId | 'free'
  canGenerate: boolean; canEdit: boolean; available: boolean
  startsAt: string | null; expiresAt: string | null; budgetPeriod: 'subscription_month'
  budget: { limitMicros: number; spentMicros: number; reservedMicros: number }
  allowedModes: TeacherLearningKind[]; courses: TeacherLearningCourse[]
}
export type TeacherLearningRequest = {
  requestId: string; kind: TeacherLearningKind; courseId: string; groupIds: string[]
  prompt: string; consent: true; sourceText?: string; rubricText?: string
  parentId?: string; submissionId?: string; testId?: string; questionCount?: number; variantCount?: number
}
export type TeacherLearningQuestion = {
  id: string; type: 'single'; text: string; choices: string[]; correctIndex: number
  explanation: string; points: number; topic: string; variant: number
}
export type TeacherLearningBundle = {
  version: 1; kind: TeacherLearningKind; title: string; summary: string
  questions: TeacherLearningQuestion[]
  tasks: { title: string; instructions: string; criteria: string[] }[]
  review: null | {
    criteria: { title: string; points: number; maxPoints: number; comment: string; evidence: string[] }[]
    feedback: string; suggestedScore: number; maxScore: number
  }
  quality: { questionId: string; issue: string; suggestion: string }[]
  testConditions?: null | { [K in keyof import('./teacherAssistantTools').TeacherTestConditions]: import('./teacherAssistantTools').TeacherTestConditions[K] | null }
  warnings: string[]
}
export type TeacherLearningDraft = {
  id: string; request: TeacherLearningRequest; bundle: TeacherLearningBundle; revision: number
  status: 'draft' | 'accepted'; teacherNotes: string; createdAt: string; updatedAt: string
}
export type TeacherLearningSave = {
  id: string; expectedRevision: number; bundle: TeacherLearningBundle
  teacherNotes: string; status: 'draft' | 'accepted'
}
