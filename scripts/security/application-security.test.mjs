import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { seal, verifySealed, signManifest, authenticateManifest, verifyBackup, exportBackup } from './encrypted-backup.mjs'
const require = createRequire(import.meta.url)
const root = new URL('../../',import.meta.url)

test('production CSP covers the actual built inline scripts and checkout form',async()=>{
  const config=JSON.parse(await readFile(new URL('vercel.json',root),'utf8'))
  const headers=config.headers.find((x)=>x.source==='/(.*)').headers
  const csp=headers.find((x)=>x.key==='Content-Security-Policy').value
  assert.match(csp,/frame-ancestors 'none'/)
  assert.match(csp,/object-src 'none'/)
  assert.match(csp,/form-action 'self' https:\/\/secure\.wayforpay\.com/)
  assert.doesNotMatch(csp,/script-src[^;]*unsafe-(inline|eval)/)
  const html=await readFile(new URL('dist/index.html',root),'utf8')
  for(const match of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    assert.ok(csp.includes(`'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`))
  }
  assert.match(html,/src="\/theme-init.js"/)
  assert.equal(headers.find((x)=>x.key==='Referrer-Policy').value,'no-referrer')
  assert.equal(headers.find((x)=>x.key==='X-Frame-Options').value,'DENY')
  assert.equal(config.headers.find((x)=>x.source==='/api/(.*)').headers[0].value,'no-store')
})

test('development server has explicit local host boundaries',async()=>{
  const config=await readFile(new URL('vite.config.ts',root),'utf8')
  assert.match(config,/host: '127.0.0.1'/)
  assert.doesNotMatch(config,/allowedHosts: true|host: true/)
})

function loadMaintenance(environment, clock = Date) {
  return readFile(new URL('server/mediaMaintenance.ts',root),'utf8').then((source)=>{
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
    const exports={}
    vm.runInNewContext(code,{exports,require,process:{env:environment},Date:clock,AbortSignal,fetch,URL})
    return exports
  })
}

test('maintenance rejects missing/short/wrong secrets and accepts only exact bearer',async()=>{
  const off=await loadMaintenance({})
  assert.throws(()=>off.authorizeMediaMaintenance({headers:{}}),(e)=>e.status===503)
  const on=await loadMaintenance({SECURITY_MAINTENANCE_SECRET:'S'.repeat(48)})
  for(const value of [undefined,'S'.repeat(48),'Bearer '+'X'.repeat(48),'Bearer '+'S'.repeat(48)+' ']) {
    assert.throws(()=>on.authorizeMediaMaintenance({headers:{authorization:value}}),(e)=>e.status===401)
  }
  assert.doesNotThrow(()=>on.authorizeMediaMaintenance({headers:{authorization:'Bearer '+'S'.repeat(48)}}))
})

test('worker claims exact object version before Storage API deletion; no claim means no delete',async()=>{
  const module=await loadMaintenance({})
  const operations=[]
  const service={rpc:async(name,parameters)=>{
    operations.push([name,parameters])
    if(name==='xelay_media_cleanup_next_scope') return {data:'private'}
    if(name.endsWith('maintenance')) return {data:{}}
    if(name.endsWith('candidates')) return {data:[{bucket_id:name.includes('private')?'xelay-chat-media':'avatars',name:'synthetic/object.png',object_id:'00000000-0000-4000-8000-000000000001'}]}
    return {data:name.includes('public')}
  },storage:{from:(bucket)=>({
    remove:async(paths)=>{
      operations.push(['remove',bucket,paths])
      return {data:paths.map(name=>({name}))}
    }
  })}}
  const result=await module.cleanDetachedMedia(service)
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{candidates:2,claimed:1,removed:1,skipped:1,failed:0,attemptedScopes:['private','public'],deferredScopes:[]})
  assert.equal(operations.filter(x=>x[0]==='remove').length,1)
  assert.equal(operations.at(-2)[1].p_object_id,'00000000-0000-4000-8000-000000000001')
})

test('worker treats empty delete result as failure and respects its time budget',async()=>{
  const module=await loadMaintenance({})
  let deleted=0
  const service={rpc:async(name)=>({data:name==='xelay_media_cleanup_next_scope'?'private':name.endsWith('maintenance')?{}:name.endsWith('candidates')?[{bucket_id:'avatars',name:'synthetic.png',object_id:'id'}]:true}),storage:{from:()=>({remove:async()=>{deleted++;return{data:[]}}})}}
  assert.equal((await module.cleanDetachedMedia(service,Date.now())).candidates,0)
  assert.equal(deleted,0)
  assert.equal((await module.cleanDetachedMedia(service)).failed,2)
})

test('slow cleanup alternates first scope across runs and reports deferred work',async()=>{
  let time=Date.now(), next='private'
  class Clock extends Date { static now() {return time} }
  const module=await loadMaintenance({},Clock)
  const service={rpc:async(name)=>{
    time+=4000
    if(name==='xelay_media_cleanup_next_scope') {const value=next;next=next==='private'?'public':'private';return{data:value}}
    if(name.endsWith('maintenance'))return{data:{}}
    if(name.endsWith('candidates'))return{data:Array.from({length:20},(_,i)=>({bucket_id:name.includes('private')?'xelay-chat-media':'avatars',name:`synthetic/${i}`,object_id:'id'}))}
    return{data:true}
  },storage:{from:()=>({remove:async(paths)=>{time+=4000;return{data:paths.map(name=>({name}))}}})}}
  const first=await module.cleanDetachedMedia(service)
  const second=await module.cleanDetachedMedia(service)
  assert.deepEqual(Array.from(first.attemptedScopes),['private'])
  assert.deepEqual(Array.from(first.deferredScopes),['public'])
  assert.deepEqual(Array.from(second.attemptedScopes),['public'])
  assert.deepEqual(Array.from(second.deferredScopes),['private'])
  assert.ok(first.removed>0&&second.removed>0)
})

test('backup encryption round trip rejects wrong password and changed ciphertext',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'xelay-security-'))
  try {
    const file=join(directory,'synthetic.enc'), password='synthetic test passphrase only'
    await seal(Readable.from([Buffer.from('Synthetic backup, no user data')]),file,password)
    assert.match(await verifySealed(file,password),/^[0-9a-f]{64}$/)
    await assert.rejects(verifySealed(file,'wrong synthetic passphrase'))
    const bytes=await readFile(file); bytes[40]^=1
    const {writeFile}=await import('node:fs/promises'); await writeFile(file,bytes)
    await assert.rejects(verifySealed(file,password))
  } finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('xelay-security-'))
    await rm(directory,{recursive:true,force:true})
  }
})

test('backup authenticates inventory and rejects omitted database, dropped objects and altered counts',async()=>{
  const password='synthetic inventory test passphrase'
  const manifest={complete:true,project:'abcdefghijklmnopqrst',createdAt:new Date().toISOString(),storageFiles:1,files:[
    {name:'database.enc',sha256:'a'.repeat(64)}, {name:'b'.repeat(64)+'.enc',sha256:'c'.repeat(64)},
  ]}
  const envelope=signManifest(manifest,password)
  assert.deepEqual(authenticateManifest(envelope,password),manifest)
  assert.throws(()=>authenticateManifest(envelope,'wrong inventory passphrase'))
  for(const change of [
    {...manifest,files:manifest.files.slice(1)}, {...manifest,storageFiles:0,files:manifest.files.slice(0,1)},
    {...manifest,project:'xxxxxxxxxxxxxxxxxxxx'}, {...manifest,complete:false},
  ]) assert.throws(()=>authenticateManifest({...envelope,payload:JSON.stringify(change)},password))
  for(const invalid of [
    {...manifest,storageFiles:0,files:manifest.files.slice(1)}, {...manifest,storageFiles:2},
    {...manifest,files:[manifest.files[0],manifest.files[0]]},
  ]) assert.throws(()=>authenticateManifest(signManifest(invalid,password),password))
})

test('complete backup verifies exact authenticated ciphertext inventory',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'xelay-security-'))
  const password='synthetic complete backup passphrase'
  try {
    const file=join(directory,'database.enc')
    await seal(Readable.from(['Synthetic database']),file,password)
    const manifest={complete:true,project:'abcdefghijklmnopqrst',createdAt:new Date().toISOString(),storageFiles:0,
      files:[{name:'database.enc',sha256:await verifySealed(file,password)}]}
    const {writeFile}=await import('node:fs/promises')
    await writeFile(join(directory,'manifest.json'),JSON.stringify(signManifest(manifest,password)))
    assert.equal((await verifyBackup(directory,password)).storageFiles,0)
    await seal(Readable.from(['Unexpected synthetic file']),join(directory,'a'.repeat(64)+'.enc'),password)
    await assert.rejects(verifyBackup(directory,password),/unexpected/)
  } finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('xelay-security-'))
    await rm(directory,{recursive:true,force:true})
  }
})

test('recovery export authenticates first, preserves bytes and cannot use original paths or overwrite files',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'xelay-security-'))
  const password='synthetic recovery export passphrase'
  try {
    const {mkdir,writeFile}=await import('node:fs/promises')
    const backup=join(directory,'encrypted'),output=join(directory,'recovery')
    await mkdir(backup)
    const objectName='a'.repeat(64)+'.enc'
    const payload=Buffer.concat([Buffer.from(JSON.stringify({bucket:'synthetic',name:'../../outside.txt'})+'\n'),Buffer.from([0,1,2,255])])
    await seal(Readable.from(['Synthetic dump']),join(backup,'database.enc'),password)
    await seal(Readable.from([payload]),join(backup,objectName),password)
    const manifest={complete:true,project:'abcdefghijklmnopqrst',createdAt:new Date().toISOString(),storageFiles:1,
      files:await Promise.all(['database.enc',objectName].map(async(name)=>({name,sha256:await verifySealed(join(backup,name),password)})))}
    await writeFile(join(backup,'manifest.json'),JSON.stringify(signManifest(manifest,password)))
    await assert.rejects(exportBackup(backup,'wrong recovery passphrase',output))
    await exportBackup(backup,password,output)
    assert.equal(await readFile(join(output,'database.dump'),'utf8'),'Synthetic dump')
    assert.deepEqual(await readFile(join(output,objectName.replace('.enc','.payload'))),payload)
    await assert.rejects(exportBackup(backup,password,output),/EEXIST/)
    await assert.rejects(readFile(join(directory,'outside.txt')),/ENOENT/)
  } finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('xelay-security-'))
    await rm(directory,{recursive:true,force:true})
  }
})
