import test from 'node:test'
import assert from 'node:assert/strict'
import { importTeachingQuestionsEasy as parse, QUESTION_IMPORT_TEXT_TEMPLATE, QUESTION_IMPORT_TABLE_TEMPLATE, parseQuestionTable, detectTeachingQuestionFormat, validateEasyImportedQuestion } from '../../src/lib/teachingQuestionImportText.ts'

test('ordinary text / AIKEN preserves explicit keys, multiline prompts and points', () => {
  const result = parse(QUESTION_IMPORT_TEXT_TEMPLATE)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.questions.map(item => item.kind), ['choice', 'boolean', 'essay'])
  assert.equal(result.questions[0].answer, 'a1')
  assert.equal(result.questions[0].points, 2)
  assert.equal(result.questions[1].answer, 'true')
  assert.equal(result.questions[2].answer, undefined)
  const aiken = parse('Which number is even?\nA. Three\nB. Four\nC. Five\nANSWER: B\n\nWhich are even?\nA) Two\nB) Four\nC) Five\nANSWER: A,B')
  assert.deepEqual(aiken.issues, [])
  assert.equal(aiken.questions[0].answer, 'a2')
  assert.deepEqual(aiken.questions[1].answer, ['a1','a2'])
})
test('Ukrainian option letters are matched exactly, never guessed from lookalikes', () => {
  const result = parse('1. Яка відповідь?\nА) Одна\nБ) Друга\nВ) Третя\nВідповідь: Б')
  assert.deepEqual(result.issues, [])
  assert.equal(result.questions[0].answer, 'a2')
  assert.ok(parse('Яка?\nA) Одна\nB) Друга\nВідповідь: В').issues.length)
})
test('missing and ambiguous keys are blocked instead of inventing essay or correct choice', () => {
  for (const text of ['1. Два плюс два?\nA) 3\nB) 4','Поясніть попит','Яка?\nA) Так\nB) Так\nВідповідь: Так','Яка?\nA) Так\nA) Ні\nВідповідь: A','Яка?\nA) Так\nB) Ні\nВідповідь: A,A','Яка?\nA) Так\nB) Ні\nВідповідь: C']) {
    const result = parse(text)
    assert.equal(result.questions.length, 0, text)
    assert.ok(result.issues.length, text)
  }
})
test('plain text supports explicit short/numerical/sequence and never translates grading rules', () => {
  const result = parse('1. Назвіть столицю\nВідповідь: Київ|Kyiv\nТип: коротка\n\n2. Скільки?\nТип: числова\nВідповідь: -2,5\nПохибка: 0,1\nБали: 1,25\n\n3. Порядок\nA) Кінець\nB) Початок\nТип: послідовність\nВідповідь: B,A')
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.questions[0].answer, ['Київ','Kyiv'])
  assert.equal(result.questions[1].answer, '-2.5')
  assert.equal(result.questions[1].tolerance, .1)
  assert.equal(result.questions[1].points, 1.25)
  assert.deepEqual(result.questions[2].answer, ['a2','a1'])
  for (const text of ['Що?\nТип: есе\nВідповідь: так', 'Що?\nТип: невідомий\nВідповідь: так', 'Що?\nТип: числова\nВідповідь: 1e999', 'Що?\nТип: числова\nВідповідь: 1\nБали: 1.001']) assert.ok(parse(text).issues.length)
})
test('CSV/TSV maps headers and answer keys while honoring quotes/newlines/semicolons', () => {
  const result = parse(QUESTION_IMPORT_TABLE_TEMPLATE)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.questions.map(item => item.kind), ['choice','multiple'])
  assert.deepEqual(result.questions[1].answer, ['a1','a3'])
  const quoted = parse('Question,A,B,Answer,Points\n"Which line, here?","first\nline","second ""quoted"" line",B,3')
  assert.deepEqual(quoted.issues, [])
  assert.equal(quoted.questions[0].options[0].text, 'first\nline')
  assert.equal(quoted.questions[0].options[1].text, 'second "quoted" line')
  assert.equal(quoted.questions[0].answer, 'a2')
  const tsv = parse('Question\tA\tB\tAnswer\nWhich?\tOne\tTwo\tB')
  assert.deepEqual(tsv.issues, [])
})
test('table errors are visible instead of silently dropping populated unsupported columns or rows', () => {
  for (const source of [
    'Question,A,B,Answer,Feedback\nWhich?,A,B,A,Important text',
    'Question,A,A,Answer\nWhich?,One,Two,A',
    'Question,A,B,Answer\nWhich?,One,Two,Z',
    'Question,A,B,Answer\nWhich?,One,Two,A,Lost cell',
    'Question,A,B,Answer\n"Unclosed,One,Two,A',
    'Question,A,B,Answer\n"Closed"invalid,One,Two,A',
  ]) assert.ok(parse(source).issues.length, source)
  assert.equal(parse('Question,A,B,Answer\nWhich?,One,Two,').questions.length, 0)
})
test('auto detection retains GIFT and Moodle XML support and forbids XML entities', () => {
  assert.equal(detectTeachingQuestionFormat('::one::Question {=Yes ~No}'),'gift')
  assert.equal(parse('::one::Question {=Yes ~No}').questions[0].answer,'a1')
  const xml = '<quiz><question type="truefalse"><questiontext><text>True?</text></questiontext><answer fraction="100"><text>true</text></answer><answer fraction="0"><text>false</text></answer></question></quiz>'
  assert.equal(parse(xml).questions[0].answer,'true')
  assert.equal(parse('<!DOCTYPE quiz [<!ENTITY x SYSTEM "https://example.invalid/secret">]><quiz></quiz>').questions.length,0)
})
test('preview edits are validated before a bank mutation can be requested', () => {
  const question = parse('Q?\nA) One\nB) Two\nANSWER: B').questions[0]
  assert.equal(validateEasyImportedQuestion(question), null)
  assert.match(validateEasyImportedQuestion({...question,answer:'unknown'}),/відповідь/)
  assert.ok(validateEasyImportedQuestion({...question,points:-1}))
  assert.ok(validateEasyImportedQuestion({...question,time_limit_seconds:0}))
  assert.ok(validateEasyImportedQuestion({...question,kind:'multiple',answer:['a1','a1']}))
})
test('oversized data, binary data and more than 100 rows/questions are bounded', () => {
  assert.ok(parse('x'.repeat(2*1024*1024+1)).issues.length)
  assert.ok(parse('Q\u0000').issues.length)
  const text = Array.from({length:101},(_,index)=>`${index+1}. Question\nA) One\nB) Two\nANSWER: B`).join('\n\n')
  assert.equal(parse(text).questions.length,100)
  assert.ok(parse(text).issues.length)
  assert.throws(()=>parseQuestionTable('Question,A,B,Answer\n'+Array(101).fill('Which?,One,Two,B').join('\n')))
})

test('literal math and angle brackets are preserved in plain text, while duplicate table option labels fail closed', () => {
  const plain = parse('1. x < 5, y > 3?\nA) Yes\nB) No\nANSWER: B')
  assert.deepEqual(plain.issues,[])
  assert.equal(plain.questions[0].text,'x < 5, y > 3?')
  const table = parse('Question;A;Варіант A;Answer\nQ?;One;Two;A')
  assert.equal(table.questions.length,0)
  assert.match(table.issues[0].message,/повторюються/)
})

test('auto format detection remains bounded for malformed braces and many key markers', () => {
  const source = '{' + '=abc'.repeat(200000)
  const start = performance.now()
  assert.equal(detectTeachingQuestionFormat(source),'gift')
  assert.ok(performance.now()-start<1000)
})
