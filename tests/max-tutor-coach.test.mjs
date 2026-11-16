import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
const module={exports:{}}
const dispatched=[]
class FixtureEvent{constructor(type,options){this.type=type;this.detail=options.detail}}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/maxTutorCoach.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{module,exports:module.exports,Date,Math,JSON,Number,Set,Map,CustomEvent:FixtureEvent,window:{dispatchEvent:e=>dispatched.push(e)}})
const c=module.exports,plain=v=>JSON.parse(JSON.stringify(v)),scope={userId:'local-student',sessionId:'local-session'},other={userId:'other-student',sessionId:'other-session'},start=1_000_000
const enabled=()=>c.setCoachEnabled(c.createCoachState(scope),true)

test('awareness is opt-in and never responds to aggregate events before explicit enabling',()=>{
 const state=c.createCoachState(scope)
 assert.equal(state.enabled,false)
 for(const e of [{type:'block',block:'assistant'},{type:'ready',runId:'run-a',mode:'quiz'},{type:'quiz',runId:'run-a',total:5,answered:5,correct:3},{type:'plan',planId:'plan-a',done:0,total:4,dueAt:start}])assert.equal(c.reduceCoachEvent(state,e,start),state)
 assert.equal(c.advanceCoach(state,start),state)
 const on=c.reduceCoachEvent(enabled(),{type:'block',block:'assistant'},start);assert.equal(on.messages.length,1);assert.match(on.messages[0].body,/вибраним матеріалом/)
 const off=c.setCoachEnabled(on,false);assert.equal(off.messages.length,0);assert.equal(off.reminders.length,0)
})

test('aggregate allowlist rejects page text, source content, forged actions and invalid or foreign fields',()=>{
 const cases=[{type:'block',block:'__proto__'},{type:'block',block:'research',sourceText:'private notes'},{type:'ready',runId:'run-a',mode:'official-grading'},{type:'quiz',runId:'run-a',total:3,answered:2,correct:3},{type:'quiz',runId:'run-a',total:3,answered:2,correct:1,weakQuestionIds:['private','private']},{type:'quiz',runId:'run-a',total:3,answered:2,correct:2,weakQuestionIds:['foreign']},{type:'quiz',runId:'run-a',total:0,answered:0,correct:0},{type:'sources',count:101},{type:'sources',count:1,title:'Private course'},{type:'project',projectId:'x',done:5,total:4},{type:'plan',planId:'x',done:0,total:4,dueAt:Infinity},{type:'execute',command:'publish'}]
 for(const value of cases)assert.equal(c.normalizeCoachEvent(value),null,JSON.stringify(value))
 assert.equal(c.normalizeCoachScope({...scope,token:'secret'}),null)
 assert.equal(c.normalizeCoachScope({userId:'__proto__',sessionId:'session'}),null)
})

test('messages are deduplicated and ordinary nudges respect a cooldown while completion feedback stays immediate',()=>{
 let state=c.reduceCoachEvent(enabled(),{type:'block',block:'research'},start)
 assert.equal(c.reduceCoachEvent(state,{type:'block',block:'research'},start+150000),state)
 assert.equal(c.reduceCoachEvent(state,{type:'sources',count:2},start+1000),state)
 state=c.reduceCoachEvent(state,{type:'ready',runId:'own-run',mode:'quiz'},start+1001);assert.equal(state.messages.at(-1).title,'Твій тренувальний тест готовий.')
 state=c.reduceCoachEvent(state,{type:'quiz',runId:'own-run',total:5,answered:5,correct:3,weakQuestionIds:['q2','q4']},start+1002)
 const feedback=state.messages.at(-1);assert.match(feedback.body,/Правильно 3 із 5/);assert.match(feedback.body,/повторення: 2/);assert.equal(feedback.action,'mistakes')
 assert.equal(c.reduceCoachEvent(state,{type:'quiz',runId:'own-run',total:5,answered:5,correct:3},start+1003),state)
})

test('quiz feedback describes the actual counts and cannot infer ability, official marks or completed work',()=>{
 for(const correct of [0,3,5]){
  const state=c.reduceCoachEvent(enabled(),{type:'quiz',runId:'own-run',total:5,answered:5,correct},start),m=state.messages[0]
  assert.match(m.body,new RegExp(`Правильно ${correct} із 5`));assert.equal(m.action,correct===5?'cards':'mistakes');assert.doesNotMatch(m.body,/оцінка|не знаєш|отримаєш|неправильн.*джерел|гарант/)
 }
 assert.equal(c.reduceCoachEvent(enabled(),{type:'quiz',runId:'own-run',total:5,answered:1,correct:0},start).messages.length,0)
})

test('dismissal and snooze preserve learning data and produce one reminder only while the space is open',()=>{
 let state=c.reduceCoachEvent(enabled(),{type:'ready',runId:'own-run',mode:'quiz'},start),id=state.messages[0].id
 state=c.snoozeCoachMessage(state,id,start,10);assert.equal(state.messages.length,0);assert.equal(state.reminders.length,1)
 assert.equal(c.advanceCoach(state,start+599999),state)
 state=c.advanceCoach(state,start+600000);assert.equal(state.reminders.length,0);assert.equal(state.messages.length,1);assert.equal(state.messages[0].id,id)
 const unchanged=c.advanceCoach(state,start+600001);assert.equal(unchanged,state)
 state=c.dismissCoachMessage(state,id);assert.equal(state.messages.length,0);assert.equal(state.seen[id]!==undefined,true)
 assert.equal(c.reduceCoachEvent(state,{type:'ready',runId:'own-run',mode:'quiz'},start+700000),state)
 assert.deepEqual(Object.keys(state).sort(),['enabled','lastNudgeAt','messages','ownerId','pausedUntil','reminders','seen','sessionId','version'].sort())
})

test('pause suppresses reminders and incoming hints until it expires; completed plan never promises academic success',()=>{
 let state=c.reduceCoachEvent(enabled(),{type:'plan',planId:'own-plan',done:1,total:3,dueAt:start+1000},start)
 assert.equal(state.reminders.length,1);state=c.pauseCoach(state,start,60)
 assert.equal(c.advanceCoach(state,start+1000),state);assert.equal(c.reduceCoachEvent(state,{type:'ready',runId:'run-x',mode:'cards'},start+1000),state)
 state=c.advanceCoach(state,start+3600000);assert.equal(state.messages.length,1);assert.equal(state.reminders.length,0);assert.match(state.messages[0].body,/поки цей простір відкритий/)
 const finished=c.reduceCoachEvent(enabled(),{type:'plan',planId:'own-plan',done:3,total:3},start);assert.equal(finished.messages[0].action,'quiz');assert.match(finished.messages[0].body,/позначив 3 із 3/)
})

test('bounded owner/session storage does not hydrate another account, a changed session or malformed private state',()=>{
 let state=c.reduceCoachEvent(enabled(),{type:'quiz',runId:'own-run',total:5,answered:5,correct:3},start),raw=c.storeCoachState(state)
 assert.deepEqual(plain(c.parseCoachState(raw,scope,start)),plain(state))
 for(const target of [other,{...scope,sessionId:'new-session'}]){const out=c.parseCoachState(raw,target,start);assert.equal(out.enabled,false);assert.equal(out.messages.length,0);assert.equal(out.reminders.length,0)}
 assert.notEqual(c.coachStorageKey(scope),c.coachStorageKey(other))
 for(const input of ['{bad','x'.repeat(50001),JSON.stringify({...state,sourceText:'private'}),JSON.stringify({...state,pausedUntil:start+2*24*60*60*1000}),JSON.stringify({...state,seen:{constructor:start}})]){
  const out=c.parseCoachState(input,scope,start);assert.equal(out.messages.some(m=>m.body==='private'),false)
 }
})

test('history and reminder queues remain bounded and restored content cannot create arbitrary actions',()=>{
 let state=enabled();for(let i=0;i<100;i++)state=c.reduceCoachEvent(state,{type:'ready',runId:`run-${i}`,mode:'cards'},start+i)
 assert.equal(state.messages.length,4);assert.equal(Object.keys(state.seen).length,80)
 for(let i=0;i<10;i++)state=c.reduceCoachEvent(state,{type:'plan',planId:`plan-${i}`,done:0,total:3,dueAt:start+100000+i},start+i)
 assert.equal(state.reminders.length,6)
 const forged=plain(state);forged.messages[0].action='delete-grade';assert.equal(c.parseCoachState(JSON.stringify(forged),scope,start+100).messages.some(m=>m.action==='delete-grade'),false)
})

test('emitter sends only normalized events for an explicit owner/session and cannot deliver raw sources',()=>{
 dispatched.length=0
 assert.equal(c.sendMaxTutorCoachEvent(undefined,{type:'sources',count:1}),false)
 assert.equal(c.sendMaxTutorCoachEvent(scope,{type:'sources',count:1,text:'private'}),false)
 assert.equal(c.sendMaxTutorCoachEvent(scope,{type:'quiz',runId:'run-own',total:5,answered:5,correct:3}),true)
 assert.equal(dispatched.length,1);assert.equal(dispatched[0].type,c.MAX_TUTOR_COACH_EVENT);assert.deepEqual(plain(dispatched[0].detail.scope),scope)
 assert.equal(c.sameCoachScope(dispatched[0].detail.scope,other),false)
 assert.deepEqual(Object.keys(dispatched[0].detail.event).sort(),['answered','correct','runId','total','type'])
})

test('coach UI never invokes providers or scrapes content and offers manual controls and reduced-motion behavior',()=>{
 const ui=readFileSync(new URL('../src/components/student/MaxTutorCoach.tsx',import.meta.url),'utf8'),css=readFileSync(new URL('../src/components/student/maxTutorCoach.css',import.meta.url),'utf8')
 assert.doesNotMatch(ui,/\bfetch\(|supabase\.|querySelector|innerHTML|innerText|textContent|api\.openai|Notification\(|navigator\.serviceWorker|dangerouslySetInnerHTML/)
 assert.match(ui,/onAction\(action\)/);assert.match(ui,/sameCoachScope\(detail.scope,scope\)/);assert.match(ui,/Увімкнути підказки/);assert.match(ui,/Автоматична підказка/);assert.match(ui,/Пауза на годину/);assert.match(ui,/aria-live="polite"/);assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/@media\(max-width:650px\)/)
})


test('completed plans cancel pending reminders even during pause and changed quiz scores remove stale hints',()=>{
 let state=c.reduceCoachEvent(enabled(),{type:'plan',planId:'own-plan',done:1,total:3,dueAt:start+1000},start);state=c.pauseCoach(state,start,60);state=c.reduceCoachEvent(state,{type:'plan',planId:'own-plan',done:3,total:3},start+100);assert.equal(state.reminders.length,0);assert.equal(c.advanceCoach(state,start+3600000).messages.length,0)
 state=c.reduceCoachEvent(enabled(),{type:'quiz',runId:'own-run',total:5,answered:5,correct:3},start);state=c.snoozeCoachMessage(state,state.messages[0].id,start);state=c.reduceCoachEvent(state,{type:'quiz',runId:'own-run',total:5,answered:5,correct:5},start+100);assert.equal(state.reminders.length,0);assert.equal(state.messages.length,1);assert.match(state.messages[0].body,/Правильно 5 із 5/);assert.equal(c.advanceCoach(state,start+600000).messages.length,1)
})


test('personal session reminders open the real planner and unchanged progress cannot repeat by moving its due time',()=>{
 let state=c.reduceCoachEvent(enabled(),{type:'plan',planId:'session-econ',done:1,total:3,dueAt:start+1000},start);assert.equal(state.reminders[0].message.action,'session');const initialId=state.reminders[0].id
 state=c.reduceCoachEvent(state,{type:'plan',planId:'session-econ',done:1,total:3,dueAt:start+5000},start+100);assert.equal(state.reminders.length,1);assert.equal(state.reminders[0].id,initialId);assert.equal(state.reminders[0].dueAt,start+1000)
 state=c.advanceCoach(state,start+1000);assert.equal(state.messages.length,1);assert.equal(state.messages[0].action,'session');state=c.dismissCoachMessage(state,state.messages[0].id)
 state=c.reduceCoachEvent(state,{type:'plan',planId:'session-econ',done:1,total:3,dueAt:start+6000},start+5000);assert.equal(state.reminders.length,0);assert.equal(c.advanceCoach(state,start+6000).messages.length,0)
 state=c.reduceCoachEvent(state,{type:'plan',planId:'session-econ',done:2,total:3,dueAt:start+7000},start+6000);assert.equal(state.reminders.length,1);assert.notEqual(state.reminders[0].id,initialId);state=c.advanceCoach(state,start+7000);assert.equal(state.messages[0].action,'session');assert.match(state.messages[0].body,/2 із 3/)
 const generated=c.reduceCoachEvent(enabled(),{type:'plan',planId:'tutor-day-a',done:0,total:4,dueAt:start},start);assert.equal(generated.messages[0].action,'plan')
})
