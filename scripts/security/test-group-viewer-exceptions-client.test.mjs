import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync}from'node:fs'
import vm from'node:vm'
import ts from'typescript'
import * as React from'react'
import * as jsx from'react/jsx-runtime'
import{renderToStaticMarkup}from'react-dom/server'
const root=new URL('../../',import.meta.url),read=file=>readFileSync(new URL(file,root),'utf8')
function load(source,imports={},globals={},fileName='actual.ts'){
 const module={exports:{}}
 vm.runInNewContext(ts.transpileModule(source,{fileName,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
  module,exports:module.exports,Date,Intl,URL,TextEncoder,TextDecoder,DOMException,structuredClone,queueMicrotask,...globals,
  require:name=>{if(typeof imports==='function')return imports(name);assert.ok(name in imports,'Known import '+name);return imports[name]}
 })
 return module.exports
}
const visibility=load(read('src/lib/studyGroupVisibility.ts'))
const viewers=['04f587f8-1604-4f53-aabc-d1699c938b1d','b6d61792-89c5-48af-ad52-73806352ae61']
const hidden=['437c96ae-19d1-4bed-ae69-0b83ae9ec1b4','445fcadc-95e2-4f8c-bfb3-6d0998030a01']
const ordinary='11111111-1111-4111-8111-111111111111',real='d54d0a4e-eb72-4ac4-8f5f-cc0bcc3bcab4'
const plain=v=>JSON.parse(JSON.stringify(v))
test('only the two verified account identities reveal hidden IDs; roles, names and ownership never substitute',()=>{
 assert.deepEqual(Array.from(visibility.TEST_STUDY_GROUP_VIEWER_IDS),viewers)
 for(const id of hidden){
  for(const viewer of viewers)assert.equal(visibility.isStudyGroupListed(id,viewer),true)
  for(const viewer of[ordinary,null,undefined,'ADMIN','mmv04','oleh_plietnikov',{id:viewers[0]},'00000000-0000-4000-8000-000000000001'])assert.equal(visibility.isStudyGroupListed(id,viewer),false)
 }
 assert.equal(visibility.isStudyGroupListed(' '+hidden[0].toUpperCase()+' ',' '+viewers[0].toUpperCase()+' '),true)
 for(const viewer of[...viewers,ordinary,null])assert.equal(visibility.isStudyGroupListed(real,viewer),true)
})
function renderGroups(actor){
 const request={id:'existing-request',status:'approved',group_name:'ооо 1'}
 const groups={
  [hidden[0]]:{id:hidden[0],representative_id:actor,representative_request_id:request.id,group_name:'ооо 1'},
  [hidden[1]]:{id:hidden[1],representative_id:actor,group_name:'Тестова ЕУБ-4'},
  [real]:{id:real,representative_id:ordinary,group_name:'Справжня ЕУБ-4'}
 }
 const memberships=[{id:'accepted-test',user_id:actor,group_id:hidden[0],status:'accepted'},
  {id:'pending-test',user_id:actor,group_id:hidden[1],status:'pending'},{id:'real',user_id:actor,group_id:real,status:'accepted'}]
 const state=[false,false,'',request,memberships,groups,''];let hook=0
 const hooks={...React,useState:initial=>[hook<state.length?state[hook++]:typeof initial==='function'?initial():initial,()=>{}],useRef:current=>({current}),useCallback:fn=>fn,useEffect:()=>{}}
 const api=load(read('src/pages/StudyGroupsPage.tsx'),name=>{
  if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsx
  if(name==='@tanstack/react-router')return{useNavigate:()=>()=>{}}
  if(name==='lucide-react')return new Proxy({},{get:()=>()=>null})
  if(name==='../context/AuthContext')return{useAuth:()=>({authUser:{id:actor},xelayUser:{studyGroupRepresentativeStatusSource:'legacy'}})}
  if(name==='../context/ToastContext')return{useToast:()=>({notify:()=>{}})}
  if(name==='../lib/studyGroupVisibility')return visibility
  if(name==='../lib/studyGroupIdentity')return{studyGroupIdentityLabel:()=> '1 курс'}
  if(name==='../components/StudyGroupCourseCard')return{StudyGroupCourseCard:props=>jsx.jsx('div',{'data-create':props.applicationId,'data-group':props.groupId})}
  if(name==='../components/halloween/HalloweenPumpkin')return{HalloweenPumpkin:()=>null}
  return{}
 },{},'actual.tsx')
 return renderToStaticMarkup(jsx.jsx(api.StudyGroupsPage,{}))
}
test('actual My Groups shows own accepted/pending test groups only to the two allowed viewers',()=>{
 for(const viewer of viewers){const html=renderGroups(viewer);assert.match(html,/ооо 1/);assert.match(html,/Тестова ЕУБ-4/);assert.match(html,/Справжня ЕУБ-4/);assert.doesNotMatch(html,/data-create=/)}
 const html=renderGroups(ordinary);assert.doesNotMatch(html,/ооо 1|Тестова ЕУБ-4|Запрошення до групи/);assert.match(html,/Справжня ЕУБ-4/)
})
function quickAccess(){
 const saved=new Map()
 const groups=[...hidden,real].map(id=>({id,group_name:id,specialty:'Synthetic programme',cohort_start_year:2026,study_level:'bachelor'}))
 const api=load(read('src/lib/groupQuickAccess.ts'),{
  './supabase':{supabase:{from(table){const q={};for(const name of['select','eq','in','is','abortSignal'])q[name]=()=>q;q.then=resolve=>Promise.resolve({data:table==='study_group_members'?groups.map(row=>({group_id:row.id})):groups,error:null}).then(resolve);return q}}},
  './studyGroupIdentity':{studyGroupIdentityLabel:()=> '1 курс'},'./studyGroupVisibility':visibility
 },{localStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}})
 return api
}
test('quick-access choices and preferences use the current viewer and never carry the exception into another account',async()=>{
 const api=quickAccess()
 for(const actor of[...viewers,ordinary]){
  const options=await api.loadScheduleQuickAccess(actor,new AbortController().signal)
  assert.deepEqual(Array.from(options,row=>row.id).sort(),(viewers.includes(actor)?[...hidden,real]:[real]).sort())
  assert.equal(api.saveGroupQuickAccess(actor,'schedule',hidden[0]),viewers.includes(actor))
  assert.equal(api.readGroupQuickAccess(actor,'schedule'),viewers.includes(actor)?hidden[0]:null)
 }
})
function offlineList(actor){
 const owner={id:actor,displayName:'Synthetic viewer',sessionId:'synthetic-session-123456789'}
 const now=Date.now(),rows=[...hidden,real].map(groupId=>({key:actor+':'+groupId,schemaVersion:1,ownerId:actor,sessionId:owner.sessionId,groupId,groupName:groupId,
  rangeStart:'2026-10-30',rangeEnd:'2026-11-01',savedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+86400000).toISOString(),lessons:[],homework:[],assignments:[]}))
 const database={close(){},transaction(){
  let pending=0,settled=false
  const tx={abort(){settled=true;tx.onabort?.()},objectStore(name){return{get:key=>request(name==='meta'?owner:rows.find(row=>row.key===key)),getAll:()=>request(rows),delete(){throw Error('Valid rows must not be deleted')}}}}
  function request(value){pending++;const request={};queueMicrotask(()=>{request.result=structuredClone(value);request.onsuccess?.();pending--;if(!pending)queueMicrotask(()=>{if(!pending&&!settled){settled=true;tx.oncomplete?.()}})});return request}
  return tx
 }}
 const indexedDB={open(){const request={};queueMicrotask(()=>{request.result=database;request.onsuccess?.()});return request}}
 return load(read('src/lib/offlineStudy.ts'),{'./studyGroupVisibility':visibility},{indexedDB,localStorage:{length:0,key:()=>null}})
}
test('offline list uses its verified owner receipt, and another requested account receives no snapshots',async()=>{
 for(const actor of[...viewers,ordinary]){
  const offline=offlineList(actor)
  assert.deepEqual(Array.from(await offline.listOfflineGroups(actor),row=>row.groupId).sort(),(viewers.includes(actor)?[...hidden,real]:[real]).sort())
  assert.deepEqual(plain(await offline.listOfflineGroups('22222222-2222-4222-8222-222222222222')),[])
 }
})
test('home learning loader lists the exception only within pre-existing ownership or accepted membership',async()=>{
 const noProvider={supabase:{from(){throw Error('Unexpected provider')},rpc(){throw Error('Unexpected provider')}}}
 const model=load(read('src/lib/homeDashboardModel.ts'))
 const times=load(read('src/lib/scheduleCopyTimes.ts'))
 const timetable=load(read('src/lib/studyGroupTimetable.ts'),{'./supabase':noProvider,'./scheduleCopyTimes':times})
 const links=load(read('src/lib/studyGroupLinks.ts'))
 const conference=load(read('src/lib/homeLessonConference.ts'),{'./studyGroupLinks':links,'./homeDashboardModel':model})
 const api=load(read('src/lib/homeDashboardRepository.ts'),{'./supabase':noProvider,'./homeDashboardModel':model,
  './studyGroupScheduleRead':{loadStudyGroupScheduleHistory(){throw Error('Unexpected default source')}},'./studyGroupTimetable':timetable,'./homeLessonConference':conference,'./studyGroupVisibility':visibility})
 for(const actor of[...viewers,ordinary]){
  const source={assertActor:async id=>assert.equal(id,actor),access:async()=>({groups:[...hidden,real].map(id=>({id,group_name:id,representative_id:actor,specialty:'Synthetic',cohort_start_year:2026,study_level:'bachelor'})),memberships:[],deputies:[]}),
   schedule:async()=>[],homework:async()=>[],materials:async()=>[],teachingGroup:async()=>({courses:[],assignments:[],materials:[],grades:[],pending_invites:[]})}
  const data=await api.loadLearningHomeDashboard({userId:actor,clockIso:'2026-10-30T09:00:00Z',source})
  assert.deepEqual(Array.from(data.groups,row=>row.id).sort(),(viewers.includes(actor)?[...hidden,real]:[real]).sort())
  const revoked={...source,access:async()=>({groups:hidden.map(id=>({id,group_name:id,representative_id:ordinary,specialty:'Synthetic',cohort_start_year:2026,study_level:'bachelor'})),memberships:[],deputies:[]})}
  if(viewers.includes(actor))assert.equal((await api.loadLearningHomeDashboard({userId:actor,clockIso:'2026-10-30T09:00:00Z',source:revoked})).groups.length,0)
 }
})
