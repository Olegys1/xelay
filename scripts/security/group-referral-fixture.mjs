// Synthetic, isolated PGlite only. No provider, browser, email, or Supabase calls.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createTeachingScopedFixture } from './teaching-scoped-fixture.mjs'
import { parseGroupReferralWorkspace } from '../../src/lib/groupReferralRepository.ts'
export async function groupReferralFixture({notificationCenter=false,invitationQuery=true}={}) {
 const fx=notificationCenter?await(await import('./notification-center-fixture.mjs')).notificationCenterFixture():await createTeachingScopedFixture();const {db,ids,asUser,seedUser,scope}=fx
 try {
  await db.exec(await readFile(new URL('../../supabase/migrations/202611070010_group_referral_campaign.sql',import.meta.url),'utf8'))
  const applyInvitationQuery=async()=>db.exec(await readFile(new URL('../../supabase/migrations/202611080010_group_referral_invitation_query.sql',import.meta.url),'utf8'))
  if(invitationQuery)await applyInvitationQuery()
  const campaign=(await db.query('select id from group_referral_campaigns')).rows[0].id
  const rpc=async(who,name,args=[],options={})=>(await asUser(who,`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) data`,args,options)).rows[0].data
  const workspace=async(who,options={})=>parseGroupReferralWorkspace(await rpc(who,'xelay_group_referral_workspace',['bring-your-group',options.after||null,options.adminAfter||null,options.candidateAfter||null],{role:who?'authenticated':'anon',aal:options.aal||'aal1'}),who)
  const action=async(who,kind,values={},options={})=>parseGroupReferralWorkspace(await rpc(who,'xelay_group_referral_action',[kind,JSON.stringify({campaignId:campaign,requestId:randomUUID(),...values}),who],{aal:options.aal||'aal1'}),who)
  const admin=(kind,values={})=>action(ids.admin,kind,values,{aal:'aal2'})
  const observe=(who,group,resource,kind='schedule',expected=who)=>rpc(who,'xelay_group_referral_observe_read',[group,kind,resource,expected])
  const open=async({startsAgoMs=3600000,equalDeadline=false}={})=>{
   const initial=await workspace(ids.admin,{aal:'aal2'});const now=Date.now()
   let state=await admin('save_campaign',{version:initial.campaign.version,title:'Synthetic referral campaign',startsAt:new Date(now-startsAgoMs).toISOString(),joinsUntil:new Date(now+(equalDeadline?8:1)*86400000).toISOString(),qualifiesUntil:new Date(now+8*86400000).toISOString(),drawAt:new Date(now+8*86400000).toISOString(),prizes:[{rank:1,label:'ChatGPT Plus',months:1},{rank:2,label:'Telegram Premium',months:6},{rank:3,label:'Telegram Premium',months:3}]})
   return admin('activate_campaign',{version:state.campaign.version})
  }
  let sequence=0
  const specialty=(await db.query('select specialty_id from profiles where id=$1',[ids.headA])).rows[0].specialty_id
  const user=async(label='student')=>{const id=randomUUID();await seedUser(id,{full_name:`Synthetic ${label}`,username:'gr_'+id.replaceAll('-','').slice(0,15),university_id:scope.university_id,academic_unit_id:scope.id,specialty_id:specialty,account_type:'student',categories:['General'],experience:'bachelor'});return id}
  const makeGroup=async({representative,organizer,code,name,students=10,createdAt}={})=>{
   const head=representative||await user('head');const group=randomUUID();const request=randomUUID();const number=++sequence
   await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
    values($1,$2,'Synthetic head',$3,$4,$5,$6,'synthetic_head','approved',$7,now())`,[request,head,scope.university_id,scope.id,'Synthetic programme '+number,name||'Group '+number,ids.admin])
   await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name,created_at)
    values($1,$2,$3,$4,$5,$6,$7,coalesce($8::timestamptz,clock_timestamp()))`,[group,request,head,scope.university_id,scope.id,'Synthetic programme '+number,name||'Group '+number,createdAt||null])
   const members=[head];for(let i=1;i<students;i++)members.push(await user())
   for(const member of members)await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at,created_at) values($1,$2,$3,'accepted',clock_timestamp()-interval '3 days',clock_timestamp()-interval '3 days')",[group,member,head])
   const schedule=randomUUID();await asUser(head,`insert into study_group_schedule(id,group_id,weekday,starts_at,ends_at,subject,lesson_type,valid_from,valid_until,created_by)
    values($1,$2,1,'09:40','11:00','Synthetic mathematics','lecture',current_date-60,current_date+180,$3)`,[schedule,group,head])
   const homework=randomUUID();await asUser(head,`insert into study_group_homework(id,group_id,schedule_item_id,lesson_date,body,created_by) values($1,$2,$3,date_trunc('week',current_date)::date+7,'Synthetic real work',$4)`,[homework,group,schedule,head])
   const result={group,head,members,schedule,homework}
   if(code){await action(head,'register_group',{groupId:group,code});result.entry=(await workspace(organizer||head)).ownGroups.find(e=>e.groupId===group)}
   return result
  }
  // Advance fixture history rather than accepting a browser clock. Only the DB
  // owner can seed these timestamps; the application roles have zero table rights.
  const elapse=async(days=1)=>{
   const interval=`${days} days`
   await db.exec('alter table group_referral_campaigns disable trigger group_referral_campaign_config_immutable')
   try{await db.query(`update group_referral_campaigns set starts_at=starts_at-$1::interval,joins_until=joins_until-$1::interval,qualifies_until=qualifies_until-$1::interval,draw_at=draw_at-$1::interval`,[interval])}finally{await db.exec('alter table group_referral_campaigns enable trigger group_referral_campaign_config_immutable')}
   await db.query(`update study_groups set created_at=created_at-$1::interval where id in(select group_id from group_referral_entries)`,[interval])
   await db.query(`update group_referral_entries set group_created_at=group_created_at-$1::interval,registered_at=registered_at-$1::interval`,[interval])
   await db.query(`update study_group_members set accepted_at=accepted_at-$1::interval,created_at=created_at-$1::interval where group_id in(select group_id from group_referral_entries)`,[interval])
   await db.exec('alter table group_referral_credits disable trigger group_referral_credit_immutable')
   try{await db.query('update group_referral_credits set first_seen_at=first_seen_at-$1::interval',[interval])}finally{await db.exec('alter table group_referral_credits enable trigger group_referral_credit_immutable')}
   await db.query(`update group_referral_reads set observed_at=observed_at-$1::interval,day=((observed_at-$1::interval) at time zone 'Europe/Kyiv')::date`,[interval])
  }
  const collect=async(groups)=>{for(const group of groups)for(const member of group.members)await observe(member,group.group,group.schedule);await elapse(1);for(const group of groups)for(const member of group.members)await observe(member,group.group,group.homework,'homework')}
  const approve=async(group,organizer=group.head)=>{let state=await workspace(organizer);let e=state.ownGroups.find(e=>e.groupId===group.group);await action(organizer,'submit_group',{entryId:e.id,version:e.version});state=await workspace(ids.admin,{aal:'aal2'});e=state.admin.groups.find(e=>e.groupId===group.group);return admin('review_group',{entryId:e.id,version:e.version,decision:'approved',reason:'Synthetic real group verified'})}
  return {...fx,campaign,rpc,workspace,action,admin,observe,open,user,makeGroup,elapse,collect,approve,applyInvitationQuery}
 }catch(error){await fx.close();throw error}
}
