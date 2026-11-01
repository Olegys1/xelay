import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as electives from '../../src/lib/studentElectiveTimetable.ts'
const {normalizeStudentElectiveMeetings,normalizeStudentElectivePlan,projectStudentElectiveTimetable:project,studentElectiveSetupState:state,studentElectiveConflictDates:conflicts,validateStudentElectiveTerm}=electives
const id=n=>`60000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const USER=id(1),OTHER=id(2),GROUP=id(10),FOREIGN=id(11),FROM='2026-11-02',UNTIL='2027-01-31'
const meeting=(patch={})=>({id:id(30),subject:'Особистий вибірковий курс',weekday:3,starts_at:'10:00',ends_at:'11:20',lesson_type:'lecture',teacher_name:'',location:'',online_url:null,online_url_secondary:null,online_links_extra:[],conference_id:null,conference_access_code:null,week_pattern:'every',week_anchor_date:null,...patch})
const plan=(patch={})=>({id:id(20),user_id:USER,group_id:GROUP,valid_from:FROM,valid_until:UNTIL,configured:true,version:1,lessons:normalizeStudentElectiveMeetings([meeting()]),...patch})
const shared=(patch={})=>({id:id(40),group_id:GROUP,weekday:2,starts_at:'14:00',ends_at:'15:20',subject:'Вибіркові дисципліни',lesson_type:'other',location:'',online_url:null,valid_from:FROM,valid_until:UNTIL,created_by:id(3),week_pattern:'every',week_anchor_date:null,is_elective_block:true,...patch})
const denied=operation=>assert.throws(operation,error=>/STUDENT_ELECTIVE|Посилання|посилання|конференц/.test(error.message))

test('normalization preserves explicit personal data while validating plain text, links and conference access',()=>{
 const result=normalizeStudentElectiveMeetings([meeting({subject:'  Мій   вибір  ',online_url:'https://example.com',teacher_name:'  Ірина  ',conference_id:' 123 456 ',conference_access_code:' код ',online_links_extra:[{url:'https://example.com/extra',label:' Резерв '}],week_pattern:'upper',week_anchor_date:FROM})])[0]
 assert.equal(result.subject,'Мій вибір');assert.equal(result.online_url,'https://example.com/');assert.equal(result.teacher_name,'Ірина')
 assert.equal(result.conference_id,'123 456');assert.equal(result.conference_access_code,'код');assert.deepEqual(result.online_links_extra,[{url:'https://example.com/extra',label:'Резерв'}])
 assert.equal(result.week_anchor_date,FROM)
 for(const patch of [{subject:''},{subject:'x'.repeat(121)},{teacher_name:'a\u202eb'},{location:'x\ncode'},{online_url:'javascript:alert(1)'},{online_url:'https://user:password@example.com/'},{conference_id:'secret\u0000'},{online_links_extra:[{url:'https://example.com',label:'x',extra:true}]}])denied(()=>normalizeStudentElectiveMeetings([meeting(patch)]))
})

test('a personal plan has bounded valid calendar fields, unique meeting IDs and no extra write capabilities',()=>{
 assert.equal(normalizeStudentElectivePlan(plan()).lessons.length,1)
 for(const patch of [{id:'bad'},{weekday:0},{weekday:8},{weekday:2.5},{starts_at:'24:00'},{starts_at:'10:00:30'},{ends_at:'09:00'},{lesson_type:'elective'},{week_pattern:'other'},{week_pattern:'upper',week_anchor_date:'2026-11-03'},{week_pattern:'lower',week_anchor_date:'2026-02-31'},{group_id:FOREIGN},{user_id:OTHER},{scheduleId:id(50)}])denied(()=>normalizeStudentElectiveMeetings([meeting(patch)]))
 denied(()=>normalizeStudentElectiveMeetings([meeting(),meeting()]))
 denied(()=>normalizeStudentElectiveMeetings(Array.from({length:21},(_,i)=>meeting({id:id(100+i)}))))
 for(const [from,until]of [['2026-02-31',UNTIL],[FROM,'2026-11-01'],['2026-01-01','2027-01-03'],['1999-09-01','2000-01-31']])denied(()=>validateStudentElectiveTerm(from,until))
 assert.doesNotThrow(()=>validateStudentElectiveTerm('2028-02-29','2028-06-30'))
})

test('student choices replace all flagged blocks of the configured term only in that owner group',()=>{
 const timetable=[shared(),shared({id:id(41),weekday:3}),shared({id:id(42),is_elective_block:false,subject:'Обов’язкова дисципліна',weekday:3,starts_at:'08:30',ends_at:'09:50'})],choices=[plan()]
 const before=structuredClone({timetable,choices})
 assert.equal(project(timetable,choices,USER,GROUP,'2026-11-03').length,0)
 const own=project(timetable,choices,USER,GROUP,'2026-11-04')
 assert.deepEqual(own.map(row=>row.subject),['Обов’язкова дисципліна','Особистий вибірковий курс'])
 assert.equal(own[1].source_kind,'personal-elective');assert.equal(own[1].personal_elective_id,id(30));assert.equal(own[1].id,id(30));assert.equal(own[1].source_schedule_id,undefined)
 assert.equal(project(timetable,choices,OTHER,GROUP,'2026-11-03')[0].id,id(40))
 assert.equal(project(timetable,choices,USER,FOREIGN,'2026-11-04').length,0)
 assert.deepEqual({timetable,choices},before)
})

test('a newly added generic block in the same term reuses the one existing personal plan without duplicates',()=>{
 const timetable=[shared(),shared({id:id(41),weekday:3}),shared({id:id(42),weekday:3,starts_at:'16:00',ends_at:'17:20'})]
 const own=project(timetable,[plan()],USER,GROUP,'2026-11-04')
 assert.equal(own.length,1);assert.equal(own[0].id,id(30));assert.equal(state(timetable,[plan()],USER,GROUP,'2026-11-04').needsSetup,false)
})

test('unconfigured, disabled, expired, foreign and overlapping plans retain the authoritative group schedule',()=>{
 const timetable=[shared()]
 for(const choices of [[],[plan({configured:false})],[plan({user_id:OTHER})],[plan({group_id:FOREIGN})],[plan({valid_until:'2026-11-02'})],[plan(),plan({id:id(21)})]]){
   const result=project(timetable,choices,USER,GROUP,'2026-11-03')
   assert.equal(result.length,1);assert.equal(result[0].id,id(40));assert.equal(result[0].source_kind,undefined)
 }
 const notMarked=[shared({is_elective_block:false})]
 assert.equal(state(notMarked,[plan()],USER,GROUP,'2026-11-04').configured,false)
 assert.deepEqual(project(notMarked,[plan()],USER,GROUP,'2026-11-04'),[])
 assert.equal(state(timetable,[],USER,GROUP,'2026-11-03').needsSetup,true)
})

test('personal recurrence respects upper/lower weeks and DST without inheriting shared links or homework identifiers',()=>{
 const timetable=[shared({online_url:'https://example.com/shared',conference_id:'SHARED'})],choices=[plan({lessons:normalizeStudentElectiveMeetings([meeting({week_pattern:'upper',week_anchor_date:FROM,online_url:'https://example.com/personal'})])})]
 const upper=project(timetable,choices,USER,GROUP,'2026-11-04')
 assert.equal(upper.length,1);assert.equal(upper[0].online_url,'https://example.com/personal');assert.equal(upper[0].conference_id,null);assert.equal(upper[0].copied_from_schedule_id,undefined)
 assert.equal(project(timetable,choices,USER,GROUP,'2026-11-11').length,0)
 const spring=[plan({valid_from:'2027-03-01',valid_until:'2027-04-30',lessons:normalizeStudentElectiveMeetings([meeting({weekday:7})])})]
 const source=[shared({valid_from:'2027-03-01',valid_until:'2027-04-30'})]
 assert.equal(project(source,spring,USER,GROUP,'2027-03-28')[0].starts_at,'10:00')
})

test('self-conflict checks consider actual alternating occurrences and allow adjacent lessons',()=>{
 const first=meeting(),overlap=meeting({id:id(31),starts_at:'11:00',ends_at:'12:20'})
 assert.ok(conflicts([first,overlap],FROM,UNTIL).includes('2026-11-04'))
 assert.deepEqual(conflicts([first,meeting({id:id(31),starts_at:'11:20',ends_at:'12:40'})],FROM,UNTIL),[])
 assert.deepEqual(conflicts([meeting({week_pattern:'upper',week_anchor_date:FROM}),meeting({id:id(31),week_pattern:'lower',week_anchor_date:FROM})],FROM,UNTIL),[])
})

test('server codes and domain messages both retain specific non-retrying error guidance',()=>{
 assert.match(electives.studentElectiveError({code:'40001',message:'Synthetic conflict'}),/Налаштування вже змінилися/)
 assert.match(electives.studentElectiveError({code:'P0001',message:'STUDENT_ELECTIVE_CONFLICT'}),/Налаштування вже змінилися/)
 assert.match(electives.studentElectiveError({code:'42501',message:'Synthetic denial'}),/Доступ до акаунта/)
 assert.match(electives.studentElectiveError({name:'AbortError',message:'Synthetic abort'}),/Збереження скасовано/)
 assert.match(electives.studentElectiveError({code:'P0001',message:'STUDENT_ELECTIVE_BLOCK_REQUIRED'}),/ще не позначив/)
})

test('normal shared calendar projection stays equivalent to existing recurrence helpers, including long validity dates',()=>{
 const source=readFileSync(new URL('../../src/lib/studyGroupTimetable.ts',import.meta.url),'utf8')
 const module={exports:{}}
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require(name){if(name==='./supabase')return{supabase:{}};if(name==='./scheduleCopyTimes')return{DEFAULT_TIMETABLE_SLOTS:[],firstShiftSlotTime(){},scheduleCopyClockMinutes(){}};throw Error('Unexpected import '+name)}})
 const occurs=module.exports.scheduleOccursOnDate
 for(const pattern of ['every','upper','lower'])for(const date of ['2026-10-27','2026-11-03','2026-11-10','2026-11-17']){
   const row=shared({is_elective_block:false,valid_from:'1900-01-01',valid_until:'2199-12-31',week_pattern:pattern,week_anchor_date:FROM})
   assert.equal(project([row],[],USER,GROUP,date).length,occurs(row,date)?1:0)
 }
})
