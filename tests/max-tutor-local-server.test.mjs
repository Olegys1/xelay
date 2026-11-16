import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import {readFileSync} from 'node:fs'
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {EventEmitter} from 'node:events'
import {Readable} from 'node:stream'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const nativeRequire=createRequire(import.meta.url),repository=fileURLToPath(new URL('../',import.meta.url)),cache=new Map(),realFs=nativeRequire('node:fs/promises')
let afterLedgerWrite=null,afterLedgerRename=null,nextDeadPid=900000
const deadPids=new Set()
const testProcess={...process,kill(target,signal){if(deadPids.has(target))throw Object.assign(Error('Verified synthetic dead PID'),{code:'ESRCH'});if(target===process.pid&&signal===0)return true;throw Object.assign(Error('PID cannot be verified'),{code:'EPERM'})}}
const ledgerFs={...realFs,async writeFile(...args){await realFs.writeFile(...args);await afterLedgerWrite?.(...args)},async rename(...args){await realFs.rename(...args);await afterLedgerRename?.(...args)}}
function load(file){const resolved=path.resolve(repository,file);if(cache.has(resolved))return cache.get(resolved).exports;const module={exports:{}};cache.set(resolved,module)
 const code=ts.transpileModule(readFileSync(resolved,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText
 vm.runInNewContext(code,{module,exports:module.exports,TextEncoder,TextDecoder,Buffer,Uint8Array,AbortController,Response,URL,fetch,setTimeout,clearTimeout,require(name){return name.startsWith('.')?load(path.resolve(path.dirname(resolved),name)+'.ts'):name==='node:fs/promises'?ledgerFs:name==='node:process'?testProcess:nativeRequire(name)}},{filename:resolved});return module.exports
}
const api=load('server/student-learning/maxTutorLocalServer.ts'),tutor=load('src/lib/maxTutor.ts'),ledgerApi=load('server/student-learning/maxTutorLocalLedger.ts')
// Synthetic credential assembled at runtime so no credential-shaped literal enters the repository.
const copy=value=>JSON.parse(JSON.stringify(value)),KEY=['sk','synthetic','local','test','key','not','a','live','secret'].join('-')
const request=(overrides={})=>({requestId:'request-1',mode:'quiz',prompt:'Створи питання за цими навчальними матеріалами.',sources:[{...copy(tutor.DEMO_TUTOR_SOURCE),id:'own-note',kind:'own_note',page:null}],...overrides})
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}})
function providerResponse(input){const source=input.sources[0],bundle=copy(tutor.createTutorDemo(input.requestId||'request-generated',input.mode).bundle);for(const q of bundle.questions)q.sourceId=source.id;for(const card of bundle.cards)card.sourceId=source.id;bundle.title='Тест за вибраним матеріалом';bundle.citations=[{sourceId:source.id,quote:source.text.slice(0,100)}];return {id:'synthetic-response',status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(bundle)}]}],usage:{input_tokens:100,input_tokens_details:{cached_tokens:0},output_tokens:20,output_tokens_details:{reasoning_tokens:0},total_tokens:120}}}
async function fixture(options={}){
 const directory=options.directory||await mkdtemp(path.join(tmpdir(),'xelay-local-tutor-')),calls=[],origin='http://127.0.0.1:3116';let bridge
 const fake=async(url,init)=>{const value=JSON.parse(init.body);calls.push({url,init,value});if(url.endsWith('/moderations'))return options.moderation?options.moderation(value,calls,init):json({results:[{flagged:false}]});if(url.endsWith('/responses'))return options.generate?options.generate(value,calls,init):json(providerResponse(JSON.parse(value.input[0].content[0].text)));throw Error('Unexpected provider')}
 bridge=await api.createMaxTutorLocalServer({origin,privateDirectory:directory,fetcher:fake,environmentApiKey:options.environmentApiKey})
 // Exercise the actual handler through HTTP-shaped readable messages. No socket, external fetch,
 // subprocess or offline-guard exception is involved; headers/cookie/body/close remain real inputs.
 const localFetch=async(address,init={})=>{
  const target=new URL(address);if(target.origin!==origin)throw Error('Unexpected local address')
  const req=Readable.from(init.body===undefined?[]:[Buffer.from(init.body)]),res=new EventEmitter(),responseHeaders=new Headers();let responseText=''
  req.url=target.pathname+target.search;req.method=init.method||'GET';req.headers={host:target.host,...Object.fromEntries(Object.entries(init.headers||{}).map(([k,v])=>[k.toLowerCase(),v]))};req.socket={remoteAddress:'127.0.0.1'}
  res.statusCode=200;res.writableEnded=false;res.destroyed=false;res.setHeader=(key,value)=>responseHeaders.set(key,String(value));res.end=value=>{responseText=value||'';res.writableEnded=true;res.emit('close')}
  const abort=()=>{req.emit('aborted');res.destroyed=true;res.emit('close')};if(init.signal?.aborted)abort();else init.signal?.addEventListener('abort',abort,{once:true})
  try{const handled=await bridge.handle(req,res);if(!handled){res.statusCode=404;res.end('')}}finally{init.signal?.removeEventListener('abort',abort)}
  return new Response(responseText||null,{status:res.statusCode,headers:responseHeaders})
 }
 let cookie='',state
 const get=async(headers={})=>{const response=await localFetch(origin+'/api/local-max/status',{headers:{...(cookie?{Cookie:cookie}:{}),...headers}});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const value=await response.json();if(response.ok)state=value;return {response,value}}
 const post=async(route,value={},headers={})=>{const response=await localFetch(origin+'/api/local-max/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-Xelay-CSRF':state?.csrfToken||'',...headers},body:JSON.stringify(value)});const result=await response.json();if(response.ok&&result.scope)state=result;return {response,value:result}}
 await get()
 return {origin,directory,calls,get,post,fetch:localFetch,state:()=>state,configure:()=>post('configure',{apiKey:KEY,model:options.model||'gpt-6.1-sol',limitUsd:options.limitUsd||1}),async close(remove=true){await bridge.close().catch(()=>{});if(remove&&!options.directory)await rm(directory,{recursive:true,force:true})}}
}

test('local bootstrap has a private HttpOnly session, strict headers and no key or false live connection',async()=>{const fx=await fixture();try{
 const {response,value}=await fx.get();assert.equal(response.status,200);assert.equal(value.connected,false);assert.equal(value.model,'gpt-6.1-sol');assert.equal(value.localOnly,true);assert.equal(value.estimatedAccounting,true);assert.equal(value.budget.limitUsd,1);assert.equal(value.models.length,3);assert.match(value.csrfToken,/^[a-f0-9]{64}$/);assert.match(value.scope.userId,/^local-/)
 assert.equal(response.headers.get('cache-control'),'no-store, private');assert.equal(response.headers.get('access-control-allow-origin'),null);assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');assert.doesNotMatch(JSON.stringify(value),/apiKey|sk-/)
 const fresh=await fx.fetch(fx.origin+'/api/local-max/status');assert.match(fresh.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/)
 const disabled=await fx.post('run',request());assert.equal(disabled.value.status,'unconfigured');assert.equal(fx.calls.length,0)
}finally{await fx.close()}})

test('cross-origin, Host rebinding, missing cookie, CSRF and query bypass fail before any provider call',async()=>{const fx=await fixture();try{
 for(const headers of [{Origin:'https://attacker.invalid'},{Cookie:''},{'X-Xelay-CSRF':''},{'X-Xelay-CSRF':'é'.repeat(64)}]){const r=await fx.post('configure',{apiKey:KEY},headers);assert.equal(r.response.status,403)}
 const rebound=await fx.fetch(fx.origin+'/api/local-max/status',{headers:{Host:'attacker.invalid'}});assert.equal(rebound.status,403)
 const cross=await fx.get({Origin:'https://attacker.invalid'});assert.equal(cross.response.status,403)
 const query=await fx.fetch(fx.origin+'/api/local-max/status?anything=1');assert.equal(query.status,403);assert.equal(fx.calls.length,0)
}finally{await fx.close()}})

test('key is accepted only in explicit local configuration and is absent from status and durable files',async()=>{const fx=await fixture();try{
 const before=fx.state().scope.sessionId,connected=await fx.configure();assert.equal(connected.response.status,200);assert.equal(connected.value.connected,true);assert.notEqual(connected.value.scope.sessionId,before);assert.doesNotMatch(JSON.stringify(connected.value),new RegExp(KEY))
 for(const value of [{apiKey:KEY,model:'https://evil.invalid'},{apiKey:KEY,limitUsd:6.01},{apiKey:KEY,limitUsd:0},{apiKey:KEY,endpoint:'https://evil.invalid'},{apiKey:'not-a-key'}])assert.ok([400,429].includes((await fx.post('configure',value)).response.status))
 for(const file of await readdir(fx.directory))assert.doesNotMatch(await readFile(path.join(fx.directory,file),'utf8'),new RegExp(KEY))
 const disconnected=await fx.post('disconnect');assert.equal(disconnected.value.connected,false)
}finally{await fx.close()}})

test('real route uses selected own text, input/output moderation, approved model and exact accounting once',async()=>{const fx=await fixture();try{
 await fx.configure();const r=await fx.post('run',request());assert.equal(r.response.status,200);assert.equal(r.value.status,'ready');assert.equal(r.value.replayed,false);assert.equal(r.value.bundle.title,'Тест за вибраним матеріалом')
 assert.deepEqual(fx.calls.map(c=>c.url),['https://api.openai.com/v1/moderations','https://api.openai.com/v1/responses','https://api.openai.com/v1/moderations'])
 const provider=fx.calls[1];assert.equal(provider.value.model,'gpt-6.1-sol');assert.equal(provider.value.store,false);assert.deepEqual(provider.value.tools,[]);assert.equal(provider.init.redirect,'error');assert.equal(provider.init.headers.Authorization,'Bearer '+KEY)
 const material=JSON.parse(provider.value.input[0].content[0].text);assert.equal(material.sources[0].text,request().sources[0].text);assert.equal(material.sources[0].id,'own-note');assert.equal(material.userId,undefined)
 const status=await fx.get();assert.equal(status.value.budget.spentUsd,0.0008);assert.equal(status.value.budget.reservedUsd,0);assert.doesNotMatch(JSON.stringify(r.value),new RegExp(KEY))
}finally{await fx.close()}})

test('same request replays without generation; changed content cannot inherit its result or a free new chance',async()=>{const fx=await fixture();try{
 await fx.configure();await fx.post('run',request());const again=await fx.post('run',request());assert.equal(again.value.replayed,true);assert.equal(fx.calls.filter(c=>c.url.endsWith('/responses')).length,1)
 const altered=request({prompt:'Зміни завдання під тим самим ідентифікатором.'});assert.equal((await fx.post('run',altered)).value.status,'conflict');assert.equal(fx.calls.filter(c=>c.url.endsWith('/responses')).length,1)
}finally{await fx.close()}})

test('concurrent duplicate stays pending rather than issuing a second model call',async()=>{let release,started;const ready=new Promise(r=>{started=r});const fx=await fixture({generate:async payload=>{started();await new Promise(r=>{release=r});return json(providerResponse(JSON.parse(payload.input[0].content[0].text)))}});try{
 await fx.configure();const first=fx.post('run',request());await ready;const second=await fx.post('run',request());assert.equal(second.value.status,'pending');assert.equal(fx.calls.filter(c=>c.url.endsWith('/responses')).length,1);release();assert.equal((await first).value.status,'ready');assert.equal((await fx.get()).value.budget.reservedUsd,0)
}finally{release?.();await fx.close()}})

test('unknown provider costs consume conservative reservation, exhaust cap and persist after restart',async()=>{const directory=await mkdtemp(path.join(tmpdir(),'xelay-local-cap-'));let fx=await fixture({directory,generate:async()=>{throw Error(KEY)}});try{
 await fx.configure();for(let i=0;i<2;i++){const r=await fx.post('run',request({requestId:'failed-'+i}));assert.equal(r.value.status,'generation_failed');assert.doesNotMatch(JSON.stringify(r.value),new RegExp(KEY))}
 const third=await fx.post('run',request({requestId:'failed-3'}));assert.equal(third.value.status,'quota_exhausted');assert.equal(fx.calls.filter(c=>c.url.endsWith('/responses')).length,2)
 const before=(await fx.get()).value;assert.equal(before.budget.spentUsd,0.88768);const owner=before.scope.userId;await fx.close(false);fx=await fixture({directory});const after=fx.state();assert.equal(after.budget.spentUsd,before.budget.spentUsd);assert.equal(after.scope.userId,owner);assert.equal(after.connected,false)
}finally{await fx.close(false);await rm(directory,{recursive:true,force:true})}})

test('disconnect during generation aborts presentation and keeps paid accounting without stored output',async()=>{let release,started;const ready=new Promise(r=>{started=r});const fx=await fixture({generate:async payload=>{started();await new Promise(r=>{release=r});return json(providerResponse(JSON.parse(payload.input[0].content[0].text)))}});try{
 await fx.configure();const running=fx.post('run',request());await ready;const disconnected=await fx.post('disconnect');assert.equal(disconnected.value.connected,false);const outcome=await running;assert.notEqual(outcome.value.status,'ready');assert.equal(outcome.value.bundle,undefined);release()
 const disk=JSON.parse(await readFile(path.join(fx.directory,'budget.json'),'utf8'));assert.equal(disk.rows[0].bundle,null);assert.equal(disk.rows[0].state,'done');assert.equal(disk.rows[0].charge,443840)
}finally{release?.();await fx.close()}})

test('moderation failure cannot become a successful result; output refusal still accounts for generation',async()=>{
 for(const stage of ['input','output']){let n=0;const fx=await fixture({moderation:async()=>json({results:[{flagged:++n===(stage==='input'?1:2)}]})});try{await fx.configure();const r=await fx.post('run',request());assert.equal(r.value.status,'refused');assert.equal(r.value.bundle,undefined);assert.equal(fx.calls.filter(c=>c.url.endsWith('/responses')).length,stage==='input'?0:1);assert.equal((await fx.get()).value.budget.spentUsd,stage==='input'?0:0.0008)}finally{await fx.close()}}
})

test('protected kinds, duplicate sources, forged identity, oversized text and markup never reach a model',async()=>{const fx=await fixture();try{
 await fx.configure();const source=request().sources[0]
 for(const value of [request({userId:'teacher'}),request({sources:[{...source,kind:'official_test_key'}]}),request({sources:[source,source]}),request({sources:[{...source,text:'ї'.repeat(13000)}]}),request({sources:[{...source,text:'<script>bad</script>'}]}),request({sources:[{...source,id:'own-note',kind:'own_excerpt',page:1}]})])assert.equal((await fx.post('run',value)).response.status,400)
 assert.equal(fx.calls.length,0)
}finally{await fx.close()}})

test('ledger serializes reservation races, settles idempotently and rejects changed final authorization',async()=>{const directory=await mkdtemp(path.join(tmpdir(),'xelay-ledger-'));try{
 const ledger=await ledgerApi.createMaxTutorLocalLedger(directory),owner=(await ledger.snapshot()).ownerId,input={userId:owner,requestId:'request-1',fingerprint:'a'.repeat(64),reserveMicros:600000,monthlyLimitMicros:1000000}
 const [first,second]=await Promise.all([ledger.begin(input),ledger.begin({...input,requestId:'request-2'})]);assert.equal(first.state,'reserved');assert.equal(second.state,'denied')
 const settlement={userId:owner,sessionId:'session-local',requestId:input.requestId,fingerprint:input.fingerprint,reservationId:first.reservationId,chargeMicros:1234,bundle:{version:1}}
 await assert.rejects(()=>ledger.finish(settlement,()=>false));const state=await ledger.snapshot();assert.equal(state.spentMicros,1234);assert.equal(state.reservedMicros,0);await assert.rejects(()=>ledger.finish(settlement,()=>true));assert.equal((await ledger.snapshot()).spentMicros,1234)
}finally{await rm(directory,{recursive:true,force:true})}})

test('corrupt durable accounting fails closed and is never reset to free allowance',async()=>{const fx=await fixture();try{
 await writeFile(path.join(fx.directory,'budget.json'),'{broken');const result=await fx.get();assert.equal(result.response.status,503);assert.equal(result.value.status,'unavailable');assert.equal(await readFile(path.join(fx.directory,'budget.json'),'utf8'),'{broken');assert.equal(fx.calls.length,0)
}finally{await fx.close()}})

const lockOwner=pid=>JSON.stringify({version:1,pid,token:'c'.repeat(64)})
const deadPid=()=>{const value=++nextDeadPid;deadPids.add(value);return value}

test('verified dead-PID lock recovers without freeing unknown pending reservations',async()=>{const directory=await mkdtemp(path.join(tmpdir(),'xelay-dead-lock-'));try{
 const first=await ledgerApi.createMaxTutorLocalLedger(directory),owner=(await first.snapshot()).ownerId
 await first.begin({userId:owner,requestId:'interrupted',fingerprint:'d'.repeat(64),reserveMicros:400000,monthlyLimitMicros:1000000})
 await writeFile(path.join(directory,'budget.lock'),lockOwner(deadPid()))
 const restarted=await ledgerApi.createMaxTutorLocalLedger(directory),state=await restarted.snapshot();assert.equal(state.ownerId,owner);assert.equal(state.reservedMicros,400000);assert.equal(state.spentMicros,0);assert.equal(state.limitMicros,1000000);assert.equal((await readdir(directory)).includes('budget.lock'),false)
}finally{await rm(directory,{recursive:true,force:true})}})

test('active or malformed lock remains untouched and fails closed',async()=>{const directory=await mkdtemp(path.join(tmpdir(),'xelay-active-lock-'));try{
 await ledgerApi.createMaxTutorLocalLedger(directory)
 for(const text of [lockOwner(process.pid),'unverifiable lock']){await writeFile(path.join(directory,'budget.lock'),text);await assert.rejects(()=>ledgerApi.createMaxTutorLocalLedger(directory),/busy/);assert.equal(await readFile(path.join(directory,'budget.lock'),'utf8'),text);await rm(path.join(directory,'budget.lock'))}
}finally{await rm(directory,{recursive:true,force:true})}})

test('concurrent dead-lock recoverers keep one owner and cannot delete an active claimant lock',async()=>{const directory=await mkdtemp(path.join(tmpdir(),'xelay-lock-race-'));try{
 const original=await ledgerApi.createMaxTutorLocalLedger(directory),owner=(await original.snapshot()).ownerId;await writeFile(path.join(directory,'budget.lock'),lockOwner(deadPid()))
 const [a,b]=await Promise.all([ledgerApi.createMaxTutorLocalLedger(directory),ledgerApi.createMaxTutorLocalLedger(directory)]),[sa,sb]=await Promise.all([a.snapshot(),b.snapshot()]);assert.equal(sa.ownerId,owner);assert.equal(sb.ownerId,owner);assert.equal(sa.limitMicros,1000000);assert.equal(sb.limitMicros,1000000)
}finally{await rm(directory,{recursive:true,force:true})}})

test('revocation during temporary write or atomic rename scrubs result and preserves paid charge',async()=>{
 for(const stage of ['write','rename']){const directory=await mkdtemp(path.join(tmpdir(),'xelay-cancel-commit-'));let allowed=true;try{
  const ledger=await ledgerApi.createMaxTutorLocalLedger(directory),owner=(await ledger.snapshot()).ownerId,input={userId:owner,requestId:'request-cancel',fingerprint:'e'.repeat(64),reserveMicros:500000,monthlyLimitMicros:1000000},reservation=await ledger.begin(input)
  if(stage==='write')afterLedgerWrite=async(file,content)=>{if(String(file).startsWith(directory)&&String(content).includes('"bundle":{"version":1}'))allowed=false}
  else afterLedgerRename=async(_from,to)=>{if(String(to)===path.join(directory,'budget.json')){const contents=JSON.parse(await readFile(to,'utf8'));if(contents.rows.some(row=>row.bundle))allowed=false}}
  const settlement={userId:owner,sessionId:'session-cancel',requestId:input.requestId,fingerprint:input.fingerprint,reservationId:reservation.reservationId,chargeMicros:2345,bundle:{version:1}}
  await assert.rejects(()=>ledger.finish(settlement,()=>allowed),/authorization changed/)
  afterLedgerWrite=null;afterLedgerRename=null
  const state=JSON.parse(await readFile(path.join(directory,'budget.json'),'utf8'));assert.equal(state.rows[0].bundle,null);assert.equal(state.rows[0].charge,2345);assert.equal(state.rows[0].state,'done');assert.equal((await ledger.snapshot()).reservedMicros,0);assert.equal((await ledger.begin(input)).state,'conflict')
 }finally{afterLedgerWrite=null;afterLedgerRename=null;await rm(directory,{recursive:true,force:true})}}
})
