import type {MaxTutorRequest} from '../../src/lib/maxTutor'
import type {MaxTutorReservationInput,MaxTutorSettlement} from './maxTutorSession'

export type MaxProductionRpcClient={rpc(name:string,args?:Record<string,unknown>):PromiseLike<{data:unknown;error:any}>}

/** The service credential never replaces the verified owner/session arguments. SQL checks them again. */
export function createMaxTutorProductionLedger(client:MaxProductionRpcClient,sessionHash:string,request:MaxTutorRequest){
 return {
  async begin(input:MaxTutorReservationInput){
   const result=await client.rpc('xelay_max_ai_reserve',{p_user_id:input.userId,p_session_hash:sessionHash,p_request_id:input.requestId,p_fingerprint:input.fingerprint,p_reserve_micros:input.reserveMicros,p_monthly_limit_micros:input.monthlyLimitMicros,p_request:request})
   if(result.error)throw Error('Max reservation unavailable')
   return result.data
  },
  async finish(input:MaxTutorSettlement){
   const result=await client.rpc('xelay_max_ai_finish',{p_user_id:input.userId,p_session_hash:sessionHash,p_request_id:input.requestId,p_fingerprint:input.fingerprint,p_reservation_id:input.reservationId,p_charge_micros:input.chargeMicros,p_bundle:input.bundle,p_request:request})
   const data=result.data as {settled?:unknown;stored?:unknown}|null
   if(result.error||!data||data.settled!==true||input.bundle!==null&&data.stored!==true)throw Error('Max settlement unavailable')
  },
 }
}
