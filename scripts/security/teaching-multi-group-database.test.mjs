// Real canonical PostgreSQL writers with fictional users and isolated storage.
// No Supabase, private accounts, notifications provider, production or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createTeachingScopedFixture } from './teaching-scoped-fixture.mjs'

const read = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')
const migration = await read('202610270002_teaching_multi_group_assignments.sql')
test('multi-group assignments keep canonical permissions, atomic receipts and private group work', async t => {
  const fx = await createTeachingScopedFixture()
  t.after(() => fx.close())
  const { db, ids, groups, dates, rpc, mutate, classroom, item } = fx
  await db.exec(await read('202610270001_teaching_group_scopes.sql'))
  const canonical = async () => (await db.query(`select oid::regprocedure::text signature,pg_get_functiondef(oid) body,proacl::text
    from pg_proc where oid in('xelay_teaching_mutate(text,jsonb)'::regprocedure,'xelay_classroom_assignment(uuid,uuid)'::regprocedure,
      'xelay_publish_due_teaching_items()'::regprocedure,'xelay_classroom_assignment_mutate(text,jsonb)'::regprocedure) order by signature`)).rows
  const before = await canonical()
  await db.exec(migration.replace(/\r?\n/g, '\r\n'))
  assert.deepEqual(await canonical(), before, 'New wrapper leaves canonical writers, projections, scheduling and ACLs untouched')
  const save = (who, payload, options) => rpc(who, 'xelay_teaching_save_multi_assignment', [JSON.stringify(payload)], options)
  const count = async table => Number((await db.query('select count(*) n from ' + table)).rows[0].n)
  const newPayload = patch => ({ expected_user_id: ids.owner, id: randomUUID(), version: 0, course_id: ids.course,
    title: 'Synthetic shared homework', body: 'One shared condition', links: ['https://example.test/shared'],
    link_labels: { 'https://example.test/shared': 'Synthetic source' }, attachments: [], status: 'published',
    submission_format: 'written', work_type: 'Synthetic practice', max_points: 10, category: '',
    targets: groups.map((group, index) => ({ group_id: group, lesson_date: index ? dates.lesson_b : dates.lesson_a,
      schedule_item_id: null, placement_mode: 'unplaced', due_at: (index ? dates.lesson_b : dates.lesson_a) + 'T15:00:00Z',
      closes_at: (index ? dates.lesson_b : dates.lesson_a) + 'T18:00:00Z' })), ...patch })
  let assignment, colleagueLink

  await t.test('anonymous, unrelated and stale actors cannot create; private tables remain inaccessible', async () => {
    const payload = newPayload()
    await assert.rejects(save(null, payload, { role: 'anon' }), error => error.code === '42501')
    await assert.rejects(save(ids.outsider, { ...payload, expected_user_id: ids.outsider }), /TEACHING_ACCESS_EXPIRED_OR_UNVERIFIED/)
    await assert.rejects(save(ids.owner, { ...payload, expected_user_id: ids.colleague }), /ACTOR_CHANGED/)
    for (const table of ['teaching_items', 'teaching_item_targets', 'teaching_create_receipts', 'teaching_submissions']) {
      await assert.rejects(fx.asUser(ids.studentA, 'select * from ' + table), error => error.code === '42501')
    }
  })
  await t.test('one canonical item has independent targets and one activity per group', async () => {
    assignment = newPayload()
    const receipt = await save(ids.owner, assignment)
    assert.equal(receipt.id, assignment.id); assert.equal(receipt.version, 1)
    const targets = (await db.query('select group_id,due_at,closes_at,lesson_date from teaching_item_targets where item_id=$1 order by group_id', [assignment.id])).rows
    assert.equal(targets.length, 2)
    assert.notEqual(targets[0].due_at, targets[1].due_at)
    const activities = (await db.query('select group_id,item_id,work_type from teaching_activities where item_id=$1', [assignment.id])).rows
    assert.equal(activities.length, 2)
    assert.deepEqual(new Set(activities.map(row => row.group_id)), new Set(groups))
    assert.ok(activities.every(row => row.work_type === assignment.work_type))
    assert.equal((await item(assignment.id)).body, assignment.body)
  })
  await t.test('exact retry returns the same receipt and creates no duplicate activity or notification', async () => {
    const before = { items: await count('teaching_items'), activities: await count('teaching_activities'), notifications: await count('notifications') }
    assert.deepEqual(await save(ids.owner, assignment), { id: assignment.id, version: 1 })
    assert.deepEqual({ items: await count('teaching_items'), activities: await count('teaching_activities'), notifications: await count('notifications') }, before)
    await assert.rejects(save(ids.owner, { ...assignment, title: 'Changed ambiguous retry' }), /CONFLICT/)
    await assert.rejects(save(ids.owner, { ...assignment, targets: [...assignment.targets].reverse() }), /CONFLICT/)
  })
  await t.test('a bad second target rolls back content, targets, activities, receipts and notifications together', async () => {
    const before = Object.fromEntries(await Promise.all(['teaching_items', 'teaching_item_targets', 'teaching_activities', 'teaching_create_receipts', 'notifications'].map(async table => [table, await count(table)])))
    const payload = newPayload()
    payload.targets[1].closes_at = dates.start + 'T00:00:00Z'
    await assert.rejects(save(ids.owner, payload), /CLOSE|constraint|INPUT/i)
    assert.equal(await item(payload.id), undefined)
    assert.deepEqual(Object.fromEntries(await Promise.all(Object.keys(before).map(async table => [table, await count(table)]))), before)
    for (const patch of [{ targets: [payload.targets[0], payload.targets[0]] }, { targets: [payload.targets[0]] }, { targets: [] }, { version: 1 }, { source_item_id: assignment.id }, { targets: [payload.targets[0], { ...payload.targets[1], group_id: randomUUID() }] }]) {
      await assert.rejects(save(ids.owner, newPayload(patch)), /INPUT|FORBIDDEN/)
    }
  })
  await t.test('selected-group colleague cannot batch to another group or bypass through legacy canonical API', async () => {
    const invite = await mutate(ids.owner, 'invite_teacher', { id: randomUUID(), course_id: ids.course, user_id: ids.colleague,
      permissions: ['assignments', 'grades'], group_scope: 'selected', group_ids: [groups[0]] })
    colleagueLink = invite.id
    await mutate(ids.colleague, 'respond_teacher', { teacher_link_id: invite.id, accept: true })
    const denied = newPayload({ expected_user_id: ids.colleague })
    await assert.rejects(save(ids.colleague, denied), /FORBIDDEN/)
    await assert.rejects(mutate(ids.colleague, 'save_assignment', denied), /FORBIDDEN/)
    assert.equal(await item(denied.id), undefined)
    const allowed = newPayload({ expected_user_id: ids.colleague, targets: [denied.targets[0]] })
    await rpc(ids.colleague, 'xelay_teaching_classified_assignment', ['save_group_assignment', JSON.stringify(allowed)])
    await assert.rejects(save(ids.colleague, assignment), /ACTOR_CHANGED/)
  })
  await t.test('students access only their own group target and own submission; shared condition never shares work', async () => {
    for (const [index, student] of [ids.studentA, ids.studentB].entries()) {
      const visible = await rpc(student, 'xelay_classroom_assignment', [assignment.id, groups[index]])
      assert.equal(visible.item.title, assignment.title)
      assert.deepEqual(visible.item.targets.map(target => target.group_id), [groups[index]])
      await assert.rejects(rpc(student, 'xelay_classroom_assignment', [assignment.id, groups[1 - index]]), /FORBIDDEN/)
      const id = randomUUID()
      await classroom(student, 'reserve_submission', { id, version: 0, item_id: assignment.id, group_id: groups[index] })
      await classroom(student, 'save_submission', { id, version: 1, body: 'Private synthetic answer ' + index, links: [], attachments: [], status: 'submitted' })
      await classroom(student, 'submit_submission', { id, version: 2 })
    }
    for (const [index, student] of [ids.studentA, ids.studentB].entries()) {
      const work = await rpc(student, 'xelay_classroom_assignment', [assignment.id, groups[index]])
      assert.equal(work.my_submission.user_id, student)
      assert.ok(!JSON.stringify(work).includes('Private synthetic answer ' + (1 - index)))
      const staff = await rpc(ids.owner, 'xelay_classroom_assignment', [assignment.id, groups[index]])
      assert.deepEqual(staff.submissions.map(row => row.user_id), [student])
    }
  })
  await t.test('single-group editing still forks shared content while retaining only that group’s work', async () => {
    const forkId = randomUUID(), target = assignment.targets[0]
    await rpc(ids.owner, 'xelay_teaching_classified_assignment', ['save_group_assignment', JSON.stringify({ ...assignment,
      id: forkId, source_item_id: assignment.id, source_version: 1, targets: [target], title: 'Synthetic edited group A' })])
    assert.equal((await item(assignment.id)).title, assignment.title)
    assert.equal((await item(forkId)).title, 'Synthetic edited group A')
    const a = await rpc(ids.studentA, 'xelay_classroom_assignment', [forkId, groups[0]])
    const b = await rpc(ids.studentB, 'xelay_classroom_assignment', [assignment.id, groups[1]])
    assert.equal(a.my_submission.body, 'Private synthetic answer 0'); assert.equal(b.my_submission.body, 'Private synthetic answer 1')
    assert.deepEqual(b.item.targets.map(target => target.group_id), [groups[1]])
  })
  await t.test('scheduled batch stays invisible and sends no early notifications; current scopes are checked at actual publication', async () => {
    // PGlite has no pg_cron background worker. Emulate only readiness, while
    // executing the actual unchanged canonical scheduler and all access guards.
    await db.exec("create or replace function public.xelay_private_teaching_scheduler_ready() returns boolean language sql stable security definer set search_path='' as $$select true$$")
    const payload = newPayload({ status: 'scheduled', publish_at: new Date(Date.now() + 3600_000).toISOString() })
    const beforeNotifications = await count('notifications')
    await save(ids.owner, payload)
    assert.equal((await item(payload.id)).status, 'scheduled')
    assert.equal(await count('notifications'), beforeNotifications)
    for (const [index, student] of [ids.studentA, ids.studentB].entries()) await assert.rejects(rpc(student, 'xelay_classroom_assignment', [payload.id, groups[index]]), /FORBIDDEN/)
    assert.equal((await db.query('select xelay_publish_due_teaching_items() n')).rows[0].n, 0)
    assert.equal(await count('notifications'), beforeNotifications)
    await db.query("update teaching_items set publish_at=clock_timestamp()-interval '1 second' where id=$1", [payload.id])
    assert.equal((await db.query('select xelay_publish_due_teaching_items() n')).rows[0].n, 1)
    assert.equal((await item(payload.id)).status, 'published')
    assert.ok(await count('notifications') > beforeNotifications)
  })
  await t.test('permission removal invalidates exact batch retry and postpones a scheduled batch atomically', async () => {
    const update = groupIds => mutate(ids.owner, 'update_teacher', { teacher_link_id: colleagueLink,
      permissions: ['assignments', 'grades'], group_scope: 'selected', group_ids: groupIds })
    await update(groups)
    const payload = newPayload({ expected_user_id: ids.colleague, status: 'scheduled', publish_at: new Date(Date.now() + 3600_000).toISOString() })
    await save(ids.colleague, payload)
    await update([groups[0]])
    const before = await count('notifications')
    await assert.rejects(save(ids.colleague, payload), /FORBIDDEN/)
    await db.query("update teaching_items set publish_at=clock_timestamp()-interval '1 second' where id=$1", [payload.id])
    assert.equal((await db.query('select xelay_publish_due_teaching_items() n')).rows[0].n, 0)
    assert.equal((await item(payload.id)).status, 'scheduled')
    assert.equal(await count('notifications'), before)
    const checks = (await db.query('select error_code from teaching_scheduled_publication_checks where item_id=$1', [payload.id])).rows
    assert.equal(checks.length, 1)
    assert.match(checks[0].error_code, /ACCESS_CHANGED/)
    await update(groups)
    await db.query("update teaching_scheduled_publication_checks set next_attempt_at=clock_timestamp()-interval '1 second' where item_id=$1", [payload.id])
    assert.equal((await db.query('select xelay_publish_due_teaching_items() n')).rows[0].n, 1)
    assert.equal((await item(payload.id)).status, 'published')
    assert.equal((await db.query('select count(*)::int n from teaching_item_targets where item_id=$1', [payload.id])).rows[0].n, 2)
  })
})
