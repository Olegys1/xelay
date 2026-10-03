import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// Compile the real helper against an isolated Storage stub. No account, token
// or network connection is used; database ownership is tested separately.
const calls=[]
let failAt=0
globalThis.__xelayPublicMediaTestStorage={rpc:async(name,params)=>{
  calls.push({operation:name.includes('reserve')?'reserve':'cancel',name,params});return {data:true,error:null}
},storage:{from:(bucket)=>({
  upload:async(path,file,options)=>{
    calls.push({operation:'upload',bucket,path,size:file.size,options})
    return {error:failAt && calls.filter(c=>c.operation==='upload').length===failAt ? new Error('Synthetic upload failure') : null}
  },
  getPublicUrl:(path)=>({data:{publicUrl:`https://staging.supabase.co/storage/v1/object/public/${bucket}/${path}`}}),
  remove:async(paths)=>{calls.push({operation:'remove',bucket,paths});return {data:paths.map(name=>({name})),error:null}},
})}}
const source=(await readFile(new URL('../../src/lib/publicMedia.ts',import.meta.url),'utf8'))
  .replace("import { supabase } from './supabase'",'const supabase=globalThis.__xelayPublicMediaTestStorage')
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
const media=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'))
const uid='00000000-0000-4000-8000-000000000001'
const file=(type='image/png',size=10)=>({name:'untrusted.svg.html',type,size})
let checks=0
const ok=(condition)=>{assert.ok(condition);checks++}
try {
  ok(media.publicMediaValidationError([file()],'avatars')===undefined)
  ok(Boolean(media.publicMediaValidationError([file('image/svg+xml')],'avatars')))
  ok(Boolean(media.publicMediaValidationError([file('video/mp4')],'question-images')))
  ok(media.publicMediaValidationError([file('video/mp4')],'answer-media')===undefined)
  ok(Boolean(media.publicMediaValidationError([file('image/png',5242881)],'avatars')))
  ok(Boolean(media.publicMediaValidationError([file('image/png',26214401)],'answer-media')))
  ok(Boolean(media.publicMediaValidationError(Array.from({length:6},()=>file()),'answer-media')))
  ok(Boolean(media.publicMediaValidationError(Array.from({length:3},()=>file('image/png',20*1024*1024)),'answer-media')))
  ok(Boolean(media.publicMediaValidationError([file('image/png',0)],'answer-media')))
  ok(media.publicMediaPath(uid,'questions',file()).startsWith(`${uid}/questions/`))
  ok(media.publicMediaPath(uid,'answers',file()).endsWith('.png'))
  assert.throws(()=>media.publicMediaPath('../other-user','questions',file()));checks++
  assert.throws(()=>media.publicMediaPath(uid,'questions',file('image/svg+xml')));checks++
  const uploaded=await media.uploadPublicMediaFiles(uid,'questions',[file()])
  ok(uploaded.length===1 && uploaded[0].type==='image')
  ok(calls.find(c=>c.operation==='upload').options.upsert===false && calls.find(c=>c.operation==='upload').options.contentType==='image/png')
  ok(calls[0].operation==='reserve' && calls[0].params.p_byte_size===10 && calls[0].params.p_mimetype==='image/png')
  calls.length=0;failAt=2
  await assert.rejects(()=>media.uploadPublicMediaFiles(uid,'answers',[file(),file()]),/Synthetic upload failure/);checks++
  ok(calls.filter(c=>c.operation==='remove').length===1)
  ok(calls.find(c=>c.operation==='remove').paths[0]===calls.find(c=>c.operation==='upload').path)
  ok(calls.filter(c=>c.operation==='cancel').length===1)
  ok(media.publicMediaUploadError({code:'54000'},'fallback').includes('ліміт'))
  ok(media.publicMediaUploadError(new Error('unknown'),'fallback')==='fallback')
  ok(media.publicContentError({message:'CONTENT_RATE_LIMIT'},'fallback').includes('публікацій'))
  ok(media.publicContentError({message:'CONTENT_TOO_LONG'},'fallback').includes('50 000'))
  ok(media.publicContentError({message:'CONTENT_MEDIA_LINK_LIMIT'},'fallback').includes('100'))
  console.log(`Public media helper: ${checks} checks passed.`)
} finally { delete globalThis.__xelayPublicMediaTestStorage }
