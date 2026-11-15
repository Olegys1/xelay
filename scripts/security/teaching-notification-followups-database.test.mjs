// Offline PostgreSQL. Real notification queue and synthetic course scopes.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createFixture } from './fixture.mjs'

const id = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const sqlId = n => "'" + id(n) + "'"
const migration = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')
const monday = '2020-11-02T07:00:00Z'
const tuesday = '2020-11-03T07:00:00Z'

test('teacher followups use current scoped backlog and deduplicate weekdays', async t => {
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
    create table public.study_groups(id uuid primary key);
    create view public.xelay_listed_study_groups as select * from public.study_groups where id<>${sqlId(2)};
    create table public.teaching_courses(id uuid primary key,owner_id uuid,archived_at timestamptz);
    create table public.teaching_course_groups(course_id uuid,group_id uuid,status text);
    create table public.teaching_course_teachers(course_id uuid,user_id uuid,status text);
    create table public.teaching_items(id uuid primary key,course_id uuid,kind text,status text,withdrawn_at timestamptz);
    create table public.teaching_item_targets(item_id uuid,group_id uuid);
    create table public.teaching_submissions(id uuid primary key,item_id uuid,course_id uuid,group_id uuid,status text,submitted_at timestamptz,attempt integer,version integer default 1);
    create table public.teaching_grade_requests(id uuid,course_id uuid,group_id uuid,activity_id uuid,status text,created_at timestamptz,version integer);
    create table public.fixture_teaching_permissions(course_id uuid,group_id uuid,user_id uuid,permissions text[]);
    create function public.xelay_teaching_group_permissions(uuid,uuid,uuid) returns text[] language sql stable as
      $$ select permissions from public.fixture_teaching_permissions where course_id=$1 and group_id=$2 and user_id=$3 $$;
    create function public.xelay_teaching_has_current_access(uuid) returns boolean language sql stable as
      $$ select exists(select 1 from auth.users where id=$1 and deleted_at is null and banned_until is null) $$;
    create function public.xelay_private_grade_request_activity_visible(uuid) returns boolean language sql stable as
      $$ select $1<>${sqlId(99)}::uuid $$;
    create function public.xelay_classroom_staff(uuid,uuid,uuid) returns boolean language sql stable as
      $$ select public.xelay_teaching_group_permissions($1,$2,$3)&&array['assignments','grades']
        and exists(select 1 from public.teaching_course_groups where course_id=$1 and group_id=$2 and status='accepted') $$;
    alter table public.notifications add column teaching_course_id uuid,add column study_group_id uuid,add column teaching_event_key text;
  `)
  await db.exec(await migration('202611030103_teaching_notification_followups.sql'))
  await db.exec(await migration('202611030104_academic_notification_priority.sql'))
  for (let n=11;n<=17;n++) await seedUser(id(n))
  await db.exec(`
    update auth.users set banned_until='infinity' where id=${sqlId(15)};
    insert into public.study_groups values(${sqlId(1)}),(${sqlId(2)}),(${sqlId(3)});
    insert into public.teaching_courses values(${sqlId(20)},${sqlId(11)},null),(${sqlId(21)},${sqlId(11)},now());
    insert into public.teaching_course_groups values
      (${sqlId(20)},${sqlId(1)},'accepted'),(${sqlId(20)},${sqlId(2)},'accepted'),
      (${sqlId(20)},${sqlId(3)},'pending'),(${sqlId(21)},${sqlId(1)},'accepted');
    insert into public.teaching_course_teachers
      select ${sqlId(20)},id,case when id=${sqlId(14)} then 'pending' else 'accepted' end
      from auth.users where id<>${sqlId(11)};
    insert into public.fixture_teaching_permissions
      select ${sqlId(20)},${sqlId(1)},id,case
        when id=${sqlId(12)} then array['assignments']
        when id=${sqlId(13)} then array['materials'] else array['assignments','grades'] end
      from auth.users;
    insert into public.fixture_teaching_permissions values
      (${sqlId(20)},${sqlId(2)},${sqlId(11)},'{assignments,grades}'),
      (${sqlId(20)},${sqlId(3)},${sqlId(11)},'{assignments,grades}'),
      (${sqlId(21)},${sqlId(1)},${sqlId(11)},'{assignments,grades}');
    insert into public.notification_preferences(user_id,notifications_enabled,email_notifications_enabled)
      values(${sqlId(16)},false,false),(${sqlId(17)},true,false);
    insert into public.teaching_items values
      (${sqlId(22)},${sqlId(20)},'assignment','published',null),
      (${sqlId(23)},${sqlId(20)},'assignment','draft',null),
      (${sqlId(24)},${sqlId(21)},'assignment','published',null);
    insert into public.teaching_submissions values
      (${sqlId(30)},${sqlId(22)},${sqlId(20)},${sqlId(1)},'submitted','2020-10-31 00:00Z',1),
      (${sqlId(31)},${sqlId(22)},${sqlId(20)},${sqlId(1)},'submitted','2020-11-01 16:00Z',1),
      (${sqlId(32)},${sqlId(22)},${sqlId(20)},${sqlId(1)},'reviewed','2020-10-31 00:00Z',1),
      (${sqlId(33)},${sqlId(22)},${sqlId(20)},${sqlId(2)},'submitted','2020-10-31 00:00Z',1),
      (${sqlId(34)},${sqlId(22)},${sqlId(20)},${sqlId(3)},'submitted','2020-10-31 00:00Z',1),
      (${sqlId(35)},${sqlId(23)},${sqlId(20)},${sqlId(1)},'submitted','2020-10-31 00:00Z',1),
      (${sqlId(36)},${sqlId(24)},${sqlId(21)},${sqlId(1)},'submitted','2020-10-31 00:00Z',1);
    insert into public.teaching_item_targets select distinct item_id,group_id from public.teaching_submissions;
    insert into public.teaching_grade_requests values
      (${sqlId(40)},${sqlId(20)},${sqlId(1)},${sqlId(98)},'open','2020-10-31 00:00Z',1),
      (${sqlId(41)},${sqlId(20)},${sqlId(1)},${sqlId(99)},'open','2020-10-31 00:00Z',1),
      (${sqlId(42)},${sqlId(20)},${sqlId(1)},${sqlId(98)},'resolved','2020-10-31 00:00Z',2);
    update public.notification_email_runtime set worker_enabled=true,last_heartbeat_at=clock_timestamp();
  `)
  const queue = async now => (await db.query('select public.xelay_private_queue_teaching_followups($1) as n', [now])).rows[0].n
  const service = (sql, params) => asUser(null, sql, params, { role: 'service_role' })
  const contextSql = 'select public.xelay_teaching_followup_email_context($1,$2) as result'

  await t.test('only scoped unresolved work is summarized on weekday mornings', async () => {
    for (const now of ['2020-11-01T07:00:00Z','2020-11-02T06:59:00Z','2020-11-02T10:00:00Z']) {
      assert.equal(await queue(now),0)
    }
    assert.equal(await queue(monday),3)
    assert.equal(await queue(monday),0)
    const { rows } = await db.query("select recipient_id,message from public.notifications where type='teaching_followup' order by recipient_id")
    assert.deepEqual(rows.map(row => row.recipient_id),[id(11),id(12),id(17)])
    assert.match(rows[0].message,/роботи|Роботи/)
    assert.match(rows[0].message,/\(1\).*\(1\)/)
    assert.match(rows[1].message,/\(1\).*\(0\)/)
    const outbox = await db.query("select recipient_id from public.notification_email_outbox where notification_type='teaching_followup' order by recipient_id")
    assert.deepEqual(outbox.rows.map(row => row.recipient_id),[id(11),id(12)])
    await assert.rejects(asUser(id(11),'select public.xelay_queue_teaching_followups()'),{code:'42501'})
    await assert.rejects(service('select public.xelay_private_teaching_followup_backlog(now())'),{code:'42501'})
    await assert.rejects(service('select * from public.teaching_followup_receipts'),{code:'42501'})
  })

  await t.test('a genuine lease rechecks date, access and completion without returning details', async () => {
    const {rows:[receipt]}=await db.query('select notification_id from public.teaching_followup_receipts where recipient_id=$1',[id(11)])
    const {rows:[outbox]}=await db.query('select id from public.notification_email_outbox where notification_id=$1',[receipt.notification_id])
    const {rows:[job]}=await service('select * from public.xelay_claim_notification_email($1)',[outbox.id])
    assert.ok(job?.lock_token)
    const context = async token => (await service(contextSql,[job.id,token])).rows[0].result
    await assert.rejects(asUser(id(11),contextSql,[job.id,job.lock_token]),{code:'42501'})
    assert.equal((await context(id(88))).reason,'teaching_followup_context_missing')
    assert.equal((await context(job.lock_token)).reason,'teaching_followup_unavailable')
    await db.query("update public.teaching_followup_receipts set kyiv_day=(clock_timestamp() at time zone 'Europe/Kyiv')::date where notification_id=$1",[receipt.notification_id])
    assert.deepEqual(await context(job.lock_token),{eligible:true})
    await db.query("update public.teaching_course_groups set status='pending' where course_id=$1 and group_id=$2",[id(20),id(1)])
    assert.equal((await context(job.lock_token)).reason,'teaching_followup_unavailable')
    await db.query("update public.teaching_course_groups set status='accepted' where course_id=$1 and group_id=$2",[id(20),id(1)])
    await db.query("update public.teaching_submissions set status='reviewed' where id=$1",[id(30)])
    await db.query("update public.teaching_grade_requests set status='resolved' where id=$1",[id(40)])
    assert.equal((await context(job.lock_token)).reason,'teaching_followup_unavailable')
  })

  await t.test('unchanged backlog does not repeat on another day, but a fresh attempt can alert', async () => {
    await db.query("update public.teaching_submissions set status='submitted' where id=$1",[id(30)])
    await db.query("update public.teaching_grade_requests set status='open' where id=$1",[id(40)])
    // Keep the same outstanding set between days for this assertion.
    await db.query("update public.teaching_submissions set submitted_at='2020-11-03 06:00Z' where id=$1",[id(31)])
    await db.query('update public.teaching_followup_receipts set kyiv_day=$1 where recipient_id=$2',['2020-11-02',id(11)])
    assert.equal(await queue(tuesday),0)
    await db.query('update public.teaching_submissions set attempt=2 where id=$1',[id(30)])
    assert.equal(await queue(tuesday),3)
    assert.equal(await queue(tuesday),0)
  })

  await t.test('real queue prefers urgent and actionable mail while old ordinary mail still progresses', async () => {
    await db.exec("update public.notification_email_outbox set status='skipped'; update public.teaching_submissions set status='returned' where id="+sqlId(32))
    const add = async (type,key) => (await db.query(`
      insert into public.notifications(recipient_id,actor_id,actor_name,type,message,teaching_event_key,teaching_course_id,study_group_id)
      values($1,$2,'Xelay',$3,'Synthetic event',$4,$5,$6) returning id,delivery_priority`,
      [id(11),id(12),type,key,id(20),id(1)])).rows[0]
    const aged = await add('answer',null)
    const ordinary = await add('teaching_update','classroom-review:'+id(30)+':1')
    const submission = await add('teaching_update','classroom-submit:'+id(30)+':2')
    const returned = await add('teaching_update','classroom-review:'+id(32)+':1')
    assert.deepEqual([aged,ordinary,submission,returned].map(row=>row.delivery_priority),
      ['normal','normal','attention','urgent'])
    await db.query("update public.notification_email_outbox set created_at=now()-interval '3 hours' where notification_id=$1",[aged.id])
    const claim = async () => (await service('select * from public.xelay_claim_notification_email(null)',[])).rows[0]
    assert.equal((await claim()).notification_id,aged.id)
    assert.equal((await claim()).notification_id,returned.id)
    const job = await claim()
    assert.equal(job.notification_id,submission.id)
    assert.equal((await claim()).notification_id,ordinary.id)
    const getContext = async () => (await service(
      'select public.xelay_teaching_action_email_context($1,$2) result',[job.id,job.lock_token])).rows[0].result
    assert.deepEqual(await getContext(),{eligible:true})
    await db.query("delete from public.teaching_item_targets where item_id=$1 and group_id=$2",[id(22),id(1)])
    assert.equal((await getContext()).reason,'teaching_action_unavailable')
    await assert.rejects(db.query("update public.notifications set delivery_priority='urgent' where id=$1",[ordinary.id]),{code:'42501'})
  })
})
