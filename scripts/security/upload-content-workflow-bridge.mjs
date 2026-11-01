// Actual byte verifier + actual PostgreSQL RPCs. Only the managed Auth/Storage
// transport is represented in-memory; there is no network or production data.
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as crypto from 'node:crypto'
import * as zlib from 'node:zlib'
import * as pathModule from 'node:path'
import assert from 'node:assert/strict'
import {uploadValidatorDependencies} from './upload-content-validator-dependencies.mjs'
const read=path=>readFile(new URL('../../'+path,import.meta.url),'utf8')
const [validatorSource,verifierSource]=await Promise.all([read('server/uploadContentValidation.ts'),read('server/uploadContentVerification.ts')])
function compile(source,imports,globals={}){
 const module={exports:{}}
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 vm.runInNewContext(code,{module,exports:module.exports,Buffer,Uint8Array,TextDecoder,TextEncoder,URL,Date,AbortController,AbortSignal,Error,
  require:name=>{assert.ok(name in imports,'Unexpected actual dependency '+name);return imports[name]},...globals})
 return module.exports
}
const validator=compile(validatorSource,{'node:crypto':crypto,'node:zlib':zlib,'node:path':pathModule,...uploadValidatorDependencies})
export function fixturePng(){
 const crc=bytes=>{let v=0xffffffff;for(const byte of bytes){v^=byte;for(let bit=0;bit<8;bit++)v=v&1?0xedb88320^(v>>>1):v>>>1}return(v^0xffffffff)>>>0}
 const chunk=(type,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4);return b}
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.from([0,200,100,10]))),chunk('IEND',Buffer.alloc(0))])
}
export async function verifyStoredBytes({db,asUser,actor,bucket,path,bytes}){
 assert.ok(Buffer.isBuffer(bytes),'Use explicit fictional byte fixtures')
 const user=(await db.query('select id,email_confirmed_at,deleted_at,banned_until from auth.users where id=$1',[actor])).rows[0]
 const object=(await db.query('select * from storage.objects where bucket_id=$1 and name=$2',[bucket,path])).rows[0]
 assert.ok(user&&object,'Test precondition requires an actual Auth user and stored object')
 const call=async(who,name,args,role='authenticated')=>{
  const allowed={
   xelay_upload_scan_candidate:['p_bucket','p_path'],
   xelay_record_upload_content_verification:['p_candidate','p_content_sha256','p_validation_sha256','p_detected_mime','p_validation_version'],
   xelay_reject_unverified_upload:['p_candidate']
  }
  assert.ok(name in allowed,'Unexpected RPC '+name)
  const values=allowed[name].map(key=>typeof args[key]==='object'?JSON.stringify(args[key]):args[key])
  try {
   const result=await asUser(who,'select public.'+name+'('+values.map((_,i)=>'$'+(i+1)).join(',')+') value',values,{role})
   return{data:result.rows[0].value,error:null}
  }catch(error){return{data:null,error:{code:error.code,message:error.message}}}
 }
 const service={auth:{getUser:async token=>{assert.equal(token,'fixture-user-token');return{data:{user:{id:actor}},error:null}},
  admin:{getUserById:async id=>{assert.equal(id,actor);return{data:{user},error:null}}}},
  rpc:(name,args)=>call(null,name,args,'service_role'),
  storage:{from:target=>({remove:async names=>{
   assert.equal(target,bucket);assert.deepEqual(JSON.parse(JSON.stringify(names)),[path])
   try{const result=await asUser(null,'delete from storage.objects where bucket_id=$1 and name=$2 returning name',[bucket,path],{role:'service_role'});return{data:result.rows,error:null}}
   catch(error){return{data:null,error:{code:error.code,message:error.message}}}
  }})}}
 const caller={rpc:(name,args)=>call(actor,name,args)}
 const storageOrigin='https://storage-fixture.invalid',origin='https://xelay-fixture.invalid'
 const endpoint=compile(verifierSource,{'node:crypto':crypto,'@supabase/supabase-js':{createClient:(url,key,options)=>{
  assert.equal(url,storageOrigin);return options.global.headers?caller:service
 }},'./uploadContentValidation.js':validator},{
  process:{env:{SUPABASE_URL:storageOrigin,XELAY_PUBLIC_URL:origin,SUPABASE_SERVICE_ROLE_KEY:'fixture-service-key',SUPABASE_ANON_KEY:'fixture-anon-key'}},
  fetch:async(url,init)=>{
   assert.equal(String(url),storageOrigin+'/storage/v1/object/'+bucket+'/'+path)
   assert.equal(init.headers.Authorization,'Bearer fixture-service-key');assert.equal(init.redirect,'error')
   return new Response(bytes,{headers:{'content-type':object.metadata.mimetype,'content-length':String(bytes.length)}})
  }
 })
 const req={method:'POST',headers:{origin,'sec-fetch-site':'same-origin','content-type':'application/json',authorization:'Bearer fixture-user-token'},body:{bucket,path}}
 const res={statusCode:null,headers:{},setHeader(k,v){this.headers[k]=v},status(s){this.statusCode=s;return this},json(value){this.body=JSON.parse(JSON.stringify(value));return this}}
 await endpoint.handleUploadContentVerification(req,res)
 return res
}

