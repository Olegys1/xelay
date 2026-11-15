import test from 'node:test'
import assert from 'node:assert/strict'
import { importTeachingQuestionsEasy as parse, previewTeachingQuestionsEasy as preview, QUESTION_IMPORT_TEXT_TEMPLATE, QUESTION_IMPORT_TABLE_TEMPLATE, parseQuestionTable, detectTeachingQuestionFormat, validateEasyImportedQuestion } from '../../src/lib/teachingQuestionImportText.ts'

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
test('blank lines between fields keep the key, points and tolerance with their question', () => {
  const result = parse([
    'How much?', 'Тип: числова', 'Відповідь: 2,5', 'Похибка: 0,1', 'Бали: 3',
    'What is the capital?', 'A) Kyiv', 'B) Lviv', 'ANSWER: A', 'Points: 2',
  ].join('\r\n\r\n'))
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.questions.map(({kind, answer, points}) => [kind, answer, points]), [['numerical', '2.5', 3], ['choice', 'a1', 2]])
  assert.equal(result.questions[0].tolerance, 0.1)
})
test('colon-labelled choices keep their options and use the explicit key', () => {
  const result = parse('Q: Pick one\n\nТип: одна\n\nA: First\n\nB: Second\n\nANSWER: B')
  assert.deepEqual(result.issues, [])
  assert.equal(result.questions[0].text, 'Q: Pick one')
  assert.equal(result.questions[0].kind, 'choice')
  assert.deepEqual(result.questions[0].options.map(option => option.text), ['First', 'Second'])
  assert.equal(result.questions[0].answer, 'a2')
  const ukrainian = parse('Оберіть відповіді\nА: Перша\nБ: Друга\nВ: Третя\nВідповідь: А,Б')
  assert.deepEqual(ukrainian.issues, [])
  assert.deepEqual(ukrainian.questions[0].answer, ['a1', 'a2'])
  for (const source of ['Pick one\nA: First\nB: Second\nANSWER: C', 'Pick one\nA: First\nA: Second\nANSWER: A']) {
    const invalid = parse(source)
    assert.equal(invalid.questions.length, 0)
    assert.ok(invalid.issues.length)
  }
})
test('colon text stays literal in established multiline options and explicit short answers', () => {
  const options = parse('Pick one\nA) Formula\nx: 4\ny: 2\nB) Other\nANSWER: A')
  assert.deepEqual(options.issues, [])
  assert.equal(options.questions[0].options[0].text, 'Formula\nx: 4\ny: 2')
  const short = parse('Compare these cases\nA: Rain\nB: Snow\nТип: коротка\nВідповідь: Water')
  assert.deepEqual(short.issues, [])
  assert.equal(short.questions[0].text, 'Compare these cases\nA: Rain\nB: Snow')
  assert.deepEqual(short.questions[0].answer, ['Water'])
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

test('unkeyed drafts retain prompts and every option until the teacher sets a key', () => {
  const source = '1. Попит зростає. Яке твердження правильне?\nA) Перша умова\nіз продовженням\nB) Інша умова\n\n2. Поясніть причину\nна основі матеріалу лекції'
  const result = preview(source)
  assert.deepEqual(result.issues, [])
  assert.equal(result.questions.length, 2)
  const [choice, short] = result.questions
  assert.equal(choice.kind, 'choice')
  assert.equal(choice.text, 'Попит зростає. Яке твердження правильне?')
  assert.deepEqual(choice.options.map(item => item.text), ['Перша умова\nіз продовженням', 'Інша умова'])
  assert.equal(choice.answer, undefined)
  assert.equal(short.kind, 'short_text')
  assert.equal(short.text, 'Поясніть причину\nна основі матеріалу лекції')
  assert.equal(short.answer, undefined)
  assert.deepEqual(result.inferredTypes, result.questions.map(item => item.id))
  assert.ok(validateEasyImportedQuestion(choice))
  assert.ok(validateEasyImportedQuestion(short))
  assert.equal(validateEasyImportedQuestion({ ...choice, answer: 'a2' }), null)
  assert.equal(validateEasyImportedQuestion({ ...short, kind: 'essay' }), null)
  assert.equal(parse(source).questions.length, 0)
})

test('unkeyed boolean, numerical and ordering previews never acquire false, zero or default order', () => {
  const result = preview('1. Твердження\nТип: так/ні\n\n2. Скільки?\nТип: числова\n\n3. Упорядкуйте\nA) Друга\nB) Перша\nТип: послідовність')
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.questions.map(item => item.kind), ['boolean', 'numerical', 'sequence'])
  assert.ok(result.questions.every(item => item.answer === undefined))
  assert.ok(result.questions.every(item => validateEasyImportedQuestion(item)))
  assert.equal(result.inferredTypes, undefined)
})

test('only an explicit standalone yes/no pair infers boolean without choosing its truth', () => {
  for (const [pair,labels] of [['Так / Ні',['Так','Ні']], ['Да / Нет',['Да','Нет']], ['True / False',['True','False']]]) {
    const result = preview(`2. Ресурси є обмеженими.\n${pair}`)
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions[0].kind, 'boolean')
    assert.equal(result.questions[0].text, 'Ресурси є обмеженими.')
    assert.deepEqual(result.questions[0].options.map(option => option.text), labels)
    assert.equal(result.questions[0].answer, undefined)
    assert.deepEqual(result.inferredTypes, [result.questions[0].id])
    assert.ok(validateEasyImportedQuestion(result.questions[0]))
  }
  for (const source of ['Ресурси є обмеженими.', 'Поясніть значення true / false', 'Умова\nТак / Ні\nПродовження умови', 'Умова\nA) Так / Ні\nB) Інший варіант']) {
    const result = preview(source)
    assert.notEqual(result.questions[0].kind, 'boolean', source)
    assert.ok(result.questions[0].text || result.questions[0].options.some(option => option.text.includes('Так / Ні')))
    assert.equal(result.questions[0].answer, undefined)
  }
})

test('untyped paragraph and bullet question boundaries preserve source text for manual review', () => {
  const result = preview('Який ресурс?\nA: Перший\nB: Другий\n\nЯка умова?\nA) Інша\nB) Та сама\n\n• Поясніть попит?\n\n• Що таке пропозиція?')
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.questions.map(item => item.text), ['Який ресурс?', 'Яка умова?', 'Поясніть попит?', 'Що таке пропозиція?'])
  assert.deepEqual(result.questions[0].options.map(item => item.text), ['Перший','Другий'])
  assert.ok(result.questions.every(item => item.answer === undefined))
})

test('blank paragraphs inside prompts and multiline options never become fabricated questions', () => {
  for (const format of ['auto', 'plain']) {
    const source = 'Q?\n\nUse the conditions below.\nA) First line\n\ncontinuation of the first option\nB) Second\nANSWER: A'
    const result = preview(source, format)
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions.length, 1)
    assert.equal(result.questions[0].text, 'Q?\nUse the conditions below.')
    assert.deepEqual(result.questions[0].options.map(option => option.text), ['First line\ncontinuation of the first option', 'Second'])
    assert.equal(result.questions[0].answer, 'a1')
  }
  const unkeyed = preview('Яка умова\nА) Перший рядок\n\nпродовження першого варіанта\nБ) Другий варіант')
  assert.deepEqual(unkeyed.issues, [])
  assert.equal(unkeyed.questions.length, 1)
  assert.equal(unkeyed.questions[0].options[0].text, 'Перший рядок\nпродовження першого варіанта')
  assert.equal(unkeyed.questions[0].answer, undefined)
})

test('unnumbered questions without question marks split only at a fresh option list', () => {
  const result = preview('Оберіть ресурс\nA) Перший\nB) Другий\n\nЗнайдіть іншу умову\nA) Одна\nB) Інша\n\nВиберіть результат\nА: Початковий\nБ: Кінцевий')
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.questions.map(item => item.text), ['Оберіть ресурс', 'Знайдіть іншу умову', 'Виберіть результат'])
  assert.ok(result.questions.every(item => item.answer === undefined))
  const ambiguous = preview('Поясніть зміну попиту\n\nВрахуйте зміну доходу\n\nНаведіть приклад')
  assert.deepEqual(ambiguous.issues, [])
  assert.equal(ambiguous.questions.length, 1)
  assert.equal(ambiguous.questions[0].text, 'Поясніть зміну попиту\nВрахуйте зміну доходу\nНаведіть приклад')
  assert.equal(ambiguous.questions[0].answer, undefined)
})

test('unkeyed table rows become editable drafts without weakening strict imports', () => {
  const source = 'Question;A;B;Points\nЯка умова?;Перша;Друга;2\nПоясніть причину;;;3'
  const result = preview(source)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.questions.map(item => [item.kind,item.points,item.answer]), [['choice',2,undefined],['short_text',3,undefined]])
  assert.equal(result.inferredTypes.length, 2)
  assert.equal(parse(source).questions.length, 0)
})

test('draft import preserves valid explicit keys and still rejects ambiguous or malformed source', () => {
  assert.deepEqual(preview(QUESTION_IMPORT_TEXT_TEMPLATE).questions.map(({kind,answer}) => [kind,answer]), [['choice','a1'],['boolean','true'],['essay',undefined]])
  for (const source of ['Яка?\nA) Так\nB) Так\nВідповідь: Так', 'Яка?\nA) Так\nB) Ні\nВідповідь: C', 'Яка?\nA) Так\nA) Ні', 'Тип: невідомий\nУмова']) {
    const result = preview(source)
    assert.equal(result.questions.length, 0, source)
    assert.ok(result.issues.length, source)
  }
})

test('ordering subsets preserve all distractors, count and explicit ordered key', () => {
  const source = 'Упорядкуйте три етапи\nA) Зайве\nB) Третій\nC) Перший\nD) Зайве теж\nE) Другий\nТип: послідовність з ускладненням\nКількість для вибору: 3'
  const result = preview(source)
  assert.deepEqual(result.issues, [])
  assert.equal(result.questions[0].kind,'sequence_select')
  assert.equal(result.questions[0].options.length,5)
  assert.equal(result.questions[0].selection_count,3)
  assert.equal(result.questions[0].answer,undefined)
  assert.ok(validateEasyImportedQuestion(result.questions[0]))
  const keyed = parse(source+'\nВідповідь: C,E,B')
  assert.deepEqual(keyed.issues, [])
  assert.deepEqual(keyed.questions[0].answer,['a3','a5','a2'])
  const table = preview('Question;A;B;C;Type;Select\nПорядок;Зайве;Перший;Другий;sequence_select;2')
  assert.deepEqual(table.issues, [])
  assert.equal(table.questions[0].selection_count,2)
  assert.equal(table.questions[0].answer,undefined)
  assert.ok(preview('Питання\nA) Перша\nB) Друга\nSelect: 1').issues.length)
})

test('ambiguous long prose is preserved and paragraph scanning stays bounded', () => {
  const source = Array(20000).fill('Ненумерований фрагмент навчального тексту').join('\n\n')
  const start = performance.now()
  const result = preview(source, 'plain')
  assert.ok(performance.now()-start < 1500)
  assert.equal(result.questions.length,0)
  assert.ok(result.issues.length)
  const short = preview('Умова одним абзацом без номерів. Визначте результат за даними джерела.')
  assert.deepEqual(short.issues, [])
  assert.equal(short.questions[0].text,'Умова одним абзацом без номерів. Визначте результат за даними джерела.')
  assert.equal(short.questions[0].answer,undefined)
})
