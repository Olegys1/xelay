import { createHash, randomUUID } from 'node:crypto'
import { syntheticTest } from './teaching-tests-fixture.mjs'

export async function addPreviewLectureFile(fixture, clips, bytes, name, mime) {
  const { db, ids, rpc, asUser } = fixture
  const extension = mime === 'video/webm' ? 'webm' : 'mp4'
  const storage_path = `${ids.course}/${ids.owner}/${randomUUID()}.${extension}`
  const file = { storage_path, name, mime_type: mime, size: bytes.length }
  await db.query("insert into storage.objects(bucket_id,name,owner,owner_id,metadata) values('xelay-teaching-files',$1,$2,$3,$4::jsonb)",
    [storage_path, ids.owner, ids.owner, JSON.stringify({ size: bytes.length, mimetype: mime })])
  const candidate = await rpc(ids.owner, 'xelay_upload_scan_candidate', ['xelay-teaching-files', storage_path])
  const digest = createHash('sha256').update(bytes).digest('hex')
  await asUser(null, 'select public.xelay_record_upload_content_verification($1::jsonb,$2,$3,$4,1) value',
    [JSON.stringify(candidate), digest, digest, mime], { role: 'service_role' })
  clips.set(storage_path, { bytes, mime })
  return file
}

export async function seedLectureCoursePreview(fixture, clips, clip, duration, today) {
  const { db, ids, groups, rpc } = fixture
  const group = groups[0]
  const testAction = (actor, action, payload) => rpc(actor, 'xelay_teaching_test_mutate', [action, JSON.stringify({ ...payload, expected_user_id: actor })])
  const question = (id, text, options) => ({
    id, text, kind: 'choice', points: 1, time_limit_seconds: null, partial_credit: false, buckets: [],
    options: options.map((text, index) => ({ id: String(index + 1), text })), answer: '1',
  })
  const topics = [
    { title: 'Попит і пропозиція', text: 'Як зміна ціни впливає на поведінку покупців і продавців.', questions: [
      question('demand', 'Що означає попит?', ['Готовність покупців придбати товар', 'Кількість продавців', 'Витрати виробника', 'Податок на продаж']),
      question('supply', 'Що може скоротити пропозицію?', ['Зростання витрат виробників', 'Зростання доходів покупців', 'Зниження витрат виробників', 'Додаткові продавці']),
    ] },
    { title: 'Ринкова рівновага', text: 'Де зустрічаються попит і пропозиція та як змінюється рівновага.', questions: [
      question('equilibrium', 'Коли ринок у рівновазі?', ['Попит дорівнює пропозиції', 'Попит завжди нульовий', 'Ціна максимальна', 'Немає продавців']),
      question('shift', 'Що зазвичай станеться з ціною, якщо попит зросте, а пропозиція не зміниться?', ['Ціна зросте', 'Ціна знизиться', 'Ціна стане нульовою', 'Пропозиція зникне']),
    ] },
  ]
  let previousTestItem = null
  for (const [position, topic] of topics.entries()) {
    const moduleId = randomUUID(), testId = randomUUID(), itemId = randomUUID()
    const file = await addPreviewLectureFile(fixture, clips, clip, `${topic.title}.mp4`, 'video/mp4')
    await testAction(ids.owner, 'save_test', syntheticTest(ids.course, [group], {
      id: testId, title: `Тест · ${topic.title}`, description: 'Два короткі запитання до лекції.', journal_date: today, work_type: 'Тест',
      questions: topic.questions, max_points: 10, bonus_percent: 0, bonus_points: 0,
      ...(position === 0 ? { retry_days: 5, retry_pass_percent: 60, closes_at: new Date(Date.now() + 14 * 86400000).toISOString() } : {}),
    }))
    await rpc(ids.owner, 'xelay_teaching_course_module_save', [JSON.stringify({
      id: moduleId, course_id: ids.course, title: topic.title, description: topic.text, position, status: 'published',
      version: 0, expected_user_id: ids.owner, group_ids: [group],
      prerequisite_item_ids: previousTestItem ? [previousTestItem] : [], release_delay_days: previousTestItem ? 5 : 0,
      items: [{ id: itemId, resource_type: 'test', resource_id: testId, required: true, completion: 'submitted', pass_percent: null, position: 0, prerequisite_item_ids: [] }],
      lecture: { file, duration_seconds: duration, test_item_id: itemId },
    })])
    previousTestItem = itemId
    if (position === 0) {
      await db.query(`insert into public.teaching_course_module_lecture_progress
        (module_id,group_id,user_id,storage_path,watched_seconds,heartbeat_at) values($1,$2,$3,$4,$5,clock_timestamp())`,
      [moduleId, group, ids.headA, file.storage_path, duration])
      let result = await testAction(ids.headA, 'start', { id: testId, group_id: group })
      for (const [index, item] of topic.questions.entries()) {
        result = await testAction(ids.headA, 'save_answer', { id: testId, version: result.attempt.version, question_id: item.id, answer: index === 0 ? '1' : '2' })
        if (index === 0) result = await testAction(ids.headA, 'navigate', { id: testId, version: result.attempt.version, index: 1 })
      }
      await testAction(ids.headA, 'finish', { id: testId, version: result.attempt.version })
    }
  }
  return {}
}
