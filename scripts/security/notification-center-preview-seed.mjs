import { randomUUID } from 'node:crypto'
import { seedCourseModulesPreview } from './course-modules-preview-seed.mjs'

export async function seedNotificationCenterPreview(fx) {
  const seed = await seedCourseModulesPreview(fx, { advanced: true })
  const { db, ids, groups, rpc } = fx
  const audience = [{ group_id: groups[0], audience_mode: 'all', subgroup_ids: [], team_ids: [] }]
  const announcementId = randomUUID()
  await rpc(ids.owner, 'xelay_teaching_audience_mutate', ['save_announcement', JSON.stringify({ id: announcementId, version: 0, course_id: ids.course, expected_user_id: ids.owner,
    title: 'Завтра зустрічаємося онлайн', body: 'Завтрашнє заняття проведемо онлайн. Посилання знайдете в розкладі. Підтвердьте ознайомлення, щоб я бачила, що ви отримали повідомлення.', targets: audience, requires_acknowledgement: true })])
  await rpc(ids.owner, 'xelay_teaching_audience_mutate', ['save_announcement', JSON.stringify({ id: randomUUID(), version: 0, course_id: ids.course, expected_user_id: ids.owner,
    title: 'Матеріали до наступної теми', body: 'Короткий конспект уже в матеріалах предмета. Його можна переглянути у зручний час.', targets: audience, requires_acknowledgement: false })])
  for (const [recipient, subject] of [[ids.studentA, 'Ви отримали відповідь на запитання про підготовку до семінару.'], [ids.headA, 'Одногрупник відповів на ваше запитання.'], [ids.studentB, 'Повідомлення тільки для іншої групи.']]) {
    await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$2,'Олена Прикладенко','answer',$3)", [recipient, ids.owner, subject])
  }
  await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message,study_group_id,teaching_course_id,teaching_event_key) values($1,$2,'Марія Прикладенко','teaching_update','Є робота, яка очікує на перевірку.',$3,$4,$5)", [ids.owner, ids.studentA, groups[0], ids.course, 'classroom-submit:' + seed.assignmentId + ':1'])
  await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message,study_group_id,academic_event_key,academic_tab,delivery_priority) values($1,$2,'Андрій Прикладенко','study_group_update','Час наступної пари змінено. Перегляньте актуальний розклад.',$3,$4,'timetable','urgent')", [ids.studentA, ids.headA, groups[0], 'academic:preview-timetable:' + randomUUID()])
  for (let index = 0; index < 44; index++) await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message,created_at) values($1,$2,'Спільнота Xelay','answer',$3,clock_timestamp()-make_interval(days=>2,mins=>$4))", [ids.studentA, ids.owner, 'Приклад зі збереженої історії · ' + (index + 1), index])
  // A separate fixture recipient demonstrates daily mail without generating
  // any external messages. The real sender can be run only with the fake provider.
  await fx.preferences(ids.headA, { category_settings: { community: { in_app: true, email: 'daily' } } })
  for (let index = 0; index < 3; index++) await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$2,'Спільнота Xelay','answer','Подія для щоденної добірки')", [ids.headA, ids.owner])
  await db.exec("update notification_email_runtime set worker_enabled=true,last_heartbeat_at=clock_timestamp(),paused_until=null,pause_reason=null")
  return { ...seed, announcementId }
}
