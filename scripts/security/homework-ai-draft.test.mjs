import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(await readFile(new URL('../../src/lib/homeworkAiDraft.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module, exports: module.exports, URL })
const core = module.exports
const first = 'Вища математика. На вівторок. Похідні. Розв’язати вправи 1–5, крім № 3. Матеріали: https://example.org/math.pdf'
const second = 'Економічна теорія. На четвер. Ринкова рівновага. Прочитати розділ 3 та підготувати власний приклад.'
const input = { source_text: first + '\n\n' + second, reference_date: '2026-10-25' }
const item = (changes = {}) => ({ subject: 'Вища математика', lesson_type: null, date_text: 'На вівторок', lesson_topic: 'Похідні', source_fragment: first, links: [{ url: 'https://example.org/math.pdf', title: 'Матеріали' }], ...changes })
const draft = (changes = {}) => ({ version: 1, complete: true, general_instructions: '', items: [item()], warnings: [], ...changes })
const plain = value => JSON.parse(JSON.stringify(value))

test('full source wording, exceptions, links and separate homework blocks survive normalization', () => {
  const result = core.normalizeHomeworkAiDraft(draft({ items: [item(), item({ subject: 'Економічна теорія', lesson_type: 'seminar', date_text: 'На четвер', lesson_topic: 'Ринкова рівновага', source_fragment: second, links: [] })] }), input)
  assert.equal(result.items.length, 2)
  assert.equal(core.homeworkAiBody(result, result.items[0]), first)
  assert.match(core.homeworkAiBody(result, result.items[0]), /крім № 3/)
  assert.equal(core.homeworkAiBody(result, result.items[1]), second)
  assert.deepEqual(plain(core.normalizeHomeworkAiDraft(result, input)), plain(result))
})

test('common instructions are preserved without repeating a common passage already inside a task', () => {
  const general = 'Відповіді підготуйте письмово.'
  const original = { source_text: general + '\n\n' + first, reference_date: '2026-10-25' }
  const result = core.normalizeHomeworkAiDraft(draft({ general_instructions: general }), original)
  assert.equal(core.homeworkAiBody(result, result.items[0]), general + '\n\n' + first)
  const contained = core.normalizeHomeworkAiDraft(draft({ general_instructions: 'крім № 3' }), input)
  assert.equal(core.homeworkAiBody(contained, contained.items[0]), first)
})

test('invented subject, topic, deadline, body or source label cannot become an editable draft', () => {
  for (const change of [{ subject: 'Історія' }, { lesson_topic: 'Інтеграли' }, { date_text: 'Завтра' }, { source_fragment: 'Усі задачі розв’язано правильно.' }, { links: [{ url: 'https://example.org/math.pdf', title: 'Офіційно перевірено' }] }]) {
    assert.throws(() => core.normalizeHomeworkAiDraft(draft({ items: [item(change)] }), input))
  }
  for (const change of [{ subject: 'Економічна теорія' }, { lesson_topic: 'Ринкова рівновага' }, { date_text: 'На четвер' }]) {
    assert.throws(() => core.normalizeHomeworkAiDraft(draft({ items: [item(change)] }), input), 'metadata must belong to its own task, not another source block')
  }
})

test('links are complete source URLs scoped to their own task, never arbitrary prefixes or executable schemes', () => {
  const withAnother = { ...input, source_text: input.source_text + '\nhttps://different.example/other-subject' }
  for (const url of ['javascript:alert(1)', 'https://example.org/', 'https://different.example/other-subject', 'https://user:secret@example.org/math.pdf']) {
    assert.throws(() => core.normalizeHomeworkAiDraft(draft({ items: [item({ links: [{ url, title: '' }] })] }), withAnother))
  }
  const result = core.normalizeHomeworkAiDraft(draft({ items: [item({ links: [] })] }), input)
  assert.equal(result.items[0].links[0].url, 'https://example.org/math.pdf')
  assert.equal(result.items[0].links.length, 1)
})

test('incomplete extraction, duplicate tasks, model database IDs and oversized data are rejected', () => {
  assert.throws(() => core.normalizeHomeworkAiDraft(draft({ complete: false }), input))
  assert.throws(() => core.normalizeHomeworkAiDraft(draft({ items: [item(), item()] }), input))
  assert.throws(() => core.normalizeHomeworkAiDraft(draft({ items: [item({ schedule_item_id: 'forged-target' })] }), input))
  assert.throws(() => core.normalizeHomeworkAiDraft(draft({ items: Array.from({ length: 11 }, () => item()) }), input))
  assert.throws(() => core.normalizeHomeworkAiInput({ ...input, source_text: 'x'.repeat(12001) }))
  assert.throws(() => core.normalizeHomeworkAiInput({ ...input, reference_date: '2026-02-30' }))
  assert.throws(() => core.normalizeHomeworkAiInput({ ...input, source_text: 'Текст\u0000команди' }))
})

test('combined common instructions and task text are never silently shortened to the storage maximum', () => {
  const common = 'Спільні умови: ' + 'а'.repeat(4500)
  const fragment = 'Завдання: ' + 'б'.repeat(6000)
  assert.throws(() => core.normalizeHomeworkAiDraft(draft({ general_instructions: common, items: [item({ subject: '', lesson_topic: '', date_text: '', source_fragment: fragment, links: [] })] }), { ...input, source_text: common + '\n' + fragment }), /10 000/)
})

test('relative deadlines use the original message date, including midnight and year boundaries', () => {
  assert.equal(core.suggestHomeworkAiDate('до завтра', '2026-10-25'), '2026-10-26')
  assert.equal(core.suggestHomeworkAiDate('на післязавтра', '2026-12-30'), '2027-01-01')
  assert.equal(core.suggestHomeworkAiDate('сьогодні', '2026-10-25'), '2026-10-25')
  assert.equal(core.suggestHomeworkAiDate('на вівторок', '2026-10-25'), '2026-10-27')
  assert.equal(core.suggestHomeworkAiDate('наступного тижня у вівторок', '2026-10-26'), '2026-11-03')
  assert.equal(core.suggestHomeworkAiDate('наступного понеділка', '2026-10-26'), '2026-11-02')
})

test('explicit Ukrainian/Russian/numeric dates are validated rather than guessed from the browser timezone', () => {
  for (const hint of ['27.10.2026', '27/10/26', '27 жовтня 2026 року', '27 октября 2026', '2026-10-27']) assert.equal(core.suggestHomeworkAiDate(hint, '2026-10-25'), '2026-10-27', hint)
  assert.equal(core.suggestHomeworkAiDate('на 01.01', '2026-12-28'), '2027-01-01')
  assert.equal(core.suggestHomeworkAiDate('29 лютого 2028', '2028-02-01'), '2028-02-29')
  assert.equal(core.suggestHomeworkAiDate('29 лютого 2027', '2027-02-01'), null)
  assert.equal(core.homeworkAiTodayInKyiv(new Date('2026-10-24T21:30:00Z')), '2026-10-25')
})

test('ranges, conflicting weekdays and ambiguous dates require a person to choose the lesson date', () => {
  for (const hint of ['26.10–28.10', 'сьогодні або завтра', 'у вівторок або четвер', '26 жовтня, вівторок', 'завтра у четвер', 'наступного тижня', 'не завтра', 'до 18:00', 'коли домовимось']) assert.equal(core.suggestHomeworkAiDate(hint, '2026-10-25'), null, hint)
})
