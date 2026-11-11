// Synthetic, isolated PostgreSQL regressions for the existing-group follow-up.
// Historical campaign tests deliberately continue to exercise their old migration.
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {groupReferralFixture} from './group-referral-fixture.mjs'

const migrationUrl=new URL('../../supabase/migrations/202611110040_group_referral_existing_groups.sql',import.meta.url)
const apply=async fx=>fx.db.exec(await readFile(migrationUrl,'utf8'))
const day=86400000
const signatures=[
 'public.xelay_group_referral_action(text,jsonb,uuid)',
 'public.xelay_group_referral_workspace(text,uuid,uuid,uuid)',
 'public.xelay_private_referral_progress(uuid,uuid)',
]
const entry=async(fx,who,group)=>(await fx.workspace(who)).ownGroups.find(e=>e.groupId===group.group)
const candidate=async(fx,group)=>(await fx.workspace(group.head)).candidateGroups.find(g=>g.id===group.group)
const register=(fx,group,code,values={})=>fx.action(group.head,'register_group',{groupId:group.group,code,...values})
const definitions=async fx=>(await fx.db.query(`select oid::regprocedure::text signature,pg_get_functiondef(oid) definition
 from pg_proc where pronamespace='public'::regnamespace and proname like '%referral%' order by oid`)).rows
const metadata=async fx=>(await fx.db.query(`select oid,proowner,proacl::text,prosecdef,provolatile,proconfig,proargnames,
 prolang,prorettype,prokind,proleakproof,proisstrict,proparallel,procost,prorows,pg_get_function_arguments(oid) arguments
 from pg_proc where oid=any($1::regprocedure[]) order by oid`,[signatures])).rows
const tableShape=async fx=>(await fx.db.query(`select c.oid,c.relname,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity,
 a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) default_value
 from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
 left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
 where c.relnamespace='public'::regnamespace and c.relname like 'group_referral_%' order by c.oid,a.attnum`)).rows
const data=async fx=>{
 const result={}
 for(const name of ['group_referral_campaigns','group_referral_links','group_referral_entries','group_referral_credits',
  'group_referral_reads','group_referral_snapshots','group_referral_draw_orders','group_referral_winners',
  'group_referral_commands','group_referral_audit','study_groups','study_group_members','class_representative_requests','notifications']){
  result[name]=(await fx.db.query(`select count(*)::int n,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) hash from public.${name} t`)).rows[0]
 }
 return result
}

test('existing-group migration changes only three function bodies; approved tickets, dates, records, schema and permissions survive twice',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());await fx.open({startsAgoMs:3*day,equalDeadline:true})
 const owner=fx.ids.headA;const code=(await fx.action(owner,'create_link',{alias:'Existing group organizer',acceptRules:true})).ownLink.code
 const beforeStart=await fx.makeGroup({createdAt:new Date(Date.now()-30*day).toISOString()})
 const over24h=await fx.makeGroup({createdAt:new Date(Date.now()-25*3600000).toISOString()})
 await assert.rejects(register(fx,beforeStart,code),/REFERRAL_OLD_GROUP/)
 await assert.rejects(register(fx,over24h,code),/REFERRAL_REGISTRATION_EXPIRED/)
 const existing=await fx.makeGroup({organizer:owner,code});await fx.collect([existing]);await fx.approve(existing,owner)
 assert.equal((await fx.workspace(owner)).ownTickets,1)
 assert.equal((await candidate(fx,beforeStart)).reason,'REFERRAL_OLD_GROUP')
 assert.equal((await candidate(fx,over24h)).reason,'REFERRAL_REGISTRATION_EXPIRED')
 const before={data:await data(fx),metadata:await metadata(fx),tables:await tableShape(fx),definitions:await definitions(fx)}
 await apply(fx)
 assert.deepEqual(await data(fx),before.data);assert.deepEqual(await metadata(fx),before.metadata);assert.deepEqual(await tableShape(fx),before.tables)
 assert.equal((await fx.workspace(owner)).ownTickets,1)
 const afterDefinitions=await definitions(fx)
 assert.deepEqual(afterDefinitions.filter((f,i)=>f.definition!==before.definitions[i].definition).map(f=>f.signature).sort(),signatures.map(s=>s.slice(7)).sort())
 for(const group of [beforeStart,over24h]){const c=await candidate(fx,group);assert.equal(c.canRegister,true);assert.equal(c.reason,undefined)}
 await apply(fx)
 assert.deepEqual(await data(fx),before.data);assert.deepEqual(await metadata(fx),before.metadata);assert.deepEqual(await definitions(fx),afterDefinitions)
 for(const group of [beforeStart,over24h]){await register(fx,group,code);assert.equal((await entry(fx,owner,group)).issues.includes('old_or_changed_group'),false)}
})

test('an old own group may use its own headman code; representative membership, retries and second groups cannot double-count a student or ticket',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());await fx.open({equalDeadline:true});await apply(fx)
 const owner=await fx.user('own headman');const code=(await fx.action(owner,'create_link',{alias:'Own group organizer',acceptRules:true})).ownLink.code
 const group=await fx.makeGroup({representative:owner,createdAt:new Date(Date.now()-90*day).toISOString()})
 assert.equal((await candidate(fx,group)).canRegister,true)
 const requestId=randomUUID();await register(fx,group,code,{requestId});await register(fx,group,code,{requestId})
 await assert.rejects(register(fx,group,code),/REFERRAL_GROUP_ALREADY_REGISTERED/)
 let state=await fx.workspace(owner);assert.equal(state.ownGroups.filter(e=>e.groupId===group.group).length,1)
 let progress=await entry(fx,owner,group);assert.equal(progress.viewerRole,'organizer');assert.equal(progress.verifiedStudents,10);assert.equal(progress.eligible,false)
 assert.equal(progress.issues.includes('old_or_changed_group'),false)
 for(const member of group.members){await fx.observe(member,group.group,group.schedule);await fx.observe(member,group.group,group.homework,'homework')}
 progress=await entry(fx,owner,group);assert.equal(progress.returningStudents,0);assert.equal(progress.ownMemberDays,1)
 await fx.elapse(1);for(const member of group.members)await fx.observe(member,group.group,group.homework,'homework')
 progress=await entry(fx,owner,group);assert.equal(progress.returningStudents,10);assert.equal(progress.ownMemberDays,2);assert.equal(progress.eligible,true)
 await fx.approve(group,owner);assert.equal((await fx.workspace(owner)).ownTickets,1)
 const second=await fx.makeGroup({createdAt:new Date(Date.now()-60*day).toISOString(),organizer:owner,code})
 await fx.db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',clock_timestamp())",[second.group,owner,second.head])
 assert.equal((await fx.observe(owner,second.group,second.schedule)).counted,false)
 assert.equal((await entry(fx,owner,second)).ownMemberCounts,false)
 assert.equal((await fx.db.query('select count(*)::int n from group_referral_credits where campaign_id=$1 and user_id=$2',[fx.campaign,owner])).rows[0].n,1)
 assert.equal((await fx.db.query('select count(*)::int n from group_referral_entries where campaign_id=$1 and group_id=$2',[fx.campaign,group.group])).rows[0].n,1)
 assert.equal((await fx.workspace(owner)).ownTickets,1)
 await fx.db.query("update study_groups set created_at=created_at+interval '1 minute' where id=$1",[group.group])
 progress=await entry(fx,owner,group);assert.ok(progress.issues.includes('old_or_changed_group'));assert.equal(progress.eligible,false)
 assert.equal((await fx.workspace(owner)).ownTickets,0)
 await fx.db.query('update study_groups set created_at=(select group_created_at from group_referral_entries where group_id=$1) where id=$1',[group.group])
 assert.equal((await fx.workspace(owner)).ownTickets,1)
})

test('old groups still require ten verified accepted students, the returning headman, real resources and two distinct Kyiv dates',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());await fx.open({equalDeadline:true});await apply(fx)
 const owner=fx.ids.headA;const code=(await fx.action(owner,'create_link',{alias:'Qualification organizer',acceptRules:true})).ownLink.code
 const nine=await fx.makeGroup({students:9,createdAt:new Date(Date.now()-30*day).toISOString(),organizer:owner,code})
 let p=await entry(fx,owner,nine);assert.equal(p.verifiedStudents,9);assert.ok(p.issues.includes('need_ten_verified_students'))
 await assert.rejects(fx.action(nine.head,'submit_group',{entryId:p.id,version:p.version}),/REFERRAL_GROUP_INELIGIBLE/)
 const group=await fx.makeGroup({createdAt:new Date(Date.now()-30*day).toISOString(),organizer:owner,code})
 await assert.rejects(fx.observe(group.members[1],group.group,group.schedule,'schedule',group.head),/REFERRAL_AUTH_REQUIRED/)
 await assert.rejects(fx.observe(fx.ids.outsider,group.group,group.schedule),/REFERRAL_GROUP_FORBIDDEN/)
 await assert.rejects(fx.observe(group.members[1],group.group,nine.schedule),/REFERRAL_GROUP_FORBIDDEN/)
 for(const student of group.members.slice(1))await fx.observe(student,group.group,group.schedule)
 await fx.elapse(1);for(const student of group.members.slice(1))await fx.observe(student,group.group,group.homework,'homework')
 p=await entry(fx,owner,group);assert.equal(p.returningStudents,9);assert.ok(p.issues.includes('representative_must_return'))
 await fx.observe(group.head,group.group,group.schedule);await fx.elapse(1);await fx.observe(group.head,group.group,group.homework,'homework')
 p=await entry(fx,owner,group);assert.equal(p.eligible,true);assert.equal(p.returningStudents,10)
 // The stored Kyiv date must agree with the server observation, not a supplied day.
 const saved=(await fx.db.query('select user_id,observed_at::text,day::text from group_referral_reads where entry_id=$1 order by user_id,day',[p.id])).rows
 assert.equal(saved.length,20)
 await fx.db.query("update group_referral_reads set day=day+10 where entry_id=$1",[p.id])
 p=await entry(fx,owner,group);assert.equal(p.returningStudents,0);assert.equal(p.eligible,false)
 await fx.db.query("update group_referral_reads set day=(observed_at at time zone 'Europe/Kyiv')::date where entry_id=$1",[p.id])
 assert.equal((await entry(fx,owner,group)).eligible,true)
 await fx.db.query('update auth.users set email_confirmed_at=null where id=$1',[group.members[1]])
 await assert.rejects(fx.observe(group.members[1],group.group,group.schedule),/REFERRAL_VERIFICATION_REQUIRED/)
 p=await entry(fx,owner,group);assert.equal(p.verifiedStudents,9);assert.equal(p.returningStudents,9)
 await fx.db.query('update auth.users set email_confirmed_at=clock_timestamp() where id=$1',[group.members[1]])
 await fx.db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[group.group,group.members[1]])
 p=await entry(fx,owner,group);assert.equal(p.verifiedStudents,9);assert.equal(p.returningStudents,9)
 await fx.db.query("update study_group_members set status='accepted',accepted_at=clock_timestamp() where group_id=$1 and user_id=$2",[group.group,group.members[1]])
 p=await entry(fx,owner,group);assert.equal(p.verifiedStudents,10);assert.equal(p.returningStudents,9)
 await fx.asUser(group.head,'delete from study_group_homework where id=$1',[group.homework])
 p=await entry(fx,owner,group);assert.equal(p.hasResource,false);assert.equal(p.returningStudents,0)
 await fx.asUser(group.head,'update study_group_schedule set valid_until=current_date-30 where id=$1',[group.schedule])
 assert.equal((await entry(fx,owner,group)).hasSchedule,false)
})

test('age relaxation preserves future-date, duplicate, test-group, actor, MFA and table-permission guards',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());await fx.open({equalDeadline:true});await apply(fx)
 const owner=fx.ids.headA;const code=(await fx.action(owner,'create_link',{alias:'Boundary organizer',acceptRules:true})).ownLink.code
 const future=await fx.makeGroup({createdAt:new Date(Date.now()+day).toISOString()})
 assert.equal((await candidate(fx,future)).canRegister,false)
 await assert.rejects(register(fx,future,code),/REFERRAL_REGISTRATION_EXPIRED/)
 const hidden=await fx.makeGroup({name:'тест 01',createdAt:new Date(Date.now()-30*day).toISOString()})
 assert.equal((await candidate(fx,hidden)).canRegister,false)
 await assert.rejects(register(fx,hidden,code),/REFERRAL_GROUP_INELIGIBLE/)
 const a=await fx.makeGroup({name:'Real Group',createdAt:new Date(Date.now()-30*day).toISOString()})
 const b=await fx.makeGroup({name:'Real-Group',createdAt:new Date(Date.now()-30*day).toISOString()})
 await fx.db.query('update study_groups set specialty=(select specialty from study_groups where id=$1) where id=$2',[a.group,b.group])
 for(const group of [a,b]){assert.equal((await candidate(fx,group)).canRegister,false);await assert.rejects(register(fx,group,code),/REFERRAL_GROUP_INELIGIBLE/)}
 const real=await fx.makeGroup({createdAt:new Date(Date.now()-30*day).toISOString()})
 await assert.rejects(fx.action(fx.ids.studentA,'register_group',{groupId:real.group,code}),/REFERRAL_GROUP_FORBIDDEN/)
 await assert.rejects(fx.rpc(owner,'xelay_group_referral_action',['register_group',JSON.stringify({campaignId:fx.campaign,requestId:randomUUID(),groupId:real.group,code}),real.head]),/REFERRAL_AUTH_REQUIRED/)
 await assert.rejects(register(fx,real,'invalid-code'),/REFERRAL_INVALID_CODE/)
 await assert.rejects(fx.action(fx.ids.admin,'freeze_entries',{version:1,confirm:true}),/REFERRAL_MFA_REQUIRED/)
 await assert.rejects(fx.action(owner,'freeze_entries',{version:1,confirm:true}),/REFERRAL_ADMIN_REQUIRED/)
 for(const table of ['campaigns','links','entries','credits','reads','snapshots','draw_orders','winners','commands','audit'])for(const role of ['anon','authenticated','service_role']){
  assert.equal((await fx.db.query("select has_table_privilege($1,$2,'select,insert,update,delete') permitted",[role,'group_referral_'+table])).rows[0].permitted,false)
 }
 await assert.rejects(fx.rpc(owner,'xelay_private_referral_progress',[randomUUID(),owner]),/permission denied/)
 const guest=await fx.workspace(null);assert.equal(guest.actor,null);assert.deepEqual(guest.ownGroups,[]);assert.deepEqual(guest.candidateGroups,[])
 const outsider=await fx.workspace(fx.ids.outsider);assert.equal(outsider.admin,undefined);assert.deepEqual(outsider.ownGroups,[])
 assert.doesNotMatch(JSON.stringify(outsider),new RegExp(code+'|'+real.head))
})

test('registration waits for campaign start and all personal windows still stop at seven days or the final deadline',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());await apply(fx);await fx.open({startsAgoMs:-day,equalDeadline:true})
 const group=await fx.makeGroup({createdAt:new Date(Date.now()-30*day).toISOString()})
 assert.equal((await candidate(fx,group)).canRegister,false)
 await assert.rejects(fx.action(group.head,'create_link',{alias:'Early organizer',acceptRules:true}),/REFERRAL_NOT_OPEN/)
 await assert.rejects(register(fx,group,'irrelevant-code'),/REFERRAL_NOT_OPEN/)
 await fx.elapse(2)
 const owner=fx.ids.headA;const code=(await fx.action(owner,'create_link',{alias:'Window organizer',acceptRules:true})).ownLink.code
 await register(fx,group,code)
 const early=group.members[1];assert.equal((await fx.observe(early,group.group,group.schedule)).counted,true)
 // Shift only this student's proof eight days, retaining an open campaign.
 await fx.db.exec('alter table group_referral_credits disable trigger group_referral_credit_immutable')
 try{await fx.db.query("update group_referral_credits set first_seen_at=first_seen_at-interval '8 days' where user_id=$1",[early])}finally{await fx.db.exec('alter table group_referral_credits enable trigger group_referral_credit_immutable')}
 assert.equal((await fx.observe(early,group.group,group.homework,'homework')).counted,false)
 const late=group.members[2];assert.equal((await fx.observe(late,group.group,group.schedule)).counted,true)
 assert.equal((await entry(fx,late,group)).ownMemberDays,1)
 await fx.elapse(5)
 const deadlineLate=group.members[3];assert.equal((await fx.observe(deadlineLate,group.group,group.schedule)).counted,true)
 await fx.elapse(2)
 // This late student's personal window has five days left when the campaign ends.
 assert.equal((await fx.observe(deadlineLate,group.group,group.homework,'homework')).counted,false)
 assert.equal((await entry(fx,deadlineLate,group)).ownMemberDays,1)
 const newOld=await fx.makeGroup({createdAt:new Date(Date.now()-30*day).toISOString()})
 assert.equal((await candidate(fx,newOld)).canRegister,false)
 await assert.rejects(register(fx,newOld,code),/REFERRAL_NOT_OPEN/)
 const p=await entry(fx,owner,group);await assert.rejects(fx.action(owner,'submit_group',{entryId:p.id,version:p.version}),/REFERRAL_NOT_OPEN/)
 const campaign=(await fx.workspace(owner)).campaign;assert.equal(campaign.joinsUntil,campaign.qualifiesUntil)
})

test('unknown function bodies fail closed atomically instead of overwriting an unrelated backend change',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close())
 for(const signature of signatures){
  const original=(await fx.db.query('select pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition
  assert.match(original,/AS \$function\$/)
  await fx.db.exec(original.replace('AS $function$','AS $function$\n-- Unexpected independent backend change.'))
  const before=await definitions(fx);const rowsBefore=await data(fx)
  await assert.rejects(apply(fx),/REFERRAL_EXISTING_GROUPS_.*CHANGED/)
  await fx.db.exec('rollback')
  assert.deepEqual(await definitions(fx),before);assert.deepEqual(await data(fx),rowsBefore)
  await fx.db.exec(original)
 }
 // Source and SQL files may independently use Windows or Unix line endings.
 // Converting a known body to CRLF must not disable the exact-source guard.
 for(const signature of signatures){
  const original=(await fx.db.query('select pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition
  await fx.db.exec(original.replace(/\r?\n/g,'\r\n'))
 }
 const beforeMetadata=await metadata(fx)
 await fx.db.exec((await readFile(migrationUrl,'utf8')).replace(/\r?\n/g,'\r\n'))
 assert.deepEqual(await metadata(fx),beforeMetadata)
 const patched=await definitions(fx);await apply(fx);assert.deepEqual(await definitions(fx),patched)
 const postcheck=await readFile(new URL('./group-referral-existing-groups-postcheck.sql',import.meta.url),'utf8')
 const result=(await fx.db.query(postcheck)).rows[0]
 assert.equal(result.registered_groups,0);assert.equal(result.eligible_approved_tickets,0)
 assert.equal(Object.keys(result.stored_data_fingerprints).length,10)
 assert.equal(Object.keys(result.function_sha256).length,3)
})
