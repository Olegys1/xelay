import { randomUUID } from 'node:crypto'
import { syntheticTest } from './teaching-tests-fixture.mjs'

export async function seedAssessmentPreview(fx) {
  const { ids, groups, db, rpc } = fx
  const option = (id, text) => ({ id, text })
  const base = { points: 3, time_limit_seconds: null, partial_credit: false, options: [], buckets: [] }
  const rubric = { criteria: [
    { id: 'content', title: 'Зміст і правильність', levels: [{ id: 'clear', label: 'Пояснення правильне й повне', points: 3 }, { id: 'part', label: 'Є правильна думка, але бракує пояснення', points: 1 }, { id: 'none', label: 'Відповіді немає або вона помилкова', points: 0 }] },
    { id: 'example', title: 'Власний приклад', levels: [{ id: 'yes', label: 'Приклад доречний та пояснений', points: 2 }, { id: 'some', label: 'Приклад наведено без пояснення', points: 1 }, { id: 'no', label: 'Прикладу немає', points: 0 }] },
  ] }
  const questions = [
    { ...base, id: 'multi', kind: 'multiple', text: 'Які з наведених ресурсів належать до чинників виробництва?', options: [option('labour', 'Праця'), option('capital', 'Капітал'), option('land', 'Земля'), option('price', 'Ціна товару')], answer: ['labour', 'capital', 'land'], partial_credit: true },
    { ...base, id: 'short', kind: 'short_text', text: 'Як називається сума всіх витрат підприємства? Напишіть словосполучення.', answer: ['сукупні витрати', 'загальні витрати'], case_sensitive: false },
    { ...base, id: 'number', kind: 'numerical', text: 'Підприємство продало 12 одиниць товару по 25 грн. Який дохід у гривнях?', answer: '300', tolerance: 0.01 },
    { ...base, id: 'calc', kind: 'calculated', text: 'Кількість проданих одиниць: {{quantity}}. Ціна за одиницю: {{price}} грн. Обчисліть дохід у гривнях.', calculation: { formula: 'quantity * price', variables: [{ name: 'quantity', min: 2, max: 10, step: 1 }, { name: 'price', min: 10, max: 50, step: 5 }] }, tolerance: 0.01 },
    { ...base, id: 'cloze', kind: 'cloze', text: 'Коли за інших рівних умов ціна зростає, величина попиту {{direction}}. Таку залежність називають законом {{law}}.', gaps: [{ id: 'direction', answers: ['зменшується', 'падає'] }, { id: 'law', answers: ['попиту'] }], answer: { direction: 'зменшується', law: 'попиту' }, partial_credit: true },
    { ...base, id: 'essay', kind: 'essay', text: 'Поясніть своїми словами, чому альтернативна вартість важлива для вибору. Наведіть один власний приклад.', rubric },
    { ...base, id: 'single', kind: 'choice', text: 'Що відображає альтернативна вартість?', options: [option('a', 'Цінність найкращої втраченої можливості'), option('b', 'Будь-яку суму грошей'), option('c', 'Лише витрати на доставку'), option('d', 'Податки підприємства')], answer: 'a' },
    { ...base, id: 'truefalse', kind: 'boolean', text: 'Обмеженість ресурсів змушує робити вибір.', options: [option('true', 'Так'), option('false', 'Ні')], answer: 'true' },
  ]
  await rpc(ids.owner, 'xelay_teaching_question_bank_mutate', ['import_entries', JSON.stringify({ course_id: ids.course, entries: questions.map(q => ({ category: ['multi', 'single', 'truefalse'].includes(q.id) ? 'Основи економіки' : 'Практичні завдання', tags: ['приклад', q.kind], question: q })) })])
  const payload = syntheticTest(ids.course, [groups[0]], { id: randomUUID(), title: 'Нові запитання · особистий варіант', description: 'Шість запитань із банку з восьми. Порядок і варіанти відповіді перемішуються; після оновлення сторінки ваш варіант зберігається.',
    shuffle_questions: true, shuffle_answers: true, draw_count: 6, questions,
    overrides: [{ user_id: ids.studentA, group_id: groups[0], opens_at: new Date(Date.now() - 3600000).toISOString(), closes_at: new Date(Date.now() + 86400000).toISOString(), duration_seconds: 1800 }] })
  await rpc(ids.owner, 'xelay_teaching_test_mutate', ['save_test', JSON.stringify(payload)])
  const essay = syntheticTest(ids.course, [groups[0]], { id: randomUUID(), title: 'Розгорнута відповідь · перевірка за критеріями', description: 'Вигадана відповідь уже здана. Відкрийте перевірку, оцініть зміст і приклад, затвердьте результат та передайте його в чернетку журналу.', questions: [questions[5]], bonus_percent: 0, bonus_points: 0 })
  await rpc(ids.owner, 'xelay_teaching_test_mutate', ['save_test', JSON.stringify(essay)])
  let detail = await rpc(ids.studentA, 'xelay_teaching_test_mutate', ['start', JSON.stringify({ id: essay.id, group_id: groups[0] })])
  detail = await rpc(ids.studentA, 'xelay_teaching_test_mutate', ['save_answer', JSON.stringify({ id: essay.id, version: detail.attempt.version, question_id: 'essay', answer: 'Альтернативна вартість показує, від чого ми відмовляємося, обираючи іншу можливість. Наприклад, дві години підготовки до семінару означають відмову від двох годин відпочинку.' })])
  await rpc(ids.studentA, 'xelay_teaching_test_mutate', ['finish', JSON.stringify({ id: essay.id, version: detail.attempt.version })])
  await db.query("update teaching_tests set closes_at=clock_timestamp()-interval '1 second' where id=$1", [essay.id])
}
