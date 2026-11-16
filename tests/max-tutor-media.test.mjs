import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const media={}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/maxTutorMedia.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:media,Math,Number,JSON,Date,Set,Map,WeakMap,Symbol,setTimeout,clearTimeout})
function fakeClock(){let next=0;const tasks=new Map();return{set(run,ms){const id=++next;tasks.set(id,{run,ms});return id},clear(id){tasks.delete(id)},fire(ms){const task=[...tasks].find(([,value])=>value.ms===ms);assert.ok(task,'timer must exist');tasks.delete(task[0]);task[1].run()},size:()=>tasks.size}}
function recognition(){return{lang:'',continuous:false,interimResults:false,maxAlternatives:0,onresult:null,onend:null,onerror:null,starts:0,stops:0,aborts:0,start(){this.starts++},stop(){this.stops++},abort(){this.aborts++;this.onend?.()}}}
const event=(items,resultIndex=0)=>({resultIndex,results:items.map(([text,final])=>({isFinal:final,0:{transcript:text}}))})
function speech(){const spoken=[],value={spoken,cancels:0,pauses:0,resumes:0,speak(utterance){spoken.push(utterance)},cancel(){this.cancels++},pause(){this.pauses++},resume(){this.resumes++},getVoices(){return[]}};return{synthesis:value,utterance:text=>({text,lang:'',voice:null,rate:0,onend:null,onerror:null})}}

test('capability detection is passive and unavailable APIs fail honestly without constructing a microphone or starting audio',()=>{
 let constructed=0
 const unsupported=media.getTutorBrowserMedia(null);assert.equal(unsupported.dictation,null);assert.equal(unsupported.speech,null)
 const supported=media.getTutorBrowserMedia({SpeechRecognition:class{constructor(){constructed++}},speechSynthesis:{...speech().synthesis},SpeechSynthesisUtterance:class{constructor(){constructed++}}})
 assert.equal(typeof supported.dictation,'function');assert.ok(supported.speech);assert.equal(constructed,0)
 const input=media.createTutorDictation({factory:null});assert.equal(input.start(true),false);assert.match(input.getState().error,/недоступне/)
 const output=media.createTutorNarrator({speech:null});assert.equal(output.play('Текст',null,true),false);assert.match(output.getState().error,/не підтримує/)
})

test('dictation requires explicit consent and starts at most one recognition session',()=>{
 const device=recognition();let factories=0;const input=media.createTutorDictation({factory:()=>{factories++;return device}})
 assert.equal(input.start(false),false);assert.equal(factories,0)
 assert.equal(input.start(true),true);assert.equal(input.start(true),false);assert.equal(factories,1);assert.equal(device.starts,1);assert.equal(device.lang,'uk-UA')
 input.dispose();assert.equal(device.aborts,1);assert.equal(device.onresult,null)
})

test('cumulative interim results never duplicate words and only final speech is delivered once after a stop',()=>{
 const device=recognition(),complete=[],timer=fakeClock(),input=media.createTutorDictation({factory:()=>device,clock:timer,onComplete:text=>complete.push(text)})
 input.start(true);device.onresult(event([['Привіт',true],['сві…',false]]));assert.equal(input.getState().transcript,'Привіт сві…')
 device.onresult(event([['Привіт',true],['світе',true]],1));const staleResult=device.onresult,staleEnd=device.onend
 input.stop();assert.equal(device.stops,1);assert.equal(input.getState().phase,'stopping');device.onend()
 staleResult(event([['Небажаний пізній результат',true]]));staleEnd()
 assert.deepEqual(complete,['Привіт світе']);assert.equal(device.aborts,1);assert.equal(timer.size(),0);assert.equal(input.getState().phase,'idle')
})

test('cancel and owner disposal abort the microphone without delivering a stale transcript or publishing further updates',()=>{
 const device=recognition(),complete=[],updates=[],input=media.createTutorDictation({factory:()=>device,onComplete:text=>complete.push(text),onUpdate:state=>updates.push(state)})
 input.start(true);device.onresult(event([['Приватний текст попереднього власника',true]]));const stale=device.onresult,ended=device.onend
 input.dispose();const count=updates.length;stale(event([['інший текст',true]]));ended();assert.equal(updates.length,count);assert.equal(complete.length,0);assert.equal(device.aborts,1);assert.equal(input.start(true),false)
 const secondDevice=recognition(),second=media.createTutorDictation({factory:()=>secondDevice,onComplete:text=>complete.push(text)})
 second.start(true);secondDevice.onresult(event([['скасований текст',true]]));second.cancel();assert.equal(complete.length,0);assert.equal(secondDevice.aborts,1)
})

test('duration and stop fallback bound microphone use even when the browser never emits end',()=>{
 const device=recognition(),timer=fakeClock(),complete=[],input=media.createTutorDictation({factory:()=>device,clock:timer,onComplete:text=>complete.push(text)})
 input.start(true);device.onresult(event([['Завершений фрагмент',true]]));timer.fire(60000);assert.equal(device.stops,1);timer.fire(2000)
 assert.deepEqual(complete,['Завершений фрагмент']);assert.equal(device.aborts,1);assert.equal(input.getState().phase,'idle');assert.equal(timer.size(),0)
})

test('dictation enforces the prompt limit and permission failures never deliver raw provider errors or interim text',()=>{
 const device=recognition(),complete=[],input=media.createTutorDictation({factory:()=>device,maxCharacters:12,onComplete:text=>complete.push(text)})
 input.start(true);device.onresult(event([['1234567890123456789',true]]));assert.equal(device.stops,1);assert.equal(input.getState().limitReached,true);device.onend();assert.deepEqual(complete,['123456789012'])
 input.start(true);device.onresult(event([['не підтверджено',false]]));device.onerror({error:'not-allowed',message:'private-provider-secret'})
 assert.match(input.getState().error,/не дозволив/);assert.doesNotMatch(input.getState().error,/private-provider-secret/);assert.equal(complete.length,1);input.dispose()
})

test('narration rejects oversized or empty input and splits long text without dropping its content',()=>{
 assert.throws(()=>media.prepareTutorNarration('   '));assert.throws(()=>media.prepareTutorNarration('x'.repeat(12001)))
 const text=('Зрозуміле пояснення. ').repeat(100),chunks=media.prepareTutorNarration(text)
 assert.ok(chunks.length>1);assert.ok(chunks.every(value=>value.length<=420));assert.equal(chunks.join(' '),text.trim())
 const singleWord=media.prepareTutorNarration('x'.repeat(12000));assert.equal(singleWord.join(''),'x'.repeat(12000));assert.ok(singleWord.length<40)
})

test('narration starts only after explicit playback and preserves the real selected browser voice across bounded chunks',()=>{
 const output=speech(),narrator=media.createTutorNarrator({speech:output}),voice={voiceURI:'real-device-voice',name:'Пристрій',lang:'uk-UA',localService:true}
 const text='Зміст. '.repeat(150);assert.equal(narrator.play(text,voice,false),false);assert.equal(output.synthesis.spoken.length,0)
 assert.equal(narrator.play(text,voice,true),true);let index=0
 while(narrator.getState().phase==='speaking'){const utterance=output.synthesis.spoken[index++];assert.equal(utterance.voice,voice);assert.equal(utterance.lang,'uk-UA');utterance.onend()}
 assert.equal(index,media.prepareTutorNarration(text).length);assert.equal(narrator.getState().phase,'idle');assert.equal(output.synthesis.cancels,0)
})

test('pause, resume and stop affect only the current narration, and stale utterance events cannot restart audio',()=>{
 const output=speech(),narrator=media.createTutorNarrator({speech:output});narrator.play('Текст. '.repeat(150),null,true)
 const stale=output.synthesis.spoken[0].onend;narrator.pause();assert.equal(narrator.getState().phase,'paused');narrator.resume();assert.equal(narrator.getState().phase,'speaking')
 assert.equal(output.synthesis.pauses,1);assert.equal(output.synthesis.resumes,1);narrator.stop();stale();assert.equal(output.synthesis.spoken.length,1);assert.equal(output.synthesis.cancels,1)
 narrator.dispose();assert.equal(narrator.play('Пізній текст',null,true),false)
})

test('changing narration owner cancels its predecessor; cleanup of the old owner cannot cancel the new owner',()=>{
 const output=speech(),old=media.createTutorNarrator({speech:output}),next=media.createTutorNarrator({speech:output});old.play('Попередній власник',null,true)
 const stale=output.synthesis.spoken[0].onend;next.play('Новий власник',null,true);assert.equal(output.synthesis.cancels,1);old.dispose();stale();assert.equal(output.synthesis.cancels,1);assert.equal(next.getState().phase,'speaking')
 next.dispose();assert.equal(output.synthesis.cancels,2);assert.equal(output.synthesis.spoken[1].onend,null)
})

test('speech failure clears its owned queue and reports a text fallback instead of pretending an audio file was generated',()=>{
 const output=speech(),narrator=media.createTutorNarrator({speech:output});narrator.play('Текст відповіді',null,true);output.synthesis.spoken[0].onerror({error:'synthesis-unavailable'})
 assert.equal(narrator.getState().phase,'error');assert.match(narrator.getState().error,/Текстова відповідь/);assert.equal(output.synthesis.cancels,1);assert.equal(output.synthesis.spoken[0].onend,null)
})

test('voice controls render without requesting resources, and an owner replacement remounts all transient voice state',()=>{
 const ui={};const source=readFileSync(new URL('../src/components/student/MaxTutorVoiceControls.tsx',import.meta.url),'utf8');const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;let resources=0
 vm.runInNewContext(code,{exports:ui,window:{SpeechRecognition:class{constructor(){resources++}}},require(id){if(id.endsWith('.css'))return{};if(id==='../../lib/maxTutorMedia')return media;return require(id)}})
 const props={ownerKey:'owner-a:session-a',text:'Приватна відповідь',onDictation:()=>{resources++},variant:'composer'};const html=renderToStaticMarkup(React.createElement(ui.MaxTutorVoiceControls,props))
 assert.equal(resources,0);assert.equal((html.match(/<button /g)||[]).length,2);assert.equal((html.match(/disabled=""/g)||[]).length,2);assert.doesNotMatch(html,/<audio|autoplay|Приватна відповідь/);assert.notEqual(ui.MaxTutorVoiceControls(props).key,ui.MaxTutorVoiceControls({...props,ownerKey:'owner-b:session-b'}).key)
})
