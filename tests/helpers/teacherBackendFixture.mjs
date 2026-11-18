// Real local PostgreSQL functions and fictional users only. No network or secrets.
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { audienceFixture } from '../../scripts/security/teaching-audience-fixture.mjs'
const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8')
export const teacherPlanMigration='20261117211956_teacher_plans_and_learning.sql'
export async function createTeacherBackendFixture({applyTeacher=true}={}){
 const fx=await audienceFixture()
 try{
  await fx.db.exec(`create table if not exists auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);`)
  for(const name of ['202611040010_teaching_tests.sql','202611040020_assessment_bank_variants.sql','202611040021_teaching_rubrics.sql',
   '202610260001_birthday_gifts.sql','202610260006_appreciation_gifts.sql','202610290002_profile_birthdays.sql','202611160100_student_max_workspace.sql','202611160110_student_plan_billing.sql',
   '20261116155610_student_max_paid_period.sql','20261116155614_student_tier_admin_birthday_discounts.sql',
   ...(applyTeacher?[teacherPlanMigration]:[])]){
   try{await fx.db.exec(await read(name))}catch(error){throw new Error(name+': '+error.message,{cause:error})}
  }
  const sessions={};for(const[name,id]of Object.entries(fx.ids).filter(([name])=>name!=='course')){sessions[id]=randomUUID();await fx.db.query('insert into auth.sessions(id,user_id)values($1,$2)',[sessions[id],id])}
  let serial=Promise.resolve();const queue=fn=>{const next=serial.then(fn,fn);serial=next.catch(()=>{});return next}
  const call=(role,user,name,args=[])=>queue(async()=>{
   await fx.db.exec('set role '+role)
   await fx.db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,session_id:sessions[user],role,aal:'aal2'})])
   try{return(await fx.db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})v`,args.map(v=>v&&typeof v==='object'&&!Array.isArray(v)?JSON.stringify(v):v))).rows[0].v}
   finally{await fx.db.exec('reset role');await fx.db.exec('reset "request.jwt.claims"')}
  })
  const ownerCall=(name,args=[],user=fx.ids.owner)=>call('authenticated',user,name,args)
  const serviceCall=(name,args=[])=>call('service_role',fx.ids.owner,name,args)
  let event=0
  const applyPayment=(order,status='Approved',override={})=>serviceCall('xelay_apply_billing_event',[order.order_reference,override.mode??order.mode,override.fingerprint??createHash('sha256').update('synthetic-event-'+(++event)).digest('hex'),status,override.amount??order.amount,override.currency??'UAH',null])
  const createOrder=(plan,user=fx.ids.owner,mode='live')=>serviceCall('xelay_create_teacher_plan_order',[user,mode,'xelay_'+randomUUID(),plan])
  const createPaidTeacher=async(plan,user=fx.ids.owner)=>{const order=await createOrder(plan,user);await applyPayment(order);return order}
  if(applyTeacher)for(const key of ['owner','colleague','otherTeacher'])await serviceCall('xelay_student_audience_assign',[fx.ids[key],'teacher','Synthetic teacher billing identity'])
  const token=(user=fx.ids.owner)=>['synthetic-header',Buffer.from(JSON.stringify({sub:user,role:'authenticated',session_id:sessions[user],exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'synthetic-signature'].join('.')
  const rpcArgs={xelay_teacher_workspace_status:[],xelay_teacher_plan_state:[],xelay_teacher_ai_catalog:[],xelay_teacher_ai_context:['p_request'],xelay_teacher_ai_history:[],xelay_teacher_ai_draft:['p_id'],xelay_teacher_ai_candidates:['p_course_id','p_group_ids'],xelay_teacher_ai_draft_save:['p_id','p_expected_revision','p_bundle','p_teacher_notes','p_status'],xelay_teacher_ai_reserve:['p_user_id','p_session_hash','p_request','p_fingerprint','p_context_hash','p_reserve_micros'],xelay_teacher_ai_finish:['p_user_id','p_session_hash','p_request_id','p_fingerprint','p_reservation_id','p_charge_micros','p_bundle']}
  const environment={TEACHER_LEARNING_ENABLED:'true',TEACHER_LEARNING_AI_ENABLED:'true',SUPABASE_URL:'https://baohfpadxvhqhhjjqtil.supabase.co',SUPABASE_ANON_KEY:'synthetic-public-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-private-key',OPENAI_API_KEY:['sk','synthetic','teacher','model','key','not','real'].join('-')}
  const clientFactory=(_url,key,options={})=>{
   const service=key===environment.SUPABASE_SERVICE_ROLE_KEY
   const jwt=options.global?.headers?.Authorization?.replace(/^Bearer /,'')
   let user=fx.ids.owner;try{if(jwt)user=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url').toString()).sub}catch{}
   return {auth:{async getUser(credential){let id;try{id=JSON.parse(Buffer.from(credential.split('.')[1],'base64url').toString()).sub}catch{};const rows=await queue(()=>fx.db.query('select id,email_confirmed_at,deleted_at,banned_until from auth.users where id=$1',[id||null]));const row=rows.rows[0];return{data:{user:row&&!row.deleted_at?row:null},error:row?null:{code:'invalid'}}}},async rpc(name,args={}){if(!Object.prototype.hasOwnProperty.call(rpcArgs,name))throw Error('Unexpected teacher RPC '+name);try{return{data:await call(service?'service_role':'authenticated',user,name,rpcArgs[name].map(n=>args[n])),error:null}}catch(error){return{data:null,error:{code:error.code,message:error.message}}}}}
  }
  return {...fx,sessions,ownerCall,serviceCall,applyPayment,createOrder,createPaidTeacher,token,environment,clientFactory,readMigration:read}
 }catch(error){await fx.close();throw error}
}
