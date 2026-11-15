import { randomUUID } from 'node:crypto'
import { syntheticTest } from './teaching-tests-fixture.mjs'

export async function seedImportVariantsPreview(fx) {
  const { ids, groups, testMutate } = fx
  const options = [
    { id: 'idea', text: 'Сформулювати мету' },
    { id: 'skip', text: 'Пропустити планування' },
    { id: 'plan', text: 'Скласти план роботи' },
    { id: 'do', text: 'Виконати заплановані дії' },
    { id: 'forget', text: 'Забути про результат' },
  ]
  const question = {
    id: 'three-of-five', kind: 'sequence_select', text: 'Оберіть три доречні етапи роботи й розташуйте їх у правильному порядку.',
    points: 3, time_limit_seconds: null, partial_credit: true, selection_count: 3, options, buckets: [],
    answer: ['idea', 'plan', 'do'],
  }
  const definition = syntheticTest(ids.course, [groups[0]], {
    id: randomUUID(), title: 'Новий тип і два варіанти · приклад',
    description: 'Варіант призначається випадково на початку спроби. В обох є послідовність із зайвими елементами.',
    base_variant_title: 'Планування проєкту', questions: [question], bonus_percent: 0, bonus_points: 0,
    variants: [{ id: 'review-variant', title: 'Перевірка результату', questions: [{
      ...question, id: 'three-of-five-review', text: 'Оберіть три етапи перевірки роботи й розташуйте їх у порядку виконання.',
      options: [
        { id: 'read', text: 'Перечитати умову' }, { id: 'delete', text: 'Видалити всю роботу' },
        { id: 'compare', text: 'Зіставити результат з умовою' }, { id: 'correct', text: 'Виправити знайдені помилки' },
        { id: 'guess', text: 'Не перевіряти результат' },
      ], answer: ['read', 'compare', 'correct'],
    }] }],
  })
  await testMutate(ids.owner, 'save_test', definition)
  const started = await testMutate(ids.headA, 'start', { id: definition.id, group_id: groups[0] })
  const issued = started.attempt.current_question
  const answer = issued.id === question.id ? question.answer : definition.variants[0].questions[0].answer
  const saved = await testMutate(ids.headA, 'save_answer', {
    id: definition.id, version: started.attempt.version, question_id: issued.id, answer,
  })
  await testMutate(ids.headA, 'finish', { id: definition.id, version: saved.attempt.version })
}
