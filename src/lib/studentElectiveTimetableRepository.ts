import { supabase } from './supabase'
import { isStudentElectiveId, normalizeStudentElectiveMeetings, normalizeStudentElectivePlan, studentElectiveConflictDates, validateStudentElectiveTerm, type StudentElectivePlan, type StudentElectivePlanInput } from './studentElectiveTimetable'

export interface StudentElectiveRepository {
  load(userId:string,groupId:string,signal?:AbortSignal):Promise<StudentElectivePlan[]>
  save(userId:string,input:StudentElectivePlanInput,signal?:AbortSignal):Promise<StudentElectivePlan>
  remove(userId:string,planId:string,expectedVersion:number,signal?:AbortSignal):Promise<void>
}
type Client={auth:{getSession():Promise<{data:{session:{user:{id:string}}|null};error:unknown}>};from(table:string):any;rpc(name:string,args:Record<string,unknown>):any}
const fail=(code:string):never=>{throw Object.assign(new Error(code),{code})}
const cancelled=(signal?:AbortSignal)=>{if(signal?.aborted)fail('STUDENT_ELECTIVE_CANCELLED')}
const request=(query:any,signal?:AbortSignal)=>signal?query.abortSignal(signal):query
/** The injected client must be the current user's authenticated client, never a
 * privileged server client. RPCs infer ownership from auth.uid(), not userId. */
export function createStudentElectiveRepository(client:Client):StudentElectiveRepository {
  async function actor(userId:string,signal?:AbortSignal){
    cancelled(signal)
    if(!isStudentElectiveId(userId))fail('STUDENT_ELECTIVE_ACCOUNT_CHANGED')
    const session=await client.auth.getSession();cancelled(signal)
    if(session.error||session.data.session?.user.id!==userId)fail('STUDENT_ELECTIVE_ACCOUNT_CHANGED')
  }
  return{
    async load(userId,groupId,signal){
      await actor(userId,signal)
      if(!isStudentElectiveId(groupId))fail('STUDENT_ELECTIVE_INVALID')
      const result=await request(client.from('student_elective_plans').select('id,user_id,group_id,valid_from,valid_until,configured,version,lessons,created_at,updated_at').eq('user_id',userId).eq('group_id',groupId).order('valid_from',{ascending:true}).limit(33),signal)
      if(result.error)throw result.error
      await actor(userId,signal)
      if(!Array.isArray(result.data)||result.data.length>32)fail('STUDENT_ELECTIVE_INVALID_RESPONSE')
      const plans=result.data.map(normalizeStudentElectivePlan)
      if(plans.some((plan:StudentElectivePlan)=>plan.user_id!==userId||plan.group_id!==groupId)||new Set(plans.map((plan:StudentElectivePlan)=>plan.id)).size!==plans.length)fail('STUDENT_ELECTIVE_INVALID_RESPONSE')
      for(let index=0;index<plans.length;index++)if(plans.slice(0,index).some((other:StudentElectivePlan)=>other.valid_from<=plans[index].valid_until&&plans[index].valid_from<=other.valid_until))fail('STUDENT_ELECTIVE_INVALID_RESPONSE')
      return plans
    },
    async save(userId,input,signal){
      await actor(userId,signal)
      if(!input||!isStudentElectiveId(input.groupId)||typeof input.configured!=='boolean'||input.expectedVersion!=null&&(!Number.isInteger(input.expectedVersion)||input.expectedVersion<1||input.expectedVersion>1000000)
        ||input.planId!==undefined&&(!isStudentElectiveId(input.planId)||input.expectedVersion==null))fail('STUDENT_ELECTIVE_INVALID')
      validateStudentElectiveTerm(input.validFrom,input.validUntil)
      const lessons=normalizeStudentElectiveMeetings(input.lessons)
      if(studentElectiveConflictDates(lessons,input.validFrom,input.validUntil).length)fail('STUDENT_ELECTIVE_OVERLAP')
      const result=await request(client.rpc('xelay_save_student_elective_plan',{p_group_id:input.groupId,p_valid_from:input.validFrom,p_valid_until:input.validUntil,p_lessons:lessons,p_expected_version:input.expectedVersion??null,p_configured:input.configured,p_plan_id:input.planId??null}),signal)
      if(result.error)throw result.error
      await actor(userId,signal)
      const plan=normalizeStudentElectivePlan(result.data)
      if(plan.user_id!==userId||plan.group_id!==input.groupId||plan.valid_from!==input.validFrom||plan.valid_until!==input.validUntil||plan.configured!==input.configured||plan.version!==(input.expectedVersion==null?1:input.expectedVersion+1)||input.planId!==undefined&&plan.id!==input.planId.toLowerCase())fail('STUDENT_ELECTIVE_INVALID_RESPONSE')
      return plan
    },
    async remove(userId,planId,expectedVersion,signal){
      await actor(userId,signal)
      if(!isStudentElectiveId(planId)||!Number.isInteger(expectedVersion)||expectedVersion<1||expectedVersion>1000000)fail('STUDENT_ELECTIVE_INVALID')
      const result=await request(client.rpc('xelay_remove_student_elective_plan',{p_id:planId,p_expected_version:expectedVersion}),signal)
      if(result.error)throw result.error
      await actor(userId,signal)
      if(result.data!==true)fail('STUDENT_ELECTIVE_INVALID_RESPONSE')
    },
  }
}
export const studentElectiveTimetableRepository=createStudentElectiveRepository(supabase)
