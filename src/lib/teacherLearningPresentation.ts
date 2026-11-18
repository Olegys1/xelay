import type { TeacherLearningBundle, TeacherLearningKind, TeacherLearningStatus } from './teacherLearning'

export const TEACHER_LEARNING_MODES: readonly { id: TeacherLearningKind; label: string; hint: string }[] = [
  { id: 'questions', label: 'Тест', hint: 'Запитання з теми або обраного матеріалу' },
  { id: 'tasks', label: 'Завдання', hint: 'Умова та зрозумілі критерії виконання' },
  { id: 'variants', label: 'Варіанти', hint: 'Кілька варіантів однієї роботи' },
  { id: 'rubric_review', label: 'Розбір роботи', hint: 'Пропозиція фідбеку та балів за критеріями' },
  { id: 'quality', label: 'Якість тесту', hint: 'Що варто уточнити в запитаннях' },
  { id: 'error_practice', label: 'Практика помилок', hint: 'Додаткова практика для ваших груп' },
]

export function teacherBudgetPercent(status: TeacherLearningStatus) {
  const { limitMicros, spentMicros, reservedMicros } = status.budget
  return limitMicros > 0 ? Math.max(0, Math.min(100, Math.floor((limitMicros - spentMicros - reservedMicros) / limitMicros * 100))) : 0
}

export function teacherQuestionsAsAiken(bundle: TeacherLearningBundle): string {
  return bundle.questions.map(question => {
    const line = (value: string) => value.replace(/[\r\n\u0000-\u001f]+/g, ' ').trim()
    if (question.choices.length < 2 || question.choices.length > 26 || !Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex >= question.choices.length) throw new Error('Спочатку перевірте варіанти й правильні відповіді кожного запитання.')
    return `${line(question.text)}\n${question.choices.map((choice, index) => `${String.fromCharCode(65 + index)}. ${line(choice)}`).join('\n')}\nANSWER: ${String.fromCharCode(65 + question.correctIndex)}`
  }).join('\n\n')
}

export function availableTeacherGroups(status: TeacherLearningStatus, courseId: string, ids: readonly string[]) {
  const allowed = new Set(status.courses.find(course => course.id === courseId)?.groups.map(group => group.id) || [])
  return Array.from(new Set(ids)).filter(id => allowed.has(id)).slice(0, status.planId === 'teacher_max' ? 10 : 1)
}
