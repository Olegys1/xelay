import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { notificationCenterFixture } from './notification-center-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'
import { seedNotificationCenterPreview } from './notification-center-preview-seed.mjs'
import { createPreviewNotificationMail } from './notification-center-preview-mail.mjs'
const target=id=>({group_id:id,audience_mode:'all',subgroup_ids:[],team_ids:[]})
const announcement=(fx,extra={})=>({id:randomUUID(),course_id:fx.ids.course,version:0,expected_user_id:fx.ids.owner,title:'Synthetic important lesson change',body:'Synthetic notice. No real student content.',targets:[target(fx.groups[0])],requires_acknowledgement:true,...extra})
const send=(fx,data,actor=fx.ids.owner)=>fx.rpc(actor,'xelay_teaching_audience_mutate',['save_announcement',JSON.stringify(data)])
const activate=fx=>fx.db.exec("update notification_email_runtime set worker_enabled=true,last_heartbeat_at=clock_timestamp(),paused_until=null,pause_reason=null where singleton")

test('notification center composes with real teaching/mail sources and preserves existing history and private boundaries',async t=>{
 const fx=await notificationCenterFixture({applyCenter:false});t.after(()=>fx.close());const {db,ids,rpc,asUser}=fx
 const legacy=(await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$2,'Synthetic owner','answer','Legacy ordinary event') returning id",[ids.studentA,ids.owner])).rows[0].id
 const prior=(await db.query('select count(*)::int n from notification_email_outbox')).rows[0].n
 await db.exec(await fx.readCenterMigration())
 assert.equal((await db.query('select acknowledgement_required from notifications where id=$1',[legacy])).rows[0].acknowledgement_required,false)
 assert.equal((await db.query('select count(*)::int n from notification_email_outbox')).rows[0].n,prior)
 for(const table of ['notification_acknowledgements','notification_email_digest_batches','notification_email_digest_entries']) for(const role of ['anon','authenticated','service_role'])
  assert.equal((await db.query('select has_table_privilege($1,$2,\'select,insert,update,delete\') allowed',[role,'public.'+table])).rows[0].allowed,false)
 await assert.rejects(rpc(ids.studentA,'xelay_notification_center',['{}',null,20,ids.studentB]),/ACTOR_CHANGED/)
 await assert.rejects(rpc(null,'xelay_notification_center',['{}',null,20,ids.studentA],{role:'anon'}),/permission denied/)
 await assert.rejects(asUser(ids.studentA,'update notifications set acknowledgement_required=true where id=$1',[legacy]),error=>error.code==='42501')
 await assert.rejects(rpc(ids.studentA,'xelay_notification_acknowledge',[legacy,ids.studentA]),/FORBIDDEN/)
 assert.ok((await fx.center(ids.studentA)).items.some(n=>n.id===legacy))
 assert.equal((await fx.center(ids.studentB)).items.some(n=>n.id===legacy),false)
 await asUser(ids.studentA,'insert into notification_preferences(user_id,notifications_enabled,email_notifications_enabled) values($1,false,true) on conflict(user_id) do update set notifications_enabled=false,email_notifications_enabled=true',[ids.studentA])
 assert.equal((await db.query('select notifications_enabled from notification_preferences where user_id=$1',[ids.studentA])).rows[0].notifications_enabled,false,'Legacy ordinary global settings remain writable')
})

test('mandatory teacher notice bypasses both off switches, read differs from ACK, and teacher receipts remain scoped',async t=>{
 const fx=await notificationCenterFixture();t.after(()=>fx.close());const {db,ids,rpc}=fx;await activate(fx)
 await fx.preferences(ids.studentA,{notifications_enabled:false,email_notifications_enabled:false,category_settings:{teacher_messages:{in_app:false,email:'off'}}})
 const a=announcement(fx);await send(fx,a)
 const unchanged=await send(fx,{...a,version:1});assert.equal(unchanged.version,1,'Saving identical content cannot send the same mandatory notice again')
 const feed=await fx.center(ids.studentA,{category:'news',view:'unread'});assert.equal(feed.required_items.length,1);assert.equal(feed.items.length,0);assert.equal(feed.required_count,1);assert.equal(feed.badge_count,1)
 const n=feed.required_items[0];assert.equal(n.category_key,'teacher_messages');assert.equal(n.acknowledgement_required,true);assert.equal(n.acknowledged_at,null)
 assert.deepEqual(await rpc(ids.studentA,'xelay_notification_counts',[ids.studentA]),{unread_count:1,required_count:1,badge_count:1})
 const job=(await db.query('select id from notification_email_outbox where notification_id=$1',[n.id])).rows[0];assert.ok(job)
 const claim=(await fx.asUser(null,'select * from xelay_claim_notification_email($1)',[job.id],{role:'service_role'})).rows[0];assert.ok(claim)
 const policy=await fx.service('xelay_notification_email_policy',[job.id,claim.lock_token]);assert.deepEqual(policy,{eligible:true,required:true,mode:'immediate',reason:'eligible'})
 await rpc(ids.studentA,'xelay_notification_mark_read',[[n.id],ids.studentA])
 const still=await fx.center(ids.studentA);assert.equal(still.required_count,1);assert.equal(still.badge_count,1);assert.equal(still.required_items[0].is_read,true);assert.equal(still.required_items[0].acknowledged_at,null)
 const ack=await rpc(ids.studentA,'xelay_notification_acknowledge',[n.id,ids.studentA]);assert.ok(ack.acknowledged_at)
 assert.equal((await rpc(ids.studentA,'xelay_notification_acknowledge',[n.id,ids.studentA])).acknowledged_at,ack.acknowledged_at)
 assert.equal((await fx.center(ids.studentA)).required_count,0)
 const receipts=await rpc(ids.owner,'xelay_teaching_announcement_receipts',[a.id,ids.owner]);assert.equal(receipts.total,2);assert.equal(receipts.acknowledged,1);assert.doesNotMatch(JSON.stringify(receipts),/@example|email|Synthetic notice/)
 await assert.rejects(rpc(ids.studentB,'xelay_notification_acknowledge',[n.id,ids.studentB]),/FORBIDDEN/)
 await assert.rejects(rpc(ids.studentB,'xelay_notification_mark_read',[[n.id],ids.studentB]),/FORBIDDEN/)
 await assert.rejects(rpc(ids.otherTeacher,'xelay_teaching_announcement_receipts',[a.id,ids.otherTeacher]),/FORBIDDEN/)
 assert.equal((await fx.service('xelay_notification_email_policy',[job.id,randomUUID()])).reason,'lease_lost')
 const afterAckPolicy=await fx.service('xelay_notification_email_policy',[job.id,claim.lock_token]);assert.equal(afterAckPolicy.eligible,true,'Acknowledging never cancels the promised mandatory email')
 await db.query("update notification_email_outbox set locked_until=now()-interval '1 second' where id=$1",[job.id])
 assert.equal((await fx.service('xelay_notification_email_policy',[job.id,claim.lock_token])).reason,'lease_lost')
})

test('scoped teacher receipts reveal only own group and revoked author access suppresses pending mandatory mail',async t=>{
 const fx=await notificationCenterFixture();t.after(()=>fx.close());const {db,ids,rpc,groups,mutate}=fx;await activate(fx)
 const link=await mutate(ids.owner,'invite_teacher',{course_id:ids.course,user_id:ids.colleague,permissions:['assignments','grades'],group_scope:'selected',group_ids:[groups[0]]})
 await mutate(ids.colleague,'respond_teacher',{teacher_link_id:link.id,accept:true})
 const a=announcement(fx,{targets:groups.map(target)});await send(fx,a)
 const scoped=await rpc(ids.colleague,'xelay_teaching_announcement_receipts',[a.id,ids.colleague]);assert.equal(scoped.total,2);assert.ok(scoped.recipients.every(r=>r.group_id===groups[0]));assert.doesNotMatch(JSON.stringify(scoped),new RegExp(ids.studentB+'|'+ids.headB))
 await assert.rejects(rpc(ids.colleague,'xelay_teaching_announcement_audience',[ids.course,JSON.stringify([target(groups[1])]),ids.colleague]),/FORBIDDEN/)
 const own=announcement(fx,{targets:[target(groups[0])],expected_user_id:ids.colleague});await send(fx,own,ids.colleague)
 const n=(await fx.center(ids.studentA)).required_items.find(n=>n.announcement_id===own.id);assert.ok(n)
 const job=(await db.query('select id from notification_email_outbox where notification_id=$1',[n.id])).rows[0]
 const claim=(await fx.asUser(null,'select * from xelay_claim_notification_email($1)',[job.id],{role:'service_role'})).rows[0]
 assert.equal((await fx.service('xelay_notification_email_policy',[job.id,claim.lock_token])).eligible,true)
 await mutate(ids.owner,'update_teacher',{teacher_link_id:link.id,status:'removed'})
 assert.equal((await fx.service('xelay_notification_email_policy',[job.id,claim.lock_token])).eligible,false)
 assert.equal((await fx.center(ids.studentA)).required_items.some(n=>n.announcement_id===own.id),false)
})

test('teacher previews use actual targets, a changed revision needs a new ACK and removal revokes outstanding access',async t=>{
 const fx=await notificationCenterFixture();t.after(()=>fx.close());const {db,ids,rpc,groups}=fx
 const preview=await rpc(ids.owner,'xelay_teaching_announcement_audience',[ids.course,JSON.stringify([target(groups[0])]),ids.owner]);assert.equal(preview.recipient_count,2)
 await assert.rejects(rpc(ids.otherTeacher,'xelay_teaching_announcement_audience',[ids.course,JSON.stringify([target(groups[0])]),ids.otherTeacher]),/FORBIDDEN/)
 const a=announcement(fx);await send(fx,a);const one=(await fx.center(ids.studentA)).required_items[0]
 await rpc(ids.studentA,'xelay_notification_acknowledge',[one.id,ids.studentA])
 const {requires_acknowledgement,...legacyEdit}=a
 await send(fx,{...legacyEdit,version:1,body:'Synthetic amended notice'})
 const feed=await fx.center(ids.studentA);assert.equal(feed.required_count,1);assert.notEqual(feed.required_items[0].id,one.id);assert.equal(feed.required_items[0].acknowledged_at,null)
 await assert.rejects(rpc(ids.studentA,'xelay_notification_acknowledge',[one.id,ids.studentA]),/FORBIDDEN/)
 const own=await rpc(ids.studentA,'xelay_teaching_group_announcements',[groups[0]]);assert.equal(own.announcements[0].notification_id,feed.required_items[0].id);assert.equal(own.announcements[0].requires_acknowledgement,true)
 await db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[groups[0],ids.studentA])
 assert.equal((await fx.center(ids.studentA)).required_count,0)
 await assert.rejects(rpc(ids.studentA,'xelay_notification_acknowledge',[feed.required_items[0].id,ids.studentA]),/FORBIDDEN/)
})

test('server feed filters, stable cursor and independent delivery categories do not read or acknowledge unseen messages',async t=>{
 const fx=await notificationCenterFixture();t.after(()=>fx.close());const {db,ids}=fx
 await db.query('delete from notifications where recipient_id=$1',[ids.studentA])
 const idsWritten=[];for(let i=0;i<7;i++) idsWritten.push((await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message,created_at) values($1,$2,'Synthetic owner','answer',$3,now()-make_interval(secs=>$4)) returning id",[ids.studentA,ids.owner,'Needle '+i,i])).rows[0].id)
 const first=await fx.center(ids.studentA,{search:'needle'},null,3),second=await fx.center(ids.studentA,{search:'needle'},first.next_cursor,3),third=await fx.center(ids.studentA,{search:'needle'},second.next_cursor,3)
 assert.equal(first.has_more,true);assert.equal(third.has_more,false);assert.equal(new Set([...first.items,...second.items,...third.items].map(n=>n.id)).size,7)
 assert.equal((await db.query('select count(*)::int n from notifications where recipient_id=$1 and is_read',[ids.studentA])).rows[0].n,0)
 await fx.preferences(ids.studentA,{notifications_enabled:false,email_notifications_enabled:true,category_settings:{community:{in_app:false,email:'immediate'}}})
 assert.equal((await fx.center(ids.studentA)).badge_count,0);assert.equal((await fx.center(ids.studentA)).items.length,7)
 await assert.rejects(fx.preferences(ids.studentA,{category_settings:{made_up:{in_app:true,email:'immediate'}}}),/INVALID_INPUT/)
 await assert.rejects(fx.center(ids.studentA,{search:'x'.repeat(161)}),/INVALID_INPUT/)
 await assert.rejects(fx.center(ids.studentA,{view:'wrong'}),/INVALID_INPUT/)
})

test('daily category groups private metadata into one deferred email and late claim converts without lost events',async t=>{
 const fx=await notificationCenterFixture();t.after(()=>fx.close());const {db,ids}=fx;await activate(fx)
 await db.query('delete from notification_email_outbox');await db.query('delete from notifications where recipient_id=$1',[ids.studentA])
 await fx.preferences(ids.studentA,{notifications_enabled:false,category_settings:{community:{in_app:false,email:'daily'}}})
 for(let i=0;i<3;i++)await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$2,'Synthetic owner','answer','Never expose this private content')",[ids.studentA,ids.owner])
 const jobs=(await db.query('select * from notification_email_outbox where recipient_id=$1',[ids.studentA])).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].notification_type,'notification_digest');assert.ok(new Date(jobs[0].available_at)>new Date())
 await db.query("update notification_email_outbox set available_at=now()-interval '1 second' where id=$1",[jobs[0].id]);const claim=(await fx.asUser(null,'select * from xelay_claim_notification_email($1)',[jobs[0].id],{role:'service_role'})).rows[0]
 const policy=await fx.service('xelay_notification_email_policy',[claim.id,claim.lock_token]);assert.equal(policy.eligible,true);assert.equal(policy.mode,'daily')
 const context=await fx.service('xelay_notification_email_digest_context',[claim.id,claim.lock_token]);assert.equal(context.total,3);assert.deepEqual(context.categories,[{key:'community',count:3}]);assert.doesNotMatch(JSON.stringify(context),/private content|Synthetic owner|@|user_id|recipient/)
 await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$2,'Synthetic owner','answer','Later event')",[ids.studentA,ids.owner]);assert.equal((await db.query('select count(*)::int n from notification_email_digest_batches where recipient_id=$1',[ids.studentA])).rows[0].n,2)
 assert.equal((await fx.service('xelay_notification_email_digest_context',[claim.id,claim.lock_token])).total,3)
 await fx.preferences(ids.studentA,{category_settings:{community:{in_app:true,email:'immediate'}}})
 const n=(await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$2,'Synthetic owner','answer','In flight event') returning id",[ids.studentA,ids.owner])).rows[0]
 const inFlight=(await fx.asUser(null,'select * from xelay_claim_notification_email((select id from notification_email_outbox where notification_id=$1))',[n.id],{role:'service_role'})).rows[0]
 await fx.preferences(ids.studentA,{category_settings:{community:{in_app:true,email:'daily'}}})
 const deferred=await fx.service('xelay_notification_email_policy',[inFlight.id,inFlight.lock_token]);assert.equal(deferred.eligible,false);assert.equal(deferred.reason,'digest_queued')
 assert.ok((await db.query('select 1 from notification_email_digest_entries where notification_id=$1',[n.id])).rows[0])
 await assert.rejects(fx.rpc(ids.studentA,'xelay_notification_email_policy',[inFlight.id,inFlight.lock_token]),/permission denied/)
 await fx.preferences(ids.studentA,{category_settings:{community:{in_app:true,email:'off'}}})
 assert.equal((await fx.service('xelay_notification_email_digest_context',[claim.id,claim.lock_token])).eligible,false,'A frozen summary is suppressed as a whole after an opt-out')
})

test('real timetable and test-admission writes classify mandatory events while test publications remain configurable',async t=>{
 const fx=await notificationCenterFixture();t.after(()=>fx.close());const {db,ids,rpc,groups,asUser}=fx
 await db.query('delete from notifications where recipient_id=$1',[ids.studentA])
 const lesson=(await asUser(ids.headA,`insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,valid_from,valid_until,created_by)
  values($1,1,'08:00','09:20','Synthetic Economics','lecture',current_date,current_date+60,$2) returning id`,[groups[0],ids.headA])).rows[0].id
 await asUser(ids.headA,"update study_group_schedule set starts_at='09:40',ends_at='11:00' where id=$1",[lesson])
 const timetable=(await fx.center(ids.studentA)).required_items.find(n=>n.academic_tab==='timetable')
 assert.ok(timetable);assert.equal(timetable.category_key,'schedule');assert.equal(timetable.delivery_priority,'urgent')
 await rpc(ids.studentA,'xelay_notification_acknowledge',[timetable.id,ids.studentA])
 const definition=syntheticTest(ids.course,[groups[0]],{title:'Synthetic admission notification test',bonus_percent:0})
 const initial=await rpc(ids.owner,'xelay_teaching_test_mutate',['save_test',JSON.stringify({...definition,expected_user_id:ids.owner})])
 assert.ok((await fx.center(ids.studentA)).items.some(n=>n.category_key==='tests'&&!n.acknowledgement_required))
 const payload={id:definition.id,version:initial.test.version,expected_user_id:ids.owner,override:{user_id:ids.studentA,group_id:groups[0],opens_at:null,closes_at:null,duration_seconds:null,excluded:true,exclusion_reason:'Synthetic condition'}}
 const changed=await rpc(ids.owner,'xelay_teaching_test_mutate',['save_override',JSON.stringify(payload)])
 const denied=(await fx.center(ids.studentA)).required_items.find(n=>n.category_key==='tests');assert.ok(denied)
 assert.equal((await rpc(ids.studentA,'xelay_teaching_test',[definition.id])).test.my_admission.allowed,false)
 await rpc(ids.owner,'xelay_teaching_test_mutate',['save_override',JSON.stringify({...payload,version:changed.test.version,override:{...payload.override,excluded:false,exclusion_reason:''}})])
 const restored=(await fx.center(ids.studentA)).required_items.filter(n=>n.category_key==='tests');assert.equal(restored.length,1);assert.notEqual(restored[0].id,denied.id)
 await assert.rejects(rpc(ids.studentA,'xelay_notification_acknowledge',[denied.id,ids.studentA]),/FORBIDDEN/)
 assert.equal((await db.query('select count(*)::int n from teaching_test_attempts where test_id=$1',[definition.id])).rows[0].n,0)
})

test('real common-deadline producer sends one mandatory notice only to the changed current audience',async t=>{
 const fx=await notificationCenterFixture();t.after(()=>fx.close());const {db,ids,groups,dates,mutate,rpc}=fx;await activate(fx)
 await fx.preferences(ids.studentA,{notifications_enabled:false,email_notifications_enabled:false,category_settings:{assignments:{in_app:false,email:'off'}}})
 const targetA={...target(groups[0]),due_at:dates.lesson_a+'T12:00:00Z',lesson_date:dates.lesson_a,placement_mode:'unplaced'}
 const targetB={...target(groups[1]),due_at:dates.lesson_b+'T12:00:00Z',lesson_date:dates.lesson_b,placement_mode:'unplaced'}
 const item={id:randomUUID(),version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Synthetic changed deadline',body:'Synthetic assignment',links:[],attachments:[],status:'published',targets:[targetA,targetB]}
 const original=await rpc(ids.owner,'xelay_teaching_save_multi_assignment',[JSON.stringify(item)])
 const changed=await mutate(ids.owner,'save_assignment',{...item,version:original.version,targets:[{...targetA,due_at:dates.lesson_a+'T13:00:00Z'},targetB]})
 const event='teaching-deadline:'+item.id+':'+changed.version
 const notes=(await db.query('select * from notifications where teaching_event_key=$1',[event])).rows
 assert.deepEqual(new Set(notes.map(n=>n.recipient_id)),new Set([ids.studentA,ids.headA]),'Unchanged second group receives no duplicate deadline notice')
 assert.ok(notes.every(n=>n.acknowledgement_required&&n.category_key==='assignments'&&n.delivery_priority==='urgent'))
 const notice=(await fx.center(ids.studentA,{category:'news'})).required_items.find(n=>n.teaching_event_key===event);assert.ok(notice)
 const job=(await db.query('select id from notification_email_outbox where notification_id=$1',[notice.id])).rows[0]
 const lease=(await fx.asUser(null,'select * from xelay_claim_notification_email($1)',[job.id],{role:'service_role'})).rows[0]
 assert.equal((await fx.service('xelay_notification_email_policy',[job.id,lease.lock_token])).eligible,true)
 const context=await fx.service('xelay_teaching_deadline_change_email_context',[job.id,lease.lock_token]);assert.equal(new Date(context.due_at).toISOString(),dates.lesson_a+'T13:00:00.000Z')
 const next=await mutate(ids.owner,'save_assignment',{...item,version:changed.version,targets:[{...targetA,due_at:null},targetB]})
 assert.equal((await fx.service('xelay_notification_email_policy',[job.id,lease.lock_token])).eligible,false,'An obsolete deadline is never mailed')
 await assert.rejects(rpc(ids.studentA,'xelay_notification_acknowledge',[notice.id,ids.studentA]),/FORBIDDEN/)
 assert.ok((await fx.center(ids.studentA)).required_items.some(n=>n.teaching_event_key==='teaching-deadline:'+item.id+':'+next.version))
})

test('complete local preview seed uses the real email sender with only an offline recording provider',async t=>{
 const fx=await notificationCenterFixture();t.after(()=>fx.close());const {ids}=fx
 const seed=await seedNotificationCenterPreview(fx);assert.ok(seed.announcementId)
 const mail=await createPreviewNotificationMail(fx,'http://127.0.0.1:3092')
 const immediate=await mail.deliver(ids.studentA)
 assert.ok(mail.messages.length>0,JSON.stringify(immediate))
 const own=mail.messages.filter(n=>n.recipient===ids.studentA);assert.ok(own.some(n=>n.text.includes('http://127.0.0.1:3092')))
 const before=mail.messages.length;const daily=await mail.deliver(ids.headA,true)
 assert.ok(mail.messages.length>before,JSON.stringify(daily))
 assert.ok(mail.messages.some(n=>n.recipient===ids.headA&&n.text.includes('notifications=1')))
 await mail.deliver(ids.studentA) // The intentionally long history can exceed one sixty-job worker batch.
 const previous=mail.messages.length;await mail.deliver(ids.studentA);await mail.deliver(ids.headA,true)
 assert.equal(mail.messages.length,previous,'Sent jobs and provider idempotency prevent a second local email')
 assert.ok(mail.messages.every(n=>n.recipient===ids.studentA||n.recipient===ids.headA))
})

test('test publication history survives harmless edits but leaves feed and email after current audience removal',async t=>{
 const fx=await notificationCenterFixture();t.after(()=>fx.close());const {db,ids,rpc,groups}=fx;await activate(fx)
 const definition=syntheticTest(ids.course,[groups[0]],{title:'Synthetic publication scope',bonus_percent:0})
 const first=await rpc(ids.owner,'xelay_teaching_test_mutate',['save_test',JSON.stringify({...definition,expected_user_id:ids.owner})])
 const notice=(await fx.center(ids.studentA)).items.find(n=>n.teaching_event_key?.startsWith('teaching-test-published:'+definition.id+':'));assert.ok(notice)
 const job=(await db.query('select id from notification_email_outbox where notification_id=$1',[notice.id])).rows[0]
 const lease=(await fx.asUser(null,'select * from xelay_claim_notification_email($1)',[job.id],{role:'service_role'})).rows[0]
 const saved=await rpc(ids.owner,'xelay_teaching_test_mutate',['save_test',JSON.stringify({...definition,version:first.test.version,title:'Synthetic harmless title update',expected_user_id:ids.owner})])
 assert.ok((await fx.center(ids.studentA)).items.some(n=>n.id===notice.id),'An ordinary edit must not erase publication history')
 assert.equal((await fx.service('xelay_notification_email_policy',[job.id,lease.lock_token])).eligible,true)
 await rpc(ids.owner,'xelay_teaching_test_mutate',['save_test',JSON.stringify({...definition,version:saved.test.version,targets:[{group_id:groups[1],audience_mode:'all',subgroup_ids:[]}],expected_user_id:ids.owner})])
 await assert.rejects(rpc(ids.studentA,'xelay_teaching_test',[definition.id]),/FORBIDDEN/)
 assert.equal((await fx.center(ids.studentA)).items.some(n=>n.id===notice.id),false)
 assert.equal((await fx.service('xelay_notification_email_policy',[job.id,lease.lock_token])).reason,'notification_unavailable')
})

test('real deadline and teacher-followup producers preserve independent email and in-app choices, receipts and caps',async t=>{
 const fx=await notificationCenterFixture();t.after(()=>fx.close());const {db,ids,groups,mutate,classroom}=fx;await activate(fx)
 const date=(await db.query("select (clock_timestamp() at time zone 'Europe/Kyiv')::date::text today")).rows[0].today
 const due=new Date(Date.now()+6*3600000).toISOString()
 const item={id:randomUUID(),version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Synthetic channel deadline',body:'Synthetic work',links:[],attachments:[],status:'published',targets:[{...target(groups[0]),due_at:due,lesson_date:date,placement_mode:'unplaced'}]}
 await mutate(ids.owner,'save_assignment',item)
 await fx.preferences(ids.studentA,{notifications_enabled:false,email_notifications_enabled:true,category_settings:{assignments:{in_app:false,email:'immediate'}}})
 await fx.preferences(ids.headA,{notifications_enabled:true,email_notifications_enabled:false,category_settings:{assignments:{in_app:true,email:'off'}}})
 const queue=async()=>(await db.query('select xelay_queue_academic_deadline_reminders() n')).rows[0].n
 assert.equal(await queue(),2);assert.equal(await queue(),0,'Existing per-source/due receipt still suppresses repeats')
 const deadlines=(await db.query("select n.*,q.id job_id from notifications n left join notification_email_outbox q on q.notification_id=n.id::text where n.type='academic_deadline'")).rows
 assert.equal(deadlines.length,2);assert.ok(deadlines.find(n=>n.recipient_id===ids.studentA).job_id);assert.equal(deadlines.find(n=>n.recipient_id===ids.headA).job_id,null)
 assert.equal((await fx.center(ids.studentA)).unread_count,0);assert.ok((await fx.center(ids.headA)).unread_count>0)
 await fx.preferences(ids.headA,{notifications_enabled:false,email_notifications_enabled:false})
 await fx.preferences(ids.studentA,{notifications_enabled:false,email_notifications_enabled:false})
 const later={...item,id:randomUUID()};await mutate(ids.owner,'save_assignment',later)
 assert.equal(await queue(),0,'Both channels off creates neither reminders nor suppression receipts')
 assert.equal((await db.query('select count(*)::int n from academic_deadline_reminder_receipts where source_id=$1',[later.id])).rows[0].n,0)
 await fx.preferences(ids.studentA,{notifications_enabled:false,email_notifications_enabled:true,category_settings:{assignments:{in_app:false,email:'daily'}}})
 assert.equal(await queue(),1)
 assert.ok((await db.query('select 1 from notification_email_digest_entries e join notifications n on n.id=e.notification_id where n.type=\'academic_deadline\' and n.recipient_id=$1',[ids.studentA])).rows[0])

 const submissionId=randomUUID();let submission=await classroom(ids.headA,'reserve_submission',{id:submissionId,item_id:item.id,group_id:groups[0]})
 submission=await classroom(ids.headA,'save_submission',{id:submissionId,item_id:item.id,group_id:groups[0],version:submission.version,body:'Synthetic response',links:[],attachments:[]})
 await classroom(ids.headA,'submit_submission',{id:submissionId,version:submission.version})
 await db.query("update teaching_submissions set submitted_at=clock_timestamp()-interval '48 hours' where id=$1",[submissionId])
 await fx.preferences(ids.owner,{notifications_enabled:false,email_notifications_enabled:true,category_settings:{assignments:{in_app:false,email:'daily'}}})
 const now=(await db.query("select ((current_date::timestamp+interval '9 hours 30 minutes') at time zone 'Europe/Kyiv')::text moment")).rows[0].moment
 assert.equal((await db.query('select xelay_private_queue_teaching_followups($1) n',[now])).rows[0].n,1)
 assert.equal((await db.query('select xelay_private_queue_teaching_followups($1) n',[now])).rows[0].n,0,'The once-daily backlog fingerprint remains intact')
 assert.ok((await db.query("select 1 from notification_email_digest_entries e join notifications n on n.id=e.notification_id where n.type='teaching_followup' and n.recipient_id=$1",[ids.owner])).rows[0])
 assert.equal((await fx.center(ids.owner)).unread_count,0)
 const weekly=(await db.query("select pg_get_functiondef('xelay_prepare_opportunities_digest()'::regprocedure) source")).rows[0].source
 assert.ok(weekly.includes("pref.preferences->'digest'='true'"));assert.ok(weekly.includes("'community','email'"));assert.ok(!weekly.includes('coalesce(n.notifications_enabled,true)'))
 const organizer=(await db.query("select pg_get_functiondef('xelay_private_dispatch_organizer_reminders(uuid,integer)'::regprocedure) source")).rows[0].source
 assert.ok(organizer.includes("channel_enabled(t.user_id,'organizer')"));assert.ok(organizer.includes("channel_enabled(v_task.user_id,'organizer')"))
})

test('current birthday source remains in-app only and respects the groups category without affecting gifts or email',async t=>{
 const fx=await notificationCenterFixture({applyCenter:false});t.after(()=>fx.close());const {db,ids}=fx
 for(const name of ['202610260001_birthday_gifts.sql','202610260006_appreciation_gifts.sql','202610290002_profile_birthdays.sql']) await db.exec(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'))
 await db.exec(await fx.readCenterMigration())
 const recipient=async()=>(await db.query('select xelay_private_birthday_notification_recipient($1,clock_timestamp()) enabled',[ids.studentA])).rows[0].enabled
 await fx.preferences(ids.studentA,{notifications_enabled:true,email_notifications_enabled:false,category_settings:{groups:{in_app:false,email:'off'}}})
 assert.equal(await recipient(),false)
 await fx.preferences(ids.studentA,{notifications_enabled:false,email_notifications_enabled:true,category_settings:{groups:{in_app:true,email:'immediate'}}})
 assert.equal(await recipient(),false,'Enabling email never enables a birthday email or birthday popup')
 await fx.preferences(ids.studentA,{notifications_enabled:true,email_notifications_enabled:false,category_settings:{groups:{in_app:true,email:'off'}}})
 assert.equal(await recipient(),true)
 const id=(await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$1,'Xelay','birthday_gift','Synthetic gift remains in app') returning id",[ids.studentA])).rows[0].id
 assert.equal((await db.query('select count(*)::int n from notification_email_outbox where notification_id=$1',[id])).rows[0].n,0)
 await assert.rejects(fx.rpc(ids.studentA,'xelay_private_notification_channel_enabled',[ids.studentA,'groups','any']),/permission denied/)
})
