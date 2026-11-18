// Complete existing teaching/retake/revision functions plus real paid teacher
// grants, isolated in-memory. Every account and payment reference is fictional.
import {readFile}from'node:fs/promises'
import {createHash,randomUUID}from'node:crypto'
import {publicationRevisionsFixture}from'../../scripts/security/teaching-test-publication-revisions-fixture.mjs'
const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8')
export const teacherArchiveMigration='20261118073935_teacher_completed_test_archive.sql'
export async function createTeacherArchiveFixture({applyArchive=true}={}){
 const fx=await publicationRevisionsFixture()
 try{
  await fx.db.exec('create table if not exists auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz)')
  for(const name of ['202610260001_birthday_gifts.sql','202610260006_appreciation_gifts.sql','202610290002_profile_birthdays.sql',
   '202611160100_student_max_workspace.sql','202611160110_student_plan_billing.sql','20261116155610_student_max_paid_period.sql',
   '20261116155614_student_tier_admin_birthday_discounts.sql','20261117211956_teacher_plans_and_learning.sql',
   ...(applyArchive?[teacherArchiveMigration]:[])]){
   try{await fx.db.exec(await read(name))}catch(error){throw new Error(name+': '+error.message,{cause:error})}
  }
  const sessions={};for(const[name,user]of Object.entries(fx.ids).filter(([name])=>name!=='course')){sessions[user]=randomUUID();await fx.db.query('insert into auth.sessions(id,user_id)values($1,$2)',[sessions[user],user])}
  const call=async(role,user,name,args=[])=>fx.db.transaction(async tx=>{
   await tx.exec('set local role '+role)
   await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,session_id:sessions[user],role,aal:'aal2'})])
   return(await tx.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})v`,args)).rows[0].v
  })
  const ownerCall=(name,args=[],user=fx.ids.owner)=>call('authenticated',user,name,args)
  const serviceCall=(name,args=[])=>call('service_role',fx.ids.owner,name,args)
  for(const key of ['owner','colleague','otherTeacher'])await serviceCall('xelay_student_audience_assign',[fx.ids[key],'teacher','Synthetic archive billing identity'])
  const createPaidTeacher=async(plan,user=fx.ids.owner)=>{
   const order=await serviceCall('xelay_create_teacher_plan_order',[user,'live','xelay_'+randomUUID(),plan])
   await serviceCall('xelay_apply_billing_event',[order.order_reference,'live',createHash('sha256').update(randomUUID()).digest('hex'),'Approved',order.amount,'UAH',null])
   return order
  }
  const archiveState=(user=fx.ids.owner,course=fx.ids.course,group=null)=>ownerCall('xelay_teaching_test_archive_state',[course,group],user)
  const archiveSet=(test,archived,version=0,{user=fx.ids.owner,course=fx.ids.course,group=null,expectedUser=user}={})=>ownerCall('xelay_teaching_test_archive_set',[test,course,group,archived,version,expectedUser],user)
  return{...fx,sessions,ownerCall,serviceCall,createPaidTeacher,archiveState,archiveSet,readMigration:read}
 }catch(error){await fx.close();throw error}
}
