import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const root=fileURLToPath(new URL('../',import.meta.url)),cache=new Map()
function load(file){const absolute=path.resolve(root,file);if(cache.has(absolute))return cache.get(absolute).exports;const module={exports:{}};cache.set(absolute,module)
 const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 vm.runInNewContext(code,{module,exports:module.exports,TextEncoder,TextDecoder,Uint8Array,Response,JSON,Number,Date,Set,Map,Promise,require(name){if(name.endsWith('.js'))name=name.slice(0,-3);if(!name.startsWith('.'))throw Error('Unexpected module');return load(path.resolve(path.dirname(absolute),name)+'.ts')}});return module.exports}
const parser=load('src/lib/maxTutorProgress.ts'),server=load('server/student-learning/maxTutorProgressResponse.ts'),client=load('src/lib/maxTutorProductionClient.ts'),tutor=load('src/lib/maxTutor.ts')
const frame=v=>JSON.stringify(v)+'\n',p=phase=>({type:'progress',phase}),result=value=>({type:'result',status:200,value}),response=text=>new Response(text,{headers:{'content-type':'application/x-ndjson;charset=utf-8'}})
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}

test('real stages reach the listener while the final model result is still pending, with split UTF8 handled',async()=>{
 let controller,complete=false;const phases=[],body=new ReadableStream({start(value){controller=value}})
 const reading=parser.readTutorProgressResponse(new Response(body,{headers:{'content-type':'application/x-ndjson'}}),value=>phases.push(value)).then(value=>{complete=true;return value})
 const bytes=new TextEncoder().encode(frame(p('preparing'))+frame(p('generating')))
 controller.enqueue(bytes.slice(0,11));controller.enqueue(bytes.slice(11));await settle();assert.deepEqual(phases,['preparing','generating']);assert.equal(complete,false)
 controller.enqueue(new TextEncoder().encode(frame(p('validating'))+frame(p('saving'))));await settle();assert.equal(complete,false)
 const final=new TextEncoder().encode(frame(result({status:'ready',title:'Попит і пропозиція'})));controller.enqueue(final.slice(0,final.length-6));controller.enqueue(final.slice(final.length-6));controller.close()
 assert.deepEqual(JSON.parse(JSON.stringify(await reading)),{status:'ready',title:'Попит і пропозиція'});assert.deepEqual(phases,['preparing','generating','validating','saving'])
})

test('partial, unordered, oversized or invented progress is rejected rather than presented as successful work',async()=>{
 for(const text of[frame(p('generating')),frame(p('generating'))+frame(p('preparing'))+frame(result({})),frame(p('saving'))+frame(p('saving'))+frame(result({})),frame({type:'progress',phase:'searching-the-web'})+frame(result({})),frame({...p('preparing'),privateText:'hidden'}),frame(result({}))+frame(p('saving')),frame({type:'result',status:999,value:{}}),'<html>login</html>'])await assert.rejects(parser.readTutorProgressResponse(response(text),()=>{}))
 await assert.rejects(parser.readTutorProgressResponse(response(frame(result({text:'x'.repeat(400)}))),()=>{},64))
 await assert.rejects(parser.readTutorProgressResponse(new Response('bad',{headers:{'content-type':'text/html'}}),()=>{}))
 assert.deepEqual(JSON.parse(JSON.stringify(await parser.readTutorProgressResponse(response(frame(result({status:'ready'}))),()=>{throw Error('observer failure')}))),{status:'ready'})
})

test('server sends only actual monotonic phases, opts in explicitly, and keeps errors/no-store JSON compatible',()=>{
 function fixture(accept){const headers={},parts=[];const res={statusCode:0,writableEnded:false,destroyed:false,setHeader(k,v){headers[k.toLowerCase()]=v},write(v){parts.push(v)},end(v){parts.push(v);this.writableEnded=true}};return{res,headers,parts,out:server.createTutorProgressResponse({headers:{accept}},res)}}
 const streamed=fixture('application/x-ndjson, application/json');streamed.out.progress('preparing');streamed.out.progress('generating');streamed.out.progress('generating');streamed.out.progress('sending');streamed.out.send(503,{status:'generation_failed'})
 assert.equal(streamed.res.statusCode,200);assert.match(streamed.headers['content-type'],/ndjson/);assert.match(streamed.headers['cache-control'],/no-store/);assert.deepEqual(streamed.parts.map(x=>JSON.parse(x).type),['progress','progress','result']);assert.equal(JSON.parse(streamed.parts.at(-1)).status,503)
 for(const accept of['application/json','text/plain',undefined]){const plain=fixture(accept);plain.out.progress('preparing');assert.equal(plain.parts.length,0);plain.out.send(400,{status:'invalid_request'});assert.equal(plain.res.statusCode,400);assert.match(plain.headers['content-type'],/application\/json/);assert.match(plain.headers['cache-control'],/no-store/);assert.equal(JSON.parse(plain.parts[0]).status,'invalid_request')}
})

test('actual production client validates streamed saved run and session identity before returning a result',async()=>{
 const example=JSON.parse(JSON.stringify(tutor.createTutorDemo('streamed-run','quiz'))),run={id:example.request.requestId,createdAt:'2026-11-17T07:00:00Z',demo:false,...example,progress:JSON.parse(JSON.stringify(tutor.emptyTutorProgress())),revision:1},credential={userId:'owner',sessionId:'session',accessToken:'synthetic-token'}
 const phases=[];let swapped=false,calls=0
 const api=client.createMaxTutorProductionClient({ownerId:'owner',credential:async()=>({...credential,sessionId:swapped?'other-session':'session'}),fetcher:async(_url,options)=>{calls++;assert.equal(options.headers.Accept,'application/x-ndjson, application/json');return response(frame(p('preparing'))+frame(p('generating'))+frame(p('validating'))+frame(p('saving'))+frame(result({status:'ready',bundle:run.bundle,replayed:false,run})))}})
 assert.equal((await api.generate(run.request,undefined,phase=>phases.push(phase))).run.id,run.id);assert.equal(calls,1);assert.equal(phases.length,4)
 const changed=client.createMaxTutorProductionClient({ownerId:'owner',credential:async()=>({...credential,sessionId:swapped?'other-session':'session'}),fetcher:async()=>{swapped=true;return response(frame(result({status:'ready',bundle:run.bundle,replayed:false,run})))}})
 await assert.rejects(changed.generate(run.request,undefined,()=>{}),e=>e.code==='identity_changed')
})
