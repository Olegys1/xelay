import { randomUUID } from 'node:crypto'
import { syntheticTest } from './teaching-tests-fixture.mjs'

/** Fictional data only, applied to the in-process preview database. */
export async function seedCourseModulesPreview(fx) {
  const { db, ids, groups, rpc } = fx
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
  const target = { group_id: groups[0], due_at: null, closes_at: null, placement_mode: 'unplaced', lesson_date: today, audience_mode: 'all', subgroup_ids: [], team_ids: [] }
  const materialId = randomUUID(), assignmentId = randomUUID(), testId = randomUUID(), draftMaterialId = randomUUID()
  const common = { version: 0, expected_user_id: ids.owner, course_id: ids.course, links: [], attachments: [], targets: [target] }
  await fx.mutate(ids.owner, 'save_material', { ...common, id: materialId, title: 'Попит і пропозиція: короткий конспект',
    body: 'Попит — готовність і можливість придбати товар за певною ціною. Пропозиція — готовність продавців продати товар.\n\nРинкова рівновага виникає там, де величина попиту дорівнює величині пропозиції.\n\nПриклад: після зростання доходів покупці можуть купувати більше товару за кожною ціною. Прочитайте конспект, а тоді позначте цей крок прочитаним.', status: 'published', allow_download: true, rights_accepted: true, rights_terms_version: '2026-10-27.1' })
  await rpc(ids.owner, 'xelay_teaching_classified_assignment', ['save_group_assignment', JSON.stringify({ ...common, id: assignmentId,
    title: 'Поясніть зміну попиту', body: 'Опишіть власний приклад зміни попиту. Поясніть, яка подія зсунула криву попиту і як це впливає на рівновагу. Обсяг: один абзац.\n\nДля переходу до контрольного тесту потрібен опублікований результат від 6 з 10 балів.', status: 'published', max_points: 10, category: '', submission_mode: 'individual', submission_format: 'written' })])
  await rpc(ids.owner, 'xelay_teaching_test_mutate', ['save_test', JSON.stringify(syntheticTest(ids.course, [groups[0]], {
    id: testId, title: 'Перевірка розуміння: попит і пропозиція', description: 'Два короткі запитання після виконання практичного завдання.',
    journal_date: today, work_type: 'Тест', bonus_percent: 0, bonus_points: 0, max_points: 10,
    questions: [
      { id: 'demand', kind: 'choice', text: 'Що може спричинити зростання попиту на нормальний товар?', points: 5, time_limit_seconds: null, partial_credit: false, buckets: [], options: [{ id: 'income', text: 'Зростання доходів покупців' }, { id: 'cost', text: 'Зростання витрат виробника' }, { id: 'tax', text: 'Зростання податку на виробника' }, { id: 'supply', text: 'Скорочення пропозиції' }], answer: 'income' },
      { id: 'equilibrium', kind: 'boolean', text: 'У стані ринкової рівноваги величина попиту дорівнює величині пропозиції.', points: 5, time_limit_seconds: null, partial_credit: false, buckets: [], options: [{ id: 'true', text: 'Так' }, { id: 'false', text: 'Ні' }], answer: 'true' },
    ],
  }))])
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
  return { materialId, assignmentId, testId, moduleIds, itemIds }
}
