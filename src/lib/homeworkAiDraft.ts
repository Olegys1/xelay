export const HOMEWORK_AI_SOURCE_LIMIT = 12000
export const HOMEWORK_AI_ITEM_LIMIT = 10
const INVALID_INPUT = 'Вставте повідомлення до 12 000 символів і вкажіть дату, коли його написали.'
const INVALID_OUTPUT = 'Не вдалося надійно розібрати повідомлення. Уточніть його або поділіть на менші частини.'

export type HomeworkAiInput = { source_text: string; reference_date: string }
export type HomeworkAiLessonType = 'lecture' | 'seminar' | 'practical' | 'lab' | 'other'
export type HomeworkAiDraftItem = {
  subject: string
  lesson_type: HomeworkAiLessonType | null
  date_text: string
  lesson_topic: string
  source_fragment: string
  links: { url: string; title: string }[]
}
export type HomeworkAiDraftResult = {
  version: 1
  complete: true
  general_instructions: string
  items: HomeworkAiDraftItem[]
  warnings: string[]
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}
function onlyKeys(value: Record<string, unknown>, keys: string[], message: string) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw new Error(message)
}
function text(value: unknown, maximum: number, allowEmpty = true, message = INVALID_OUTPUT): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(message)
  const result = value.replace(/\r\n?/g, '\n').trim()
  if (!allowEmpty && !result) throw new Error(message)
  return result
}
const comparable = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim()
const sourceContains = (source: string, part: string) => !part || comparable(source).includes(comparable(part))

export function isHomeworkAiDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  if (year < 1900 || year > 2200) return false
  const parsed = new Date(value + 'T12:00:00Z')
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function homeworkAiTodayInKyiv(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value || '').join('-')
}

export function normalizeHomeworkAiInput(value: unknown): HomeworkAiInput {
  const raw = record(value, INVALID_INPUT)
  onlyKeys(raw, ['source_text', 'reference_date'], INVALID_INPUT)
  const source_text = text(raw.source_text, HOMEWORK_AI_SOURCE_LIMIT, false, INVALID_INPUT)
  if (!isHomeworkAiDate(raw.reference_date)) throw new Error(INVALID_INPUT)
  return { source_text, reference_date: raw.reference_date }
}

function safeUrl(value: unknown): string {
  const candidate = text(value, 2048, false)
  try {
    const parsed = new URL(candidate)
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(INVALID_OUTPUT)
    return parsed.href
  } catch { throw new Error(INVALID_OUTPUT) }
}

/** Read links as text only. Neither extraction nor validation fetches them. */
function sourceUrls(source: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const match of source.matchAll(/https?:\/\/[^\s<>"“”]+/giu)) {
    let token = match[0].replace(/[.,;!?…]+$/u, '')
    for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (token.endsWith(closing) && token.split(closing).length > token.split(opening).length) token = token.slice(0, -1)
    }
    try { const canonical = safeUrl(token); if (!result.has(canonical)) result.set(canonical, token) } catch { /* Non-links remain in the original message text. */ }
  }
  return result
}

export function homeworkAiBody(draft: Pick<HomeworkAiDraftResult, 'general_instructions'>, item: HomeworkAiDraftItem): string {
  const general = draft.general_instructions.trim(), fragment = item.source_fragment.trim()
  if (!general || sourceContains(fragment, general)) return fragment
  if (sourceContains(general, fragment)) return general
  return general + '\n\n' + fragment
}

/** Same validator runs before a server response and before browser Apply. */
export function normalizeHomeworkAiDraft(value: unknown, inputValue: HomeworkAiInput): HomeworkAiDraftResult {
  const input = normalizeHomeworkAiInput(inputValue)
  const raw = record(value, INVALID_OUTPUT)
  onlyKeys(raw, ['version', 'complete', 'general_instructions', 'items', 'warnings'], INVALID_OUTPUT)
  if (raw.version !== 1 || raw.complete !== true) throw new Error('Повідомлення не вдалося розібрати повністю. Вставте до 10 завдань або уточніть текст. Нічого не застосовано.')
  const general = text(raw.general_instructions, 10000)
  if (!sourceContains(input.source_text, general)) throw new Error(INVALID_OUTPUT)
  if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > HOMEWORK_AI_ITEM_LIMIT) throw new Error(INVALID_OUTPUT)
  const rawItems = raw.items
  if (!Array.isArray(raw.warnings) || raw.warnings.length > 6) throw new Error(INVALID_OUTPUT)
  const warnings = raw.warnings.map(item => text(item, 400, false))
  const seen = new Set<string>()
  const items = rawItems.map(value => {
    const item = record(value, INVALID_OUTPUT)
    onlyKeys(item, ['subject', 'lesson_type', 'date_text', 'lesson_topic', 'source_fragment', 'links'], INVALID_OUTPUT)
    const subject = text(item.subject, 160), date_text = text(item.date_text, 160), lesson_topic = text(item.lesson_topic, 240)
    const source_fragment = text(item.source_fragment, 10000, false)
    if (![subject, date_text, lesson_topic, source_fragment].every(part => sourceContains(input.source_text, part))) throw new Error(INVALID_OUTPUT)
    if (item.lesson_type !== null && !['lecture', 'seminar', 'practical', 'lab', 'other'].includes(String(item.lesson_type))) throw new Error(INVALID_OUTPUT)
    const base: HomeworkAiDraftItem = { subject, date_text, lesson_topic, source_fragment, lesson_type: item.lesson_type as HomeworkAiLessonType | null, links: [] }
    const body = homeworkAiBody({ general_instructions: general }, base)
    // A subject/deadline from another assignment in the same message must not
    // become the metadata of this verbatim task block.
    if (![subject, date_text, lesson_topic].every(part => sourceContains(body, part))) throw new Error(INVALID_OUTPUT)
    if (body.length > 10000) throw new Error('Повний текст одного ДЗ перевищує 10 000 символів. Поділіть повідомлення — завдання не скорочено й не застосовано.')
    if (rawItems.length > 1 && general && sourceContains(general, source_fragment)) throw new Error(INVALID_OUTPUT)
    const identity = JSON.stringify([subject, date_text, item.lesson_type, comparable(source_fragment)])
    if (seen.has(identity)) throw new Error('У чернетці повторюється однакове завдання. Уточніть повідомлення й підготуйте її ще раз.')
    seen.add(identity)
    const allowedUrls = sourceUrls(body)
    if (allowedUrls.size > 10 || !Array.isArray(item.links) || item.links.length > 10) throw new Error('До одного ДЗ можна додати до 10 посилань. Поділіть повідомлення або додайте їх вручну.')
    const links = new Map<string, { url: string; title: string }>()
    for (const value of item.links) {
      const link = record(value, INVALID_OUTPUT)
      onlyKeys(link, ['url', 'title'], INVALID_OUTPUT)
      const canonical = safeUrl(link.url), title = text(link.title, 80)
      if (!allowedUrls.has(canonical) || !sourceContains(input.source_text, title)) throw new Error(INVALID_OUTPUT)
      if (!links.has(canonical)) links.set(canonical, { url: allowedUrls.get(canonical)!, title })
    }
    for (const [canonical, url] of allowedUrls) if (!links.has(canonical)) links.set(canonical, { url, title: '' })
    return { ...base, links: [...links.values()] }
  })
  return { version: 1, complete: true, general_instructions: general, items, warnings }
}

// Responses strict structured output. No model-generated database identifiers or dates.
export const HOMEWORK_AI_MODEL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['version', 'complete', 'general_instructions', 'items', 'warnings'],
  properties: {
    version: { type: 'integer', enum: [1] }, complete: { type: 'boolean' },
    general_instructions: { type: 'string', description: 'Verbatim common preparation instructions applying to all extracted tasks, or empty. At most 10000 characters.' },
    items: { type: 'array', maxItems: HOMEWORK_AI_ITEM_LIMIT, items: {
      type: 'object', additionalProperties: false,
      required: ['subject', 'lesson_type', 'date_text', 'lesson_topic', 'source_fragment', 'links'],
      properties: {
        subject: { type: 'string', description: 'Copy explicit subject name exactly from source, up to160 characters, or empty if unknown.' },
        lesson_type: { type: ['string', 'null'], enum: ['lecture', 'seminar', 'practical', 'lab', 'other', null] },
        date_text: { type: 'string', description: 'Verbatim date/deadline phrase up to160 characters, e.g завтра, 27 жовтня. Empty if absent. Never calculate a date.' },
        lesson_topic: { type: 'string', description: 'Copy explicit lesson topic exactly from source, up to240 characters, otherwise empty.' },
        source_fragment: { type: 'string', description: 'One complete continuous VERBATIM source block for one assignment, including subject/date heading, all questions, conditions, references and URLs; at most10000characters. Never summarize or answer.' },
        links: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['url', 'title'], properties: {
          url: { type: 'string', description: 'Exact http(s)URL from this task or common instructions. No invented or shortened URLs.' },
          title: { type: 'string', description: 'Exact explicit source label up to80characters, or empty.' },
        } } },
      },
    } },
    warnings: { type: 'array', maxItems: 6, items: { type: 'string', description: 'A Ukrainian clarification or review warning, up to400characters.' } },
  },
} as const

const addDays = (date: string, count: number) => { const value = new Date(date + 'T12:00:00Z'); value.setUTCDate(value.getUTCDate() + count); return value.toISOString().slice(0, 10) }
const dateFrom = (year: number, month: number, day: number) => { const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; return isHomeworkAiDate(value) ? value : null }
const months = [
  ['січня', 'січень', 'января', 'январь'], ['лютого', 'лютий', 'февраля', 'февраль'], ['березня', 'березень', 'марта', 'март'],
  ['квітня', 'квітень', 'апреля', 'апрель'], ['травня', 'травень', 'мая', 'май'], ['червня', 'червень', 'июня', 'июнь'],
  ['липня', 'липень', 'июля', 'июль'], ['серпня', 'серпень', 'августа', 'август'], ['вересня', 'вересень', 'сентября', 'сентябрь'],
  ['жовтня', 'жовтень', 'октября', 'октябрь'], ['листопада', 'листопад', 'ноября', 'ноябрь'], ['грудня', 'грудень', 'декабря', 'декабрь'],
]
const weekdays = [
  /понеділ(?:ок|ка|ку)|понедельник(?:а|у)?/u, /вівтор(?:ок|ка|ку)|вторник(?:а|у)?/u,
  /серед(?:а|у|и)|сред(?:а|у|ы)/u, /четвер(?:г[ау]?)?/u, /п['’ʼ]?ятниц(?:я|ю|і)|пятниц(?:а|у|ы)/u,
  /субот(?:а|у|и)|суббот(?:а|у|ы)/u, /неділ(?:я|ю|і)|воскресень(?:е|я)/u,
]

/** A suggestion only; unknown/range/conflicting hints require an explicit date selection. */
export function suggestHomeworkAiDate(dateText: string, referenceDate: string): string | null {
  if (!isHomeworkAiDate(referenceDate) || typeof dateText !== 'string' || dateText.length > 160) return null
  const hint = dateText.normalize('NFC').toLocaleLowerCase('uk-UA').trim()
  if (!hint || /(?:^|\s)(?:не|ні)\s+(?:завтра|сьогодні|сегодня|післязавтра|послезавтра)/u.test(hint)) return null
  const year = Number(referenceDate.slice(0, 4)), explicit = new Set<string>()
  for (const match of hint.matchAll(/(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/g)) {
    if (!isHomeworkAiDate(match[1])) return null
    explicit.add(match[1])
  }
  for (const match of hint.matchAll(/(?<!\d)(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?(?!\d)/g)) {
    const inferredYear = match[3] ? Number(match[3].length === 2 ? '20' + match[3] : match[3]) : year
    let value = dateFrom(inferredYear, Number(match[2]), Number(match[1]))
    if (!value) return null
    if (!match[3] && referenceDate.slice(5, 7) === '12' && Number(match[2]) === 1) value = dateFrom(year + 1, 1, Number(match[1]))
    if (value) explicit.add(value)
  }
  const monthWords = months.flat().join('|')
  const wordDate = new RegExp(`(?<![\\p{L}\\p{N}])(\\d{1,2})\\s+(${monthWords})(?:\\s+(\\d{4})(?:\\s*р(?:оку)?\\.?)?)?(?![\\p{L}\\p{N}])`, 'gu')
  for (const match of hint.matchAll(wordDate)) {
    const month = months.findIndex(words => words.includes(match[2])) + 1
    let value = dateFrom(match[3] ? Number(match[3]) : year, month, Number(match[1]))
    if (!value) return null
    if (!match[3] && referenceDate.slice(5, 7) === '12' && month === 1) value = dateFrom(year + 1, 1, Number(match[1]))
    if (value) explicit.add(value)
  }
  if (explicit.size > 1) return null
  const weekMatches = weekdays.flatMap((expression, index) => new RegExp(`(?:^|[^\\p{L}])(?:${expression.source})(?=$|[^\\p{L}])`, 'u').test(hint) ? [index + 1] : [])
  if (weekMatches.length > 1) return null
  const relatives = new Set<number>()
  if (/(?:^|[^\p{L}])(?:післязавтра|послезавтра)(?=$|[^\p{L}])/u.test(hint)) relatives.add(2)
  if (/(?:^|[^\p{L}])завтра(?=$|[^\p{L}])/u.test(hint)) relatives.add(1)
  if (/(?:^|[^\p{L}])(?:сьогодні|сегодня)(?=$|[^\p{L}])/u.test(hint)) relatives.add(0)
  if (relatives.size > 1) return null
  const relative = relatives.size ? addDays(referenceDate, [...relatives][0]) : null
  if (explicit.size) {
    const value = [...explicit][0]
    if (relative && relative !== value) return null
    if (weekMatches.length && (new Date(value + 'T12:00:00Z').getUTCDay() || 7) !== weekMatches[0]) return null
    return value
  }
  if (relative) {
    if (weekMatches.length && (new Date(relative + 'T12:00:00Z').getUTCDay() || 7) !== weekMatches[0]) return null
    return relative
  }
  if (weekMatches.length) {
    const current = new Date(referenceDate + 'T12:00:00Z').getUTCDay() || 7
    if (/наступн\S*\s+тижн|следующ\S*\s+недел/u.test(hint)) return addDays(referenceDate, 8 - current + weekMatches[0] - 1)
    let delta = (weekMatches[0] - current + 7) % 7
    if (!delta && /наступн|следующ/u.test(hint)) delta = 7
    return addDays(referenceDate, delta)
  }
  return null
}
