import { randomUUID } from 'node:crypto'

// Synthetic data only. Uses the real authenticated timetable and teaching flows.
export async function seedJournalSchedulePreview(fx) {
  const { db, ids, groups } = fx
  const dates = (await db.query("select (clock_timestamp() at time zone 'Europe/Kyiv')::date::text today,((clock_timestamp() at time zone 'Europe/Kyiv')::date+1)::text tomorrow,((clock_timestamp() at time zone 'Europe/Kyiv')::date+2)::text laboratory,((clock_timestamp() at time zone 'Europe/Kyiv')::date+14)::text last")).rows[0]
  const subject = (await db.query('select coalesce(s.name,c.title) name from teaching_course_groups g join teaching_courses c on c.id=g.course_id left join study_group_seminar_subjects s on s.id=g.subject_id where g.course_id=$1 and g.group_id=$2', [ids.course, groups[0]])).rows[0].name
  async function lesson(type, day, start, end) {
    const id = randomUUID()
    await fx.asUser(ids.headA, `insert into study_group_schedule(id,group_id,weekday,starts_at,ends_at,subject,lesson_type,valid_from,valid_until,created_by)
      values($1,$2,extract(isodow from $3::date),$4,$5,$6,$7,$3,$8,$9)`, [id, groups[0], day, start, end, subject, type, dates.last, ids.headA])
    return id
  }
  const lecture = await lesson('lecture', dates.today, '08:00', '09:20')
  const seminar = await lesson('seminar', dates.tomorrow, '09:40', '11:00')
  const laboratory = await lesson('lab', dates.laboratory, '11:20', '12:40')
  const subjectId = (await db.query('select id from study_group_seminar_subjects where group_id=$1 and name=$2', [groups[0], subject])).rows[0].id
  await db.query('update teaching_course_groups set subject_id=$3 where course_id=$1 and group_id=$2', [ids.course, groups[0], subjectId])
  await db.query("update teaching_courses set grading_rules=jsonb_set(grading_rules,'{presets}',$2::jsonb) where id=$1", [ids.course, JSON.stringify([{ id: 'seminar-example', name: 'Усна відповідь на семінарі', work_type: 'Семінар', category: '', max_points: 7 }])])
  const publication = async (schedule, date, title, body, maximum = null) => fx.classroom(ids.owner, 'save_group_assignment', {
    id: randomUUID(), version: 0, expected_user_id: ids.owner, course_id: ids.course, title, body, status: 'published', links: [], attachments: [],
    max_points: maximum, category: '', submission_mode: 'individual', targets: [{ group_id: groups[0], lesson_date: date, schedule_item_id: schedule,
      placement_mode: 'lesson', due_at: `${date}T16:00:00Z`, audience_mode: 'all', subgroup_ids: [], team_ids: [] }],
  })
  await publication(lecture, dates.today, 'Передивитися конспект лекції', 'Повторіть поняття попиту та пропозиції. Підготуйте один приклад зміни попиту.')
  await publication(seminar, dates.tomorrow, 'Підготовка до семінару', 'Прочитайте розділ 2 і дайте відповіді на запитання 1–3. На семінарі обговоримо приклади з вашого досвіду.')
  await publication(laboratory, dates.laboratory, 'Лабораторна робота: графік попиту', 'Побудуйте графік за таблицею і поясніть зміщення кривої. Завантажте результат до лабораторної роботи.', 10)
  await fx.asUser(ids.headA, 'insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by) values($1,$2,$3,$4,$5)',
    [groups[0], seminar, dates.tomorrow, 'Додатково від старости: принесіть приклади до третього запитання.', ids.headA])
  return { ...dates, lecture, seminar, laboratory }
}
