// Isolated PostgreSQL producer/permission tests. No live database or mail.
// Synthetic tables model the columns read by the production triggers; existing
// academic write guards remain covered by their separate feature test suites.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(new URL('../../supabase/migrations/202610140003_academic_notification_producers.sql', import.meta.url), 'utf8')
const id = () => randomUUID()

async function fixture() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select current_setting('role',true) $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on function auth.uid(),auth.role() to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,deleted_at timestamptz,banned_until timestamptz);
    create table public.profiles(id uuid primary key,full_name text);
    create table public.study_groups(id uuid primary key,representative_id uuid not null);
    create table public.study_group_members(id uuid primary key default gen_random_uuid(),group_id uuid,user_id uuid,status text);
    create table public.study_group_schedule(id uuid primary key default gen_random_uuid(),group_id uuid,subject text,
      starts_at time default '08:00',ends_at time default '09:20',created_by uuid,updated_at timestamptz default now());
    create table public.study_group_homework(id uuid primary key default gen_random_uuid(),group_id uuid,schedule_item_id uuid,
      lesson_date date default current_date,body text,url text,lesson_topic text,
      resource_links jsonb default '[]',attachments jsonb default '[]',created_by uuid,updated_at timestamptz default now());
    create table public.study_group_long_term_tasks(id uuid primary key default gen_random_uuid(),group_id uuid,
      subject text,title text,description text,due_date date,closed_at timestamptz,created_by uuid,
      resource_links jsonb default '[]',resource_attachments jsonb default '[]',create_request_id uuid,
      updated_at timestamptz default now());
    create table public.study_group_materials(id uuid primary key default gen_random_uuid(),group_id uuid,
      title text,body text,links jsonb default '[]',attachments jsonb default '[]',created_by uuid,updated_at timestamptz default now());
    create table public.study_group_seminars(id uuid primary key default gen_random_uuid(),group_id uuid,
      lesson_date date default current_date,title text,instructions text,starts_at time default '08:00',ends_at time default '09:20',
      teaching_version integer default 1,created_by uuid,updated_at timestamptz default now());
    create table public.study_group_seminar_questions(id uuid primary key default gen_random_uuid(),seminar_id uuid,
      body text,position integer,primary_capacity integer default 1,updated_at timestamptz default now());
    create table public.study_group_seminar_teams(id uuid primary key default gen_random_uuid(),seminar_id uuid,
      name text,position integer,capacity integer default 1,updated_at timestamptz default now());
    create table public.study_group_seminar_schedule(id uuid primary key default gen_random_uuid(),group_id uuid,
      starts_at time default '08:00',ends_at time default '09:20',teaching_version integer default 1,updated_at timestamptz default now());
    create table public.study_group_timetable_photos(group_id uuid primary key,storage_path text,updated_by uuid,updated_at timestamptz default now());
    create table public.shared_organizer_workspaces(id uuid primary key,owner_id uuid,name text,archived_at timestamptz);
    create table public.shared_organizer_members(workspace_id uuid,user_id uuid,role text,primary key(workspace_id,user_id));
    create table public.shared_organizer_invitations(id uuid primary key,workspace_id uuid,inviter_id uuid,invitee_id uuid,
      status text default 'pending',expires_at timestamptz default now()+interval '7 days',responded_at timestamptz);
    create table public.shared_organizer_tasks(id uuid primary key default gen_random_uuid(),workspace_id uuid,
      created_by uuid,updated_by uuid,assignee_id uuid,title text,notes text,subject text,due_at timestamptz,due_date date,
      completed boolean default false,updated_at timestamptz default now());
    create table public.notifications(id uuid primary key default gen_random_uuid(),recipient_id uuid,actor_id uuid,
      actor_name text,type text,message text,is_read boolean default false,study_group_id uuid,
      teaching_event_key text,created_at timestamptz default now());
    create table public.notification_email_outbox(id uuid primary key,notification_id text,recipient_id uuid,actor_id uuid,
      notification_type text,status text,lock_token uuid,locked_until timestamptz);
    alter table public.notifications enable row level security;
    create policy legacy_read on public.notifications for select to authenticated using(recipient_id=auth.uid());
    create policy legacy_insert on public.notifications for insert to authenticated with check(true);
    create policy legacy_update on public.notifications for update to authenticated using(recipient_id=auth.uid()) with check(recipient_id=auth.uid());
    grant select,insert,update on public.notifications to authenticated;
    grant select,insert,update,delete on public.study_group_schedule,public.study_group_homework,
      public.study_group_long_term_tasks,public.study_group_materials,public.study_group_seminars,
      public.study_group_seminar_questions,public.study_group_seminar_teams,public.study_group_seminar_schedule,
      public.study_group_timetable_photos,public.shared_organizer_tasks,public.shared_organizer_invitations to authenticated;
    create function public.xelay_teaching_is_backend_write() returns boolean language sql stable security invoker as $$
      select coalesce(current_setting('role',true),'none') in('none','postgres','service_role') $$;
  `)
  await db.exec(migration)
  const representative = id(), deputy = id(), accepted = id(), pending = id(), outsider = id(), group = id()
  for (const [user, name] of [[representative,'Representative'],[deputy,'Deputy'],[accepted,'Accepted'],[pending,'Pending'],[outsider,'Outsider']]) {
    await db.query('insert into auth.users(id) values($1)',[user])
    await db.query('insert into profiles(id,full_name) values($1,$2)',[user,name])
  }
  await db.query('insert into study_groups values($1,$2)',[group,representative])
  await db.query("insert into study_group_members(group_id,user_id,status) values($1,$2,'accepted'),($1,$3,'accepted'),($1,$4,'pending')",[group,deputy,accepted,pending])
  const as = async (actor, sql, parameters = [], { role='authenticated' } = {}) => {
    assert.ok(['authenticated','service_role','anon'].includes(role))
    await db.exec(`set role ${role}`)
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor || ''])
    try { return await db.query(sql,parameters) }
    finally { await db.exec('reset role'); await db.exec('reset "request.jwt.claim.sub"') }
  }
  const transaction = async (actor, action) => {
    await db.exec('set role authenticated')
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor])
    await db.exec('begin')
    try { await action(); await db.exec('commit') }
    catch(error) { await db.exec('rollback'); throw error }
    finally { await db.exec('reset role'); await db.exec('reset "request.jwt.claim.sub"') }
  }
  const rows = async (type) => (await db.query('select * from notifications where type=$1 order by recipient_id',[type])).rows
  return { db, as, transaction, rows, representative, deputy, accepted, pending, outsider, group }
}

test('migration is future-only, uses private helpers and preserves existing schemas', () => {
  assert.doesNotMatch(migration,/insert into public\.notifications[\s\S]*?from public\.study_group_long_term_tasks/i)
  assert.doesNotMatch(migration,/update public\.notifications set|delete from public\.notifications/i)
  assert.deepEqual([...migration.matchAll(/grant execute[^;]+;/gi)].map(m=>m[0]),[
    'grant execute on function public.xelay_shared_organizer_notification_email_context(uuid,uuid) to service_role;',
  ])
  assert.match(migration,/from public,anon,authenticated,service_role/)
  assert.match(migration,/create constraint trigger study_group_seminar_notification[\s\S]*?deferrable initially deferred/)
})

test('homework edits use the actual deputy, include the representative without a membership, and reject no-ops', async () => {
  const f = await fixture()
  try {
    const lesson = id(), homework = id()
    await f.db.query('insert into study_group_schedule(id,group_id,subject) values($1,$2,$3)',[lesson,f.group,'Economics'])
    await f.as(f.representative,'insert into study_group_homework(id,group_id,schedule_item_id,body,created_by) values($1,$2,$3,$4,$5)',[homework,f.group,lesson,'First homework',f.representative])
    let notifications = await f.rows('group_homework')
    assert.deepEqual(new Set(notifications.map(n=>n.recipient_id)),new Set([f.deputy,f.accepted]))
    await f.as(f.deputy,'update study_group_homework set body=$2 where id=$1',[homework,'Edited by deputy'])
    notifications = await f.rows('group_homework')
    const edited = notifications.filter(n=>n.actor_id===f.deputy)
    assert.deepEqual(new Set(edited.map(n=>n.recipient_id)),new Set([f.representative,f.accepted]))
    assert.ok(edited.every(n=>n.actor_name==='Deputy' && n.academic_tab==='schedule'))
    await f.as(f.deputy,'update study_group_homework set body=body,updated_at=clock_timestamp() where id=$1',[homework])
    assert.equal((await f.rows('group_homework')).length,4)
    await f.as(f.deputy,"update study_group_homework set resource_links='[{\"url\":\"https://example.test\"}]' where id=$1",[homework])
    assert.equal((await f.rows('group_homework')).length,6)
    assert.ok(notifications.every(n=>![f.pending,f.outsider].includes(n.recipient_id)))
  } finally { await f.db.close() }
})

test('long-term tasks and materials notify on resources and closed status, with no historical replay', async () => {
  const f = await fixture()
  try {
    const task = id(), material = id()
    await f.as(f.deputy,'insert into study_group_long_term_tasks(id,group_id,subject,title,created_by) values($1,$2,$3,$4,$5)',[task,f.group,'Economics','Prepare report',f.deputy])
    assert.equal((await f.rows('study_group_update')).length,2)
    await f.as(f.deputy,"update study_group_long_term_tasks set resource_attachments='[{\"path\":\"synthetic\"}]' where id=$1",[task])
    await f.as(f.deputy,'update study_group_long_term_tasks set closed_at=clock_timestamp() where id=$1',[task])
    assert.equal((await f.rows('study_group_update')).length,6)
    await f.as(f.representative,'insert into study_group_materials(id,group_id,title,created_by) values($1,$2,$3,$4)',[material,f.group,'Lecture material',f.representative])
    assert.equal((await f.rows('study_group_update')).filter(n=>n.academic_tab==='materials').length,2)
    await f.as(f.representative,'update study_group_materials set updated_at=clock_timestamp(),title=title where id=$1',[material])
    const count = (await f.rows('study_group_update')).length
    await f.db.exec(migration)
    assert.equal((await f.rows('study_group_update')).length,count)
  } finally { await f.db.close() }
})

test('timetable imports coalesce by group and transaction', async () => {
  const f = await fixture()
  try {
    await f.transaction(f.deputy,async()=>{
      await f.db.query("insert into study_group_schedule(group_id,subject) values($1,'One'),($1,'Two'),($1,'Three')",[f.group])
      await f.db.query("insert into study_group_timetable_photos(group_id,storage_path,updated_by) values($1,'synthetic/photo',$2)",[f.group,f.deputy])
    })
    const rows = await f.rows('study_group_update')
    assert.equal(rows.length,2)
    assert.ok(rows.every(n=>n.academic_tab==='timetable'))
    await f.as(f.deputy,"insert into study_group_schedule(group_id,subject) values($1,'Later')",[f.group])
    assert.equal((await f.rows('study_group_update')).length,4)
  } finally { await f.db.close() }
})

test('clearing homework and deleting material notify, but parent lesson/group cleanup does not create duplicate academic events', async () => {
  const f = await fixture()
  try {
    const lesson = id(), homework = id(), cascadedHomework = id(), material = id(), orphanMaterial = id()
    await f.db.query("insert into study_group_schedule(id,group_id,subject) values($1,$2,'Economics')",[lesson,f.group])
    await f.as(f.deputy,"insert into study_group_homework(id,group_id,schedule_item_id,body,created_by) values($1,$2,$3,'One',$4),($5,$2,$3,'Two',$4)",
      [homework,f.group,lesson,f.deputy,cascadedHomework])
    assert.equal((await f.rows('group_homework')).length,4)
    await f.as(f.deputy,'delete from study_group_homework where id=$1',[homework])
    assert.equal((await f.rows('group_homework')).length,6)
    assert.equal((await f.rows('group_homework')).filter(n=>n.message.startsWith('видалив')).length,2)
    await f.transaction(f.deputy,async()=>{
      await f.db.query('delete from study_group_schedule where id=$1',[lesson])
      await f.db.query('delete from study_group_homework where id=$1',[cascadedHomework])
    })
    assert.equal((await f.rows('group_homework')).length,6,'Parent lesson removal is already covered by timetable')
    assert.equal((await f.rows('study_group_update')).filter(n=>n.academic_tab==='timetable').length,2)
    await f.as(f.deputy,"insert into study_group_materials(id,group_id,title,created_by) values($1,$2,'One',$3),($4,$2,'Two',$3)",
      [material,f.group,f.deputy,orphanMaterial])
    await f.as(f.deputy,'delete from study_group_materials where id=$1',[material])
    assert.equal((await f.rows('study_group_update')).filter(n=>n.academic_tab==='materials').length,6)
    await f.db.query('delete from study_groups where id=$1',[f.group])
    await f.as(f.deputy,'delete from study_group_materials where id=$1',[orphanMaterial])
    assert.equal((await f.rows('study_group_update')).filter(n=>n.academic_tab==='materials').length,6,'No audience remains after group deletion')
  } finally { await f.db.close() }
})

test('seminar questions coalesce and teacher classroom events suppress duplicate group notifications', async () => {
  const f = await fixture()
  try {
    const seminar = id(), teacherSeminar = id()
    await f.transaction(f.deputy,async()=>{
      await f.db.query("insert into study_group_seminars(id,group_id,title) values($1,$2,'Headman seminar')",[seminar,f.group])
      await f.db.query("insert into study_group_seminar_questions(seminar_id,position,body) values($1,1,'One'),($1,2,'Two')",[seminar])
    })
    assert.equal((await f.rows('study_group_update')).length,2)
    await f.transaction(f.representative,async()=>{
      await f.db.query("insert into study_group_seminars(id,group_id,title,teaching_version) values($1,$2,'Teacher seminar',8)",[teacherSeminar,f.group])
      await f.db.query("insert into study_group_seminar_questions(seminar_id,position,body) values($1,1,'Teacher question')",[teacherSeminar])
      await f.db.query("insert into notifications(recipient_id,actor_id,type,study_group_id,teaching_event_key) values($1,$2,'teaching_update',$3,$4)",[f.accepted,f.representative,f.group,`classroom-seminar:${teacherSeminar}:8`])
    })
    assert.equal((await f.rows('study_group_update')).length,2,'Classroom producer remains sole notification')
    await f.as(f.deputy,"update study_group_seminars set title='Headman edited teacher content',teaching_version=9 where id=$1",[teacherSeminar])
    assert.equal((await f.rows('study_group_update')).length,4,'Headman edits still produce updates')
    await f.transaction(f.deputy,async()=>{
      await f.db.query('delete from study_group_seminar_questions where seminar_id=$1',[teacherSeminar])
      await f.db.query('delete from study_group_seminars where id=$1',[teacherSeminar])
    })
    assert.equal((await f.rows('study_group_update')).length,6,'Seminar deletion is one event, without another per removed question')
    const historicalTeacherSeminar=id()
    await f.transaction(f.representative,async()=>{
      await f.db.query("insert into study_group_seminars(id,group_id,title,teaching_version) values($1,$2,'Teacher original',3)",[historicalTeacherSeminar,f.group])
      await f.db.query("insert into notifications(recipient_id,actor_id,type,study_group_id,teaching_event_key) values($1,$2,'teaching_update',$3,$4)",
        [f.accepted,f.representative,f.group,`classroom-seminar:${historicalTeacherSeminar}:3`])
    })
    await f.as(f.representative,'delete from study_group_seminars where id=$1',[historicalTeacherSeminar])
    assert.equal((await f.rows('study_group_update')).length,8,'Historical teacher create event cannot suppress a later teacher deletion')
  } finally { await f.db.close() }
})

test('shared invitations are scoped to the invitee, responses to inviter, tasks to current members', async () => {
  const f = await fixture()
  try {
    const workspace = id(), invitation = id(), task = id()
    await f.db.query("insert into shared_organizer_workspaces(id,owner_id,name) values($1,$2,'Team')",[workspace,f.representative])
    await f.db.query("insert into shared_organizer_members values($1,$2,'owner'),($1,$3,'member')",[workspace,f.representative,f.deputy])
    await f.as(f.representative,'insert into shared_organizer_invitations(id,workspace_id,inviter_id,invitee_id) values($1,$2,$3,$4)',[invitation,workspace,f.representative,f.accepted])
    assert.deepEqual((await f.rows('shared_organizer_invite')).map(n=>n.recipient_id),[f.accepted])
    await f.as(f.accepted,"update shared_organizer_invitations set status='accepted' where id=$1",[invitation])
    assert.deepEqual((await f.rows('shared_organizer_update')).map(n=>n.recipient_id),[f.representative])
    await f.db.query("insert into shared_organizer_members values($1,$2,'member')",[workspace,f.accepted])
    await f.as(f.deputy,'insert into shared_organizer_tasks(id,workspace_id,created_by,updated_by,title) values($1,$2,$3,$3,$4)',[task,workspace,f.deputy,'Private team task'])
    assert.deepEqual(new Set((await f.rows('shared_organizer_update')).filter(n=>n.academic_event_key.startsWith('shared-organizer-task:')).map(n=>n.recipient_id)),new Set([f.representative,f.accepted]))
    await f.as(f.deputy,'update shared_organizer_tasks set completed=true where id=$1',[task])
    assert.equal((await f.rows('shared_organizer_update')).length,5)
    await f.db.query('delete from shared_organizer_members where workspace_id=$1 and user_id=$2',[workspace,f.accepted])
    await f.as(f.deputy,'delete from shared_organizer_tasks where id=$1',[task])
    assert.equal((await f.rows('shared_organizer_update')).length,6)
  } finally { await f.db.close() }
})

test('legacy notification policies cannot forge trusted events or alter their payloads; read marking still works', async () => {
  const f = await fixture()
  try {
    await f.as(f.deputy,"insert into study_group_materials(group_id,title,created_by) values($1,'Protected',$2)",[f.group,f.deputy])
    const notification = (await f.rows('study_group_update')).find(n=>n.recipient_id===f.accepted)
    await f.as(f.accepted,'update notifications set is_read=true where id=$1',[notification.id])
    assert.equal((await f.rows('study_group_update')).find(n=>n.id===notification.id).is_read,true)
    await assert.rejects(()=>f.as(f.accepted,"update notifications set message='Forged' where id=$1",[notification.id]),e=>e.code==='42501')
    await assert.rejects(()=>f.as(f.accepted,"insert into notifications(recipient_id,actor_id,type,study_group_id,academic_event_key,academic_tab) values($1,$2,'study_group_update',$3,'forged','materials')",[f.accepted,f.deputy,f.group]),e=>e.code==='42501')
    await assert.rejects(()=>f.as(f.accepted,"select public.xelay_private_notify_group_event($1,'forged','Forged','materials',$2)",[f.group,f.deputy]),e=>e.code==='42501')
  } finally { await f.db.close() }
})

test('organizer email context is service-only, lease-bound, metadata-only and rechecks private membership/invitations', async () => {
  const f = await fixture()
  try {
    const workspace = id(), invitation = id()
    await f.db.query("insert into shared_organizer_workspaces(id,owner_id,name) values($1,$2,'Private title')",[workspace,f.representative])
    await f.db.query("insert into shared_organizer_members values($1,$2,'owner'),($1,$3,'member')",[workspace,f.representative,f.deputy])
    await f.as(f.representative,'insert into shared_organizer_invitations(id,workspace_id,inviter_id,invitee_id) values($1,$2,$3,$4)',[invitation,workspace,f.representative,f.accepted])
    const notification = (await f.rows('shared_organizer_invite'))[0]
    const job = id(), lease = id()
    await f.db.query("insert into notification_email_outbox values($1,$2,$3,$4,$5,'processing',$6,clock_timestamp()+interval '2 minutes')",
      [job,notification.id,notification.recipient_id,notification.actor_id,notification.type,lease])
    const context = async (jobId=job, lock=lease) => (await f.as(null,
      'select public.xelay_shared_organizer_notification_email_context($1,$2) as context',[jobId,lock],{role:'service_role'})).rows[0].context
    await assert.rejects(()=>f.as(f.accepted,'select public.xelay_shared_organizer_notification_email_context($1,$2)',[job,lease]),e=>e.code==='42501')
    assert.equal((await context(job,id())).reason,'lease_lost')
    assert.deepEqual(await context(),{eligible:true,reason:'eligible',path:`/organizer?view=shared&workspace=${workspace}`})
    await f.as(f.accepted,'update notifications set is_read=true where id=$1',[notification.id])
    assert.equal((await context()).eligible,true,'Already-read events still email')
    assert.equal((await f.db.query("select has_table_privilege('service_role','shared_organizer_members','SELECT') as allowed")).rows[0].allowed,false)
    await f.db.query("update shared_organizer_invitations set expires_at=clock_timestamp()-interval '1 second' where id=$1",[invitation])
    assert.equal((await context()).reason,'organizer_invitation_unavailable')
    await f.db.query("update shared_organizer_invitations set expires_at=clock_timestamp()+interval '1 day' where id=$1",[invitation])
    await f.as(f.accepted,"update shared_organizer_invitations set status='accepted' where id=$1",[invitation])
    assert.equal((await context()).reason,'organizer_invitation_unavailable')
    await f.db.query("insert into shared_organizer_members values($1,$2,'member')",[workspace,f.accepted])
    assert.equal((await context()).eligible,true,'Accepting an invitation does not suppress its email while membership survives')
    await f.db.query('delete from shared_organizer_members where workspace_id=$1 and user_id=$2',[workspace,f.accepted])
    assert.equal((await context()).reason,'organizer_invitation_unavailable','Accepted invitations cannot substitute for revoked membership')
    const response = (await f.rows('shared_organizer_update'))[0]
    const responseJob = id(), responseLease = id()
    await f.db.query("insert into notification_email_outbox values($1,$2,$3,$4,$5,'processing',$6,clock_timestamp()+interval '2 minutes')",
      [responseJob,response.id,response.recipient_id,response.actor_id,response.type,responseLease])
    assert.equal((await context(responseJob,responseLease)).eligible,true)
    await f.db.query('delete from shared_organizer_members where workspace_id=$1 and user_id=$2',[workspace,f.representative])
    assert.equal((await context(responseJob,responseLease)).reason,'organizer_membership_removed')
    await f.db.query("update shared_organizer_workspaces set archived_at=clock_timestamp() where id=$1",[workspace])
    assert.equal((await context(responseJob,responseLease)).reason,'organizer_unavailable')
    await f.db.query("update notification_email_outbox set locked_until=clock_timestamp()-interval '1 second' where id=$1",[responseJob])
    assert.equal((await context(responseJob,responseLease)).reason,'lease_lost')
  } finally { await f.db.close() }
})
