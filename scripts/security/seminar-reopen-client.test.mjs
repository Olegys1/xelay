// Current model/loader/RPC adapter with inert provider responses. No remote data.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync}from'node:fs'
import vm from'node:vm'
import ts from'typescript'
const read=name=>readFileSync(new URL('../../'+name,import.meta.url),'utf8')
const NOW=Date.parse('2026-10-30T10:00:00Z')
class Clock extends Date{constructor(...args){super(...(args.length?args:[NOW]))}static now(){return NOW}}
const id=n=>'aa000000-0000-4000-8000-'+String(n).padStart(12,'0')
const group=id(1),otherGroup=id(2),semId=id(3),pastId=id(4),slotId=id(5),subjectId=id(6),teamId=id(7)
const plain=v=>JSON.parse(JSON.stringify(v))
function load(source,imports={}){
 const module={exports:{}}
 vm.runInNewContext(ts.transpileModule(source,{fileName:'actual.ts',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  module,exports:module.exports,Date:Clock,Intl,URL,TextDecoder,TextEncoder,AbortController,DOMException,
  require:name=>{assert.ok(name in imports,'Unexpected dependency '+name);return imports[name]}
 })
 return module.exports
}
const seminar=(overrides={})=>({id:semId,group_id:group,subject_id:subjectId,schedule_id:slotId,lesson_date:'2026-10-30',starts_at:'08:00',ends_at:'09:20',
 title:'Synthetic seminar',instructions:'Existing instructions',format:'teams',created_by:id(8),resource_links:[],resource_attachments:[],selection_deadline_at:null,selection_version:0,...overrides})
const slot={id:slotId,group_id:group,subject_id:subjectId,weekday:5,starts_at:'08:00',ends_at:'09:20',valid_from:'2026-09-01',valid_until:'2027-08-31',created_by:id(8)}
function fixture(options={}){
 const calls=[],selections=[],profiles=[]
 const supabase={from(table){
  const q={}
  for(const method of['select','eq','order','in'])q[method]=(...args)=>{selections.push([table,method,...plain(args)]);return q}
  const result=()=>({data:table==='study_groups'?{supplement_capacity:3}:table==='study_group_seminar_subjects'?[{id:subjectId,group_id:group,name:'Synthetic subject',created_by:id(8)}]:
   table==='study_group_seminar_schedule'?[slot]:table==='study_group_seminars'?[seminar()]:[],error:options.tableError||null})
  q.single=async()=>result();q.then=resolve=>Promise.resolve(result()).then(resolve);return q
 },rpc:async(name,args)=>{
  calls.push([name,plain(args)])
  if(name==='xelay_open_seminar_selections')return{data:options.open??{seminars:[],schedule:[],occupancy:[]},error:options.openError||null}
  if(name==='xelay_seminar_streak')return{data:0,error:null}
  if(options.mutationError)return{data:null,error:options.mutationError}
  if(name==='xelay_set_seminar_selection_deadline')return{data:options.response??{seminar_id:args.p_seminar_id,selection_deadline_at:args.p_deadline||new Date(NOW).toISOString(),selection_version:args.p_expected_version+1},error:null}
  if(name==='xelay_create_seminar_team')return{data:options.response??{id:args.p_team_id,seminar_id:args.p_seminar_id,name:args.p_name,capacity:args.p_capacity,position:1},error:null}
  throw Error('Unexpected RPC '+name)
 }}
 const provider={'./supabase':{supabase}},times=load(read('src/lib/scheduleCopyTimes.ts'))
 const timetable=load(read('src/lib/studyGroupTimetable.ts'),{...provider,'./scheduleCopyTimes':times})
 const homework=load(read('src/lib/homeworkResources.ts'),provider)
 const resources=load(read('src/lib/seminarResources.ts'),{...provider,'./homeworkResources':homework})
 const api=load(read('src/lib/seminars.ts'),{...provider,'./profiles':{getPublicProfiles:async ids=>{profiles.push(ids);return{data:[],error:null}}},
  './seminarResources':resources,'./studyGroupTimetable':timetable,'./scheduleSubjects':load(read('src/lib/scheduleSubjects.ts'))})
 return{api,calls,selections,profiles}
}
test('selection deadline overrides only booking; original lesson history and exact closing boundary remain',()=>{
 const{api}=fixture(),past=seminar(),future=seminar({selection_deadline_at:'2026-10-31T18:00:00Z'})
 assert.equal(api.seminarHasStarted(past),true)
 assert.equal(api.seminarSelectionIsClosed(past),true)
 assert.equal(api.seminarSelectionIsClosed(future),false)
 assert.equal(api.seminarHasStarted(future),true,'Reopening cannot rewrite lesson chronology')
 const end=Date.parse(future.selection_deadline_at)
 assert.equal(api.seminarSelectionIsClosed(future,end-1),false);assert.equal(api.seminarSelectionIsClosed(future,end),true)
 assert.equal(api.seminarSelectionIsClosed(seminar({selection_deadline_at:'invalid'})),true)
 assert.equal(api.seminarSelectionIsClosed(seminar({selection_deadline_at:new Date(NOW).toISOString()})),true)
})
test('Kyiv local conversion roundtrips independently of the test host timezone and rejects invalid calendar/time input',()=>{
 const{api}=fixture(),local='2026-10-31T20:00',iso=api.seminarSelectionDeadlineFromLocal(local)
 assert.equal(api.seminarSelectionDeadlineLocalValue(iso),local)
 assert.notEqual(iso,'2026-10-31T20:00:00.000Z')
 for(const value of['2026-02-30T12:00','2026-10-31T24:00','2026-10-31T12:65','2026-10-31','bad','2026-10-31T12:00Z'])assert.throws(()=>api.seminarSelectionDeadlineFromLocal(value))
 assert.equal(api.seminarSelectionDeadlineLocalValue('bad'),'')
})
test('past reopened discovery remains group-scoped and never changes the selected-date question/reservation queries',async()=>{
 const reopened=seminar({id:pastId,lesson_date:'2026-10-01',selection_deadline_at:'2026-10-31T18:00:00Z',selection_version:2,
  resource_links:['https://example.test/notes','javascript:alert(1)']})
 const fx=fixture({open:{seminars:[reopened,{...reopened,id:id(9),group_id:otherGroup},{...reopened,id:id(10),selection_deadline_at:'2026-10-01T18:00:00Z'}],
  schedule:[slot,{...slot,id:id(11),group_id:otherGroup}],occupancy:[
   {seminar_id:pastId,question_id:null,team_id:teamId,role:'team',count:5},{seminar_id:id(9),question_id:null,team_id:teamId,role:'team',count:99},
   {seminar_id:pastId,question_id:null,team_id:teamId,role:'team',count:-1}]}})
 const data=await fx.api.loadSeminars(group,'2026-10-30')
 assert.deepEqual(Array.from(data.seminars,s=>s.id),[semId])
 assert.deepEqual(Array.from(data.reopened_seminars,s=>s.id),[pastId])
 assert.deepEqual(plain(data.reopened_seminars[0].resource_links),['https://example.test/notes'])
 assert.equal(data.reopened_schedule.length,1);assert.equal(data.selection_occupancy.length,1);assert.equal(data.selection_occupancy[0].count,5)
 for(const table of['study_group_seminar_questions','study_group_seminar_teams','study_group_seminar_reservations']){
  assert.deepEqual(fx.selections.find(row=>row[0]===table&&row[1]==='in')[3],[semId])
 }
 assert.equal(fx.calls.filter(([name])=>name==='xelay_open_seminar_selections').length,1)
 assert.match(fx.selections.find(row=>row[0]==='study_group_seminars'&&row[1]==='select')[2],/selection_deadline_at,selection_version/)
})
test('denied or malformed reopened metadata cannot be represented as successful data',async()=>{
 for(const options of[{openError:{code:'42501',message:'SEMINAR_MEMBER_REQUIRED'}},{open:{seminars:[],schedule:[]}},{open:{seminars:false,schedule:[],occupancy:[]}}]){
  const fx=fixture(options);await assert.rejects(fx.api.loadSeminars(group,'2026-10-30'));assert.equal(fx.profiles.length,0)
 }
})
test('deadline setter sends captured version and explicit close; failure/mismatched response stays an error',async()=>{
 const fx=fixture(),deadline='2026-10-31T18:00:00Z'
 await fx.api.setSeminarSelectionDeadline(group,semId,deadline,2)
 assert.deepEqual(fx.calls.at(-1),['xelay_set_seminar_selection_deadline',{p_group_id:group,p_seminar_id:semId,p_deadline:new Date(deadline).toISOString(),p_expected_version:2}])
 await fx.api.setSeminarSelectionDeadline(group,semId,null,3)
 assert.equal(fx.calls.at(-1)[1].p_deadline,null)
 for(const args of[[group,semId,'bad',0],[group,semId,'2026-10-01T18:00:00Z',0],[group,semId,deadline,-1]]){
  const bad=fixture();await assert.rejects(bad.api.setSeminarSelectionDeadline(...args));assert.equal(bad.calls.length,0)
 }
 const denied=fixture({mutationError:{code:'PT409',message:'SEMINAR_SELECTION_CONFLICT'}})
 await assert.rejects(denied.api.setSeminarSelectionDeadline(group,semId,deadline,2))
 assert.match(denied.api.seminarError({message:'SEMINAR_SELECTION_CONFLICT'}),/Оновіть/)
 await assert.rejects(fixture({response:false}).api.setSeminarSelectionDeadline(group,semId,deadline,2))
})
test('team creation keeps the supplied retry identity and validates shape without gaining manager parameters',async()=>{
 const fx=fixture()
 await fx.api.createSeminarTeam(group,semId,teamId,' Команда A ',5)
 await fx.api.createSeminarTeam(group,semId,teamId,' Команда A ',5)
 assert.deepEqual(fx.calls[0],fx.calls[1])
 assert.deepEqual(fx.calls[0],['xelay_create_seminar_team',{p_group_id:group,p_seminar_id:semId,p_team_id:teamId,p_name:'Команда A',p_capacity:5}])
 for(const [name,capacity]of[['',5],['x'.repeat(81),5],['x',0],['x',51],['x',1.5]]){
  const bad=fixture();await assert.rejects(bad.api.createSeminarTeam(group,semId,teamId,name,capacity));assert.equal(bad.calls.length,0)
 }
 await assert.rejects(fixture({response:{id:teamId,seminar_id:id(11),name:'A',capacity:5}}).api.createSeminarTeam(group,semId,teamId,'A',5))
})
