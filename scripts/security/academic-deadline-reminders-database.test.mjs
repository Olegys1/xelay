// Offline PostgreSQL. Synthetic academic records, real notification queue.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createFixture } from './fixture.mjs'

const id = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const sqlId = n => "'" + id(n) + "'"
const migration = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')
const denied = promise => assert.rejects(promise, { code: '42501' })

test('academic deadlines use the current audience, one receipt per deadline, and a scoped email lease', async t => {
  const fx = await createFixture({ migrations: [
    '202609260001_profile_connections_messages.sql',
    '202610010004_email_notifications.sql',
  ] })
  const { db, asUser, seedUser } = fx
  t.after(() => fx.close())
  await db.exec('alter table public.messages add column deleted_at timestamptz')
  for (const name of ['202610070008_notification_email_unread.sql', '202610140002_all_notification_email.sql']) {
    await db.exec(await migration(name))
  }
  await db.exec(`
    create table public.study_groups(id uuid primary key,representative_id uuid);
    create view public.xelay_listed_study_groups as select * from public.study_groups where id<>${sqlId(2)};
    create table public.study_group_members(group_id uuid,user_id uuid,status text);
    create table public.study_group_schedule(id uuid primary key,group_id uuid,weekday smallint,valid_from date,valid_until date,
      week_pattern text,week_anchor_date date,excluded_dates date[]);
    create table public.study_group_homework(id uuid primary key,group_id uuid,schedule_item_id uuid,lesson_date date,
      due_at timestamptz,body text,url text,resource_links jsonb,attachments jsonb);
    create table public.study_group_long_term_tasks(id uuid primary key,group_id uuid,due_date date,closed_at timestamptz);
    create table public.teaching_courses(id uuid primary key,archived_at timestamptz);
    create table public.teaching_items(id uuid primary key,course_id uuid,kind text,status text,withdrawn_at timestamptz,submission_mode text);
    create table public.teaching_item_targets(item_id uuid,group_id uuid,due_at timestamptz,lesson_date date);
    create table public.teaching_submissions(item_id uuid,group_id uuid,user_id uuid,status text,team_id uuid);
    create function public.xelay_classroom_student(uuid,uuid,uuid) returns boolean language sql stable as
      $$ select $3 not in (${sqlId(11)},${sqlId(17)}) $$;
    create function public.xelay_private_teaching_my_team(uuid,uuid,uuid) returns uuid language sql stable as
      $$ select case when $3=${sqlId(15)}::uuid then ${sqlId(99)}::uuid end $$;
    create function public.xelay_private_teaching_submission_owner(s public.teaching_submissions,u uuid)
      returns boolean language sql stable as $$
        select case when s.team_id is null then s.user_id=u else s.team_id=public.xelay_private_teaching_my_team(s.item_id,s.group_id,u) end
      $$;
    create function public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date)
      returns boolean language sql stable as $$ select $6 between $2 and $3 $$;
    alter table public.notifications add column study_group_id uuid;
  `)
  for (const name of ['202611030101_academic_deadline_candidates.sql', '202611030102_academic_deadline_reminders.sql']) {
    await db.exec(await migration(name))
  }
  for (let n = 11; n <= 17; n++) await seedUser(id(n))
  await db.exec(`
    update auth.users set banned_until='infinity' where id=${sqlId(16)};
    insert into public.study_groups values(${sqlId(1)},${sqlId(11)}),(${sqlId(2)},${sqlId(11)});
    insert into public.study_group_members
      select ${sqlId(1)},id,case when id=${sqlId(13)} then 'pending' else 'accepted' end from auth.users;
    insert into public.notification_preferences(user_id,notifications_enabled,email_notifications_enabled)
      values(${sqlId(14)},true,false),(${sqlId(17)},false,false);
    insert into public.teaching_courses values(${sqlId(20)},null),(${sqlId(21)},now());
    insert into public.teaching_items values
      (${sqlId(22)},${sqlId(20)},'assignment','published',null,'individual'),
      (${sqlId(23)},${sqlId(20)},'assignment','published',null,'team'),
      (${sqlId(24)},${sqlId(20)},'assignment','draft',null,'individual'),
      (${sqlId(25)},${sqlId(21)},'assignment','published',null,'individual');
    insert into public.teaching_item_targets
      select id,${sqlId(1)},now()+interval '6 hours',date '2026-11-03' from public.teaching_items;
    insert into public.teaching_submissions values
      (${sqlId(22)},${sqlId(1)},${sqlId(14)},'submitted',null),
      (${sqlId(22)},${sqlId(1)},${sqlId(15)},'returned',null),
      (${sqlId(23)},${sqlId(1)},${sqlId(12)},'reviewed',${sqlId(99)});
    insert into public.study_group_schedule values
      (${sqlId(30)},${sqlId(1)},2,'2026-11-03','2026-11-03','every',null,'{}'),
      (${sqlId(31)},${sqlId(1)},2,'2026-11-03','2026-11-03','every',null,'{2026-11-03}'),
      (${sqlId(32)},${sqlId(2)},2,'2026-11-03','2026-11-03','every',null,'{}');
    insert into public.study_group_homework(id,group_id,schedule_item_id,lesson_date,due_at,body,resource_links,attachments)
      values(${sqlId(33)},${sqlId(1)},${sqlId(30)},'2026-11-03',now()+interval '6 hours','Homework','[]','[]'),
        (${sqlId(34)},${sqlId(1)},${sqlId(30)},'2026-11-03',null,'Undated homework','[]','[]'),
        (${sqlId(35)},${sqlId(1)},${sqlId(31)},'2026-11-03',now()+interval '6 hours','Cancelled lesson','[]','[]'),
        (${sqlId(36)},${sqlId(2)},${sqlId(32)},'2026-11-03',now()+interval '6 hours','Hidden test group','[]','[]');
    insert into public.study_group_long_term_tasks values
      (${sqlId(40)},${sqlId(1)},(now() at time zone 'Europe/Kyiv')::date,null),
      (${sqlId(41)},${sqlId(1)},(now() at time zone 'Europe/Kyiv')::date,now());
    update public.notification_email_runtime set worker_enabled=true,last_heartbeat_at=clock_timestamp();
  `)

  const queue = async () => (await db.query('select public.xelay_queue_academic_deadline_reminders() as n')).rows[0].n
  const service = (sql, params) => asUser(null, sql, params, { role: 'service_role' })
  const lease = async (source, recipient = 12) => {
    const { rows: [job] } = await db.query(
      'select q.id from academic_deadline_reminder_receipts r join notification_email_outbox q using(notification_id) where r.source_id=$1 and r.recipient_id=$2',
      [id(source), id(recipient)])
    return (await service('select * from public.xelay_claim_notification_email($1)', [job.id])).rows[0]
  }
  const contextSql = 'select public.xelay_academic_deadline_email_context($1,$2) as result'
  const context = async (job, token = job.lock_token) => (await service(contextSql, [job.id, token])).rows[0].result

  await t.test('only eligible upcoming records are queued, and a retry adds no notifications or emails', async () => {
    assert.equal(await queue(), 10)
    assert.equal(await queue(), 0)
    const { rows } = await db.query('select source_id,recipient_id from public.academic_deadline_reminder_receipts order by source_id,recipient_id')
    assert.deepEqual(rows.map(row => [row.source_id, row.recipient_id]), [
      ...[12, 15].map(user => [id(22), id(user)]),
      ...[33, 40].flatMap(source => [11, 12, 14, 15].map(user => [id(source), id(user)])),
    ])
    assert.equal((await db.query("select count(*)::int as n from public.notification_email_outbox where notification_type='academic_deadline'")).rows[0].n, 8)
  })

  await t.test('a live lease is required and exposes only the matching deadline', async () => {
    const job = await lease(22)
    const eligible = await context(job)
    assert.equal(eligible.eligible, true)
    assert.equal(eligible.source_id, id(22))
    assert.equal(eligible.group_id, id(1))
    assert.equal((await context(job, id(98))).eligible, false)
    await denied(asUser(id(12), contextSql, [job.id, job.lock_token]))
    await denied(service('select public.xelay_queue_academic_deadline_reminders()'))
    await denied(asUser(id(12), 'select * from public.academic_deadline_reminder_receipts'))
    await denied(asUser(id(12), "insert into public.notifications(recipient_id,actor_id,actor_name,type,message) values($1,$1,'Xelay','academic_deadline','forged')", [id(12)]))
    await denied(db.query('update public.notifications set message=$1 where id::text=$2', ['changed', job.notification_id]))
    const marked = await asUser(id(12), 'update public.notifications set is_read=true where id::text=$1 returning is_read', [job.notification_id])
    assert.deepEqual(marked.rows, [{ is_read: true }])
    assert.equal((await context(job)).eligible, true)

    await db.query("insert into public.teaching_submissions values($1,$2,$3,'submitted',null)", [id(22), id(1), id(12)])
    assert.equal((await context(job)).eligible, false)
  })

  await t.test('rescheduling creates a fresh receipt and prevents delivery of the old email', async () => {
    const job = await lease(33)
    assert.equal((await context(job)).eligible, true)
    await db.query("update public.study_group_homework set due_at=due_at+interval '1 hour' where id=$1", [id(33)])
    assert.equal((await context(job)).eligible, false)
    assert.equal(await queue(), 4)
    assert.equal(await queue(), 0)
  })
})
