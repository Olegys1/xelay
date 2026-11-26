import {groupMaterialReference,groupMaterialSourceId,parseStudentMaterialGroups,type StudentMaterialGroup,type StudentMaterialPreview} from '../../src/lib/studentGroupMaterials.js'
import type {TutorSource} from '../../src/lib/maxTutor.js'

type Material={kind:string;id:string;materialId?:string;materialSourceKind?:'study'|'teaching';courseId?:string;groupId:string;title:string;subjectName?:string;allowAi?:boolean}
type Content={userId:string;allowAi:true;text:string;title:string;rightsVersion:string;truncated:boolean}
export type StudentGroupMaterialPorts={
 userId:string
 groups(signal?:AbortSignal):Promise<StudentMaterialGroup[]>
 isMember?(groupId:string,signal?:AbortSignal):Promise<boolean>
 list(groupId:string,signal?:AbortSignal):Promise<{records:Material[];truncated:boolean}>
 content(groupId:string,materialId:string,signal?:AbortSignal):Promise<Content>
 assertRights(groupId:string,materialId:string,version:string,signal?:AbortSignal):Promise<{userId:string;allowAi:true;rightsVersion:string}>
}
const fail=(code='material_unavailable',status=403):never=>{throw Object.assign(Error(code),{code,status})}
const clean=(text:string,max:number)=>text.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max)
/** Request-local only: extraction is reused, authorization is never cached. */
export function createStudentGroupMaterialAccess(ports:StudentGroupMaterialPorts){
 const previews=new Map<string,{preview:StudentMaterialPreview;version:string}>()
 const groups=async(signal?:AbortSignal)=>{if(signal?.aborted)return fail('cancelled',499);return parseStudentMaterialGroups(await ports.groups(signal))}
 async function member(groupId:string,signal?:AbortSignal){if(signal?.aborted)return fail('cancelled',499);if(ports.isMember?!await ports.isMember(groupId,signal):!(await groups(signal)).some(g=>g.id===groupId))fail()}
 async function list(groupId:string,signal?:AbortSignal){
  await member(groupId,signal)
  const result=await ports.list(groupId,signal),items=result.records.filter(m=>m.kind==='material').map(m=>{
   if(m.groupId!==groupId) return fail()
   return {id:groupMaterialSourceId({groupId,materialId:m.materialId||m.id,kind:m.materialSourceKind||(m.courseId?'teaching':'study')}),title:clean(m.title,200)||'Матеріал групи',subject:clean(m.subjectName||'',200),allowAi:m.allowAi===true}
  })
  await member(groupId,signal)
  return {items,truncated:result.truncated}
 }
 async function preview(id:string,signal?:AbortSignal):Promise<StudentMaterialPreview>{
  const ref=groupMaterialReference(id);if(!ref)return fail('invalid_request',400)
  const listed=await list(ref.groupId,signal),item=listed.items.find(m=>m.id===id)
  if(!item)return fail()
  if(!item.allowAi)return fail('material_ai_not_allowed')
  const content=await ports.content(ref.groupId,ref.materialId,signal)
  if(content.userId!==ports.userId||content.allowAi!==true||!content.rightsVersion)return fail()
  // Keep the existing private excerpt storage contract. The reserved source ID
  // retains provenance; it is not trusted as proof of access.
  let text=content.text.slice(0,20000)
  while(Buffer.byteLength(text,'utf8')>23000)text=text.slice(0,-1)
  text=text.trim();if(!text)return fail('material_text_unavailable',422)
  const result:StudentMaterialPreview={source:{id,title:clean(content.title,200)||'Матеріал групи',text,page:null,kind:'own_excerpt'},truncated:content.truncated||text!==content.text.trim()}
  await member(ref.groupId,signal)
  previews.set(id,{preview:result,version:content.rightsVersion})
  return result
 }
 async function assertSources(sources:readonly TutorSource[],signal?:AbortSignal){
  const checked=new Set<string>(),memberships=new Set<string>()
  for(const source of sources){
   if(!source.id.startsWith('gm_'))continue
   const ref=groupMaterialReference(source.id);if(!ref)return fail('invalid_request',400)
   let cached=previews.get(source.id)
   if(!cached){await preview(source.id,signal);cached=previews.get(source.id)!}
   const expected=cached.preview.source
   if(source.kind!==expected.kind||source.page!==expected.page||source.title!==expected.title||source.text!==expected.text)return fail('context_changed',409)
   if(checked.has(source.id))continue
   if(!memberships.has(ref.groupId)){await member(ref.groupId,signal);memberships.add(ref.groupId)}
   const rights=await ports.assertRights(ref.groupId,ref.materialId,cached.version,signal)
   if(rights.userId!==ports.userId||rights.allowAi!==true||rights.rightsVersion!==cached.version)return fail('context_changed',409)
   checked.add(source.id)
  }
 }
 return {groups,list,preview,assertSources}
}
