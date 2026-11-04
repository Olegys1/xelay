import test from 'node:test'
import assert from 'node:assert/strict'
import { importTeachingQuestions } from '../../src/lib/teachingQuestionImport.ts'

const xml = (type, body, prompt = 'Оберіть відповідь') => `<quiz><question type="${type}"><name><text>Приклад</text></name><questiontext format="html"><text><![CDATA[${prompt}]]></text></questiontext>${body}</question></quiz>`
const answer = (value, weight = 0, extra = '') => `<answer fraction="${weight}"><text>${value}</text>${extra}</answer>`

test('GIFT imports common questions with their actual correct answers', async t => {
  await t.test('single choice and escaped markers', () => {
    const result = importTeachingQuestions('::Столиця::Столиця України? {=Київ ~Львів ~Одеса ~Дніпро}\n\nРезультат 2\\+2? {=4 ~3 ~5 ~6}', 'gift')
    assert.equal(result.questions.length, 2)
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions[0].options[0].text, 'Київ')
    assert.equal(result.questions[0].answer, 'a1')
    assert.notEqual(result.questions[0].id, result.questions[1].id)
  })
  await t.test('short answer, boolean, numerical tolerance, essay and matching', () => {
    const result = importTeachingQuestions('$CATEGORY: Економіка\n// ignored comment\nДва? {=два =two}\n\nПравда? {TRUE}\n\nЧисло? {#42:0.1}\n\nПоясніть {}\n\nРозподіліть {=2 -> Парні =3 -> Непарні}', 'gift')
    assert.deepEqual(result.issues, [])
    assert.deepEqual(result.questions.map(item => item.kind), ['short_text', 'boolean', 'numerical', 'essay', 'sorting'])
    assert.deepEqual(result.questions[0].answer, ['два', 'two'])
    assert.equal(result.questions[2].tolerance, 0.1)
    assert.equal(result.questions[4].answer.a2, 'b2')
  })
  await t.test('weighted unsupported answers are reported rather than silently changed', () => {
    const result = importTeachingQuestions('Запитання {~%50%А ~%50%Б ~%-100%В}', 'gift')
    assert.equal(result.questions.length, 0)
    assert.ok(result.issues[0].message.includes('Зважені'))
  })
  await t.test('unrecognized nested content does not disappear silently', () => {
    const result = importTeachingQuestions('Невідомо {a{b}c}', 'gift')
    assert.ok(result.issues.length)
  })
})

test('Moodle XML imports supported definitions', async t => {
  await t.test('choice keeps the answer key and converts HTML to plain text', () => {
    const result = importTeachingQuestions(xml('multichoice', '<single>true</single>' + answer('A', 0) + answer('Б', 100), '<p>Запитання <b>один</b></p><script>bad()</script>'), 'moodle_xml')
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions[0].kind, 'choice')
    assert.equal(result.questions[0].answer, 'a2')
    assert.equal(result.questions[0].text, 'Запитання один')
  })
  await t.test('multiple choice preserves the exact correct subset', () => {
    const result = importTeachingQuestions(xml('multichoice', '<single>false</single>' + answer('A', 50) + answer('Б', 50) + answer('В', 0)), 'moodle_xml')
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions[0].kind, 'multiple')
    assert.deepEqual(result.questions[0].answer, ['a1', 'a2'])
    assert.equal(result.questions[0].partial_credit, false)
  })
  await t.test('short answers preserve acceptable variants and case sensitivity', () => {
    const result = importTeachingQuestions(xml('shortanswer', '<usecase>1</usecase>' + answer('КНУ', 100) + answer('Київський університет', 100)), 'moodle_xml')
    assert.deepEqual(result.questions[0].answer, ['КНУ', 'Київський університет'])
    assert.equal(result.questions[0].case_sensitive, true)
  })
  await t.test('numerical finite answer and tolerance', () => {
    const result = importTeachingQuestions(xml('numerical', answer('-2.5', 100, '<tolerance>0.01</tolerance>')), 'moodle_xml')
    assert.equal(result.questions[0].answer, '-2.5')
    assert.equal(result.questions[0].tolerance, 0.01)
  })
  await t.test('scientific numerical notation becomes an equivalent plain decimal accepted by storage', () => {
    const result = importTeachingQuestions(xml('numerical', answer('1e-7', 100)), 'moodle_xml')
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions[0].answer, '0.0000001')
  })
  await t.test('truefalse answer does not rely on XML order', () => {
    const result = importTeachingQuestions(xml('truefalse', answer('false', 100) + answer('true', 0)), 'moodle_xml')
    assert.equal(result.questions[0].answer, 'false')
  })
  await t.test('essay remains manual, without a fabricated correct answer', () => {
    const result = importTeachingQuestions(xml('essay', ''), 'moodle_xml')
    assert.equal(result.questions[0].kind, 'essay')
    assert.equal(result.questions[0].answer, undefined)
  })
  await t.test('matching becomes equivalent categorical matching', () => {
    const body = '<subquestion><text>Праця</text><answer><text>Ресурси</text></answer></subquestion><subquestion><text>Товар</text><answer><text>Продукція</text></answer></subquestion>'
    const result = importTeachingQuestions(xml('matching', body), 'moodle_xml')
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions[0].answer.a1, 'b1')
    assert.equal(result.questions[0].options[1].text, 'Товар')
  })
  await t.test('textual cloze imports all acceptable gap answers', () => {
    const result = importTeachingQuestions(xml('multianswer', '', 'Столиця: {1:SHORTANSWER:=Київ~=Kyiv}. Число: {1:SA:=два}'), 'moodle_xml')
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions[0].text, 'Столиця: {{gap1}}. Число: {{gap2}}')
    assert.deepEqual(result.questions[0].gaps[0].answers, ['Київ', 'Kyiv'])
  })
})

test('imports reject unsafe, lossy and malformed data without executing it', async t => {
  await t.test('external entities and DTD are rejected', () => {
    const result = importTeachingQuestions('<!DOCTYPE quiz [<!ENTITY leak SYSTEM "file:///secret">]><quiz/>', 'moodle_xml')
    assert.equal(result.questions.length, 0)
    assert.ok(result.issues[0].message.includes('DTD'))
  })
  await t.test('mismatched and truncated XML fail closed', () => {
    for (const input of ['<quiz><question></quiz>', '<quiz><question>', '<notquiz/>']) {
      const result = importTeachingQuestions(input, 'moodle_xml')
      assert.equal(result.questions.length, 0)
      assert.ok(result.issues.length)
    }
  })
  await t.test('Moodle attachments cannot become broken or external file references', () => {
    const result = importTeachingQuestions(xml('essay', '', '<img src="@@PLUGINFILE@@/a.png">'), 'moodle_xml')
    assert.equal(result.questions.length, 0)
    assert.ok(result.issues[0].message.includes('вкладення'))
  })
  await t.test('unsupported types and weighted grading get explicit reports', () => {
    for (const input of [xml('calculated', ''), xml('multichoice', '<single>false</single>' + answer('a', 25) + answer('b', 75)), xml('shortanswer', answer('a', 50))]) {
      const result = importTeachingQuestions(input, 'moodle_xml')
      assert.equal(result.questions.length, 0)
      assert.ok(result.issues.length)
    }
  })
  await t.test('unsupported question point precision is reported instead of resetting points silently', () => {
    const result = importTeachingQuestions(xml('essay', '<defaultgrade>1.333</defaultgrade>'), 'moodle_xml')
    assert.equal(result.questions.length, 0)
    assert.ok(result.issues[0].message.includes('Вага'))
  })
  await t.test('nonfinite numeric answers and wildcard answer patterns are rejected', () => {
    for (const input of [xml('numerical', answer('NaN', 100)), xml('shortanswer', answer('.*', 100))]) {
      const result = importTeachingQuestions(input, 'moodle_xml')
      assert.equal(result.questions.length, 0)
      assert.ok(result.issues.length)
    }
  })
  await t.test('file size, depth and question count are bounded', () => {
    assert.ok(importTeachingQuestions('a'.repeat(2 * 1024 * 1024 + 1), 'gift').issues.length)
    assert.ok(importTeachingQuestions('<quiz>' + '<a>'.repeat(33) + '</a>'.repeat(33) + '</quiz>', 'moodle_xml').issues.length)
    const result = importTeachingQuestions(Array.from({ length: 101 }, (_, index) => `Питання ${index} {TRUE}`).join('\n\n'), 'gift')
    assert.equal(result.questions.length, 100)
    assert.ok(result.issues.some(issue => issue.message.includes('100')))
  })
})
