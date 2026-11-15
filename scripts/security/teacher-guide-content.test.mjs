import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildGuide, guideUpdatedLabel, validateGuide } from '../../public/guides/guide-data.mjs'

const raw = JSON.parse(await readFile(new URL('../../public/guides/data/teacher.json', import.meta.url), 'utf8'))
const teacher = validateGuide(buildGuide(raw, 'teacher'))
const section = id => teacher.sections.find(item => item.id === id)

test('existing teacher manual URLs remain valid and every topic has an actionable route', () => {
  const previous = [
    'teacher-workspace-map', 'teacher-profile-contacts', 'teacher-create-course', 'teacher-connect-group',
    'teacher-sent-requests', 'teacher-calendar', 'teacher-assignment-draft', 'teacher-assignment-standalone',
    'teacher-assignment-deadlines', 'teacher-publish-schedule', 'teacher-multiple-groups', 'teacher-review-submission',
    'teacher-journal-create', 'teacher-journal-publish', 'teacher-grading-rules', 'teacher-grade-requests', 'teacher-voice',
    'teacher-material-create', 'teacher-material-update', 'teacher-material-view-only', 'teacher-colleagues',
    'teacher-student-contacts', 'teacher-semesters-export', 'teacher-daily-routine', 'teacher-help',
  ]
  for (const id of previous) assert.ok(section(id), `Missing stable URL ${id}`)
  for (const item of teacher.sections) {
    if (item.id === '__first-setup') continue
    assert.ok(item.goal && item.expected, `${item.id}: explain purpose and result`)
    assert.ok(item.steps.length >= 3 && item.steps.every(step => step.trim().length > 0), `${item.id}: usable steps`)
  }
})

test('manual covers current assessment, audience, schedule and notification workflows without inventing released results', () => {
  for (const id of ['teacher-audiences', 'teacher-announcements', 'teacher-tests-create', 'teacher-test-question-types',
    'teacher-tests-bank-import', 'teacher-test-variants', 'teacher-test-overrides', 'teacher-tests-review',
    'teacher-rubrics', 'teacher-notifications', 'teacher-lecture-course']) assert.ok(section(id), `Missing current workflow ${id}`)
  const journal = JSON.stringify(section('teacher-journal-create'))
  assert.match(journal, /автоматично/)
  assert.match(journal, /Оновити з розкладу/)
  assert.match(journal, /не виставляє оцінку/)
  assert.match(JSON.stringify(section('teacher-tests-review')), /чернетки/)
  assert.match(JSON.stringify(section('teacher-tests-review')), /окремо опублікуйте/)
  assert.match(JSON.stringify(section('teacher-test-overrides')), /тільки до початку/)
  assert.match(JSON.stringify(section('teacher-audiences')), /спільної здачі/)
  assert.match(JSON.stringify(section('teacher-notifications')), /безкоштовні й не потребують підписки/)
  assert.doesNotMatch(JSON.stringify(teacher), /У викладацькому кабінеті ним керувати не потрібно|Оновлено 28 жовтня/)
})

test('displayed update date follows the selected manual, including unchanged headman data', async () => {
  const headmanRaw = JSON.parse(await readFile(new URL('../../public/guides/data/headman.json', import.meta.url), 'utf8'))
  const headman = buildGuide(headmanRaw, 'headman')
  assert.equal(teacher.version, '2026-11-06')
  assert.equal(headman.version, headmanRaw.version)
  assert.equal(guideUpdatedLabel(teacher.version), 'Оновлено 6 листопада 2026 року.')
  assert.equal(guideUpdatedLabel('2026-02-30'), '')
  assert.equal(guideUpdatedLabel('<script>'), '')
  assert.equal(guideUpdatedLabel(undefined), '')
  const app = await readFile(new URL('../../public/guides/app.mjs', import.meta.url), 'utf8')
  assert.match(app, /guideUpdatedLabel\(current\.version\)/)
  assert.doesNotMatch(app, /Оновлено 28 жовтня 2026/)
})

test('public teacher guide remains practical, private-data safe and free from long dash punctuation', () => {
  const content = JSON.stringify(teacher)
  assert.doesNotMatch(content, /[—–]/)
  assert.doesNotMatch(content, /план (нашої|зустрічі)|порядок (нашої )?зустрічі/i)
  assert.match(JSON.stringify(section('teacher-help')), /Не надсилайте пароль/)
  assert.match(JSON.stringify(section('teacher-tests-create')), /Скриншоти|скриншоти/)
  assert.match(JSON.stringify(section('teacher-tests-bank-import')), /Правильні відповіді не слід вгадувати/)
})

test('import guide distinguishes direct editor import from saving a bank and publishing a test', () => {
  const content = JSON.stringify(section('teacher-tests-bank-import'))
  for (const format of ['DOCX', 'PDF', 'XLSX', 'CSV', 'TSV', 'TXT', 'MD', 'AIKEN', 'GIFT', 'Moodle XML']) assert.ok(content.includes(format))
  assert.match(content, /Створювати банк перед цим не потрібно/)
  assert.match(content, /Окремо натисніть «Зберегти чернетку»/)
  assert.match(content, /Імпорт не публікує тест автоматично/)
  assert.match(content, /Я перевірив умови, правильні відповіді та бали/)
  assert.match(content, /2 МБ на джерело та 4 МБ сумарно/)
  assert.match(content, /до 20 МБ/)
  assert.match(content, /без надсилання файлів моделі ШІ/)
  assert.match(content, /Розпізнати з ШІ/)
  assert.match(content, /Підтвердьте надсилання вибраного тексту або зображення OpenAI/)
})
