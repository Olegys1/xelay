import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import * as crypto from 'node:crypto'
import * as zlib from 'node:zlib'
import * as pathModule from 'node:path'
import {uploadValidatorDependencies} from './upload-content-validator-dependencies.mjs'
const read=path=>readFile(new URL('../../'+path,import.meta.url),'utf8')
function load(source,imports,globals={}){
 const module={exports:{}}
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  module,exports:module.exports,Buffer,Uint8Array,TextDecoder,TextEncoder,Date,URL,AbortController,AbortSignal,Error,Map,Set,console,
  require:name=>{assert.ok(name in imports,'Unexpected import '+name);return imports[name]},...globals
 })
 return module.exports
}
const validator=load(await read('server/uploadContentValidation.ts'),{'node:crypto':crypto,'node:zlib':zlib,'node:path':pathModule,...uploadValidatorDependencies})
const source=await read('server/uploadContentVerification.ts')
const route=await read('api/security/media-cleanup.ts')
const origin='https://fictional-app.example',storage='https://fictional-storage.example'
const owner='20000000-0000-4000-8000-000000000002',parent='10000000-0000-4000-8000-000000000001',id='30000000-0000-4000-8000-000000000003'
const bucket='xelay-submission-files',path=parent+'/'+owner+'/'+id+'.txt'
const plain=v=>JSON.parse(JSON.stringify(v))
function fixture(options={}){
 const bytes=options.bytes||Buffer.from('Ordinary fictional homework.\n')
 const state={auth:[],calls:[],fetch:[],records:[],rejected:[],removed:[]}
 const file={object_id:id,bucket_id:bucket,storage_path:path,owner_id:owner,size:bytes.length,mime_type:'text/plain',
  created_at:'2026-10-30T16:00:00Z',updated_at:'2026-10-30T16:00:00Z',storage_version:'fictional-object-version',already_verified:false,...options.candidate}
 const user={id:owner,email_confirmed_at:'2026-01-01T00:00:00Z',...options.user}
 const service={auth:{getUser:async token=>{state.auth.push(token);return{data:{user:{id:owner}},error:options.authError||null}},admin:{getUserById:async()=>({data:{user},error:null})}},
  rpc:async(name,args)=>{
   if(name==='xelay_reject_unverified_upload'){state.rejected.push(plain(args));return{data:options.rejectFalse?false:true,error:options.rejectError||null}}
   assert.equal(name,'xelay_record_upload_content_verification');state.records.push(plain(args));return{data:options.recordFalse?false:true,error:options.recordError||null}
  },storage:{from(target){assert.equal(target,bucket);return{remove:async paths=>{state.removed.push(paths);return{data:paths.map(name=>({name})),error:options.removeError||null}}}}}}
 const caller={rpc:async(name,args)=>{state.calls.push([name,plain(args)]);assert.equal(name,'xelay_upload_scan_candidate');return{data:file,error:options.candidateError||null}}}
 const createClient=(url,key,settings)=>{assert.equal(url,storage);return settings.global.headers?caller:service}
 const fetch=async(url,init)=>{
  state.fetch.push([String(url),init])
  assert.equal(String(url),storage+'/storage/v1/object/'+file.bucket_id+'/'+file.storage_path)
  assert.equal(init.headers.Authorization,'Bearer fictional-service-key')
  assert.equal(init.redirect,'error')
  if(options.wait)await options.wait
  if(options.response)return options.response(bytes)
  return new Response(bytes,{status:200,headers:{'content-type':file.mime_type,'content-length':String(bytes.length)}})
 }
 const endpoint=load(source,{'node:crypto':crypto,'@supabase/supabase-js':{createClient},'./uploadContentValidation.js':validator},{
  process:{env:{SUPABASE_URL:storage,SUPABASE_SERVICE_ROLE_KEY:'fictional-service-key',SUPABASE_ANON_KEY:'fictional-anon-key',XELAY_PUBLIC_URL:origin}},fetch
 })
 const api=load(route,{'../../server/uploadContentVerification.js':endpoint,
  '../../server/mediaMaintenance.js':{authorizeMediaMaintenance(){throw Error('unexpected cleanup')},cleanDetachedMedia(){throw Error('unexpected cleanup')},mediaMaintenanceClient(){throw Error('unexpected cleanup')},MaintenanceError:class extends Error{}},
  '../../server/opportunitiesFiles.js':{handleOpportunitiesFileValidation(){throw Error('unexpected opportunities')}},
  '../../server/teachingMaterialFiles.js':{handleTeachingMaterialFileView(){throw Error('unexpected viewer')}}
 })
 const run=async(patch={})=>{
  const req={method:'POST',query:{xelay_upload_route:'verify'},body:{bucket,path},...patch,
   headers:{origin,'sec-fetch-site':'same-origin','content-type':'application/json',authorization:'Bearer fictional-user-token',...patch.headers}}
  const res={headers:{},setHeader(k,v){this.headers[k]=v},status(s){this.statusCode=s;return this},json(v){this.body=plain(v);return this}}
  await api.default(req,res);return res
 }
 return{state,file,run}
}

test('actual bytes are checked before server-only version-bound receipt, never caller claims',async()=>{
 const fx=fixture(),res=await fx.run()
 assert.equal(res.statusCode,200);assert.deepEqual(res.body,{verified:true,validation_version:1})
 assert.equal(fx.state.fetch.length,1);assert.equal(fx.state.records.length,1)
 assert.deepEqual(fx.state.calls[0],['xelay_upload_scan_candidate',{p_bucket:bucket,p_path:path}])
 const record=fx.state.records[0]
 assert.equal(record.p_content_sha256,crypto.createHash('sha256').update('Ordinary fictional homework.\n').digest('hex'))
 assert.equal(record.p_detected_mime,'text/plain');assert.equal(record.p_validation_version,1)
 assert.equal(record.p_candidate.storage_version,'fictional-object-version')
 assert.match(record.p_validation_sha256,/^[a-f0-9]{64}$/)
 assert.match(res.headers['Cache-Control'],/no-store/);assert.equal(res.headers['X-Content-Type-Options'],'nosniff')
 assert.doesNotMatch(JSON.stringify(res.body),/fictional-service-key|fictional-user-token|sha256|owner_id|storage_version/)
})
test('non-PDF bytes renamed PDF remain quarantined with no verification receipt',async()=>{
 const pdfPath=path.replace(/txt$/,'pdf'),fx=fixture({candidate:{storage_path:pdfPath,mime_type:'application/pdf'}})
 const res=await fx.run({body:{bucket,path:pdfPath}})
 assert.equal(res.statusCode,422);assert.equal(fx.state.records.length,0);assert.equal(fx.state.fetch.length,1)
 assert.equal(fx.state.rejected.length,1);assert.deepEqual(plain(fx.state.removed),[[pdfPath]])
})
test('verified current receipt avoids another expensive download',async()=>{
 const fx=fixture({candidate:{already_verified:true}}),res=await fx.run()
 assert.equal(res.statusCode,200);assert.equal(fx.state.fetch.length,0);assert.equal(fx.state.records.length,0)
})
test('cross-origin/method/body forgery and traversal fail before authentication',async()=>{
 for(const [patch,status]of[
  [{method:'GET'},405],[{headers:{origin:'https://foreign.example'}},403],[{headers:{'sec-fetch-site':'cross-site'}},403],
  [{headers:{'content-type':'text/plain'}},415],[{body:{bucket,path,url:'https://foreign.example'}},400],
  [{body:{bucket,path,verified:true}},400],[{body:{bucket,path,content_sha256:'0'.repeat(64)}},400],
  [{body:{bucket:'other',path}},400],[{body:{bucket,path:'../../other.txt'}},400],
  [{body:{bucket,path:path+"' OR 1=1 --"}},400],[{headers:{'content-length':'99999'}},413]
 ]){const fx=fixture(),res=await fx.run(patch);assert.equal(res.statusCode,status);assert.equal(fx.state.auth.length,0);assert.equal(fx.state.fetch.length,0)}
})
test('missing/expired/unconfirmed/banned accounts cannot inspect Storage bytes',async()=>{
 const missing=fixture();assert.equal((await missing.run({headers:{authorization:''}})).statusCode,401)
 for(const options of[{authError:{message:'PRIVATE_DETAIL'}},{user:{email_confirmed_at:null}},{user:{deleted_at:'2026-01-01'}},{user:{banned_until:'2099-01-01'}},{user:{banned_until:'invalid'}}]){
  const fx=fixture(options),res=await fx.run();assert.equal(res.statusCode,401);assert.equal(fx.state.calls.length,0);assert.equal(fx.state.fetch.length,0)
 }
})
test('candidate foreign actor, path, bucket, size and version cannot reach privileged file read',async()=>{
 for(const candidate of[{owner_id:id},{storage_path:path.replace(parent,id)},{bucket_id:'other'},{object_id:'not-uuid'},{size:52428801},{size:0},{size:1.5},{storage_version:1},{updated_at:'invalid'}]){
  const fx=fixture({candidate}),res=await fx.run();assert.equal(res.statusCode,403);assert.equal(fx.state.fetch.length,0)
 }
})
test('rate and caller ACL denials cannot cause Storage download or leak details',async()=>{
 for(const[error,status]of[[{code:'PT429',message:'PRIVATE_SQL'},429],[{code:'42501',message:'PRIVATE_SQL'},403],[{code:'XX000',message:'PRIVATE_SQL'},503]]){
  const fx=fixture({candidateError:error}),res=await fx.run();assert.equal(res.statusCode,status);assert.equal(fx.state.fetch.length,0);assert.doesNotMatch(JSON.stringify(res.body),/PRIVATE_SQL/)
 }
})
test('upstream status MIME compression and wrong declared/actual lengths cannot produce a receipt',async()=>{
 for(const response of[
  b=>new Response(b,{status:302,headers:{location:'https://foreign.example'}}),
  b=>new Response(b,{headers:{'content-type':'text/html'}}),
  b=>new Response(b,{headers:{'content-type':'text/plain','content-encoding':'gzip'}}),
  b=>new Response(b,{headers:{'content-type':'text/plain','content-length':'1'}}),
  b=>new Response(b.subarray(0,3),{headers:{'content-type':'text/plain'}}),
  b=>new Response(Buffer.concat([b,Buffer.from('EXTRA')]),{headers:{'content-type':'text/plain'}})
 ]){const fx=fixture({response}),res=await fx.run();assert.ok([409,413].includes(res.statusCode));assert.equal(fx.state.records.length,0)}
})
test('only confirmed rejected-current objects are deleted; changed or failed retirement keeps bytes private',async()=>{
 const pdfPath=path.replace(/txt$/,'pdf')
 for(const options of[{rejectFalse:true},{rejectError:{code:'XX000'}}]){
  const fx=fixture({...options,candidate:{storage_path:pdfPath,mime_type:'application/pdf'}}),res=await fx.run({body:{bucket,path:pdfPath}})
  assert.equal(res.statusCode,422);assert.equal(fx.state.rejected.length,1);assert.equal(fx.state.removed.length,0)
 }
 const transient=fixture({response:b=>new Response(b,{headers:{'content-type':'text/html'}})})
 assert.equal((await transient.run()).statusCode,409);assert.equal(transient.state.rejected.length,0);assert.equal(transient.state.removed.length,0)
})
test('whole-file validation concurrency is bounded without a pending-body queue',async()=>{
 let release
 const wait=new Promise(resolve=>{release=resolve}),fx=fixture({wait})
 const first=fx.run(),second=fx.run()
 for(let index=0;index<30&&fx.state.fetch.length<2;index++)await new Promise(resolve=>setTimeout(resolve,1))
 assert.equal(fx.state.fetch.length,2)
 const denied=await fx.run();assert.equal(denied.statusCode,429);assert.equal(fx.state.fetch.length,2)
 release();assert.equal((await first).statusCode,200);assert.equal((await second).statusCode,200)
 assert.equal((await fx.run()).statusCode,200,'completed requests release their memory slot')
})
test('changed object or failed service receipt never reports a verified upload',async()=>{
 for(const options of[{recordFalse:true},{recordError:{code:'PT409',message:'PRIVATE'}}]){
  const fx=fixture(options),res=await fx.run();assert.equal(res.statusCode,409);assert.equal(res.body.verified,undefined);assert.doesNotMatch(JSON.stringify(res.body),/PRIVATE/)
 }
})
test('cancelled request never records an otherwise valid file',async()=>{
 const fx=fixture(),res=await fx.run({aborted:true})
 assert.equal(fx.state.records.length,0);assert.equal(res.statusCode,undefined)
})

