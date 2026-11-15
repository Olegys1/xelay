import type { TeachingTest, TeachingTestRepublishCandidate } from './teachingTests'

const definitionFields = [
  'id', 'course_id', 'title', 'description', 'status', 'opens_at', 'closes_at',
  'duration_seconds', 'max_points', 'category', 'journal_date', 'work_type',
  'allow_skip', 'allow_return', 'question_timer_policy', 'restrict_copy',
  'bonus_percent', 'bonus_points', 'targets', 'questions', 'shuffle_questions',
  'shuffle_answers', 'draw_count', 'overrides', 'require_access_code',
  'restrict_tab_switch', 'discourage_capture', 'allow_external_links',
  'variants', 'base_variant_title',
] as const

// Only authored configuration belongs in a draft. Staff receipts, other
// students' permissions and publication history must never become its payload.
export function teachingTestPublicationDefinition(test: TeachingTest): Record<string, unknown> {
  return Object.fromEntries(definitionFields.filter(key => test[key] !== undefined)
    .map(key => [key, structuredClone(test[key])]))
}

export function teachingPublicationCandidateMatches(candidate: TeachingTestRepublishCandidate, filters: {
  search: string; groupId: string; before: string | null; after: string | null
}): boolean {
  const started = Date.parse(candidate.started_at)
  if (!Number.isFinite(started)) return false
  if (filters.groupId && candidate.group_id !== filters.groupId) return false
  if (filters.search.trim() && !candidate.student_name.toLocaleLowerCase('uk-UA')
    .includes(filters.search.trim().toLocaleLowerCase('uk-UA'))) return false
  // A boundary of 13:25 means strictly before 13:25, including seconds.
  if (filters.before && (!Number.isFinite(Date.parse(filters.before)) || started >= Date.parse(filters.before))) return false
  if (filters.after && (!Number.isFinite(Date.parse(filters.after)) || started < Date.parse(filters.after))) return false
  return true
}

export function teachingPublicationSelectedAttempts(candidates: TeachingTestRepublishCandidate[], selected: ReadonlySet<string>): string[] {
  const eligible = new Set(candidates.filter(candidate => candidate.eligible && candidate.status === 'submitted')
    .map(candidate => candidate.source_attempt_id))
  if ([...selected].some(id => !eligible.has(id))) throw new Error('Склад спроб змінився. Оновіть дані й оберіть студентів ще раз.')
  return [...new Set(selected)].sort()
}

export function teachingPublicationChanges(before: TeachingTest, after: TeachingTest): string[] {
  const changed = (keys: (keyof TeachingTest)[]) => keys.some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
  return [
    changed(['opens_at', 'closes_at', 'duration_seconds']) && 'Час доступу та тривалість',
    changed(['title', 'description']) && 'Назва та опис',
    changed(['questions', 'variants', 'base_variant_title', 'draw_count']) && 'Запитання та варіанти',
    changed(['targets', 'overrides']) && 'Отримувачі та особисті умови',
    changed(['max_points', 'bonus_percent', 'bonus_points', 'journal_date', 'work_type', 'category']) && 'Оцінювання та журнал',
    changed(['allow_skip', 'allow_return', 'question_timer_policy', 'restrict_copy', 'require_access_code',
      'restrict_tab_switch', 'discourage_capture', 'allow_external_links', 'shuffle_questions', 'shuffle_answers']) && 'Правила проходження',
  ].filter((value): value is string => Boolean(value))
}
