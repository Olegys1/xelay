import type { TutorMode, TutorRun, TutorState } from './maxTutor'

/** Only already validated runs from this account's scoped state are candidates.
 * The server resolves these IDs again; client history never grants access. */
export function tutorConversationRuns(state: TutorState, activeRunId = state.activeRunId): TutorRun[] {
  const byId = new Map(state.runs.map(run => [run.id, run])), seen = new Set<string>(), ordered: TutorRun[] = []
  function visit(id: string, before = Infinity) {
    const run = byId.get(id)
    if (!run || seen.has(id) || ordered.length >= 12 || Date.parse(run.createdAt) > before) return
    seen.add(id)
    const references = 'conversationRunIds' in run.request && Array.isArray(run.request.conversationRunIds) ? run.request.conversationRunIds : []
    for (const reference of references) if (typeof reference === 'string') visit(reference, Date.parse(run.createdAt))
    ordered.push(run)
  }
  visit(activeRunId)
  return ordered.slice(-12).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}
export function tutorConversationRunIds(state: TutorState): string[] {
  return tutorConversationRuns(state).filter(run => !run.demo).slice(-4).map(run => run.id)
}

/** Infer a requested activity from the student's message, never file contents.
 * Ordinary questions remain a conversation and can be asked without a file. */
export function inferTutorConversationMode(prompt: string, sourceCount: number): TutorMode {
  const text = prompt.trim().slice(0, 2400).replace(/\s+/g, ' ')
  const opening = text.replace(/^(?:будь ласка|пожалуйста|please)[,\s]+/iu, '')
  // A question about creating a test is not permission to create one.
  if (/^(?:(?:чи\s+)?(?:можеш|можете|можешь|можна|можно|can you|could you)\s+(?:(?:мені|мне|будь ласка|пожалуйста)\s+)?)?(?:поясни(?:ти|ть|те)?|поясніть|объясни(?:ть|те)?|розкажи|розкажіть|расскажи|расскажите|explain|tell me|що таке|что такое|як |как |why |how |what is )/iu.test(opening)) return sourceCount > 0 ? 'explain' : 'chat'
  const parts = text.split(/[.!?\n]+/).filter(part => !/(?:не\s+(?:треба|потріб|нужно|делай|створ|зроб|создав|роби)|без\s+(?:тест|карт|план)|do not|don't)/iu.test(part))
  const create = '(?:створи|створити|зроби|зробити|підготуй|згенеруй|сделай|создай|сгенерируй|подготовь|generate|create|make)'
  for (const part of parts) {
    // The first requested artifact governs the format. A plan can contain tests;
    // a test about planning is still a test, regardless of the later topic words.
    const artifact = new RegExp('(?:' + create + '|склади|составь|build)[^.!?\\n]{0,80}?(тест\\p{L}*|вікторин\\p{L}*|викторин\\p{L}*|quiz(?:zes)?|(?:practice\\s+)?tests?|картк\\p{L}*|карточк\\p{L}*|flash\\s*cards|план(?!\\p{L})|plan(?!\\p{L}))', 'iu').exec(part)?.[1]
    if (artifact) return /^(?:план|plan)$/iu.test(artifact) ? 'plan' : /^(?:картк|карточк|flash)/iu.test(artifact) ? 'cards' : 'quiz'
    if (/(?:^|\s)(?:розв[’'ʼ]?яжи|розв[’'ʼ]?язати|реши|решить|solve)\s/iu.test(part)) return 'math'
  }
  if (sourceCount > 0 && /^(?:(?:будь ласка|пожалуйста|please)[,\s]+)?(?:поясни|поясніть|объясни|розкажи|расскажи|explain)/iu.test(text)) return 'explain'
  return 'chat'
}

/** Restore only a UI selection against freshly authorized cloud history.
 * Local prompt/bundle/progress data is deliberately never merged here. */
export function restoreTutorConversationReference(state: TutorState, raw: string | null, ownerId: string | null): TutorState {
  if (!ownerId || !raw || raw.length > 512) return state
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return state
    const reference = value as Record<string, unknown>
    if (Object.keys(reference).length !== 3 || reference.version !== 1 || reference.ownerId !== ownerId || typeof reference.activeRunId !== 'string') return state
    if (reference.activeRunId !== '' && !state.runs.some(run => run.id === reference.activeRunId)) return state
    return { ...state, activeRunId: reference.activeRunId }
  } catch { return state }
}
export function storeTutorConversationReference(state: TutorState, ownerId: string | null): string | null {
  if (!ownerId || state.activeRunId !== '' && !state.runs.some(run => run.id === state.activeRunId)) return null
  return JSON.stringify({ version: 1, ownerId, activeRunId: state.activeRunId })
}

/** Activities open at their first usable control instead of their footer. */
export function tutorConversationScrollTarget(run: TutorRun | undefined): 'end' | 'quiz' | 'cards' | 'study' | 'plan' | 'math' {
  if (!run) return 'end'
  if (run.bundle.study) return 'study'
  if (run.bundle.mode === 'quiz' && run.bundle.questions.length) return 'quiz'
  if (run.bundle.mode === 'cards' && run.bundle.cards.length) return 'cards'
  if (run.bundle.mode === 'plan' && run.bundle.plan.length) return 'plan'
  if (run.bundle.mode === 'math' && run.bundle.math) return 'math'
  return 'end'
}
