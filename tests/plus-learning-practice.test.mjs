import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

const source=readFileSync(new URL('../src/lib/plusLearningPractice.ts',import.meta.url),'utf8'),module={exports:{}}
runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,Date,Number,Math,BigInt,Map,Set,Error})
const {plusReviewId,mergePlusRuns,plusPracticeItems,seedPlusMistakes,schedulePlusReview,replacePlusReview}=module.exports
const plain=value=>JSON.parse(JSON.stringify(value)),NOW=Date.parse('2026-11-17T10:00:00Z')
function run(id='synthetic-run'){return{id,demo:false,createdAt:'2026-11-17T09:00:00Z',request:{mode:'quiz'},bundle:{title:'Синтетичний навчальний приклад',questions:[{id:'wrong',text:'Перше питання',options:['Так','Ні'],correctIndex:1,explanation:'Синтетичне пояснення',sourceId:''},{id:'pending',text:'Неперевірене питання',options:['Так','Ні'],correctIndex:1,explanation:'Синтетичне пояснення',sourceId:''},{id:'right',text:'Правильна відповідь',options:['Так','Ні'],correctIndex:0,explanation:'Синтетичне пояснення',sourceId:''}],cards:[{id:'card',front:'Термін',back:'Значення',sourceId:''}]},progress:{answers:{wrong:0,pending:0,right:0},submitted:['wrong','right'],cardRatings:{},doneTasks:[]}}}

test('practice uses checked mistakes and own saved cards without inventing results for unchecked answers',()=>{
 const original=run(),before=plain(original),items=plusPracticeItems([original],[],NOW)
 assert.deepEqual(Array.from(items,item=>[item.kind,item.itemId]).sort(),[['card','card'],['mistake','wrong']])
 assert.ok(items.every(item=>item.due));assert.deepEqual(plain(original),before)
 assert.equal(plusPracticeItems([{...original,demo:true}],[],NOW).length,0)
})

test('checking a mistake captures it once and later personal repetition cannot alter the original result',()=>{
 const original=run(),before=plain(original),first=seedPlusMistakes([], [original],NOW),again=seedPlusMistakes(first,[original],NOW+1000)
 assert.equal(first.length,1);assert.equal(first[0].repetitions,0);assert.equal(first[0].dueAt,new Date(NOW).toISOString());assert.deepEqual(plain(again),plain(first))
 const item=plusPracticeItems([original],first,NOW).find(item=>item.kind==='mistake'),review=schedulePlusReview(item,'good',NOW),saved=replacePlusReview(first,review)
 assert.equal(saved.length,1);assert.equal(saved[0].rating,'good');assert.deepEqual(plain(original),before)
 const corrected={...original,progress:{...original.progress,answers:{...original.progress.answers,wrong:1}}}
 assert.ok(plusPracticeItems([corrected],saved,NOW).some(item=>item.kind==='mistake'&&item.itemId==='wrong'),'the historical notebook entry remains available after correction')
})

test('repetition intervals are deterministic, capped and become due only after their scheduled time',()=>{
 const item=plusPracticeItems([run()],[],NOW).find(item=>item.kind==='card')
 for(const [rating,delay,days]of[['again',600000,0],['hard',86400000,1],['good',172800000,2],['easy',345600000,4]]){
  const next=schedulePlusReview(item,rating,NOW);assert.equal(Date.parse(next.dueAt),NOW+delay);assert.equal(next.intervalDays,days);assert.equal(next.repetitions,1)
  assert.equal(plusPracticeItems([run()],[next],NOW).find(item=>item.kind==='card').due,false)
  assert.equal(plusPracticeItems([run()],[next],NOW+delay).find(item=>item.kind==='card').due,true)
 }
 const max=schedulePlusReview({...item,review:{intervalDays:365,repetitions:10000}},'easy',NOW)
 assert.equal(max.intervalDays,365);assert.equal(max.repetitions,10000)
 assert.throws(()=>schedulePlusReview(item,'unexpected',NOW));assert.throws(()=>schedulePlusReview(item,'good',NaN))
})

test('pending current answers win over older cloud pages and demo runs never enter the library',()=>{
 const old=run(),current={...old,progress:{...old.progress,answers:{...old.progress.answers,pending:1}}},later={...run('later'),createdAt:'2026-11-17T09:30:00Z'},demo={...run('demo'),demo:true}
 const list=mergePlusRuns([old,demo],[later],[current])
 assert.deepEqual(Array.from(list,item=>item.id),['later','synthetic-run']);assert.equal(list[1].progress.answers.pending,1);assert.equal(old.progress.answers.pending,0)
})

test('review keys are stable safe identifiers, distinguish tuple boundaries and replace only the intended item',()=>{
 const id=plusReviewId('mistake','ab','c');assert.equal(id,plusReviewId('mistake','ab','c'));assert.match(id,/^review-[0-9a-f]{16}$/)
 assert.notEqual(id,plusReviewId('mistake','a','bc'));assert.notEqual(id,plusReviewId('card','ab','c'));assert.notEqual(plusReviewId('card','run','питання'),plusReviewId('card','run','питання2'))
 const first={id,kind:'mistake',runId:'ab',itemId:'c',rating:'again'},other={...first,id:'other',runId:'other'},next={...first,rating:'easy'}
 const replaced=replacePlusReview([first,other],next)
 assert.equal(replaced.length,2);assert.equal(replaced.find(item=>item.runId==='other'),other);assert.equal(replaced.find(item=>item.runId==='ab').rating,'easy');assert.equal(first.rating,'again')
})
