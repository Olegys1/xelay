import {createCloudStudyServices} from '../assistant-v2/cloudStudyServices.ts'
import {createSupabaseAssistantReadRepository,verifySupabaseAssistantSession,type AssistantCallerClient} from '../assistant-v2/supabaseReadRepository.ts'
import {createStudentGroupMaterialAccess} from './studentGroupMaterialAccess.js'
import {createAuthorizedMaterialFileReader} from '../assistant-v2/cloudMaterialStorage.ts'

/** All metadata/permission reads use the caller JWT. Private files are read only
 * after cloudStudyServices verifies visibility and current author consent. */
export function createStudentGroupMaterials(options:{client:AssistantCallerClient;credential:string;userId:string;now:()=>number;url:string;privateKey:string;fetcher:typeof fetch}){
 const {client,credential,userId,now}=options
 const verifySession=async(token:string,signal?:AbortSignal)=>signal?.aborted||token!==credential?null:verifySupabaseAssistantSession(client,token,now())
 const repository=()=>createSupabaseAssistantReadRepository({client,credential,userId,now})
 const study=createCloudStudyServices({verifySession,createCallerClient:()=>client,now,readStorageFile:createAuthorizedMaterialFileReader(options)})
 return createStudentGroupMaterialAccess({
  userId,
  async isMember(groupId,signal){
   const queries=[
    client.from('study_group_members').select('group_id').eq('group_id',groupId).eq('user_id',userId).eq('status','accepted').limit(1),
    client.from('study_groups').select('id').eq('id',groupId).eq('representative_id',userId).limit(1),
   ]
   const results=await Promise.all(queries.map(query=>signal?query.abortSignal(signal):query))
   if(signal?.aborted||results.some(r=>r.error))return false
   return results.some(r=>Array.isArray(r.data)&&r.data.length===1)
  },
  async groups(signal){const catalog=await repository().catalog(signal);if(catalog.userId!==userId)throw Error('Invalid owner');return catalog.groups.filter(g=>g.learning).map(g=>({id:g.id,name:g.name.slice(0,200)}))},
  list:(groupId,signal)=>study.read(credential,{topic:'materials',scope:{groupId},limit:100},signal),
  content:(groupId,materialId,signal)=>study.materialContent(credential,{scope:{groupId},materialId},signal),
  assertRights:(groupId,materialId,rightsVersion,signal)=>study.assertMaterialRights(credential,{scope:{groupId},materialId,rightsVersion},signal),
 })
}
