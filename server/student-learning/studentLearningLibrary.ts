import {createClient} from '@supabase/supabase-js'
import {validateStudentLearningLibraryDocument} from '../../src/lib/studentLearningLibrary.js'

type RpcClient={rpc:(name:string,args?:Record<string,unknown>)=>PromiseLike<{data:unknown;error:{code?:string;message?:string}|null}>;auth:{getUser:(token:string)=>PromiseLike<{data:{user:any};error:unknown}>}}
type Factory=(url:string,key:string,options:Record<string,unknown>)=>RpcClient
export type StudentLibraryDependencies={environment?:Record<string,string|undefined>;clientFactory?:Factory;fetcher?:typeof fetch;now?:()=>number}
const PROJECT='https://baohfpadxvhqhhjjqtil.supabase.co',UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const validId=(v:unknown):v is string=>typeof v==='string'&&ID.test(v)&&!['constructor','prototype','__proto__'].includes(v)
class LibraryError extends Error{constructor(public http:number,public code:string){super(code)}}
function fail(http:number,code:string):never{throw new LibraryError(http,code)}
function send(res:any,http:number,value:unknown){if(res.writableEnded||res.destroyed)return;res.statusCode=http;res.setHeader('Content-Type','application/json;charset=utf-8');res.end(JSON.stringify(value))}
async function body(req:any){if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers?.['content-type']||'')))return fail(400,'invalid_request');let value:unknown;if(req.body!==undefined){value=req.body;if(typeof value==='string'){if(Buffer.byteLength(value)>260000)return fail(413,'invalid_request');try{value=JSON.parse(value)}catch{return fail(400,'invalid_request')}}}else{let size=0;const chunks:Buffer[]=[];for await(const part of req){const bytes=Buffer.isBuffer(part)?part:Buffer.from(part);size+=bytes.length;if(size>260000)return fail(413,'invalid_request');chunks.push(bytes)}try{value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)))}catch{return fail(400,'invalid_request')}}if(!object(value)||Buffer.byteLength(JSON.stringify(value))>260000)return fail(400,'invalid_request');return value}
export function createStudentLearningLibrary(dependencies:StudentLibraryDependencies={}){
 const env=dependencies.environment||process.env,now=dependencies.now||Date.now,url=(env.SUPABASE_URL||env.VITE_SUPABASE_URL||'').replace(/\/$/,''),key=env.SUPABASE_ANON_KEY||env.VITE_SUPABASE_ANON_KEY||'',factory=dependencies.clientFactory||createClient as unknown as Factory
 const origins=['https://www.xelay.ink','https://xelay.ink'];if(env.VERCEL_ENV==='preview'&&env.VERCEL_URL&&/^[a-z0-9-]+\.vercel\.app$/i.test(env.VERCEL_URL))origins.push('https://'+env.VERCEL_URL)
 const enabled=env.STUDENT_MAX_ENABLED==='true'&&url===PROJECT&&!!key&&key.length<=8192&&!/\s/.test(key)
 const fetcher=dependencies.fetcher||fetch,databaseFetch:typeof fetch=(input,init)=>fetcher(input,{...init,redirect:'error',signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)})
 return async function handler(req:any,res:any){
  res.setHeader('Cache-Control','no-store, private');res.setHeader('Pragma','no-cache');res.setHeader('Vary','Authorization, Origin');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cross-Origin-Resource-Policy','same-origin')
  let active=true;const closed=()=>{active=false};req.once?.('aborted',closed);res.once?.('close',closed)
  try{
   if(!['GET','POST'].includes(req.method)){res.setHeader('Allow','GET, POST');return send(res,405,{status:'invalid_request'})}
   if(!enabled)return fail(503,'unavailable')
   const origin=req.headers?.origin;if(origin!==undefined&&(typeof origin!=='string'||!origins.includes(origin))||req.headers?.['sec-fetch-site']==='cross-site'||req.method==='POST'&&typeof origin!=='string')return fail(403,'forbidden')
   const token=typeof req.headers?.authorization==='string'?req.headers.authorization.match(/^Bearer ([^\s]{1,8192})$/)?.[1]:null;if(!token||token.split('.').length!==3)return fail(401,'signed_out')
   const caller=factory(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:databaseFetch,headers:{Authorization:'Bearer '+token}}})
   const verified=await caller.auth.getUser(token);if(verified.error||!verified.data?.user?.email_confirmed_at||!UUID.test(String(verified.data.user.id)))return fail(401,'signed_out')
   let claims:any;try{claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'))}catch{return fail(401,'signed_out')}
   if(!object(claims)||claims.sub!==verified.data.user.id||claims.role!=='authenticated'||!Number.isSafeInteger(claims.exp)||Number(claims.exp)*1000<=now()||!UUID.test(String(claims.session_id)))return fail(401,'signed_out')
   const scope={userId:String(verified.data.user.id).toLowerCase(),sessionId:String(claims.session_id).toLowerCase()}
   const current=()=>active&&Number(claims.exp)*1000>now(),rpc=async(name:string,args?:Record<string,unknown>)=>{if(!current())return fail(401,'signed_out');const result=await caller.rpc(name,args);if(!current())return fail(401,'signed_out');if(result.error){if(result.error.code==='42501')return fail(403,'forbidden');if(result.error.code==='PT429')return fail(429,'rate_limited');if(result.error.code==='22023')return fail(400,'invalid_request');if(result.error.code==='PT409')return fail(409,'conflict');return fail(503,'unavailable')}return result.data}
   let requestUrl:URL;try{requestUrl=new URL(req.url||'/api/student-library',origins[0])}catch{return fail(400,'invalid_request')}
   if(Array.from(requestUrl.searchParams.keys()).some(k=>!['cursor','runId','runIds'].includes(k))||['cursor','runId','runIds'].some(k=>requestUrl.searchParams.getAll(k).length>1))return fail(400,'invalid_request')
   const cursor=req.query?.cursor??requestUrl.searchParams.get('cursor'),runId=req.query?.runId??requestUrl.searchParams.get('runId'),runIds=req.query?.runIds??requestUrl.searchParams.get('runIds')
   if(cursor!==null&&cursor!==undefined&&!validId(cursor)||runId!==null&&runId!==undefined&&!validId(runId)||[cursor,runId,runIds].filter(v=>v!==null&&v!==undefined).length>1)return fail(400,'invalid_request')
   if(runIds!==null&&runIds!==undefined&&(typeof runIds!=='string'||runIds.length>2430||runIds.split(',').length<1||runIds.split(',').length>30||!runIds.split(',').every(validId)||new Set(runIds.split(',')).size!==runIds.split(',').length))return fail(400,'invalid_request')
   if(req.method==='GET'){
    if(runId)return send(res,200,{status:'ready',scope,run:await rpc('xelay_student_library_run',{p_run_id:runId})})
    if(runIds){const data=await rpc('xelay_student_library_runs_batch',{p_run_ids:runIds.split(',')});if(!object(data))return fail(503,'unavailable');return send(res,200,{status:'ready',scope,...data})}
    const data=await rpc('xelay_student_library_get',{p_cursor:cursor||null});if(!object(data))return fail(503,'unavailable');return send(res,200,{status:'ready',scope,...data})
   }
   if(cursor||runId||runIds)return fail(400,'invalid_request')
   const raw=await body(req);if(Object.keys(raw).length!==3||!['document','expectedRevision','mutationId'].every(k=>Object.prototype.hasOwnProperty.call(raw,k))||!Number.isSafeInteger(raw.expectedRevision)||Number(raw.expectedRevision)<0||Number(raw.expectedRevision)>2147483646||!validId(raw.mutationId))return fail(400,'invalid_request')
   let document:unknown;try{document=validateStudentLearningLibraryDocument(raw.document)}catch{return fail(400,'invalid_request')}
   const data=await rpc('xelay_student_library_put',{p_document:document,p_expected_revision:raw.expectedRevision,p_mutation_id:raw.mutationId});if(!object(data)||!['saved','conflict'].includes(String(data.state)))return fail(503,'unavailable')
   const {state,...value}=data
   if(state==='conflict')return send(res,409,{status:'conflict',snapshot:{status:'ready',scope,...value,runs:[],nextCursor:null}})
   return send(res,200,{status:'ready',scope,...value})
  }catch(e){if(e instanceof LibraryError)return send(res,e.http,{status:e.code});return send(res,503,{status:'unavailable'})}
  finally{req.removeListener?.('aborted',closed);res.removeListener?.('close',closed)}
 }
}
