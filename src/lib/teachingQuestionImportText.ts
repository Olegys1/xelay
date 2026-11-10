import type { TeachingTestQuestion, TeachingTestQuestionKind } from './teachingTests'
import { importTeachingQuestions, type TeachingQuestionImportResult } from './teachingQuestionImport.ts'

export type TeachingEasyImportFormat = 'auto' | 'plain' | 'table' | 'gift' | 'moodle_xml'
export const QUESTION_IMPORT_MAX_TEXT = 2 * 1024 * 1024
export const QUESTION_IMPORT_MAX_QUESTIONS = 100
export const QUESTION_IMPORT_TEXT_TEMPLATE = `1. Столиця України?
A) Київ
B) Львів
C) Одеса
D) Дніпро
Відповідь: A
Бали: 2

2. Земля обертається навколо Сонця.
Тип: так/ні
Відповідь: так
Бали: 1

3. Поясніть, що таке попит.
Тип: есе
Бали: 3`
export const QUESTION_IMPORT_TABLE_TEMPLATE = 'Запитання;A;B;C;D;Відповідь;Бали;Тип\nСтолиця України?;Київ;Львів;Одеса;Дніпро;A;2;одна\nОберіть парні числа;2;3;4;5;A,C;2;кілька'
const clean = (value: string) => value.replace(/\u0000/g, '').trim()
const normal = (value: string) => clean(value).normalize('NFKC').toLocaleLowerCase('uk').replace(/[’']/g, "'")
// Plain documents are literal text. React escapes it, including inequalities and angle brackets.
const plain = (value: string) => clean(value)
const base = (kind: TeachingTestQuestionKind, text: string): TeachingTestQuestion => ({ id: crypto.randomUUID(), kind, text: plain(text), points: 1, time_limit_seconds: null, partial_credit: false, options: [], buckets: [] })
const issue = (message: string): never => { throw new Error(message) }
const textLimit = (text: string) => { if (text.length > QUESTION_IMPORT_MAX_TEXT || new TextEncoder().encode(text).length > QUESTION_IMPORT_MAX_TEXT) issue('Текст завеликий. За один раз можна розпізнати до 2 МБ тексту і 100 запитань.') }
const kindAliases: Record<string, TeachingTestQuestionKind> = {
  choice: 'choice', single: 'choice', одна: 'choice', 'одна правильна': 'choice', тест: 'choice',
  multiple: 'multiple', кілька: 'multiple', декілька: 'multiple', 'кілька правильних': 'multiple',
  boolean: 'boolean', truefalse: 'boolean', 'так/ні': 'boolean', 'так або ні': 'boolean',
  short_text: 'short_text', shortanswer: 'short_text', 'коротка відповідь': 'short_text', коротка: 'short_text',
  numerical: 'numerical', числова: 'numerical', число: 'numerical',
  essay: 'essay', есе: 'essay', 'розгорнута відповідь': 'essay', розгорнута: 'essay',
  sequence: 'sequence', послідовність: 'sequence',
}
const resolveKind = (value: string, fallback: TeachingTestQuestionKind): TeachingTestQuestionKind => value ? kindAliases[normal(value)] || issue(`Тип «${value}» не розпізнано. Оберіть тип у попередньому перегляді або скористайтеся шаблоном.`) : fallback
function numeric(value: string, label: string, fallback?: number) {
  if (!value.trim() && fallback !== undefined) return fallback
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(value.trim())) issue(`Поле «${label}» має містити число.`)
  const result = Number(value.replace(',', '.'))
  if (!Number.isFinite(result)) issue(`Перевірте поле «${label}».`)
  return result
}
function answerIds(answer: string, labels: string[], texts: string[]): string[] {
  const tokens = answer.split(/[,;|]/).map(clean).filter(Boolean)
  if (!tokens.length) issue('Не вказано правильну відповідь. Додайте рядок «Відповідь: A» або ключ у таблиці.')
  const ids = tokens.map(token => {
    const label = normal(token.replace(/[.)]$/, ''))
    let index = labels.findIndex(item => normal(item) === label)
    if (index < 0) {
      const matches = texts.flatMap((text, at) => normal(text) === normal(token) ? [at] : [])
      if (matches.length !== 1) issue(`Ключ «${token}» не відповідає одному варіанту. Вкажіть його літеру, наприклад A.`)
      index = matches[0]
    }
    return `a${index + 1}`
  })
  if (new Set(ids).size !== ids.length) issue('Правильні відповіді повторюються. Залиште кожну літеру один раз.')
  return ids
}
function makeQuestion(prompt: string, labels: string[], options: string[], answer: string, type: string, points: string, tolerance = '') {
  const kind = resolveKind(type, options.length ? answer.split(/[,;|]/).filter(value => value.trim()).length > 1 ? 'multiple' : 'choice' : 'short_text')
  const result = base(kind, prompt)
  result.points = numeric(points, 'Бали', 1)
  if (kind === 'essay') {
    if (answer.trim() || options.length) issue('Для есе не потрібно вказувати автоматичний ключ або варіанти. Відповідь перевіряє викладач.')
  } else if (kind === 'boolean') {
    if (options.length) issue('Для так/ні залиште умову, тип і ключ без окремого списку варіантів.')
    const truth = normal(answer)
    result.options = [{ id: 'true', text: 'Так' }, { id: 'false', text: 'Ні' }]
    result.answer = ['так', 'true', 't', 'yes', '1'].includes(truth) ? 'true' : ['ні', 'false', 'f', 'no', '0'].includes(truth) ? 'false' : issue('Для так/ні вкажіть «Відповідь: так» або «Відповідь: ні».')
  } else if (kind === 'short_text') {
    if (options.length) issue('Для короткої відповіді приберіть варіанти і вкажіть допустимі відповіді через | у ключі.')
    result.answer = answer.split('|').map(plain).filter(Boolean)
    result.case_sensitive = false
  } else if (kind === 'numerical') {
    if (options.length) issue('Для числової відповіді приберіть варіанти.')
    result.answer = String(numeric(answer, 'Відповідь'))
    result.tolerance = numeric(tolerance, 'Похибка', 0)
  } else {
    result.options = options.map((text, index) => ({ id: `a${index + 1}`, text: plain(text) }))
    const ids = answerIds(answer, labels, options)
    if (kind === 'choice' && ids.length !== 1) issue('Для одного правильного варіанта ключ має містити одну літеру.')
    if (kind === 'sequence' && (ids.length !== options.length || options.some((_, index) => !ids.includes(`a${index + 1}`)))) issue('Ключ послідовності має містити всі літери у правильному порядку.')
    result.answer = kind === 'choice' ? ids[0] : ids
  }
  const invalid = validateEasyImportedQuestion(result)
  if (invalid) issue(invalid)
  return result
}
/** Revalidate edited previews too; empty/ambiguous answer keys never receive a guessed default. */
export function validateEasyImportedQuestion(item: TeachingTestQuestion): string | null {
  if (!item.text.trim() || item.text.length > 10000) return 'Умова має містити від 1 до 10000 символів.'
  if (!Number.isFinite(item.points) || item.points < 0.01 || item.points > 10000 || Math.abs(item.points * 100 - Math.round(item.points * 100)) > 0.000001) return 'Бали мають бути від 0,01 до 10000 з точністю до сотих.'
  if (item.time_limit_seconds !== null && (!Number.isInteger(item.time_limit_seconds) || item.time_limit_seconds < 1 || item.time_limit_seconds > 86400)) return 'Час запитання має бути від 1 до 86400 секунд або порожнім.'
  if (item.options.length > 30 || item.options.some(option => !option.text.trim() || option.text.length > 2000)) return 'Варіантів має бути не більше 30, кожен від 1 до 2000 символів.'
  if (['choice', 'multiple', 'sequence'].includes(item.kind) && item.options.length < 2) return 'Потрібні щонайменше два варіанти відповіді.'
  const optionIds = item.options.map(option => option.id)
  if (['choice', 'boolean'].includes(item.kind) && (typeof item.answer !== 'string' || !optionIds.includes(item.answer))) return 'Оберіть правильну відповідь.'
  if (['multiple', 'sequence'].includes(item.kind) && (!Array.isArray(item.answer) || !item.answer.length || new Set(item.answer).size !== item.answer.length || item.answer.some(id => !optionIds.includes(id)))) return 'Перевірте правильні відповіді.'
  if (item.kind === 'sequence' && (item.answer as string[]).length !== optionIds.length) return 'Послідовність має містити всі елементи.'
  if (item.kind === 'short_text' && (!Array.isArray(item.answer) || !item.answer.length || item.answer.some(value => !value.trim() || value.length > 2000))) return 'Вкажіть щонайменше одну допустиму коротку відповідь.'
  if (item.kind === 'numerical' && (typeof item.answer !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(item.answer) || !Number.isFinite(Number(item.answer)) || Math.abs(Number(item.answer)) > 1e12 || !Number.isFinite(item.tolerance) || item.tolerance! < 0 || item.tolerance! > 1e9)) return 'Перевірте числову відповідь і допустиму похибку.'
  if (item.kind === 'sorting' && (item.buckets.length < 2 || item.buckets.length > 10 || item.options.some(option => !item.buckets.some(bucket => bucket.id === (item.answer as Record<string,string>)?.[option.id])))) return 'Призначте категорію кожному елементу.'
  if (item.kind === 'cloze' && (!item.gaps?.length || item.gaps.length > 20 || new Set(item.gaps.map(gap => gap.id)).size !== item.gaps.length || item.gaps.some(gap => !/^[A-Za-z0-9_-]{1,32}$/.test(gap.id) || !item.text.includes(`{{${gap.id}}}`) || !gap.answers.length || gap.answers.some(value => !value.trim() || value.length > 2000)))) return 'Перевірте унікальні позначки пропусків у тексті та допустимі відповіді.'
  if (item.kind === 'calculated' && (!item.calculation?.formula.trim() || item.calculation.formula.length > 500 || !item.calculation.variables.length || item.calculation.variables.length > 8 || new Set(item.calculation.variables.map(variable => variable.name)).size !== item.calculation.variables.length || item.calculation.variables.some(variable => !/^[a-zA-Z][a-zA-Z0-9_]{0,15}$/.test(variable.name) || ![variable.min,variable.max,variable.step].every(Number.isFinite) || variable.max < variable.min || variable.step <= 0))) return 'Перевірте формулу, унікальні назви змінних і діапазони чисел.'
  return null
}

const plainQuestionMetadata = /^(ANSWER|Відповідь|Правильна відповідь|Тип|Бали|Points|Похибка|Tolerance)\s*:\s*(.*)$/i
const plainQuestionOption = /^([A-Za-zА-Яа-яІіЇїЄєҐґ])[.)]\s+(.+)$/u
const colonQuestionOption = /^([A-Za-zА-Яа-яІіЇїЄєҐґ]):\s*(.+)$/u
const plainOptionKinds: readonly TeachingTestQuestionKind[] = ['choice', 'multiple', 'sequence']

function plainQuestions(text: string): TeachingQuestionImportResult {
  const result: TeachingQuestionImportResult = { questions: [], issues: [] }
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: { lines: string[]; line: number }[] = []
  let current: string[] = [], start = 1, separated = false, hasKeyOrType = false, awaitingOptions = false
  const finish = () => {
    if (current.length) blocks.push({ lines: current, line: start })
    current = []
    hasKeyOrType = false
    awaitingOptions = false
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line) { separated = true; continue }
    const metadata = line.match(plainQuestionMetadata)
    // Word inserts blank lines between fields of the same question.
    const continuesOptions = awaitingOptions && (plainQuestionOption.test(line) || colonQuestionOption.test(line))
    if (/^\d+[.)]\s+\S/.test(line) || (separated && hasKeyOrType && !metadata && !continuesOptions)) finish()
    if (!current.length) start = index + 1
    current.push(line)
    if (metadata && /^(?:ANSWER|Відповідь|Правильна відповідь|Тип)$/i.test(metadata[1])) {
      awaitingOptions = !hasKeyOrType && normal(metadata[1]) === 'тип' && plainOptionKinds.includes(kindAliases[normal(metadata[2])])
      hasKeyOrType = true
    }
    separated = false
  }
  finish()
  for (const block of blocks) {
    try {
      if (result.questions.length >= QUESTION_IMPORT_MAX_QUESTIONS) issue('За один імпорт можна додати до 100 запитань. Розділіть файл.')
      let answer = '', type = '', points = '', tolerance = ''
      const labels: string[] = [], options: string[] = [], prompt: string[] = []
      let hasOptions = false
      const explicitType = block.lines.find(line => /^Тип\s*:/i.test(line))?.match(plainQuestionMetadata)?.[2]
      const colonOptions = block.lines.slice(1).filter(line => colonQuestionOption.test(line))
      // Keep existing multiline options intact. Infer an untyped colon list
      // only when its labels start at A or А.
      const allowColonOptions = !block.lines.some(line => plainQuestionOption.test(line)) && colonOptions.length > 1
        && (explicitType ? plainOptionKinds.includes(kindAliases[normal(explicitType)]) : /^[AА]:/iu.test(colonOptions[0]))
      for (const line of block.lines) {
        const metadata = line.match(plainQuestionMetadata)
        if (metadata) {
          const name = normal(metadata[1]), content = metadata[2]
          if (['answer', 'відповідь', 'правильна відповідь'].includes(name)) { if (answer) issue('Ключ відповіді вказано двічі.'); answer = content }
          else if (name === 'тип') { if (type) issue('Тип запитання вказано двічі.'); type = content }
          else if (['бали', 'points'].includes(name)) { if (points) issue('Бали вказано двічі.'); points = content }
          else tolerance = content
          continue
        }
        const option = line.match(plainQuestionOption) || (allowColonOptions && prompt.length ? line.match(colonQuestionOption) : null)
        if (option) {
          if (!prompt.length) issue('Перед варіантами потрібен текст запитання.')
          if (labels.some(label => normal(label) === normal(option[1]))) issue('Літери варіантів повторюються.')
          labels.push(option[1]); options.push(option[2]); hasOptions = true
        } else if (hasOptions) {
          if (/^\d+[.)]\s/.test(line)) issue('Варіанти позначайте літерами A), B), C).')
          options[options.length - 1] += '\n' + line
        } else prompt.push(line.replace(/^\d+[.)]\s+/, ''))
      }
      if (!answer && !type) issue('Не знайдено ключа. Додайте «Відповідь: A». Для відкритого питання явно вкажіть «Тип: есе».')
      const item = makeQuestion(prompt.join('\n'), labels, options, answer, type, points, tolerance)
      result.questions.push(item)
    } catch (failure) { result.issues.push({ line: block.line, message: (failure as Error).message }) }
  }
  if (!blocks.length) result.issues.push({ message: 'Текст порожній. Додайте запитання за прикладом.' })
  return result
}

/** Strict CSV/TSV reader. Quoting is parsed without executing spreadsheet formulas. */
export function parseQuestionTable(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0]
  const separator = first.includes('\t') ? '\t' : first.split(';').length > first.split(',').length ? ';' : ','
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false, afterQuote = false
  const pushCell = () => { row.push(cell); cell = ''; afterQuote = false; if (row.length > 36) issue('У таблиці забагато колонок. Використайте шаблон імпорту.') }
  const pushRow = () => { pushCell(); if (row.some(value => value.trim())) rows.push(row); row = []; if (rows.length > 101) issue('У таблиці має бути заголовок і щонайбільше 100 запитань.') }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"') { if (text[index + 1] === '"') { cell += '"'; index++ } else { quoted = false; afterQuote = true } } else cell += char
    } else if (char === separator) pushCell()
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[index + 1] === '\n') index++; pushRow() }
    else if (char === '"' && !cell.length && !afterQuote) quoted = true
    else { if (afterQuote && char.trim()) issue('Пошкоджені лапки у CSV. Збережіть файл ще раз або вставте TSV з таблиці.'); if (!afterQuote) cell += char }
    if (cell.length > 20000) issue('Одна клітинка завелика. Розділіть умову і варіанти за шаблоном.')
  }
  if (quoted) issue('У CSV не закрито лапки.')
  if (cell || row.length) pushRow()
  return rows
}
export function questionTableToText(rows: string[][]): string { return rows.map(row => row.map(cell => '"' + cell.replace(/"/g, '""') + '"').join('\t')).join('\n') }
function tableQuestions(text: string): TeachingQuestionImportResult {
  const result: TeachingQuestionImportResult = { questions: [], issues: [] }
  const rows = parseQuestionTable(text)
  if (rows.length < 2) issue('Таблиця має містити заголовок і хоча б одне запитання.')
  const headers = rows[0].map(normal)
  const column = (aliases: string[]) => headers.findIndex(header => aliases.includes(header))
  const promptColumn = column(['запитання', 'питання', 'question', 'prompt', 'умова'])
  const answerColumn = column(['відповідь', 'правильна відповідь', 'answer', 'correct', 'correct answer', 'ключ'])
  const pointsColumn = column(['бали', 'points', 'score']), kindColumn = column(['тип', 'type', 'kind']), toleranceColumn = column(['похибка', 'tolerance'])
  if (promptColumn < 0) issue('Не знайдено колонки «Запитання». Завантажте шаблон таблиці і перенесіть дані в нього.')
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) issue('Назви колонок повторюються. Залиште один заголовок для кожної колонки.')
  const optionColumns = headers.flatMap((header, index) => /^[a-z]$/.test(header) || /^варіант\s+[a-z]$/.test(header) ? [{ index, label: header.slice(-1).toUpperCase() }] : [])
  if (new Set(optionColumns.map(item => normal(item.label))).size !== optionColumns.length) issue('Позначки варіантів повторюються. Не використовуйте одночасно A і «Варіант A».')
  const knownColumns = new Set([promptColumn, answerColumn, pointsColumn, kindColumn, toleranceColumn, ...optionColumns.map(item => item.index)])
  const unsupported = headers.filter((_, index) => !knownColumns.has(index) && rows.slice(1).some(row => row[index]?.trim()))
  if (unsupported.length) issue(`Колонки «${unsupported.join('», «')}» не підтримуються. Перенесіть потрібний текст у колонки шаблону, щоб нічого не загубити.`)
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]
    try {
      if (row.length > headers.length && row.slice(headers.length).some(value => value.trim())) issue('У рядку більше клітинок, ніж заголовків.')
      const options = optionColumns.filter(item => clean(row[item.index] || ''))
      const item = makeQuestion(row[promptColumn] || '', options.map(item => item.label), options.map(item => row[item.index]), answerColumn < 0 ? '' : row[answerColumn] || '', kindColumn < 0 ? '' : row[kindColumn] || '', pointsColumn < 0 ? '' : row[pointsColumn] || '', toleranceColumn < 0 ? '' : row[toleranceColumn] || '')
      result.questions.push(item)
    } catch (failure) { result.issues.push({ line: index + 1, message: (failure as Error).message }) }
  }
  return result
}
export function detectTeachingQuestionFormat(text: string): Exclude<TeachingEasyImportFormat, 'auto'> {
  const cleaned = text.replace(/^\uFEFF/, '').trim()
  if (/^(?:<\?xml[^>]*>\s*)?<quiz[\s>]|<!DOCTYPE|<!ENTITY/i.test(cleaned)) return 'moodle_xml'
  const first = cleaned.split(/\r?\n/, 1)[0].toLocaleLowerCase('uk')
  if (/запитання|питання|question|prompt|умова/.test(first) && /\t|;|,/.test(first)) return 'table'
  if (/^\s*(?:\$CATEGORY:|::[^\n]*::)/im.test(cleaned)) return 'gift'
  const opening = cleaned.indexOf('{')
  if (opening >= 0) {
    const closing = cleaned.indexOf('}', opening + 1)
    const body = cleaned.slice(opening + 1, closing < 0 ? undefined : closing)
    if (!body.trim() || /[=~#]|TRUE|FALSE/.test(body)) return 'gift'
  }
  return 'plain'
}
export function importTeachingQuestionsEasy(text: string, format: TeachingEasyImportFormat = 'auto'): TeachingQuestionImportResult {
  try {
    if (!text.trim()) issue('Спочатку додайте файл або вставте текст.')
    textLimit(text)
    if (text.includes('\u0000')) issue('Файл не схожий на текст. Оберіть DOCX, PDF, XLSX або збережіть текст як UTF-8.')
    const resolved = format === 'auto' ? detectTeachingQuestionFormat(text) : format
    if (resolved === 'gift' || resolved === 'moodle_xml') return importTeachingQuestions(text, resolved)
    return resolved === 'table' ? tableQuestions(text) : plainQuestions(text)
  } catch (failure) { return { questions: [], issues: [{ message: (failure as Error).message }] } }
}
