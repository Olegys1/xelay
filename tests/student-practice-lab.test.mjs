import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import {readFileSync} from 'node:fs'
const module={exports:{}}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/studentPracticeLab.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,Date,Map,Set,JSON,Number,Object,Array,String,Math})
const {validatePracticeQuestion,initialPracticeLabState,importPracticeQuestions,exportPracticeQuestions,mergePracticeQuestions,startPracticeAttempt,answerPracticeQuestion,scorePracticeAttempt,finishPracticeAttempt,parsePracticeLabState,practiceSecondsRemaining,preparePracticeStorage}=module.exports
const plain=v=>JSON.parse(JSON.stringify(v))
const q=(id='q1',patch={})=>({id,subject:'Економіка',topic:'Попит',prompt:'Що змінює величину попиту?',options:['Ціна','Назва товару'],correct:0,explanation:'За інших рівних умов — ціна.',...patch})
const now=1_800_000_000_000

test('manual questions require2–6 distinct options, valid keys and bounded safe identifiers',()=>{
 assert.equal(validatePracticeQuestion(q()).correct,0)
 for(const patch of [{id:'__proto__'},{id:'constructor'},{subject:''},{prompt:'x'.repeat(2001)},{options:['a','a']},{options:['a']},{options:['a','b'],correct:2},{correct:-1},{explanation:'x'.repeat(2001)},{execute:'bad'}]) assert.throws(()=>validatePracticeQuestion(q('q1',patch)))
 const text=q('q2',{prompt:'<img src=x onerror=alert(1)>','explanation':'Текст <b> не виконується'})
 assert.equal(validatePracticeQuestion(text).prompt,text.prompt)
})
test('JSON import/export preserves text and answer keys without executable content',()=>{
 const questions=[q('q1',{prompt:'Рядок\n"у лапках"',explanation:'<script>text only</script>'}),q('q2',{topic:'Пропозиція',correct:1})]
 assert.deepEqual(plain(importPracticeQuestions(exportPracticeQuestions(questions,'json'),'json')),questions)
 const withoutId=q();delete withoutId.id
 assert.match(importPracticeQuestions(JSON.stringify([withoutId]),'json')[0].id,/^import-/)
 assert.throws(()=>importPracticeQuestions('{bad','json'))
 assert.throws(()=>importPracticeQuestions(JSON.stringify({format:'xelay-practice-v1',questions,code:'run'}),'json'))
 assert.throws(()=>importPracticeQuestions(JSON.stringify([q(),q()]),'json'))
 assert.throws(()=>importPracticeQuestions(JSON.stringify([]),'json'))
})
test('CSV parser supports quoted commas, embedded newlines and six answers with1based correct field',()=>{
 const question=q('q1',{prompt:'Два, слова\nз "лапками"',options:['Один','Два, три','Чотири','П’ять','Шість','Сім'],correct:5})
 const rows=importPracticeQuestions(exportPracticeQuestions([question],'csv'),'csv')
 assert.deepEqual(plain({...rows[0],id:'q1'}),question)
 for(const raw of ['bad,headers\nx,y','subject,topic,question,option1,option2,option3,option4,option5,option6,correct,explanation\na,b,c,d,e,,,,,0,x','subject,topic,question,option1,option2,option3,option4,option5,option6,correct,explanation\n"unclosed'])assert.throws(()=>importPracticeQuestions(raw,'csv'))
})
test('spreadsheet export neutralizes formula-leading cells; losslessJSON remains available',()=>{
 const csv=exportPracticeQuestions([q('q1',{prompt:'=SUM(A1:A5)',options:['+RUN','@RUN']})],'csv')
 assert.ok(csv.includes('"\'=SUM(A1:A5)"'))
 assert.ok(csv.includes('"\'+RUN"'))
 assert.equal(importPracticeQuestions(exportPracticeQuestions([q('q1',{prompt:'=SUM(A1:A5)'})],'json'),'json')[0].prompt,'=SUM(A1:A5)')
})
test('repeated imports add no duplicate chances/questions and collisions fail without mutation',()=>{
 const existing=[q('q1')]
 assert.equal(mergePracticeQuestions(existing,[q('foreign-id')]).length,1)
 assert.throws(()=>mergePracticeQuestions(existing,[q('q1',{prompt:'Інше питання'})]))
 assert.equal(existing.length,1)
 assert.equal(mergePracticeQuestions(existing,[q('q2',{prompt:'Інше питання'})]).length,2)
 assert.throws(()=>importPracticeQuestions('x'.repeat(1_000_001),'json'))
 assert.throws(()=>importPracticeQuestions(JSON.stringify(Array.from({length:201},(_,i)=>q(`q${i}`))),'json'))
})
test('an attempt snapshots questions, shuffles only valid random values and ignores later bank edits',()=>{
 const questions=[q('q1'),q('q2',{correct:1})]
 const attempt=startPracticeAttempt(questions,'practice',now,'attempt1',20,()=>0,true)
 assert.equal(attempt.questions[0].id,'q2')
 questions[0].options[0]='Змінено';questions[0].correct=1
 assert.equal(attempt.questions[1].options[0],'Ціна')
 assert.equal(attempt.questions[1].correct,0)
 assert.throws(()=>startPracticeAttempt([q(),q()],'practice',now,'attempt1'))
 assert.throws(()=>startPracticeAttempt([q(),q('q2')],'practice',now,'attempt1',20,()=>1,true))
})
test('timer uses a durable absolute deadline; late answers and closed edits are rejected exactly',()=>{
 const attempt=startPracticeAttempt([q()],'exam',now,'attempt1',1)
 assert.equal(practiceSecondsRemaining(attempt,now),60)
 assert.equal(practiceSecondsRemaining(attempt,now+59001),1)
 assert.equal(practiceSecondsRemaining(attempt,now+60000),0)
 assert.equal(answerPracticeQuestion(attempt,'q1',0,now+60000),attempt)
 const answered=answerPracticeQuestion(attempt,'q1',0,now+59999)
 assert.equal(answered.answers.q1,0)
 assert.equal(answerPracticeQuestion(attempt,'__proto__',0,now),attempt)
 assert.equal(answerPracticeQuestion(attempt,'q1',-1,now),attempt)
 assert.equal(answerPracticeQuestion(attempt,'q1',0,now-1),attempt)
})
test('completion is idempotent, keeps highest and low attempts separately and preserves snapshot feedback',()=>{
 let state=initialPracticeLabState([q()]);state.current=startPracticeAttempt(state.questions,'practice',now,'attempt1')
 state.current=answerPracticeQuestion(state.current,'q1',0,now+10)
 const done=finishPracticeAttempt(state,now+100)
 assert.equal(scorePracticeAttempt(done.current).percent,100)
 assert.equal(done.history.length,1)
 assert.equal(finishPracticeAttempt(done,now+200),done)
 assert.equal(answerPracticeQuestion(done.current,'q1',1,now+150),done.current)
 const second=finishPracticeAttempt({...done,current:startPracticeAttempt(state.questions,'practice',now+1000,'attempt2')},now+2000)
 assert.equal(second.history.length,2)
 assert.equal(scorePracticeAttempt(second.history[0]).percent,0)
 assert.equal(scorePracticeAttempt(second.history[1]).percent,100)
})
test('refresh restores current answers, deadline and history; timeout completion caps timestamp atdeadline',()=>{
 let state=initialPracticeLabState([q()]);state.current=startPracticeAttempt(state.questions,'exam',now,'attempt1',1)
 state.current=answerPracticeQuestion(state.current,'q1',0,now+10)
 const restored=parsePracticeLabState(JSON.stringify(state),[])
 assert.deepEqual(plain(restored),plain(state))
 const done=finishPracticeAttempt(restored,now+90000)
 assert.equal(done.current.submittedAt,now+60000)
 assert.equal(done.history.length,1)
 assert.equal(scorePracticeAttempt(done.current).correct,1)
})
test('storage recovers safely from corrupt, excessive, foreign and prototype-shaped data',()=>{
 for(const raw of ['{bad','x'.repeat(3_000_001),JSON.stringify({version:9,questions:[]}),JSON.stringify({version:1,questions:[q('__proto__')]})])assert.equal(parsePracticeLabState(raw,[q()]).questions.length,1)
 const attempt=startPracticeAttempt([q()],'exam',now,'attempt1',1)
 attempt.answers=JSON.parse('{"__proto__":1,"q1":99}')
 const restored=parsePracticeLabState(JSON.stringify({version:1,questions:[q()],current:attempt,history:[]}),[])
 assert.deepEqual(plain(restored.current.answers),{})
 assert.equal(Object.prototype.polluted,undefined)
 const bad=parsePracticeLabState(JSON.stringify({version:1,questions:[q()],current:{...attempt,deadline:now-1},history:[]}),[])
 assert.equal(bad.current,null)
})
test('bounded storage preserves bank/current/latest result, omits duplicate snapshot and trims oldest history explicitly',()=>{
 let state=initialPracticeLabState([q()])
 for(let i=0;i<8;i++){state.current=startPracticeAttempt(state.questions,'practice',now+i*1000,`attempt${i}`);state=finishPracticeAttempt(state,now+i*1000+10)}
 const original=JSON.stringify(state)
 const compact=preparePracticeStorage(state,2000)
 assert.ok(compact.json.length<=2000)
 assert.ok(compact.dropped>0)
 assert.equal(compact.retainedHistoryIds[0],'attempt7')
 const restored=parsePracticeLabState(compact.json)
 assert.equal(restored.current.id,'attempt7')
 assert.equal(restored.history[0].id,'attempt7')
 assert.deepEqual(plain(restored.questions),plain(state.questions))
 assert.equal(JSON.stringify(state),original)
 assert.throws(()=>preparePracticeStorage(state,10))
})
