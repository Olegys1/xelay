import type { TeachingTestQuestion } from './teachingTests'

export type TeachingQuestionImportIssue = { message: string; line?: number; question?: string }
export type TeachingQuestionImportResult = { questions: TeachingTestQuestion[]; issues: TeachingQuestionImportIssue[]; inferredTypes?: string[] }
type XmlNode = { name: string; attributes: Record<string, string>; children: XmlNode[]; content: (string | XmlNode)[] }
const MAX_LENGTH = 2 * 1024 * 1024
const MAX_QUESTIONS = 100
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, code: string) => {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  if (code[0] !== '#') return named[code.toLowerCase()] || all
  const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
  return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : ''
})
function plain(text: string) {
  // Imported markup is never rendered. Remove real paired/void tags while
  // preserving literal comparisons such as "x < 5, y > 3" or "a < b > c".
  const paired = new Set(Array.from(text.matchAll(/<\/\s*([a-z][\w:-]*)\s*>/gi), match => match[1].toLowerCase()))
  const tokens = /<\/?([a-z][\w:-]*)(?:\s[^<>]*)?\s*\/?>/gi
  const pieces: string[] = []
  let start = 0, suppressed: string | null = null
  for (const match of text.matchAll(tokens)) {
    const tag = match[1].toLowerCase(), closing = match[0].startsWith('</')
    if (!suppressed) pieces.push(text.slice(start, match.index))
    if (suppressed) { if (closing && tag === suppressed) suppressed = null }
    else if (!closing && ['script', 'style'].includes(tag)) suppressed = tag
    else if (tag === 'br' || closing && ['p', 'div'].includes(tag)) pieces.push('\n')
    else if (!paired.has(tag) && !['img', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'base', 'embed', 'param', 'track', 'col'].includes(tag)) pieces.push(match[0])
    start = match.index + match[0].length
  }
  if (!suppressed) pieces.push(text.slice(start))
  return decode(pieces.join('')).trim()
}
function question(kind: TeachingTestQuestion['kind'], text: string, fields: Partial<TeachingTestQuestion>): TeachingTestQuestion {
  return { id: crypto.randomUUID(), kind, text: text.trim(), points: 1, time_limit_seconds: null, partial_credit: false, options: [], buckets: [], ...fields }
}
function decimal(number: number): string {
  const string = String(number)
  if (!/[eE]/.test(string)) return string
  const [mantissa, exponent] = string.split(/[eE]/), sign = mantissa.startsWith('-') ? '-' : ''
  const unsigned = mantissa.replace(/^-/, ''), digits = unsigned.replace('.', ''), position = (unsigned.indexOf('.') < 0 ? unsigned.length : unsigned.indexOf('.')) + Number(exponent)
  return sign + (position <= 0 ? '0.' + '0'.repeat(-position) + digits : position >= digits.length ? digits + '0'.repeat(position - digits.length) : digits.slice(0, position) + '.' + digits.slice(position))
}
function* scanXmlTokens(text: string): Generator<string> {
  let at = 0, count = 0
  while (at < text.length) {
    if (++count > 50000) throw new Error('XML містить забагато елементів.')
    const start = at
    if (text[at] !== '<') {
      const next = text.indexOf('<', at); at = next < 0 ? text.length : next
    } else {
      const ending = text.startsWith('<!--', at) ? '-->' : text.startsWith('<![CDATA[', at) ? ']]>' : text.startsWith('<?', at) ? '?>' : null
      if (ending) {
        const next = text.indexOf(ending, at + (ending === ']]>' ? 9 : ending === '-->' ? 4 : 2))
        if (next < 0) throw new Error('XML обірваний: не закрито коментар, CDATA або інструкцію.')
        at = next + ending.length
      } else {
        let quote = '', closed = false
        for (at++; at < text.length; at++) {
          const char = text[at]
          if (char === '<') throw new Error('Пошкоджена структура XML: перед наступним тегом бракує закривної дужки.')
          if (quote) { if (char === quote) quote = '' }
          else if (char === '"' || char === "'") quote = char
          else if (char === '>') { at++; closed = true; break }
        }
        if (!closed) throw new Error('XML обірваний: тег не закрито.')
      }
    }
    yield text.slice(start, at)
  }
}
function parseXml(text: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML із зовнішніми сутностями або DTD не підтримується.')
  const root: XmlNode = { name: '#root', attributes: {}, children: [], content: [] }
  const stack = [root]
  for (const token of scanXmlTokens(text)) {
    const current = stack[stack.length - 1]
    if (token.startsWith('<!--') || token.startsWith('<?')) continue
    if (token.startsWith('<![CDATA[')) { current.content.push(token.slice(9, -3)); continue }
    if (token.startsWith('</')) {
      if (stack.length < 2 || token.slice(2, -1).trim() !== current.name) throw new Error('Пошкоджена структура XML: теги не збігаються.')
      stack.pop(); continue
    }
    if (token.startsWith('<')) {
      const match = token.match(/^<([A-Za-z_][\w:.-]*)([\s\S]*?)\/?\s*>$/)
      if (!match) throw new Error('Не вдалося прочитати тег XML.')
      const attributes: Record<string, string> = Object.create(null)
      const attribute = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y
      let position = 0
      while (position < match[2].length) {
        while (position < match[2].length && /\s/.test(match[2][position])) position++
        if (position === match[2].length) break
        attribute.lastIndex = position
        const item = attribute.exec(match[2])
        if (!item || Object.prototype.hasOwnProperty.call(attributes, item[1])) throw new Error('Пошкоджені або повторювані атрибути XML.')
        attributes[item[1]] = decode(item[2] ?? item[3]); position = attribute.lastIndex
      }
      const child: XmlNode = { name: match[1], attributes, children: [], content: [] }
      current.children.push(child); current.content.push(child)
      if (!/\/\s*>$/.test(token)) stack.push(child)
      if (stack.length > 32) throw new Error('XML має надмірну вкладеність.')
    } else current.content.push(decode(token))
  }
  if (stack.length !== 1) throw new Error('XML обірваний: є незакриті теги.')
  if (root.children.length !== 1 || root.children[0].name !== 'quiz') throw new Error('Оберіть Moodle XML із кореневим елементом quiz.')
  return root.children[0]
}
function xmlText(node?: XmlNode): string { return node?.content.map(item => typeof item === 'string' ? item : xmlText(item)).join('') || '' }
function child(node: XmlNode, name: string) { return node.children.find(item => item.name === name) }
function value(node: XmlNode, name: string) { return xmlText(child(node, name)) }
function xmlQuestions(text: string, result: TeachingQuestionImportResult) {
  const quiz = parseXml(text)
  for (const node of quiz.children.filter(item => item.name === 'question')) {
    if (node.attributes.type === 'category') continue
    const title = plain(value(node, 'name')) || `Запитання ${result.questions.length + result.issues.length + 1}`
    try {
      if (result.questions.length >= MAX_QUESTIONS) throw new Error('За один імпорт можна додати до 100 запитань.')
      if (node.children.some(item => item.name === 'file') || child(node, 'questiontext')?.children.some(item => item.name === 'file') || value(node, 'questiontext').includes('@@PLUGINFILE@@')) throw new Error('Запитання містить вкладення. Додайте його вручну: файли з XML не імпортуються.')
      const prompt = plain(value(node, 'questiontext'))
      const answers = node.children.filter(item => item.name === 'answer')
      const answerText = (item: XmlNode) => plain(value(item, 'text'))
      const fraction = (item: XmlNode) => Number(item.attributes.fraction || '0')
      const options = answers.map((item, index) => ({ id: `a${index + 1}`, text: answerText(item) }))
      const positive = answers.flatMap((item, index) => fraction(item) > 0 ? [options[index].id] : [])
      let item: TeachingTestQuestion
      switch (node.attributes.type) {
        case 'multichoice': {
          const single = value(node, 'single').trim().toLowerCase() !== 'false' && value(node, 'single').trim() !== '0'
          if (single && (positive.length !== 1 || fraction(answers[options.findIndex(option => option.id === positive[0])]) !== 100)) throw new Error('Часткові ваги одиночних відповідей потребують ручного перенесення.')
          if (!single && (answers.some(answer => fraction(answer) < 0) || new Set(answers.filter(answer => fraction(answer) > 0).map(fraction)).size > 1)) throw new Error('Нерівні ваги або штрафи за варіанти потребують ручного перенесення, щоб зберегти правила оцінювання.')
          item = question(single ? 'choice' : 'multiple', prompt, { options, answer: single ? positive[0] : positive }); break
        }
        case 'truefalse': {
          if (positive.length !== 1) throw new Error('Потрібна одна правильна відповідь так/ні.')
          const correct = answerText(answers[options.findIndex(option => option.id === positive[0])]).toLowerCase()
          if (!['true', 'false'].includes(correct)) throw new Error('Невідоме значення відповіді так/ні.')
          item = question('boolean', prompt, { options: [{ id: 'true', text: 'Так' }, { id: 'false', text: 'Ні' }], answer: correct }); break
        }
        case 'shortanswer': {
          if (answers.some(answer => fraction(answer) > 0 && fraction(answer) !== 100)) throw new Error('Часткові ваги текстових відповідей потребують ручного перенесення.')
          item = question('short_text', prompt, { answer: answers.filter(answer => fraction(answer) === 100).map(answerText), case_sensitive: value(node, 'usecase').trim() === '1' }); break
        }
        case 'numerical': {
          const correct = answers.filter(answer => fraction(answer) === 100)
          if (correct.length !== 1 || child(node, 'units')?.children.length) throw new Error('Імпорт числового питання підтримує одну відповідь без одиниць вимірювання.')
          const number = Number(answerText(correct[0])), tolerance = Number(value(correct[0], 'tolerance') || '0')
          if (!Number.isFinite(number) || !Number.isFinite(tolerance) || tolerance < 0) throw new Error('Некоректна числова відповідь або похибка.')
          item = question('numerical', prompt, { answer: decimal(number), tolerance }); break
        }
        case 'essay': item = question('essay', prompt, {}); break
        case 'matching': {
          const pairs = node.children.filter(item => item.name === 'subquestion').map(item => ({ text: plain(value(item, 'text')), answer: plain(xmlText(child(child(item, 'answer') || item, 'text'))) }))
          const labels = [...new Set(pairs.map(pair => pair.answer))]
          const buckets = labels.map((label, index) => ({ id: `b${index + 1}`, text: label }))
          item = question('sorting', prompt, { options: pairs.map((pair, index) => ({ id: `a${index + 1}`, text: pair.text })), buckets, answer: Object.fromEntries(pairs.map((pair, index) => [`a${index + 1}`, buckets[labels.indexOf(pair.answer)].id])) }); break
        }
        case 'multianswer': item = parseCloze(prompt); break
        default: throw new Error(`Тип «${node.attributes.type || 'невідомий'}» не підтримується цим імпортом. Створіть його вручну.`)
      }
      const points = Number(value(node, 'defaultgrade') || '1')
      if (!Number.isFinite(points) || points <= 0 || points > 10000 || Math.abs(Math.round(points * 100) - points * 100) > 0.000001) throw new Error('Вага запитання має бути від 0,01 до 10000 з точністю до сотих.')
      item.points = points
      checkQuestion(item)
      result.questions.push(item)
    } catch (error) { result.issues.push({ question: title, message: (error as Error).message }) }
  }
}
function unescapeGift(text: string) { return text.replace(/\\([~=#{}:\\])/g, '$1').trim() }
function splitAnswers(text: string) {
  const parts: { marker: string; text: string; weight?: number }[] = []
  let marker = '', start = 0
  const add = (end: number) => {
    if (parts.length >= 60) throw new Error('У блоці GIFT забагато відповідей. Залиште до 30 варіантів або допустимих відповідей.')
    let body = text.slice(start, end).trim(), weight: number | undefined
    const percent = body.match(/^%(-?(?:\d+(?:\.\d*)?|\.\d+))%/)
    if (body.startsWith('%') && !percent) throw new Error('Не вдалося прочитати вагу відповіді GIFT.')
    if (percent) { weight = Number(percent[1]); body = body.slice(percent[0].length) }
    // A zero weight must never become a correct answer just because of '='.
    if (marker === '=' && weight === 0) throw new Error('Ключ «=» суперечить нульовій вазі відповіді GIFT. Виправте ключ і вагу перед імпортом.')
    let feedback = body.length
    for (let index = 0; index < body.length; index++) {
      if (body[index] === '\\') { index++; continue }
      if (body[index] === '#') { feedback = index; break }
    }
    parts.push({ marker, text: unescapeGift(body.slice(0, feedback)), weight })
  }
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue }
    if (text[index] !== '=' && text[index] !== '~') continue
    if (marker) add(index)
    else if (text.slice(0, index).trim()) throw new Error('Частину блоку відповідей GIFT не розпізнано.')
    marker = text[index]; start = index + 1
  }
  if (marker) add(text.length)
  return parts
}
const correctGiftAnswer = (answer: { marker: string; weight?: number }) => answer.weight === undefined ? answer.marker === '=' : answer.weight === 100
function parseCloze(source: string): TeachingTestQuestion {
  const gaps: { id: string; answers: string[] }[] = []
  const prompt = source.replace(/\{(\d+):(SHORTANSWER|SA|SHORTANSWER_C|SAC):([^{}]+)\}/gi, (_, weight: string, kind: string, body: string) => {
    if (gaps.length >= 20) throw new Error('В одному запитанні можна імпортувати до 20 пропусків.')
    if (Number(weight) !== 1) throw new Error('Для пропусків підтримується однакова вага. Нерівні ваги перенесіть вручну.')
    if (kind.toUpperCase().endsWith('_C') || kind.toUpperCase() === 'SAC') throw new Error('Пропуски з урахуванням регістру перенесіть вручну.')
    const answers = splitAnswers(body)
    if (answers.some(answer => answer.weight !== undefined && answer.weight !== 100 && answer.weight !== 0)) throw new Error('Зважені варіанти пропуску перенесіть вручну.')
    const correct = answers.filter(correctGiftAnswer).map(answer => answer.text)
    if (!correct.length) throw new Error('У пропуску не знайдено правильної відповіді.')
    if (correct.length > 30 || correct.some(answer => !answer || answer.length > 2000)) throw new Error('У пропуску потрібно від 1 до 30 допустимих відповідей, кожна до 2000 символів.')
    const id = `gap${gaps.length + 1}`; gaps.push({ id, answers: correct }); return `{{${id}}}`
  })
  if (!gaps.length || /\{\d+:[^{}]+\}/.test(prompt)) throw new Error('Підтримуються текстові пропуски SHORTANSWER з однаковою вагою.')
  return question('cloze', prompt, { gaps, answer: Object.fromEntries(gaps.map(gap => [gap.id, gap.answers[0]])), partial_credit: true })
}
type GiftBlock = { prefix: string; body: string; line: number }
/** One pass, including malformed input. Never retry a multiline regex at every line. */
function scanGiftBlocks(text: string, result: TeachingQuestionImportResult): GiftBlock[] {
  const blocks: GiftBlock[] = []
  let start = 0, open = -1, line = 1, startLine = 1
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') { if (text[index + 1] === '\n') line++; index++; continue }
    if (char === '\n') { line++; continue }
    if (char === '{') {
      if (open >= 0) throw new Error(`Рядок ${line}: вкладені блоки GIFT не підтримуються. Перевірте фігурні дужки.`)
      open = index
    } else if (char === '}') {
      if (open < 0) throw new Error(`Рядок ${line}: знайдено закривну дужку GIFT без початкової.`)
      blocks.push({ prefix: text.slice(start, open), body: text.slice(open + 1, index), line: startLine })
      // Keep the accepted 100-question preview and one explicit limit issue;
      // do not allocate an issue for every extra tiny block in a large file.
      if (blocks.length > MAX_QUESTIONS) { result.issues.push({ line, message: 'За один імпорт можна додати до 100 запитань. Решту не розбирали; розділіть файл.' }); return blocks.slice(0, MAX_QUESTIONS) }
      const newline = text.indexOf('\n', index + 1), end = newline < 0 ? text.length : newline
      if (text.slice(index + 1, end).trim()) throw new Error(`Рядок ${line}: текст після відповідей GIFT потребує ручного перенесення. Він не буде втрачений мовчки.`)
      open = -1; start = end + 1; startLine = line + 1; index = end
      if (newline >= 0) line++
    }
  }
  if (open >= 0) throw new Error(`Рядок ${line}: блок відповідей GIFT не закрито.`)
  if (text.slice(start).trim()) result.issues.push({ line: startLine, message: 'Частину GIFT не розпізнано. Перевірте фігурні дужки та непідтримувані блоки; вони не додані до списку.' })
  return blocks
}
function giftQuestions(text: string, result: TeachingQuestionImportResult) {
  const cleaned = text.replace(/^[\t ]*\/\/[^\n]*$/gm, '').replace(/^[\t ]*\$CATEGORY:[^\n]*$/gm, '')
  const blocks = scanGiftBlocks(cleaned, result)
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index], line = block.line
    let title = `Запитання ${index + 1}`
    try {
      if (result.questions.length >= MAX_QUESTIONS) throw new Error('За один імпорт можна додати до 100 запитань.')
      let prefix = block.prefix.trim()
      if (prefix.startsWith('::')) {
        const end = prefix.indexOf('::', 2)
        if (end < 0 || prefix.slice(2, end).includes('\n')) throw new Error('Не вдалося прочитати назву запитання GIFT.')
        title = unescapeGift(prefix.slice(2, end)) || title; prefix = prefix.slice(end + 2).trimStart()
      }
      const marker = prefix.match(/^\[(html|plain|markdown|moodle)\]/i)
      const convert = marker && ['plain', 'markdown'].includes(marker[1].toLowerCase()) ? (value: string) => value.trim() : plain
      const text = convert(unescapeGift(marker ? prefix.slice(marker[0].length) : prefix))
      const body = block.body.trim()
      let item: TeachingTestQuestion
      if (/^(?:TRUE|FALSE|T|F)(?:\s*#.*)?$/is.test(body)) {
        item = question('boolean', text, { options: [{ id: 'true', text: 'Так' }, { id: 'false', text: 'Ні' }], answer: /^T/i.test(body) ? 'true' : 'false' })
      } else if (body.startsWith('#')) {
        const numeric = body.slice(1).split(/(?<!\\)#/)[0].trim().match(/^=?\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:\s*:\s*(\d+(?:\.\d*)?))?\s*$/i)
        if (!numeric || !Number.isFinite(Number(numeric[1]))) throw new Error('Для числового питання підтримується одна відповідь і необов’язкова похибка через двокрапку.')
        item = question('numerical', text, { answer: decimal(Number(numeric[1])), tolerance: Number(numeric[2] || 0) })
      } else if (!body) item = question('essay', text, {})
      else {
        const answers = splitAnswers(body)
        if (!answers.length) throw new Error('Не знайдено варіантів відповіді.')
        if (answers.some(answer => answer.weight !== undefined && answer.weight !== 100 && answer.weight !== 0)) throw new Error('Зважені відповіді GIFT перенесіть вручну, щоб не змінити правила оцінювання.')
        if (answers.every(answer => answer.marker === '=' && answer.text.includes('->'))) {
          const pairs = answers.map(answer => { const [left, ...right] = answer.text.split('->'); return { text: convert(left), answer: convert(right.join('->')) } })
          const labels = [...new Set(pairs.map(pair => pair.answer))], buckets = labels.map((label, index) => ({ id: `b${index + 1}`, text: label }))
          item = question('sorting', text, { options: pairs.map((pair, index) => ({ id: `a${index + 1}`, text: pair.text })), buckets, answer: Object.fromEntries(pairs.map((pair, index) => [`a${index + 1}`, buckets[labels.indexOf(pair.answer)].id])) })
        } else if (answers.every(answer => answer.marker === '=')) item = question('short_text', text, { answer: answers.map(answer => convert(answer.text)), case_sensitive: false })
        else {
          const options = answers.map((answer, index) => ({ id: `a${index + 1}`, text: convert(answer.text) }))
          const correct = answers.flatMap((answer, index) => correctGiftAnswer(answer) ? [options[index].id] : [])
          item = question(correct.length === 1 ? 'choice' : 'multiple', text, { options, answer: correct.length === 1 ? correct[0] : correct })
        }
      }
      checkQuestion(item); result.questions.push(item)
    } catch (error) { result.issues.push({ line, question: title, message: (error as Error).message }) }
  }
  if (!blocks.length && !result.issues.length) result.issues.push({ message: 'Не знайдено запитань GIFT. Приклад: Столиця України? {=Київ ~Львів ~Одеса ~Дніпро}' })
}
function checkQuestion(item: TeachingTestQuestion) {
  if (!item.text || item.text.length > 10000) throw new Error('Текст запитання має містити від 1 до 10000 символів.')
  if (item.options.length > 30 || item.options.some(option => !option.text || option.text.length > 2000)) throw new Error('Перевірте варіанти: до 30, кожен до 2000 символів.')
  if (['choice', 'multiple'].includes(item.kind) && item.options.length < 2) throw new Error('Додайте щонайменше два варіанти відповіді.')
  if (item.kind === 'choice' && !item.answer || item.kind === 'multiple' && !(item.answer as string[]).length) throw new Error('Не знайдено правильної відповіді.')
  if (item.kind === 'short_text' && (!(item.answer as string[]).length || (item.answer as string[]).length > 30 || (item.answer as string[]).some(answer => !answer || answer.length > 2000 || answer.includes('*')))) throw new Error('Потрібно від 1 до 30 непорожніх текстових відповідей до 2000 символів; шаблони зі зірочкою не підтримуються.')
  if (item.kind === 'numerical' && (Math.abs(Number(item.answer)) > 1e12 || !Number.isFinite(item.tolerance) || item.tolerance! > 1e9)) throw new Error('Числова відповідь має бути в межах ±10¹², похибка від 0 до 10⁹.')
  if (item.kind === 'sorting' && (item.buckets.length < 2 || item.buckets.length > 10 || item.buckets.some(bucket => !bucket.text))) throw new Error('Для відповідності потрібні від 2 до 10 непорожніх категорій.')
}

/** Parses locally. Never evaluates imported HTML, formulas, scripts or XML entities. */
export function importTeachingQuestions(text: string, format: 'gift' | 'moodle_xml'): TeachingQuestionImportResult {
  const result: TeachingQuestionImportResult = { questions: [], issues: [] }
  try {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Файл порожній.')
    if (text.length > MAX_LENGTH || new TextEncoder().encode(text).length > MAX_LENGTH) throw new Error('Для імпорту оберіть текстовий файл до 2 МБ.')
    if (format === 'moodle_xml') xmlQuestions(text, result)
    else if (format === 'gift') giftQuestions(text, result)
    else throw new Error('Оберіть формат GIFT або Moodle XML.')
    if (!result.questions.length && !result.issues.length) result.issues.push({ message: 'У файлі немає підтримуваних запитань.' })
  } catch (error) { result.questions = []; result.issues.push({ message: (error as Error).message }) }
  return result
}
