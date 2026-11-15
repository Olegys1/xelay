import { randomUUID } from 'node:crypto'
import { syntheticTest } from './teaching-tests-fixture.mjs'

export async function seedRichTestPreview(fixture, photos, today) {
  const { db, ids, groups, rpc } = fixture
  const group = groups[0]
  const mutate = (actor, action, values) => rpc(actor, 'xelay_teaching_test_mutate', [action, JSON.stringify({ ...values, expected_user_id: actor })])
  await db.query("update teaching_courses set title='Математика та економіка' where id=$1", [ids.course])
  for (const [key, first, last] of [['owner', 'Олена', 'Савчук'], ['studentA', 'Марія', 'Коваленко'], ['headA', 'Андрій', 'Бондаренко'], ['studentB', 'Данило', 'Мельник']]) {
    await db.query('update public.profiles set first_name=$1,last_name=$2 where id=$3', [first, last, ids[key]])
    await db.query('update public.teaching_entries set full_name=$1 where user_id=$2', [`${last} ${first}`, ids[key]])
  }
  const image = async (bytes, alt) => {
    const receipt = await rpc(ids.owner, 'xelay_teaching_test_question_image_upload', [ids.course, ids.owner, bytes.toString('base64')])
    return { id: receipt.id, mime_type: 'image/jpeg', alt }
  }
  const parabola = await image(photos.parabola, 'Координатна площина з параболою, гілки вгору')
  const line = await image(photos.line, 'Координатна площина з прямою, що зростає')
  const choice = (id, text, options) => ({ id, text, kind: 'choice', points: 1, time_limit_seconds: 120, partial_credit: false,
    buckets: [], options, answer: options[0].id })
  const questions = [
    choice('graph', 'Оберіть графік функції \\(y=x^2\\).', [
      { id: 'parabola', text: '', images: [parabola] }, { id: 'line', text: '', images: [line] },
      { id: 'circle', text: 'Коло радіуса \\(2\\)' }, { id: 'constant', text: 'Горизонтальна пряма \\(y=2\\)' },
    ]),
    choice('root', 'Чому дорівнює \\(\\sqrt{81} + \\frac{4}{2}\\)?\nДовідка: https://en.wikipedia.org/wiki/Square_root', [
      { id: 'eleven', text: '\\(11\\)' }, { id: 'nine', text: '\\(9\\)' },
      { id: 'fourteen', text: '\\(14\\)' }, { id: 'seven', text: '\\(7\\)' },
    ]),
    choice('price', 'Ціна зросла зі 100 до 120 грн. На скільки відсотків вона зросла?', [
      { id: '20', text: '\\(20\\%\\)' }, { id: '25', text: '\\(25\\%\\)' },
      { id: '10', text: '\\(10\\%\\)' }, { id: '80', text: '\\(80\\%\\)' },
    ]),
  ]
  const common = { questions, journal_date: today, duration_seconds: 600, max_points: 12, bonus_percent: 0, bonus_points: 0, discourage_capture: true }
  const activeId = randomUUID(), reviewId = randomUUID(), draftId = randomUUID()
  await mutate(ids.owner, 'save_test', syntheticTest(ids.course, [group], { ...common, id: activeId, title: 'Математика · формули та графіки', allow_external_links: true }))
  await mutate(ids.owner, 'save_test', syntheticTest(ids.course, [group], { ...common, id: draftId, title: 'Чернетка · спробуйте вставку з Word', status: 'draft' }))
  await mutate(ids.owner, 'save_test', syntheticTest(ids.course, [group], { ...common, id: reviewId, title: 'Результати · дві здані роботи', draw_count: 2,
    shuffle_answers: true, variants: [{ id: randomUUID(), title: 'Інший набір', questions: [questions[0], questions[2]].map(question => ({ ...question, id: `alt-${question.id}` })) }] }))
  for (const actor of [ids.studentA, ids.headA]) {
    let result = await mutate(actor, 'start', { id: reviewId, group_id: group })
    for (let index = 0; index < result.attempt.question_count; index++) {
      const question = result.attempt.current_question
      if (index === 0 || actor === ids.headA) result = await mutate(actor, 'save_answer', { id: reviewId, version: result.attempt.version, question_id: question.id, answer: question.options[0].id })
      if (index < result.attempt.question_count - 1) result = await mutate(actor, 'navigate', { id: reviewId, version: result.attempt.version, index: index + 1 })
    }
    await mutate(actor, 'finish', { id: reviewId, version: result.attempt.version })
  }
  const review = await rpc(ids.owner, 'xelay_teaching_test', [reviewId])
  await mutate(ids.owner, 'close_test', { id: reviewId, version: review.test.version, confirm_close_all: true })
  return { activeId, reviewId, draftId }
}
