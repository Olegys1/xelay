import {validateTutorRequest,type TutorSource} from './maxTutor.js'

const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const reference=new RegExp(`^gm_([st])_(${UUID})_(${UUID})$`)
export type GroupMaterialReference={kind:'study'|'teaching';groupId:string;materialId:string}
/** A reference, never a capability. The server rechecks membership and author
 * consent before every use, including reuse through conversation history. */
export function groupMaterialReference(id:string):GroupMaterialReference|null{
 const match=reference.exec(id)
 return match?{kind:match[1]==='s'?'study':'teaching',groupId:match[2],materialId:match[3]}:null
}
export function groupMaterialSourceId(value:GroupMaterialReference){
 const id=`gm_${value.kind==='study'?'s':'t'}_${value.groupId}_${value.materialId}`
 if(!groupMaterialReference(id))throw Error('Invalid group material')
 return id
}
export type StudentMaterialGroup={id:string;name:string}
export type StudentGroupMaterial={id:string;title:string;subject:string;allowAi:boolean}
export type StudentMaterialPreview={source:TutorSource;truncated:boolean}
export type StudentGroupMaterialsClient={
 groups(signal?:AbortSignal):Promise<StudentMaterialGroup[]>
 list(groupId:string,signal?:AbortSignal):Promise<{items:StudentGroupMaterial[];truncated:boolean}>
 preview(id:string,signal?:AbortSignal):Promise<StudentMaterialPreview>
}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const exact=(v:Record<string,any>,fields:string[])=>Object.keys(v).length===fields.length&&fields.every(k=>Object.prototype.hasOwnProperty.call(v,k))
const label=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v)
const invalid=():never=>{throw Error('Не вдалося перевірити матеріали групи. Онови список.')}
export function parseStudentMaterialGroups(value:unknown):StudentMaterialGroup[]{
 if(!Array.isArray(value)||value.length>100||value.some(g=>!object(g)||!exact(g,['id','name'])||!new RegExp(`^${UUID}$`).test(g.id)||!label(g.name,200)||!g.name)||new Set(value.map(g=>g.id)).size!==value.length)return invalid()
 return value.map(g=>({id:g.id,name:g.name}))
}
export function parseStudentGroupMaterials(value:unknown,groupId:string){
 if(!object(value)||!exact(value,['items','truncated'])||!Array.isArray(value.items)||value.items.length>100||typeof value.truncated!=='boolean')return invalid()
 const items:StudentGroupMaterial[]=value.items.map((m:unknown)=>{
  if(!object(m)||!exact(m,['id','title','subject','allowAi'])||typeof m.id!=='string'||groupMaterialReference(m.id)?.groupId!==groupId||!label(m.title,200)||!m.title||!label(m.subject,200)||typeof m.allowAi!=='boolean')return invalid()
  return {id:m.id,title:m.title,subject:m.subject,allowAi:m.allowAi}
 })
 if(new Set(items.map(m=>m.id)).size!==items.length)return invalid()
 return {items,truncated:value.truncated}
}
export function parseStudentMaterialPreview(value:unknown,id:string):StudentMaterialPreview{
 if(!groupMaterialReference(id)||!object(value)||!exact(value,['source','truncated'])||typeof value.truncated!=='boolean')return invalid()
 const source=validateTutorRequest({requestId:'material-preview',mode:'explain',prompt:'Поясни матеріал',sources:[value.source]}).sources[0]
 if(source.id!==id||source.kind!=='own_excerpt'||source.page!==null)return invalid()
 return {source,truncated:value.truncated}
}
