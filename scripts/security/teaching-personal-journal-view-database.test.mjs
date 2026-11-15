// Real SQL preferences on an isolated in-memory database and synthetic identities.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { audienceFixture } from './teaching-audience-fixture.mjs'

test('personal journal display reloads per teacher/course/group without changing grades or legacy order, and shares version protection', async t => {
  const fx = await audienceFixture(); t.after(() => fx.close())
  for (const name of ['202611030104_academic_notification_priority.sql', '202611030106_teaching_common_deadline_notifications.sql',
    '202611040001_fix_teaching_gradebook_dispatch.sql', '202611040011_teaching_journal_preferences_absence.sql', '202611050070_teaching_personal_journal_view.sql']) {
    await fx.db.exec(await readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8'))
  }
  const { ids, groups, dates, mutate, rpc, db, asUser } = fx
  const works = []
  for (const title of ['Lecture', 'Seminar', 'Unscheduled test']) works.push((await mutate(ids.owner, 'save_activity', { id: randomUUID(), version: 0, course_id: ids.course, group_id: groups[0], title, category: '', activity_date: dates.lesson_a, max_points: 10 })).id)
  const entries = (await db.query('select id from teaching_entries where course_id=$1 and group_id=$2', [ids.course, groups[0]])).rows
  await mutate(ids.owner, 'save_grade', { activity_id: works[0], entry_id: entries[0].id, score: 5, comment: '', reason: '', version: 0 })
  const unchanged = async () => (await db.query('select to_jsonb(g) data from teaching_grades g order by id')).rows
  const before = await unchanged(), defaultView = { layout: 'combined', show_lectures: true, section: 'all' }
  const read = (actor = ids.owner, group = groups[0]) => rpc(actor, 'xelay_teaching_journal_preferences', [ids.course, group])
  const save = (actor, settings, version, expected = actor, group = groups[0]) => rpc(actor, 'xelay_teaching_save_journal_view', [ids.course, group, JSON.stringify(settings), version, expected])
  assert.deepEqual(await read(), { activity_ids: [], version: 0, view_settings: defaultView })
  const array = values => '{' + values.join(',') + '}'
  let order = await rpc(ids.owner, 'xelay_teaching_save_journal_preferences', [ids.course, groups[0], array([...works].reverse()), 0, ids.owner])
  assert.equal(order.version, 1)
  const settings = { layout: 'separate', show_lectures: true, section: 'lectures' }
  let saved = await save(ids.owner, settings, 1)
  assert.equal(saved.version, 2); assert.deepEqual(saved.activity_ids, [...works].reverse()); assert.deepEqual(saved.view_settings, settings)
  assert.deepEqual(await read(), saved)
  assert.deepEqual(await save(ids.owner, settings, 2), saved, 'An identical view is idempotent')
  await assert.rejects(save(ids.owner, { ...settings, section: 'seminars' }, 1), /CONFLICT/)
  order = await rpc(ids.owner, 'xelay_teaching_save_journal_preferences', [ids.course, groups[0], array(works), 2, ids.owner])
  assert.equal(order.version, 3); saved = await read(); assert.deepEqual(saved.activity_ids, works); assert.deepEqual(saved.view_settings, settings)
  await assert.rejects(save(ids.owner, settings, 2), /CONFLICT/)
  const invitation = await mutate(ids.owner, 'invite_teacher', { course_id: ids.course, user_id: ids.colleague, permissions: ['grades'], group_scope: 'selected', group_ids: [groups[0]] })
  await mutate(ids.colleague, 'respond_teacher', { teacher_link_id: invitation.id, accept: true })
  assert.deepEqual((await read(ids.colleague)).view_settings, defaultView)
  await save(ids.colleague, { layout: 'combined', show_lectures: false, section: 'all' }, 0)
  assert.deepEqual(await read(), saved); assert.deepEqual((await read(ids.owner, groups[1])).view_settings, defaultView)
  await assert.rejects(save(ids.colleague, settings, 0, ids.colleague, groups[1]), /FORBIDDEN/)
  await assert.rejects(read(ids.studentA), /FORBIDDEN/)
  await assert.rejects(save(ids.studentA, settings, 0), /FORBIDDEN/)
  await assert.rejects(save(ids.owner, settings, 3, ids.studentA), /ACTOR_CHANGED/)
  for (const invalid of [null, [], {}, { ...settings, layout: 'unknown' }, { ...settings, show_lectures: 'false' }, { ...settings, section: 'all' }, { ...settings, show_lectures: false }, { ...settings, user_id: ids.colleague }]) {
    await assert.rejects(save(ids.owner, invalid, 3), /INVALID_INPUT/)
  }
  await assert.rejects(asUser(ids.owner, 'select * from teaching_journal_preferences'), /permission denied/)
  assert.deepEqual(await unchanged(), before)
  assert.deepEqual(await read(), saved)
})
