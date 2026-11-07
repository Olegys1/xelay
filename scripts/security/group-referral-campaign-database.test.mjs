import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {groupReferralFixture} from './group-referral-fixture.mjs'
import {normalizeGroupReferralCode} from '../../src/lib/groupReferralInvitation.ts'

test('draft is safe by default; exact actor, MFA, consent, immutable attribution and table boundaries',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());const {db,ids}=fx
 const guest=await fx.workspace(null);assert.equal(guest.campaign.state,'draft');assert.equal(guest.campaign.startsAt,null);assert.equal(guest.campaign.prizes[0].label,'ChatGPT Plus');assert.equal(guest.campaign.prizes[0].months,1);assert.equal(guest.actor,null);assert.deepEqual(guest.ownGroups,[]);assert.equal(guest.admin,undefined)
 await assert.rejects(fx.admin('activate_campaign',{version:1}),/REFERRAL_CAMPAIGN_INCOMPLETE/)
 await assert.rejects(fx.action(ids.headA,'create_link',{alias:'Synthetic inviter',acceptRules:true}),/REFERRAL_NOT_OPEN/)
 await assert.rejects(fx.action(ids.admin,'activate_campaign',{version:1}),/REFERRAL_MFA_REQUIRED/)
 await assert.rejects(fx.action(ids.studentA,'activate_campaign',{version:1}),/REFERRAL_ADMIN_REQUIRED/)
 await assert.rejects(fx.rpc(ids.headA,'xelay_group_referral_action',['create_link',JSON.stringify({campaignId:fx.campaign,requestId:randomUUID(),alias:'Synthetic',acceptRules:true}),ids.studentA]),/REFERRAL_AUTH_REQUIRED/)
 for(const table of ['campaigns','links','entries','credits','reads','snapshots','draw_orders','winners','commands','audit'])for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query('select has_table_privilege($1,$2,\'select,insert,update,delete\') permitted',[role,'group_referral_'+table])).rows[0].permitted,false)
 await assert.rejects(fx.asUser(ids.headA,"insert into group_referral_credits(campaign_id,user_id,entry_id,first_seen_at) values($1,$2,$3,'2000-01-01')",[fx.campaign,ids.headA,randomUUID()]),/permission denied/)
 await assert.rejects(fx.rpc(ids.headA,'xelay_private_referral_progress',[randomUUID(),ids.headA]),/permission denied/)
 const noCampaign=await fx.rpc(null,'xelay_group_referral_workspace',['not-installed-campaign',null,null],{role:'anon'});assert.equal(noCampaign.campaign,null);assert.equal(noCampaign.actor,null);assert.deepEqual(noCampaign.winners,[])
 await fx.open();await assert.rejects(fx.action(ids.headA,'create_link',{alias:'Synthetic head',acceptRules:false}),/REFERRAL_INVALID_PAYLOAD/)
 const requestId=randomUUID();let state=await fx.action(ids.headA,'create_link',{alias:'Synthetic head',acceptRules:true,requestId});const code=state.ownLink.code
 assert.match(code,/^[A-F0-9]{32}$/);const normalizedCode=normalizeGroupReferralCode(' '+code.toLowerCase()+' ');assert.equal(normalizedCode,code)
 assert.equal((await fx.action(ids.headA,'create_link',{alias:'Synthetic head',acceptRules:true,requestId})).ownLink.code,code)
 await assert.rejects(fx.action(ids.headA,'create_link',{alias:'Changed alias',acceptRules:true,requestId}),/REFERRAL_INVALID_PAYLOAD/)
 await assert.rejects(fx.action(ids.headA,'create_link',{alias:'Changed alias',acceptRules:true}),/REFERRAL_INVALID_PAYLOAD/)
 await assert.rejects(fx.admin('save_campaign',{version:state.campaign.version,title:'Changed',prizes:state.campaign.prizes}),/REFERRAL_INVALID_STATE/)
 const old=await fx.makeGroup({createdAt:new Date(Date.now()-86400000).toISOString()});await assert.rejects(fx.action(old.head,'register_group',{groupId:old.group,code}),/REFERRAL_OLD_GROUP/)
 const hidden=await fx.makeGroup({name:'ооо 1'});await assert.rejects(fx.action(hidden.head,'register_group',{groupId:hidden.group,code}),/REFERRAL_GROUP_INELIGIBLE/)
 const group=await fx.makeGroup();await assert.rejects(fx.action(group.head,'register_group',{groupId:group.group,code:'not-an-inviter-code'}),/REFERRAL_INVALID_CODE/)
 await fx.action(group.head,'register_group',{groupId:group.group,code:normalizedCode});await assert.rejects(fx.action(group.head,'register_group',{groupId:group.group,code}),/REFERRAL_GROUP_ALREADY_REGISTERED/)
 await assert.rejects(fx.action(ids.studentA,'register_group',{groupId:group.group,code}),/REFERRAL_GROUP_FORBIDDEN/)
 const outsider=await fx.workspace(ids.outsider);assert.deepEqual(outsider.ownGroups,[]);assert.equal(outsider.ownLink,null);assert.doesNotMatch(JSON.stringify(outsider),new RegExp(code+'|'+group.head))
})

test('only real accepted verified students produce server-dated reads; one credit per campaign; late joiners own week',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());await fx.open()
 const inviter=fx.ids.headA;const code=(await fx.action(inviter,'create_link',{alias:'Inviter one',acceptRules:true})).ownLink.code
 const a=await fx.makeGroup({organizer:inviter,code});const b=await fx.makeGroup({organizer:inviter,code})
 const student=a.members[1]
 await assert.rejects(fx.observe(student,a.group,a.schedule,'schedule',a.head),/REFERRAL_AUTH_REQUIRED/)
 await assert.rejects(fx.observe(fx.ids.outsider,a.group,a.schedule),/REFERRAL_GROUP_FORBIDDEN/)
 await assert.rejects(fx.observe(student,a.group,b.schedule),/REFERRAL_GROUP_FORBIDDEN/)
 await assert.rejects(fx.observe(student,a.group,randomUUID()),/REFERRAL_GROUP_FORBIDDEN/)
 await assert.rejects(fx.action(a.head,'submit_group',{entryId:a.entry.id,version:a.entry.version,observedAt:'2000-01-01'}),/REFERRAL_INVALID_PAYLOAD/)
 assert.equal((await fx.observe(student,a.group,a.schedule)).counted,true);await fx.observe(student,a.group,a.schedule)
 let own=(await fx.workspace(student)).ownGroups[0];assert.equal(own.viewerRole,'member');assert.equal(own.canSubmit,false);assert.equal(own.ownMemberDays,1)
 await fx.db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',clock_timestamp()-interval '1 day')",[b.group,student,b.head])
 assert.equal((await fx.observe(student,b.group,b.schedule)).counted,false)
 await assert.rejects(fx.action(student,'submit_group',{entryId:own.id,version:own.version}),/REFERRAL_GROUP_FORBIDDEN/)
 await fx.db.query('update auth.users set email_confirmed_at=null where id=$1',[a.members[2]]);await assert.rejects(fx.observe(a.members[2],a.group,a.schedule),/REFERRAL_VERIFICATION_REQUIRED/)
 await fx.db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[a.group,student]);assert.deepEqual((await fx.workspace(student)).ownGroups.map(e=>e.groupId),[b.group])
 await assert.rejects(fx.observe(student,a.group,a.schedule),/REFERRAL_GROUP_FORBIDDEN/)
 assert.equal((await fx.workspace(a.head)).ownGroups[0].returningStudents,0)
 // Entry age alone never consumes a late student's personal seven-day window.
 await fx.elapse(3);const late=b.members[2];assert.equal((await fx.observe(late,b.group,b.schedule)).counted,true);assert.equal((await fx.workspace(late)).ownGroups[0].ownMemberDays,1)
 assert.equal((await fx.db.query('select count(*)::int n from group_referral_credits where campaign_id=$1 and user_id=$2',[fx.campaign,student])).rows[0].n,1)
})

test('full journey: unlimited tickets, organizer review, regression-safe snapshot, three distinct weighted winners, private publication and issuance',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());await fx.open()
 const organizers=[fx.ids.headA,fx.ids.headB,fx.ids.studentA];const codes=[]
 for(let i=0;i<organizers.length;i++)codes.push((await fx.action(organizers[i],'create_link',{alias:'Organizer '+(i+1),acceptRules:true})).ownLink.code)
 const groups=[];for(let i=0;i<6;i++)groups.push(await fx.makeGroup({organizer:organizers[i<4?0:i-3],code:codes[i<4?0:i-3]}))
 await fx.collect(groups)
 for(let i=0;i<groups.length;i++)await fx.approve(groups[i],organizers[i<4?0:i-3])
 let state=await fx.workspace(organizers[0]);assert.equal(state.ownTickets,4);assert.ok(state.ownGroups.every(e=>e.eligible&&e.returningStudents===10&&e.verifiedStudents===10))
 let admin=await fx.workspace(fx.ids.admin,{aal:'aal2'});assert.equal(admin.admin.approvedTickets,6);assert.equal(admin.admin.eligibleOrganizers,3)
 const previouslyShownVersion=admin.campaign.version;const reviewed=admin.admin.groups[0]
 await fx.admin('review_group',{entryId:reviewed.id,version:reviewed.version,decision:'approved',reason:'Synthetic recheck after another admin preview'})
 await assert.rejects(fx.admin('freeze_entries',{version:previouslyShownVersion,confirm:true}),/REFERRAL_VERSION_CONFLICT/)
 admin=await fx.workspace(fx.ids.admin,{aal:'aal2'})
 await assert.rejects(fx.admin('freeze_entries',{version:admin.campaign.version,confirm:true}),/REFERRAL_TOO_EARLY/)
 await fx.elapse(9)
 await fx.db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[groups[0].group,groups[0].members[1]])
 await assert.rejects(fx.admin('freeze_entries',{version:admin.campaign.version,confirm:true}),/REFERRAL_GROUP_INELIGIBLE/)
 await fx.db.query("update study_group_members set status='accepted' where group_id=$1 and user_id=$2",[groups[0].group,groups[0].members[1]])
 state=await fx.admin('freeze_entries',{version:admin.campaign.version,confirm:true});assert.equal(state.campaign.state,'frozen');assert.match(state.campaign.snapshotHash,/^[a-f0-9]{64}$/)
 assert.equal((await fx.db.query('select count(*)::int n from group_referral_snapshots')).rows[0].n,6)
 await assert.rejects(fx.db.exec("update group_referral_snapshots set alias='rewritten'"),/REFERRAL_IMMUTABLE/)
 const requestId=randomUUID();const draw={version:state.campaign.version,confirm:true,requestId}
 const parallel=await Promise.all([fx.admin('draw_winners',draw),fx.admin('draw_winners',draw)])
 state=parallel[0];assert.deepEqual(parallel[1].winners.map(w=>w.id),state.winners.map(w=>w.id));assert.equal(state.campaign.state,'drawn');assert.equal(state.winners.length,3);assert.equal(new Set(state.winners.map(w=>w.organizerId)).size,3)
 assert.equal((await fx.db.query("select count(*)::int n from group_referral_commands where action='draw_winners'")).rows[0].n,1)
 assert.equal((await fx.db.query('select count(*)::int n from group_referral_draw_orders')).rows[0].n,6)
 const winners=state.winners.map(w=>w.id);assert.deepEqual((await fx.admin('draw_winners',draw)).winners.map(w=>w.id),winners)
 await assert.rejects(fx.admin('draw_winners',{version:state.campaign.version,confirm:true}),/REFERRAL_ALREADY_DRAWN/)
 assert.deepEqual((await fx.workspace(null)).winners,[])
 state=await fx.admin('publish_results',{version:state.campaign.version,confirm:true});assert.equal(state.campaign.state,'published')
 const guest=await fx.workspace(null);assert.equal(guest.winners.length,3);for(const w of guest.winners){assert.equal(w.organizerId,undefined);assert.equal(w.prizeStatus,undefined);assert.equal(w.interviewStatus,undefined)}
 assert.doesNotMatch(JSON.stringify(guest),/Synthetic head|example\.test|rules_version|requestId|random_key|student_|"admin"/)
 let winner=state.winners[0];state=await fx.admin('set_prize_status',{winnerId:winner.id,version:winner.version,prizeStatus:'issued',reason:'Synthetic manual fulfilment'})
 winner=state.winners.find(w=>w.id===winner.id);assert.equal(winner.prizeStatus,'issued')
 let own=await fx.action(winner.organizerId,'set_interview_status',{winnerId:winner.id,version:winner.version,interviewStatus:'declined',reason:'Prefer not to participate'})
 assert.equal(own.winners.find(w=>w.id===winner.id).interviewStatus,'declined')
 await assert.rejects(fx.action(winner.organizerId,'set_interview_status',{winnerId:winner.id,version:winner.version+1,interviewStatus:'completed',reason:'Not allowed'}),/REFERRAL_ADMIN_REQUIRED/)
 const notices=(await fx.db.query("select count(*)::int n from notifications where type='group_referral_result'")).rows[0].n;assert.equal(notices,3)
 assert.ok((await fx.workspace(fx.ids.admin,{aal:'aal2'})).admin.audit.some(a=>a.action==='set_prize_status'))
})

test('registration expires after24hours; normalized duplicate groups and invalid prize structures are rejected',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());const draft=await fx.workspace(fx.ids.admin,{aal:'aal2'})
 await assert.rejects(fx.admin('save_campaign',{version:draft.campaign.version,title:'Synthetic malformed prizes',prizes:[{months:1},{months:6},{months:3}]}),/REFERRAL_INVALID_PAYLOAD/)
 await fx.open({startsAgoMs:3*86400000});const code=(await fx.action(fx.ids.headA,'create_link',{alias:'Real organizer',acceptRules:true})).ownLink.code
 const expired=await fx.makeGroup({createdAt:new Date(Date.now()-25*3600000).toISOString()});await assert.rejects(fx.action(expired.head,'register_group',{groupId:expired.group,code}),/REFERRAL_REGISTRATION_EXPIRED/)
 const a=await fx.makeGroup({name:'Duplicate Group'});const b=await fx.makeGroup({name:'Duplicate-Group'})
 await fx.db.query('update study_groups set specialty=(select specialty from study_groups where id=$1) where id=$2',[a.group,b.group])
 await assert.rejects(fx.action(a.head,'register_group',{groupId:a.group,code}),/REFERRAL_GROUP_INELIGIBLE/)
 await assert.rejects(fx.action(b.head,'register_group',{groupId:b.group,code}),/REFERRAL_GROUP_INELIGIBLE/)
 await assert.rejects(fx.db.exec("update group_referral_campaigns set title='Unsafe mid-campaign change'"),/REFERRAL_IMMUTABLE/)
})

test('own and admin pagination exceed50entries without a ticket or group cap and member progress never exposes rosters',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());await fx.open();const organizer=fx.ids.headA
 const code=(await fx.action(organizer,'create_link',{alias:'Unlimited organizer',acceptRules:true})).ownLink.code
 for(let i=0;i<51;i++){const candidate=await fx.makeGroup({students:1});await fx.db.query('update study_groups set representative_id=$1 where id=$2',[organizer,candidate.group])}
 const candidates=await fx.workspace(organizer);assert.equal(candidates.candidateGroups.length,50);assert.ok(candidates.candidateNextCursor)
 const moreCandidates=await fx.workspace(organizer,{candidateAfter:candidates.candidateNextCursor});assert.equal(moreCandidates.candidateGroups.length,2);assert.equal(moreCandidates.candidateNextCursor,null)
 assert.equal(new Set([...candidates.candidateGroups,...moreCandidates.candidateGroups].map(g=>g.id)).size,52)
 for(let i=0;i<51;i++)await fx.makeGroup({organizer,code,students:1})
 const first=await fx.workspace(organizer);assert.equal(first.ownGroups.length,50);assert.ok(first.nextCursor)
 const second=await fx.workspace(organizer,{after:first.nextCursor});assert.equal(second.ownGroups.length,1);assert.equal(second.nextCursor,null)
 assert.equal(new Set([...first.ownGroups,...second.ownGroups].map(e=>e.id)).size,51)
 const adminFirst=await fx.workspace(fx.ids.admin,{aal:'aal2'});const adminSecond=await fx.workspace(fx.ids.admin,{aal:'aal2',adminAfter:adminFirst.admin.nextCursor})
 assert.equal(adminFirst.admin.groups.length,50);assert.equal(adminSecond.admin.groups.length,1)
 assert.equal(first.ownTickets,0);assert.ok(first.ownGroups.every(e=>!e.eligible))
 assert.doesNotMatch(JSON.stringify(first.ownGroups),/email|username|recipient|members|students\":\[/i)
})

test('removed resources and reaccepted memberships invalidate old proof instead of crediting a replay',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());await fx.open();const organizer=fx.ids.headA
 const code=(await fx.action(organizer,'create_link',{alias:'Proof organizer',acceptRules:true})).ownLink.code
 const group=await fx.makeGroup({organizer,code});await fx.collect([group]);let state=await fx.workspace(organizer);assert.equal(state.ownGroups[0].eligible,true)
 const student=group.members[1]
 await fx.db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[group.group,student])
 await fx.db.query("update study_group_members set status='accepted',accepted_at=clock_timestamp() where group_id=$1 and user_id=$2",[group.group,student])
 state=await fx.workspace(organizer);assert.equal(state.ownGroups[0].returningStudents,9);assert.equal(state.ownGroups[0].eligible,false)
 await fx.asUser(group.head,'delete from study_group_homework where id=$1',[group.homework])
 state=await fx.workspace(organizer);assert.equal(state.ownGroups[0].hasResource,false);assert.equal(state.ownGroups[0].returningStudents,0)
 await assert.rejects(fx.action(organizer,'submit_group',{entryId:state.ownGroups[0].id,version:state.ownGroups[0].version}),/REFERRAL_GROUP_INELIGIBLE/)
})

test('freeze requires three organizers; no ticket cap, fake clock acceptance, partial draw or double command',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());await fx.open();const owner=fx.ids.headA
 const code=(await fx.action(owner,'create_link',{alias:'Only organizer',acceptRules:true})).ownLink.code
 const group=await fx.makeGroup({organizer:owner,code});await fx.collect([group]);await fx.approve(group,owner);await fx.elapse(9)
 const state=await fx.workspace(fx.ids.admin,{aal:'aal2'});await assert.rejects(fx.admin('freeze_entries',{version:state.campaign.version,confirm:true}),/REFERRAL_NEED_THREE_ORGANIZERS/)
 assert.equal((await fx.db.query('select count(*)::int n from group_referral_snapshots')).rows[0].n,0)
 assert.equal((await fx.workspace(null)).campaign.state,'open')
 await assert.rejects(fx.admin('draw_winners',{version:state.campaign.version,confirm:true}),/REFERRAL_INVALID_STATE/)
 await assert.rejects(fx.admin('freeze_entries',{version:state.campaign.version+1,confirm:true}),/REFERRAL_VERSION_CONFLICT/)
 const repeated={entryId:group.entry.id,version:1,requestId:randomUUID()};await assert.rejects(fx.action(owner,'submit_group',repeated),/REFERRAL_VERSION_CONFLICT|REFERRAL_NOT_OPEN/)
})

test('current notification-center integration preserves channel choices and never forces promotional email or mandatory ACK',async t=>{
 const fx=await groupReferralFixture({notificationCenter:true});t.after(()=>fx.close());await fx.open()
 const organizers=[fx.ids.headA,fx.ids.headB,fx.ids.studentA];const groups=[]
 for(let i=0;i<organizers.length;i++){
  const code=(await fx.action(organizers[i],'create_link',{alias:'Notification organizer '+i,acceptRules:true})).ownLink.code
  groups.push(await fx.makeGroup({organizer:organizers[i],code}))
 }
 await fx.preferences(organizers[0],{notifications_enabled:true,email_notifications_enabled:true,category_settings:{community:{in_app:false,email:'off'}}})
 await fx.preferences(organizers[1],{notifications_enabled:false,email_notifications_enabled:true})
 await fx.preferences(organizers[2],{notifications_enabled:true,email_notifications_enabled:false})
 await fx.collect(groups);for(let i=0;i<groups.length;i++)await fx.approve(groups[i],organizers[i]);await fx.elapse(9)
 let state=await fx.workspace(fx.ids.admin,{aal:'aal2'});state=await fx.admin('freeze_entries',{version:state.campaign.version,confirm:true});state=await fx.admin('draw_winners',{version:state.campaign.version,confirm:true});await fx.admin('publish_results',{version:state.campaign.version,confirm:true})
 const notices=(await fx.db.query("select * from notifications where type='group_referral_result'")).rows
 assert.equal(notices.length,1);assert.equal(notices[0].recipient_id,organizers[2]);assert.equal(notices[0].acknowledgement_required,false)
 assert.equal((await fx.db.query('select count(*)::int n from notification_email_outbox where notification_id=$1',[String(notices[0].id)])).rows[0].n,0)
 assert.equal((await fx.db.query('select count(*)::int n from notification_email_digest_entries where notification_id=$1',[notices[0].id])).rows[0].n,0)
 assert.ok((await fx.center(organizers[2])).items.some(n=>n.id===notices[0].id))
})

test('one final campaign deadline may end joins and qualification together; personal seven-day windows never extend it',async t=>{
 const fx=await groupReferralFixture();t.after(()=>fx.close());let state=await fx.open({equalDeadline:true})
 assert.equal(state.campaign.joinsUntil,state.campaign.qualifiesUntil)
 const organizer=fx.ids.headA;const code=(await fx.action(organizer,'create_link',{alias:'Final deadline organizer',acceptRules:true})).ownLink.code
 const group=await fx.makeGroup({organizer,code});await fx.elapse(7)
 const late=group.members[1];assert.equal((await fx.observe(late,group.group,group.schedule)).counted,true)
 assert.equal((await fx.workspace(late)).ownGroups[0].ownMemberDays,1)
 await fx.elapse(2)
 assert.equal((await fx.observe(late,group.group,group.homework,'homework')).counted,false)
 const member=(await fx.workspace(late)).ownGroups[0];assert.equal(member.ownMemberDays,1);assert.equal(member.returningStudents,0)
 assert.equal((await fx.db.query('select count(*)::int n from group_referral_reads where user_id=$1',[late])).rows[0].n,1)
 // Ordinary platform group creation is unaffected after the campaign has ended.
 const after=await fx.makeGroup({students:1});assert.ok(after.group)
 await assert.rejects(fx.action(after.head,'register_group',{groupId:after.group,code}),/REFERRAL_NOT_OPEN/)
 state=await fx.workspace(organizer);assert.equal(state.ownTickets,0);assert.equal(state.campaign.state,'open')
})
