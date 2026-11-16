import test from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
const module={exports:{}}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/studentSessionPlanner.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,Date,Number,Math,Set,Map,JSON})
const p=module.exports,today='2026-11-16'
test('multi-exam plan never exceeds daily capacity or allocates after exam and is reproducible',()=>{const state=p.initialSessionPlanner(today);const week=p.buildRevisionWeek(state,today);for(let d=0;d<7;d++){const date=p.shiftSessionDay(today,d);assert.ok(week.sessions.filter(s=>s.date===date).reduce((n,s)=>n+s.minutes,0)<=60)}for(const s of week.sessions){assert.ok(s.date<state.exams.find(e=>e.id===s.examId).date);assert.ok(s.minutes>0)}assert.equal(JSON.stringify(week),JSON.stringify(p.buildRevisionWeek(state,today)))})
test('combined workload overload and overdue exams are visible, not hidden by the schedule',()=>{const state=p.initialSessionPlanner(today);state.dailyMinutes=15;state.exams.forEach(e=>{e.date='2026-11-18';e.remainingMinutes=20});assert.ok(p.buildRevisionWeek(state,today).warnings.some(w=>w.startsWith('Разом')));state.exams[0].date=today;assert.equal(p.buildRevisionWeek(state,today).overdue.length,1)})
test('personal plan restores dates, daily capacity and per-session completion while rejecting corrupt records',()=>{const state=p.initialSessionPlanner(today);state.completed=['exam-micro:2026-11-16'];state.dailyMinutes=45;const restored=p.parseSessionPlanner(JSON.stringify(state),today);assert.deepEqual(JSON.parse(JSON.stringify(restored)),JSON.parse(JSON.stringify(state)));assert.equal(p.buildRevisionWeek(restored,today).completedCount,1);assert.equal(p.parseSessionPlanner('{',today).version,1);assert.equal(p.normalizePersonalExam({...state.exams[0],remainingMinutes:Infinity}),null);assert.equal(p.normalizePersonalExam({...state.exams[0],id:'__proto__'}),null)})
test('grade goal is arithmetic from manual data with impossible and already reached goals distinguished',()=>{assert.equal(p.gradeGoal(52,30,75,100).needed,23);assert.equal(p.gradeGoal(52,10,75,100).possible,false);assert.equal(p.gradeGoal(80,10,75,100).achieved,true);for(const args of [[NaN,1,2,3],[-1,10,5,10],[90,20,90,100],[10,10,101,100]])assert.throws(()=>p.gradeGoal(...args))})
test('calendar has only own all-day events and neutralizes text injection',()=>{const s=p.buildRevisionWeek(p.initialSessionPlanner(today),today).sessions.slice(0,1);s[0].subject='Тема\r\nBEGIN:VEVENT';const text=p.revisionCalendar(s,today);assert.equal((text.match(/^BEGIN:VEVENT$/gm)||[]).length,1);assert.ok(text.includes('DTSTART;VALUE=DATE:20261116'));assert.ok(text.includes('DTEND;VALUE=DATE:20261117'));assert.throws(()=>p.revisionCalendar([{...s[0],examId:'bad\nBEGIN:VEVENT'}],today))})

test('completed minutes from yesterday reduce later work and are never allocated or charged twice',()=>{
 const exam={id:'own-exam',subject:'Мій предмет',date:'2026-11-18',topics:['Тема'],remainingMinutes:40,priority:'normal'}
 const done={id:'own-exam:2026-11-15',examId:'own-exam',subject:'Мій предмет',date:'2026-11-15',minutes:20,topic:'Тема'}
 const state={version:1,dailyMinutes:60,exams:[exam],completed:[done.id],completedSessions:[done,done]}
 const restored=p.parseSessionPlanner(JSON.stringify(state),today)
 assert.equal(restored.completedSessions.length,1)
 const week=p.buildRevisionWeek(restored,today)
 assert.equal(week.totalMinutes,20)
 assert.equal(week.sessions.filter(s=>s.date===done.date).length,0)
 assert.ok(!week.warnings.length)
 const allDone={...restored,exams:[{...exam,remainingMinutes:20}]}
 assert.equal(p.buildRevisionWeek(allDone,today).totalMinutes,0)
 assert.ok(!p.buildRevisionWeek(allDone,today).warnings.length)
})

test('explicit work-ahead snapshots appear once and consume only remaining daily capacity',()=>{
 const exams=[{id:'exam-a',subject:'Предмет А',date:'2026-11-20',topics:['А'],remainingMinutes:20,priority:'normal'},{id:'exam-b',subject:'Предмет Б',date:'2026-11-20',topics:['Б'],remainingMinutes:40,priority:'normal'}]
 const done={id:'exam-a:2026-11-17',examId:'exam-a',subject:'Предмет А',date:'2026-11-17',minutes:20,topic:'А'}
 const state={version:1,dailyMinutes:30,exams,completed:[done.id],completedSessions:[done]}
 const week=p.buildRevisionWeek(state,today)
 assert.equal(week.sessions.filter(s=>s.id===done.id).length,1)
 assert.equal(week.sessions.filter(s=>s.examId==='exam-a').length,1)
 for(let i=0;i<7;i++){const day=p.shiftSessionDay(today,i);assert.ok(week.sessions.filter(s=>s.date===day).reduce((n,s)=>n+s.minutes,0)<=30)}
 assert.equal(week.totalMinutes,60)
 assert.equal(week.completedCount,1)
 const undone={...state,completed:[]}
 assert.equal(p.buildRevisionWeek(undone,today).completedCount,0)
})

test('completion snapshots reject foreign exams, mismatched IDs, invalid dates and minutes, and unmarked records',()=>{
 const base=p.initialSessionPlanner(today),valid={id:'exam-micro:2026-11-16',examId:'exam-micro',subject:'Мікроекономіка',date:today,minutes:20,topic:'Попит'}
 const bad=[{...valid,examId:'foreign',id:'foreign:2026-11-16'},{...valid,id:'exam-statistics:2026-11-16'},{...valid,date:'2026-02-31',id:'exam-micro:2026-02-31'},{...valid,minutes:0},{...valid,minutes:241},{...valid,minutes:NaN},{...valid,minutes:1.5},{...valid,subject:''}]
 for(const snapshot of bad)assert.equal(p.normalizeRevisionSession(snapshot,base.exams),null)
 const restored=p.parseSessionPlanner(JSON.stringify({...base,completed:[valid.id],completedSessions:[...bad,valid,valid]}),today)
 assert.equal(restored.completedSessions.length,1)
 const orphan=p.parseSessionPlanner(JSON.stringify({...base,completed:[],completedSessions:[valid]}),today)
 assert.equal(orphan.completedSessions.length,0)
 const legacy=p.parseSessionPlanner(JSON.stringify({...base,completed:['exam-micro:2026-11-15'],completedSessions:undefined}),today)
 assert.deepEqual(Array.from(legacy.completed),['exam-micro:2026-11-15'])
 assert.equal(legacy.completedSessions.length,0)
})

test('higher priority actually receives extra attention before rounding, without exceeding capacity',()=>{
 const exam={id:'attention',subject:'Важлива тема',date:'2026-11-24',topics:['Тема'],remainingMinutes:80,priority:'normal'}
 const state={version:1,dailyMinutes:120,exams:[exam],completed:[],completedSessions:[]}
 const normal=p.buildRevisionWeek(state,today),high=p.buildRevisionWeek({...state,exams:[{...exam,priority:'high'}]},today)
 assert.ok(high.sessions.find(s=>s.date===today).minutes>normal.sessions.find(s=>s.date===today).minutes)
 assert.ok(high.totalMinutes<=80)
})
