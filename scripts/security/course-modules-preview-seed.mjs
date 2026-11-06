import { randomUUID } from 'node:crypto'
import { syntheticTest } from './teaching-tests-fixture.mjs'
import { seedJournalSchedulePreview } from './journal-schedule-preview-fixture.mjs'
import { seedLectureCoursePreview } from './lecture-course-preview-seed.mjs'
import { seedRichTestPreview } from './rich-test-preview-seed.mjs'

/** Fictional data only, applied to the in-process preview database. */
export async function seedCourseModulesPreview(fx, { advanced = false, examControls = false, lecture, richPhotos } = {}) {
  const { db, ids, groups, rpc } = fx
  const testAction = (actor, action, payload) => rpc(actor, 'xelay_teaching_test_mutate', [action, JSON.stringify({ ...payload, expected_user_id: actor })])
  const names = { owner: 'Олена Прикладенко', studentA: 'Марія Прикладенко', headA: 'Андрій Прикладенко', headB: 'Софія Прикладенко', studentB: 'Данило Прикладенко' }
  for (const [key, name] of Object.entries(names)) {
    await db.query('update profiles set full_name=$1 where id=$2', [name, ids[key]])
    await db.query('update teaching_entries set full_name=$1 where user_id=$2', [name, ids[key]])
  }
  await db.query("update teaching_courses set title='Основи економіки',semester='Осінній семестр' where id=$1", [ids.course])
  await db.query("update study_groups set group_name='ЕУБ · навчальний приклад' where id=$1", [groups[0]])
  await db.query("update study_groups set group_name='Інша група · приклад' where id=$1", [groups[1]])
  await fx.mutate(ids.owner, 'sync_roster', { course_id: ids.course, group_id: groups[0] })
  const today = (await db.query("select (clock_timestamp() at time zone 'Europe/Kyiv')::date::text as today")).rows[0].today
  if (richPhotos) return seedRichTestPreview(fx, richPhotos, today)
  if (lecture) return seedLectureCoursePreview(fx, lecture.clips, lecture.bytes, lecture.duration, today)
  const target = { group_id: groups[0], due_at: null, closes_at: null, placement_mode: 'unplaced', lesson_date: today, audience_mode: 'all', subgroup_ids: [], team_ids: [] }
  const materialId = randomUUID(), assignmentId = randomUUID(), testId = randomUUID(), draftMaterialId = randomUUID()
  const common = { version: 0, expected_user_id: ids.owner, course_id: ids.course, links: [], attachments: [], targets: [target] }
  await fx.mutate(ids.owner, 'save_material', { ...common, id: materialId, title: 'Попит і пропозиція: короткий конспект',
    body: 'Попит — готовність і можливість придбати товар за певною ціною. Пропозиція — готовність продавців продати товар.\n\nРинкова рівновага виникає там, де величина попиту дорівнює величині пропозиції.\n\nПриклад: після зростання доходів покупці можуть купувати більше товару за кожною ціною. Прочитайте конспект, а тоді позначте цей крок прочитаним.', status: 'published', allow_download: true, rights_accepted: true, rights_terms_version: '2026-10-27.1' })
  await rpc(ids.owner, 'xelay_teaching_classified_assignment', ['save_group_assignment', JSON.stringify({ ...common, id: assignmentId,
    title: 'Поясніть зміну попиту', body: 'Опишіть власний приклад зміни попиту. Поясніть, яка подія зсунула криву попиту і як це впливає на рівновагу. Обсяг: один абзац.\n\nДля переходу до контрольного тесту потрібен опублікований результат від 6 з 10 балів.', status: 'published', max_points: 10, category: '', submission_mode: 'individual', submission_format: 'written' })])
  await testAction(ids.owner, 'save_test', syntheticTest(ids.course, [groups[0]], {
    id: testId, title: 'Перевірка розуміння: попит і пропозиція', description: 'Два короткі запитання після виконання практичного завдання.',
    journal_date: today, work_type: 'Тест', bonus_percent: 0, bonus_points: 0, max_points: 10,
    questions: [
      { id: 'demand', kind: 'choice', text: 'Що може спричинити зростання попиту на нормальний товар?', points: 5, time_limit_seconds: null, partial_credit: false, buckets: [], options: [{ id: 'income', text: 'Зростання доходів покупців' }, { id: 'cost', text: 'Зростання витрат виробника' }, { id: 'tax', text: 'Зростання податку на виробника' }, { id: 'supply', text: 'Скорочення пропозиції' }], answer: 'income' },
      { id: 'equilibrium', kind: 'boolean', text: 'У стані ринкової рівноваги величина попиту дорівнює величині пропозиції.', points: 5, time_limit_seconds: null, partial_credit: false, buckets: [], options: [{ id: 'true', text: 'Так' }, { id: 'false', text: 'Ні' }], answer: 'true' },
    ],
  }))
  await fx.mutate(ids.owner, 'save_material', { ...common, id: draftMaterialId, title: 'Майбутня тема: еластичність', body: 'Ця чернетка ще не опублікована.', status: 'draft', allow_download: true })
  // Andriy has a real submitted work and a published mark in the fictional journal.
  const submissionId = randomUUID()
  let saved = await fx.classroom(ids.headA, 'reserve_submission', { id: submissionId, item_id: assignmentId, group_id: groups[0] })
  saved = await fx.classroom(ids.headA, 'save_submission', { id: submissionId, item_id: assignmentId, group_id: groups[0], version: saved.version, body: 'Після зростання доходів попит на книги зріс. Крива попиту змістилася праворуч, рівноважні ціна й кількість зросли.', links: [], attachments: [] })
  await fx.classroom(ids.headA, 'submit_submission', { id: submissionId, version: saved.version })
  const activity = (await db.query('select id from teaching_activities where item_id=$1 and group_id=$2', [assignmentId, groups[0]])).rows[0]
  const entry = (await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3 and active', [ids.course, groups[0], ids.headA])).rows[0]
  const grade = await fx.mutate(ids.owner, 'save_grade', { activity_id: activity.id, entry_id: entry.id, version: 0, score: 8, comment: 'Приклад правильний.', reason: '' })
  await fx.mutate(ids.owner, 'publish_grades', { activity_id: activity.id, expected_versions: [{ entry_id: entry.id, version: grade.version }] })
  const moduleIds = [randomUUID(), randomUUID(), randomUUID()], itemIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  const module = (id, title, description, position, items, prerequisite_item_ids = [], status = 'published') => ({ id, course_id: ids.course, title, description, position, status, version: 0, expected_user_id: ids.owner, group_ids: [groups[0]], prerequisite_item_ids, items })
  const item = (id, resource_type, resource_id, completion, position, prerequisite_item_ids = [], pass_percent = null) => ({ id, resource_type, resource_id, required: true, completion, position, prerequisite_item_ids, pass_percent })
  for (const payload of [
    module(moduleIds[0], 'Розібратися в основах', 'Короткий конспект і власний приклад. До наступного модуля — після перевірки викладачкою.', 0, [item(itemIds[0], 'material', materialId, 'acknowledged', 0), item(itemIds[1], 'assignment', assignmentId, 'passed', 1, [itemIds[0]], 60)]),
    module(moduleIds[1], 'Перевірити себе', 'Контрольний тест відкриється після опублікованого результату не нижче 60% за практичне завдання.', 1, [item(itemIds[2], 'test', testId, 'submitted', 0)], [itemIds[1]]),
    module(moduleIds[2], 'Наступна тема', 'Підготовка наступного модуля. Студенти ще не бачать цю чернетку.', 2, [item(itemIds[3], 'material', draftMaterialId, 'acknowledged', 0)], [], 'draft'),
  ]) await rpc(ids.owner, 'xelay_teaching_course_module_save', [JSON.stringify(payload)])
  await rpc(ids.headA, 'xelay_student_module_acknowledge', [itemIds[0], groups[0], ids.headA])
  if (!advanced) return { materialId, assignmentId, testId, moduleIds, itemIds }
  // A separate test leaves the original gated course path untouched. Maria is
  // explicitly excluded before any attempt; Andriy can draw three of twenty.
  const poolTestId = randomUUID()
  const questions = Array.from({ length: 20 }, (_, index) => {
    const price = 10 + index
    return { id: `pool-${index + 1}`, kind: 'choice', text: `Товар коштує ${price} грн. Скільки коштують дві одиниці без знижки?`, points: 1,
      time_limit_seconds: null, partial_credit: false, buckets: [], options: [
        { id: 'correct', text: `${price * 2} грн` }, { id: 'single', text: `${price} грн` }, { id: 'plus', text: `${price + 2} грн` }, { id: 'triple', text: `${price * 3} грн` },
      ], answer: 'correct' }
  })
  await testAction(ids.owner, 'save_test', syntheticTest(ids.course, [groups[0]], {
    id: poolTestId, title: 'Випадковий варіант: 3 із 20 запитань', journal_date: today, work_type: 'Тест',
    description: 'Банк містить 20 простих запитань. Кожна особиста спроба отримує рівно три без повторення. Після початку варіант зберігається.',
    questions, draw_count: 3, max_points: 3, shuffle_questions: true, shuffle_answers: true, bonus_percent: 0, bonus_points: 0,
    overrides: [{ user_id: ids.studentA, group_id: groups[0], opens_at: null, closes_at: null, duration_seconds: null,
      excluded: true, exclusion_reason: 'Локальний приклад: для допуску спочатку зверніться до викладачки.' }],
  }))
  // Two actual submitted attempts await separate teacher review, bonus approval
  // and journal transfer. No result has been published by this demonstration.
  const reviewTestId = randomUUID()
  const reviewQuestions = [
    { ...questions[0], id: 'review-demand', text: 'Товар коштує 10 грн. Скільки коштують дві одиниці?' },
    { id: 'review-equilibrium', kind: 'boolean', text: 'У рівновазі величина попиту дорівнює величині пропозиції.', points: 1, time_limit_seconds: null, partial_credit: false,
      options: [{ id: 'true', text: 'Так' }, { id: 'false', text: 'Ні' }], buckets: [], answer: 'true' },
  ]
  if (examControls) await testAction(ids.owner, 'save_test', syntheticTest(ids.course, [groups[0]], {
    title: 'Контрольна · код і випадкові варіанти',
    description: 'Локальний приклад входу за кодом, водяного знака й автоматичної здачі після другого виходу із вкладки.',
    journal_date: today, work_type: 'Тест', max_points: 2, bonus_percent: 0, bonus_points: 0,
    require_access_code: true, restrict_tab_switch: true, discourage_capture: true,
    questions: reviewQuestions,
    variants: [{ id: randomUUID(), title: 'Варіант 2', questions: [
      { ...questions[7], id: 'variant-price' },
      { ...reviewQuestions[1], id: 'variant-demand', text: 'Зростання доходів може підвищити попит на нормальний товар.', answer: 'true' },
    ] }],
  }))
  await testAction(ids.owner, 'save_test', syntheticTest(ids.course, [groups[0]], { id: reviewTestId, title: 'Перевірка робіт: два здані приклади',
    description: 'Дві вигадані роботи вже здано, приймання закрито. Перевірте відповіді, окремо затвердьте результати з бонусами, передайте їх у чернетки журналу й опублікуйте.',
    journal_date: today, work_type: 'МКР', questions: reviewQuestions, max_points: 4, bonus_percent: 20, bonus_points: 2 }))
  for (const actor of [ids.studentA, ids.headA]) {
    let detail = await testAction(actor, 'start', { id: reviewTestId, group_id: groups[0] })
    for (let index = 0; index < reviewQuestions.length; index++) {
      const question = reviewQuestions[index]
      detail = await testAction(actor, 'save_answer', { id: reviewTestId, version: detail.attempt.version, question_id: question.id,
        answer: actor === ids.studentA && index === 1 ? 'false' : question.answer })
      if (index < reviewQuestions.length - 1) detail = await testAction(actor, 'navigate', { id: reviewTestId, version: detail.attempt.version, index: index + 1 })
    }
    await testAction(actor, 'finish', { id: reviewTestId, version: detail.attempt.version })
  }
  const review = await rpc(ids.owner, 'xelay_teaching_test', [reviewTestId])
  await testAction(ids.owner, 'close_test', { id: reviewTestId, version: review.test.version, confirm_close_all: true })
  const journal = await seedJournalSchedulePreview(fx)
  await rpc(ids.owner, 'xelay_teaching_sync_journal_schedule', [ids.course, groups[0], journal.today, journal.last, ids.owner])
  return { materialId, assignmentId, testId, moduleIds, itemIds, poolTestId, reviewTestId, journal }
}
