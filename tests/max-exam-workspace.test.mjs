import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const module={exports:{}}
const study={}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/maxTutorStudy.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:study,Date,JSON,Set,Map,Number,TextEncoder})
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/maxExamWorkspace.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{module,exports:module.exports,Date,JSON,Set,Map,Number,TextEncoder,require(name){assert.equal(name,'./maxTutorStudy');return study}})
const {normalizeMaxExamDraft,parseMaxExamDrafts,parseMaxExamScratch,maxExamPrompt,maxStudySummary}=module.exports
const draft={id:'exam-private-test',subject:'Економічна теорія',date:'2026-12-01',dailyMinutes:30,goal:'Зрозуміти головне',note:'Мій власний конспект.',createdAt:'2026-11-16T12:00:00Z'}
test('exam drafts validate calendar dates, bounded source text and safe stored fields',()=>{
 assert.ok(normalizeMaxExamDraft(draft))
 for(const patch of [{date:'2026-02-30'},{date:'2026-02-29'},{dailyMinutes:0},{dailyMinutes:241},{subject:''},{id:'__proto__'},{note:'а'.repeat(8001)},{subject:'<script>secret</script>'},{note:'bad\u0000note'}])assert.equal(normalizeMaxExamDraft({...draft,...patch}),null)
 assert.ok(normalizeMaxExamDraft({...draft,date:'2028-02-29'}))
})
test('stored drafts are bounded, deduplicated, and malformed JSON never hydrates unchecked data',()=>{
 assert.equal(parseMaxExamDrafts('{').length,0)
 assert.equal(parseMaxExamDrafts(JSON.stringify([draft,draft,{...draft,id:'exam-second',date:'wrong'}])).length,1)
 assert.equal(parseMaxExamDrafts(JSON.stringify(Array.from({length:21},(_,index)=>({...draft,id:'exam-'+index})))).length,0)
 assert.equal(parseMaxExamDrafts('x'.repeat(400001)).length,0)
 const escaped=Array.from({length:20},(_,index)=>({...draft,id:'exam-'+index,note:'"'.repeat(8000)}))
 assert.equal(parseMaxExamDrafts(JSON.stringify(escaped)).length,20,'all individually valid maximum escaped notes survive a full store and reload')
})
test('unfinished wizard notes survive scratch parsing before a subject has been filled',()=>{
 const value=parseMaxExamScratch(JSON.stringify({step:0,draft:{...draft,subject:'',note:'Незавершений власний конспект'}}))
 assert.equal(value.step,0);assert.equal(value.draft.note,'Незавершений власний конспект');assert.equal(value.draft.subject,'')
 assert.equal(parseMaxExamScratch(JSON.stringify({step:4,draft})),null)
 const unfinished=parseMaxExamScratch(JSON.stringify({step:1,draft:{...draft,date:'',note:'Власний HTML-конспект: <p>Приклад</p>'}}))
 assert.equal(unfinished.draft.note,'Власний HTML-конспект: <p>Приклад</p>');assert.equal(unfinished.draft.date,'');assert.equal(normalizeMaxExamDraft(unfinished.draft),null,'draft content remains exportable while an invalid source cannot be sent to the model')
})
test('the exam prompt carries the user date, time and goal without claiming a predicted grade',()=>{
 const value=maxExamPrompt(draft)
 assert.match(value,/2026-12-01/);assert.match(value,/30 хвилин/);assert.match(value,/Зрозуміти головне/);assert.match(value,/лише обрані/);assert.match(value,/Не обіцяй оцінку/)
 assert.throws(()=>maxExamPrompt({...draft,id:'invalid'}))
})
test('progress counts only checked answers and actual completed task IDs, excludes synthetic demos and keeps zero-index answers',()=>{
 const run={id:'own-run',demo:false,bundle:{questions:[{id:'q0',correctIndex:0},{id:'q1',correctIndex:1},{id:'q2',correctIndex:2}],cards:[{id:'c0'},{id:'c1'}],plan:[{id:'day',tasks:['first','second']}]},progress:{answers:{q0:0,q1:0,q2:2},submitted:['q0','q1'],cardRatings:{c0:'known',c1:'repeat'},doneTasks:['day:0','foreign:1']}}
 const summary=maxStudySummary([run,{...run,id:'demo-run',demo:true}])
 assert.equal(summary.sessions,1);assert.equal(summary.checked,2);assert.equal(summary.correct,1);assert.equal(summary.mistakes.length,1);assert.equal(summary.mistakes[0].question.id,'q1');assert.equal(summary.tasksTotal,2);assert.equal(summary.tasksDone,1);assert.equal(summary.cardsKnown,1);assert.equal(summary.cardsRepeat,1)
 assert.equal(maxStudySummary([]).checked,0)
})
test('new study progress includes actual gap results and submitted written work without inventing an AI score',()=>{
 const run={id:'own-v2',demo:false,bundle:{version:2,questions:[],cards:[],plan:[],study:{gaps:[{id:'gap',before:'Це',after:'',acceptedAnswers:['Попит'],explanation:'Source',sourceId:'s'}],reading:[{id:'part'}],written:[{id:'written'}]}},progress:{answers:{},submitted:[],cardRatings:{},doneTasks:[],studyAnswers:{gap:'попит',written:'Власний розбір'},studySubmitted:['gap','written'],studyDone:['part']}}
 const summary=maxStudySummary([run]);assert.equal(summary.checked,1);assert.equal(summary.correct,1);assert.equal(summary.readDone,1);assert.equal(summary.writtenSubmitted,1);assert.equal(summary.writtenTotal,1);assert.equal('writtenScore' in summary,false)
})
