import type {AssistantStorageReadDescriptor} from './cloudStudyServices.ts'
const fail=(code:string,status:number):never=>{throw Object.assign(Error(code),{code,status})}
/** Invoke only through cloudStudyServices AFTER caller visibility and author AI
 * consent. This also supports AI-approved, view-only classroom attachments.
 * No signed URL, credential or storage path is returned to the browser/model. */
export function createAuthorizedMaterialFileReader(options:{url:string;privateKey:string;fetcher:typeof fetch}){
 if(options.url!=='https://baohfpadxvhqhhjjqtil.supabase.co')throw Error('Invalid project')
 return async(descriptor:AssistantStorageReadDescriptor,signal?:AbortSignal)=>{
  const {bucket,path,size}=descriptor
  if(!['xelay-study-materials','xelay-teaching-files'].includes(bucket)||!Number.isSafeInteger(size)||size<1||size>8*1024*1024||!/^([a-f\d-]{36}\/){2}[a-f\d-]{36}\.[a-z\d]{1,5}$/i.test(path))return fail('material_file_invalid',422)
  const url=options.url+'/storage/v1/object/authenticated/'+bucket+'/'+path.split('/').map(encodeURIComponent).join('/')
  const response=await options.fetcher(url,{headers:{apikey:options.privateKey,authorization:'Bearer '+options.privateKey},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)})
  const declared=response.headers.get('content-length')
  if(!response.ok||response.redirected||response.url&&response.url!==url||!response.body||declared&&(!/^\d+$/.test(declared)||Number(declared)>size)){try{await response.body?.cancel()}catch{};return fail('material_file_unavailable',503)}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0
  try{for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>size)return fail('material_file_changed',409);chunks.push(part.value)}}finally{void reader.cancel().catch(()=>{});reader.releaseLock()}
  if(total!==size)return fail('material_file_changed',409)
  return new Uint8Array(Buffer.concat(chunks))
 }
}
