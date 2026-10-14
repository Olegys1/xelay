// Full repository migration-chain integration in an isolated PostgreSQL model.
// Synthetic Auth/cron prerequisites only; no production, network or mail.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const root = new URL('../../',import.meta.url)
const mailMigration = await readFile(new URL('supabase/migrations/202610140002_all_notification_email.sql',root),'utf8')
const academicMigration = await readFile(new URL('supabase/migrations/202610140003_academic_notification_producers.sql',root),'utf8')
const chatMigration = await readFile(new URL('supabase/migrations/202610140004_chat_notification_email_context.sql',root),'utf8')
// Mirror the production package from repository sources only. Remove standalone
// outer wrappers, preserving function bodies, statements and their order.
const bundle = 'begin;\n' + [mailMigration,academicMigration,chatMigration]
  .map(source=>source.replace(/^[ \t]*(?:begin|commit);[ \t]*\r?$/gim,''))
  .join('\n') + '\ncommit;'
const first = result => result.rows[0]
const denied = work => assert.rejects(work,error=>error.code==='42501')

test('new notification migrations compose with the actual full prior chain and its academic/security guards', async t=>{
  const fx = await createFixture({useStagingParity:true,through:'202610140001',beforeMigrationsSql:`
    -- Managed Auth provides this column. The shared offline fixture predates it.
    alter table auth.users add column if not exists banned_until timestamptz;
    -- Only represent the installed pg_cron signature required by course
    -- progression. This stub never runs jobs or executes scheduled SQL.
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  `})
  const {db,asUser,seedUser} = fx
  const owner=randomUUID(), member=randomUUID(), pending=randomUUID(), outsider=randomUUID()
  const university=randomUUID(), unit=randomUUID(), specialty=randomUUID(), request=randomUUID(), group=randomUUID()
  const sql = async (statement,values=[]) => (await db.query(statement,values)).rows
  try {
    await db.query("insert into universities(id,name,slug) values($1,'Notification integration university',$2)",[university,'notification-'+university])
    await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Integration faculty',$3,'faculty')",[unit,university,'notification-'+unit])
    await db.query("insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name) values($1,$2,$3,'INTEG','Economics','Integration Economics')",[specialty,university,unit])
    for(const user of [owner,member,pending,outsider]) await seedUser(user,{
      username:'notify_'+user.slice(0,12).replaceAll('-',''),university_id:university,academic_unit_id:unit,
      specialty_id:specialty,study_year:'1',experience:'bachelor',categories:['General'],
    })
    // Real schemas, FKs and validation triggers stay enabled. Only fixtures are
    // seeded by the database owner; application academic writes use Auth below.
    await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,
      specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
      values($1,$2,'Integration representative',$3,$4,'Integration Economics','INTEG-1','integration_fixture','approved',$2,now())`,
      [request,owner,university,unit])
    await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name)
      values($1,$2,$3,$4,$5,'Integration Economics','INTEG-1')`,[group,request,owner,university,unit])
    const username=user=>'notify_'+user.slice(0,12).replaceAll('-','')
    const memberInvite=first(await asUser(owner,'select public.xelay_invite_to_study_group($1,$2) as id',[group,username(member)])).id
    await asUser(member,'select public.xelay_respond_study_group_invitation($1,true)',[memberInvite])
    await asUser(owner,'select public.xelay_invite_to_study_group($1,$2)',[group,username(pending)])
    const historical = first(await asUser(null,`insert into notifications(recipient_id,actor_id,actor_name,type,message)
      values($1,$2,'Synthetic owner','fixture_before_all_notification_email','Synthetic historical event') returning id`,
      [member,owner],{role:'service_role'})).id
    const baselineCount=first(await db.query('select count(*)::int as count from notification_email_outbox')).count
    await t.test('atomic source bundle applies and reruns without historical backfill or duplicate triggers',async()=>{
      assert.equal(bundle.match(/^[ \t]*begin;[ \t]*$/gim).length,1)
      assert.equal(bundle.match(/^[ \t]*commit;[ \t]*$/gim).length,1)
      await db.exec(bundle)
      await db.exec(bundle)
      assert.equal(first(await db.query('select count(*)::int as count from notification_email_outbox')).count,baselineCount)
      assert.equal(first(await db.query('select count(*)::int as count from notification_email_outbox where notification_id=$1',[historical])).count,0)
      for(const [table,trigger] of [
        ['notifications','notification_email_queue'],['notifications','academic_notification_update_guard'],
        ['study_group_homework','study_group_homework_notification'],
        ['study_group_long_term_tasks','study_group_long_term_task_notification'],
        ['study_group_materials','study_group_material_notification'],
        ['study_group_seminars','study_group_seminar_notification'],
        ['shared_organizer_tasks','shared_organizer_task_notification'],
      ]) assert.equal(first(await db.query(`select count(*)::int as count from pg_trigger
        where tgrelid=$1::regclass and tgname=$2 and not tgisinternal`,['public.'+table,trigger])).count,1)
      assert.equal(first(await db.query("select count(*)::int as count from pg_trigger where tgname='xelay_teaching_email_queue'")).count,0)
      for(const role of ['anon','authenticated']) {
        assert.equal(first(await db.query("select has_table_privilege($1,'public.notifications','INSERT') as allowed",[role])).allowed,false)
        assert.equal(first(await db.query("select has_function_privilege($1,'public.xelay_shared_organizer_notification_email_context(uuid,uuid)','EXECUTE') as allowed",[role])).allowed,false)
        assert.equal(first(await db.query("select has_function_privilege($1,'public.xelay_chat_notification_email_context(uuid,uuid)','EXECUTE') as allowed",[role])).allowed,false)
      }
      assert.equal(first(await db.query("select has_function_privilege('service_role','public.xelay_shared_organizer_notification_email_context(uuid,uuid)','EXECUTE') as allowed")).allowed,true)
      assert.equal(first(await db.query("select has_table_privilege('service_role','public.shared_organizer_tasks','SELECT') as allowed")).allowed,false)
      assert.equal(first(await db.query("select has_function_privilege('service_role','public.xelay_private_notify_group_event(uuid,text,text,text,uuid,text)','EXECUTE') as allowed")).allowed,false)
      assert.equal(first(await db.query("select has_function_privilege('service_role','public.xelay_chat_notification_email_context(uuid,uuid)','EXECUTE') as allowed")).allowed,true)
      for(const table of ['chat_spaces','chat_members','chat_invitations','chat_join_requests']) {
        assert.equal(first(await db.query('select has_table_privilege(\'service_role\',$1,\'SELECT\') as allowed',['public.'+table])).allowed,false)
      }
      for(const role of ['anon','authenticated']) await denied(asUser(role==='authenticated'?member:null,
        'select public.xelay_chat_notification_email_context($1,$2)',[randomUUID(),randomUUID()],{role}))
      assert.equal(first(await asUser(null,'select public.xelay_chat_notification_email_context($1,$2) as context',
        [randomUUID(),randomUUID()],{role:'service_role'})).context.reason,'lease_lost')
      const delivery=first(await asUser(null,'select public.xelay_notification_email_delivery_status() as state',[],{role:'service_role'})).state
      assert.equal(delivery.delivery_mode,'per_notification_v1')
      assert.equal(delivery.contexts_ready,true)
    })

    let lesson,homework
    await t.test('actual authenticated schedule/homework writes create exactly one job per eligible notification',async()=>{
      lesson=first(await asUser(owner,`insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,
        valid_from,valid_until,created_by) values($1,1,'08:00','09:20','Integration Economics','lecture','2026-10-12','2026-12-31',$2) returning id`,[group,owner])).id
      const timetable=await sql("select * from notifications where study_group_id=$1 and type='study_group_update'",[group])
      assert.deepEqual(timetable.map(n=>n.recipient_id),[member])
      assert.equal(timetable[0].academic_tab,'timetable')
      homework=first(await asUser(owner,`insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by)
        values($1,$2,'2026-10-12','Synthetic actual homework',$3) returning id`,[group,lesson,owner])).id
      const notices=await sql("select * from notifications where study_group_id=$1 and type='group_homework'",[group])
      assert.deepEqual(notices.map(n=>n.recipient_id),[member])
      const queue=await sql('select * from notification_email_outbox where notification_id=$1',[notices[0].id])
      assert.equal(queue.length,1); assert.equal(queue[0].status,'pending'); assert.equal(queue[0].notification_type,'group_homework')
      await asUser(member,'update notifications set is_read=true where id=$1',[notices[0].id])
      assert.equal(first(await db.query('select status from notification_email_outbox where id=$1',[queue[0].id])).status,'pending')
      await denied(asUser(member,"update study_group_homework set body='Forbidden' where id=$1 returning id",[homework]).then(result=>{
        if(result.rows.length===0) { const error=new Error('RLS rejected write'); error.code='42501'; throw error }
      }))
      await denied(asUser(pending,'select public.xelay_save_study_group_long_term_task($1,null,\'Economics\',\'Forbidden\',\'\',\'2026-12-01\')',[group]))
    })

    await t.test('real long-term/material RPCs preserve private scope and queue their events',async()=>{
      const task=first(await asUser(owner,`select public.xelay_save_study_group_long_term_task_resources(
        $1,null,'Integration Economics','Long-term integration','Synthetic assignment','2026-12-01','[]','[]',null,$2) as id`,[group,randomUUID()])).id
      const longTerm=await sql("select * from notifications where academic_event_key like 'academic:long-term-task:'||$1::text||':%'",[task])
      assert.deepEqual(longTerm.map(n=>n.recipient_id),[member])
      const subject=first(await asUser(owner,"select (public.xelay_save_material_subject($1,null,'Integration Economics')->>'id')::uuid as id",[group])).id
      const material=first(await asUser(owner,`select (public.xelay_save_study_group_material(
        $1,null,$2,'Integration material','2026-10-12','Synthetic body','[]','[]')->>'id')::uuid as id`,[group,subject])).id
      const materialNotice=await sql("select * from notifications where academic_event_key like 'academic:material:'||$1::text||':%'",[material])
      assert.deepEqual(materialNotice.map(n=>n.recipient_id),[member])
      for(const notice of [...longTerm,...materialNotice]) assert.equal(first(await db.query('select count(*)::int as count from notification_email_outbox where notification_id=$1',[notice.id])).count,1)
      await asUser(owner,'delete from study_group_homework where id=$1',[homework])
      const removed=await sql("select * from notifications where type='group_homework' and message like 'видалив%' and study_group_id=$1",[group])
      assert.equal(removed.length,1); assert.equal(removed[0].recipient_id,member)
      assert.equal(first(await db.query('select count(*)::int as count from notification_email_outbox where notification_id=$1',[removed[0].id])).count,1)
      assert.equal(first(await db.query("select count(*)::int as count from notifications where recipient_id in($1,$2) and academic_event_key is not null",[pending,outsider])).count,0)
    })
  } finally { await fx.close() }
})
