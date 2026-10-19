// Shared by the private generation endpoint and the editor. No database or
// provider code belongs here: generated content is an untrusted draft.
export type SeminarAiFormat = 'questions' | 'booking' | 'teams'
export type SeminarAiInput = {
  source_text: string
  format: SeminarAiFormat
  primary_capacity: number | null
  team_size: number | null
  team_count: number | null
  participant_count: number | null
}
export type SeminarAiDraftResult = {
  version: 1
  title: string
  instructions: string
  format: SeminarAiFormat
  questions: { body: string; primary_capacity: number }[]
  teams: { name: string; capacity: number }[]
  warnings: string[]
}

export const SEMINAR_AI_MAX_SOURCE_LENGTH = 12000
export const SEMINAR_AI_MAX_ITEMS = 30
const MAX_INSTRUCTIONS = 10000
const INVALID_OUTPUT = 'ШІ повернув неповну або некоректну чернетку. Спробуйте уточнити текст або заповніть форму вручну.'
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[], message: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(message)
}
function text(value: unknown, limit: number, message: string, required = true): string {
  if (typeof value !== 'string' || value.length > limit || CONTROL_CHARACTERS.test(value)) throw new Error(message)
  const normalized = value.replace(/\r\n?/g, '\n').trim()
  if (required && !normalized) throw new Error(message)
  return normalized
}
function integer(value: unknown, min: number, max: number, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(message)
  return value
}
function warnings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 6) throw new Error(INVALID_OUTPUT)
  return value.map((item) => text(item, 400, INVALID_OUTPUT))
}
function format(value: unknown): SeminarAiFormat {
  if (value !== 'questions' && value !== 'booking' && value !== 'teams') throw new Error('Оберіть формат семінару.')
  return value
}

export function normalizeSeminarAiInput(value: unknown): SeminarAiInput {
  const input = record(value, 'Перевірте дані для підготовки семінару.')
  onlyKeys(input, ['source_text', 'format', 'primary_capacity', 'team_size', 'team_count', 'participant_count'], 'Перевірте параметри семінару.')
  const source = text(input.source_text, SEMINAR_AI_MAX_SOURCE_LENGTH, 'Вставте питання або умови завдання: до 12 000 символів.')
  const kind = format(input.format)
  const primary = input.primary_capacity ?? null
  const size = input.team_size ?? null
  const count = input.team_count ?? null
  const participants = input.participant_count ?? null
  if (kind !== 'teams') {
    if (size !== null || count !== null || participants !== null) throw new Error('Для питань оберіть кількість місць на питання, без параметрів команд.')
    return {
      source_text: source, format: kind,
      primary_capacity: integer(primary, 1, 30, 'Вкажіть від 1 до 30 місць на питання.'),
      team_size: null, team_count: null, participant_count: null,
    }
  }
  if (primary !== null) throw new Error('Для командної роботи вкажіть розмір команди.')
  const teamSize = integer(size, 1, 50, 'У команді може бути від 1 до 50 людей.')
  if ((count === null) === (participants === null)) throw new Error('Оберіть кількість команд або загальну кількість учасників.')
  const teamCount = count === null ? null : integer(count, 1, 30, 'Можна підготувати від 1 до 30 команд.')
  const participantCount = participants === null ? null : integer(participants, 1, 300, 'Вкажіть від 1 до 300 учасників.')
  if (participantCount !== null && Math.ceil(participantCount / teamSize) > SEMINAR_AI_MAX_ITEMS) {
    throw new Error('Виходить понад 30 команд. Збільште кількість людей у команді або зменште кількість учасників.')
  }
  return {
    source_text: source, format: kind, primary_capacity: null,
    team_size: teamSize, team_count: teamCount, participant_count: participantCount,
  }
}

// Team capacities are derived from explicit user choices, never from a model.
export function seminarAiTeams(value: SeminarAiInput): SeminarAiDraftResult['teams'] {
  const input = normalizeSeminarAiInput(value)
  if (input.format !== 'teams') return []
  const size = input.team_size!
  const count = input.team_count ?? Math.ceil(input.participant_count! / size)
  return Array.from({ length: count }, (_, index) => ({
    name: `Команда ${index + 1}`,
    capacity: input.participant_count === null ? size : Math.min(size, input.participant_count - index * size),
  }))
}

// https://developers.openai.com/api/docs/guides/structured-outputs
// All objects explicitly deny extra keys, and incomplete extraction is not a
// usable import. Responses refusal/incomplete states are handled by the server.
export const SEMINAR_AI_MODEL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['version', 'complete', 'title', 'instructions', 'questions', 'warnings'],
  properties: {
    version: { type: 'integer', enum: [1] },
    complete: { type: 'boolean' },
    title: { type: 'string', description: 'Explicit source heading up to 160 characters, or empty if not provided.' },
    instructions: { type: 'string', description: 'Only general source instructions, at most 10000 characters; do not duplicate questions.' },
    questions: { type: 'array', maxItems: SEMINAR_AI_MAX_ITEMS, items: { type: 'string', description: 'One complete source question or assignment, at most 2000 characters.' } },
    warnings: { type: 'array', maxItems: 6, items: { type: 'string', description: 'Short Ukrainian review note, at most 400 characters.' } },
  },
} as const

/** Convert extraction to an editable draft; this function never saves anything. */
export function buildSeminarAiDraft(value: unknown, inputValue: SeminarAiInput): SeminarAiDraftResult {
  const input = normalizeSeminarAiInput(inputValue)
  const raw = record(value, INVALID_OUTPUT)
  onlyKeys(raw, ['version', 'complete', 'title', 'instructions', 'questions', 'warnings'], INVALID_OUTPUT)
  if (raw.version !== 1 || raw.complete !== true) {
    throw new Error('Не вдалося повністю виділити питання. Вставте чіткий список до 30 питань або розділіть великий семінар на кілька завдань.')
  }
  const title = text(raw.title, 160, INVALID_OUTPUT, false)
    || (input.format === 'teams' ? 'Командне завдання до семінару' : 'Питання до семінару')
  const instructions = text(raw.instructions, MAX_INSTRUCTIONS, INVALID_OUTPUT, false)
  if (!Array.isArray(raw.questions) || !raw.questions.length || raw.questions.length > SEMINAR_AI_MAX_ITEMS) throw new Error(INVALID_OUTPUT)
  const questions = raw.questions.map((item) => text(item, 2000, INVALID_OUTPUT))
  const notices = warnings(raw.warnings)
  if (input.format !== 'teams') return {
    version: 1, title, instructions, format: input.format,
    questions: questions.map((body) => ({ body, primary_capacity: input.primary_capacity! })),
    teams: [], warnings: notices,
  }

  const teams = seminarAiTeams(input)
  const assignments: number[][] = teams.map(() => [])
  questions.forEach((_, index) => assignments[index % teams.length].push(index + 1))
  // With more teams than questions, repeat references rather than duplicating
  // or dropping source text. Every team has a task; people still join freely.
  assignments.forEach((items, index) => { if (!items.length) items.push(index % questions.length + 1) })
  const combined = [
    instructions,
    `Питання для підготовки:\n${questions.map((body, index) => `${index + 1}. ${body}`).join('\n\n')}`,
    `Завдання команд:\n${teams.map((team, index) => `${team.name}: питання ${assignments[index].join(', ')}.`).join('\n')}`,
  ].filter(Boolean).join('\n\n')
  if (combined.length > MAX_INSTRUCTIONS) throw new Error('Текст командних завдань перевищує 10 000 символів. Скоротіть загальні умови або розділіть семінар на кілька завдань.')
  const teamNotice = teams.length > questions.length
    ? 'Команд більше, ніж питань: окремі команди отримали однакові питання. Перевірте розподіл у загальних умовах.'
    : 'Питання розподілено між командами по черзі. Перед збереженням можна змінити цей розподіл у загальних умовах.'
  return {
    version: 1, title, instructions: combined, format: 'teams', questions: [], teams,
    warnings: [...notices.slice(0, 5), teamNotice],
  }
}

/** Validate the complete response again in the browser before offering Apply. */
export function normalizeSeminarAiDraft(value: unknown, inputValue: SeminarAiInput): SeminarAiDraftResult {
  const input = normalizeSeminarAiInput(inputValue)
  const raw = record(value, INVALID_OUTPUT)
  onlyKeys(raw, ['version', 'title', 'instructions', 'format', 'questions', 'teams', 'warnings'], INVALID_OUTPUT)
  if (raw.version !== 1 || raw.format !== input.format || !Array.isArray(raw.questions) || !Array.isArray(raw.teams)) throw new Error(INVALID_OUTPUT)
  const title = text(raw.title, 160, INVALID_OUTPUT)
  const instructions = text(raw.instructions, MAX_INSTRUCTIONS, INVALID_OUTPUT, false)
  const notices = warnings(raw.warnings)
  if (input.format !== 'teams') {
    if (raw.teams.length || !raw.questions.length || raw.questions.length > SEMINAR_AI_MAX_ITEMS) throw new Error(INVALID_OUTPUT)
    const questions = raw.questions.map((value) => {
      const question = record(value, INVALID_OUTPUT)
      onlyKeys(question, ['body', 'primary_capacity'], INVALID_OUTPUT)
      if (question.primary_capacity !== input.primary_capacity) throw new Error(INVALID_OUTPUT)
      return { body: text(question.body, 2000, INVALID_OUTPUT), primary_capacity: input.primary_capacity! }
    })
    return { version: 1, title, instructions, format: input.format, questions, teams: [], warnings: notices }
  }
  const expectedTeams = seminarAiTeams(input)
  if (raw.questions.length || raw.teams.length !== expectedTeams.length || !instructions) throw new Error(INVALID_OUTPUT)
  const teams = raw.teams.map((value, index) => {
    const team = record(value, INVALID_OUTPUT)
    onlyKeys(team, ['name', 'capacity'], INVALID_OUTPUT)
    if (team.name !== expectedTeams[index].name || team.capacity !== expectedTeams[index].capacity) throw new Error(INVALID_OUTPUT)
    return expectedTeams[index]
  })
  return { version: 1, title, instructions, format: 'teams', questions: [], teams, warnings: notices }
}
