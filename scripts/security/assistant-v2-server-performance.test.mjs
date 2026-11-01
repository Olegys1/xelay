import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {EventEmitter} from 'node:events'
import {createSupabaseAssistantReadRepository,verifySupabaseAssistantSession} from '../../server/assistant-v2/supabaseReadRepository.ts'
import {createAuthenticatedAssistantReadService} from '../../server/assistant-v2/authenticatedRead.ts'
import {createAssistantCloudHandler} from '../../server/assistant-v2/cloudHandler.ts'
const uid=n=>`63000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const USER=uid(1),HEAD=uid(2),GROUP=uid(100),NOW=Date.parse('2026-11-02T10:00:00Z')
const TOKEN=['head',Buffer.from(JSON.stringify({sub:USER,role:'authenticated',exp:Math.floor(NOW/1000)+3600,session_id:'performance-test'})).toString('base64url'),'synthetic-signature'].join('.')
function fixture({groups=3,delayMs=0,seed=true}={}){
 const state={operations:[],active:0,maximumActive:0,banned:false,removed:false,after:null}
 const tables={study_group_members:Array.from({length:groups},(_,i)=>({id:uid(10+i),group_id:uid(100+i),user_id:USER,status:'accepted'})),study_groups:Array.from({length:groups},(_,i)=>({id:uid(100+i),representative_id:HEAD,group_name:'Synthetic '+i,specialty:'Synthetic',cohort_start_year:2026,study_level:'bachelor'})),study_group_deputy_requests:[],study_group_seminar_subjects:Array.from({length:groups},(_,i)=>({id:uid(200+i),group_id:uid(100+i),name:'Synthetic subject'})),study_group_material_subjects:Array.from({length:groups},(_,i)=>({id:uid(300+i),group_id:uid(100+i),name:'Synthetic materials'})),study_group_schedule:[{id:uid(400),group_id:GROUP,weekday:1,subject:'Synthetic subject',starts_at:'08:30:00',ends_at:'09:50:00',lesson_type:'lecture',location:'',valid_from:'2026-09-01',valid_until:'2027-01-31',week_pattern:'every',week_anchor_date:null,excluded_dates:[],updated_at:'2026-11-01T10:00:00Z'}],study_group_homework:[]}
 async function operation(kind,name,value){state.operations.push({kind,name});state.active++;state.maximumActive=Math.max(state.maximumActive,state.active);try{if(delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));state.after?.({kind,name});return value()}finally{state.active--}}
 class Query{
  constructor(table){this.table=table;this.filters=[];this.maximum=100}
  select(columns){this.columns=columns;return this}eq(key,value){this.filters.push(row=>row[key]===value);return this}in(key,value){this.filters.push(row=>value.includes(row[key]));return this}gte(key,value){this.filters.push(row=>row[key]>=value);return this}lte(key,value){this.filters.push(row=>row[key]<=value);return this}gt(key,value){this.filters.push(row=>row[key]>value);return this}order(){return this}limit(maximum){this.maximum=maximum;return this}abortSignal(){return this}
  then(resolve,reject){return operation('table',this.table,()=>({data:(state.removed&&this.table==='study_group_members'?[]:tables[this.table]||[]).filter(row=>this.filters.every(filter=>filter(row))).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,this.maximum).map(row=>Object.fromEntries(this.columns.split(',').filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]))),error:null})).then(resolve,reject)}
 }
 const client={auth:{getUser:()=>operation('auth','getUser',()=>({data:{user:{id:USER,email_confirmed_at:'2026-01-01T00:00:00Z'}},error:null}))},from:table=>new Query(table),rpc:(name,args)=>operation('rpc',name,()=>({data:state.banned?null:name==='xelay_classroom_workspace'?{classrooms:[]}:name==='xelay_teaching_group'?{courses:[],assignments:[],materials:[],grades:[]}:null,error:state.banned?{}:null}))}
 const verify=(credential)=>verifySupabaseAssistantSession(client,credential,NOW)
 const repository=(session)=>createSupabaseAssistantReadRepository({client,userId:USER,credential:TOKEN,now:()=>NOW,...(seed?{verifiedSession:session}:{})})
 const readService=createAuthenticatedAssistantReadService({verifySession:verify,createCallerRepository:session=>repository(session),now:()=>NOW})
 const ports={verifySession:verify,catalog:(session,_credential,signal)=>repository(session).catalog(signal),read:readService.read,writes:{list(){throw Error('No write')},prepare(){throw Error('No write')},edit(){throw Error('No write')},confirm(){throw Error('No write')},cancel(){throw Error('No write')}}}
 const handler=createAssistantCloudHandler({enabled:true,ports,now:()=>NOW})
 async function dispatch(route,topic='study',scope=topic==='study'?{groupId:GROUP,from:'2026-11-02',to:'2026-11-02'}:{}){const req=Readable.from(route==='read'?[JSON.stringify({topic,scope,limit:30})]:[]);Object.assign(req,{method:route==='read'?'POST':'GET',url:'/api/assistant?route='+route,headers:{authorization:'Bearer '+TOKEN,...(route==='read'?{origin:'https://www.xelay.ink','sec-fetch-site':'same-origin','content-type':'application/json'}:{})}});const res=new EventEmitter();Object.assign(res,{writableEnded:false,destroyed:false,writeHead(status){this.status=status},end(raw){this.raw=raw;this.writableEnded=true}});const start=performance.now();await handler(req,res);return{status:res.status,body:JSON.parse(res.raw),elapsedMs:Math.round((performance.now()-start)*100)/100}}
 return{state,client,repository,dispatch,counts:()=>({auth:state.operations.filter(row=>row.kind==='auth').length,rpc:state.operations.filter(row=>row.kind==='rpc').length,tables:state.operations.filter(row=>row.kind==='table').length,total:state.operations.length,maxConcurrent:state.maximumActive})}
}

test('actual HTTP catalog uses bounded fresh caller reads; measured SDK calls are explicit',async()=>{
 const f=fixture({delayMs:2}),result=await f.dispatch('catalog')
 assert.equal(result.status,200);assert.equal(result.body.groups.length,3)
 console.log(JSON.stringify({fixture:'three accepted groups, no teaching, 2ms fake SDK operations',route:'catalog',...f.counts(),elapsedMs:result.elapsedMs}))
 assert.equal(f.counts().total,15)
})

test('actual HTTP study read preserves both fresh permission snapshots and outputs only authorized rows',async()=>{
 const f=fixture({delayMs:2}),result=await f.dispatch('read')
 assert.equal(result.status,200);assert.equal(result.body.records.length,1);assert.equal(result.body.records[0].groupId,GROUP)
 console.log(JSON.stringify({fixture:'three accepted groups, no teaching, 2ms fake SDK operations',route:'read',...f.counts(),elapsedMs:result.elapsedMs}))
 assert.equal(f.counts().total,28)
})

test('removal during timetable retrieval still fails the mandatory final fresh membership check',async()=>{
 const f=fixture();f.state.after=({name})=>{if(name==='study_group_schedule')f.state.removed=true}
 const result=await f.dispatch('read');assert.equal(result.status,403);assert.equal(result.body.error,'access_denied')
 assert.equal(f.state.operations.filter(row=>row.name==='study_group_members').length,2)
})

test('a ban after the first verification remains visible to the final account check',async()=>{
 const f=fixture();f.state.after=({name})=>{if(name==='study_group_material_subjects')f.state.banned=true}
 const result=await f.dispatch('catalog');assert.equal(result.status,401);assert.equal(result.body.error,'session_changed')
})

test('the verified identity handoff is validated, single-use and never replaces the final live identity lookup',async()=>{
 const session={userId:USER,accountActive:true,emailConfirmed:true,expiresAt:new Date(NOW+3600000).toISOString(),sessionId:'performance-test'}
 for(const patch of [{userId:uid(999)},{accountActive:false},{emailConfirmed:false},{expiresAt:'invalid'},{expiresAt:new Date(NOW-1).toISOString()}]){
  const f=fixture();assert.throws(()=>f.repository({...session,...patch}),error=>error.code==='assistant_account_changed');assert.equal(f.counts().total,0)
 }
 const f=fixture(),repository=f.repository(session)
 await repository.catalog();assert.equal(f.counts().auth,1)
 await repository.catalog();assert.equal(f.counts().auth,3)
 assert.equal(f.state.operations.filter(row=>row.name==='study_group_members').length,2)
 f.state.banned=true;await assert.rejects(repository.catalog())
})

test('a study-only authorization snapshot cannot be repurposed for seminar, material or teacher data',async()=>{
 const f=fixture(),repository=f.repository()
 const access=await repository.readAccess({userId:USER,membershipLimit:101,teachingGrantLimit:201,studyGroupId:GROUP})
 assert.equal(access.memberships.length,1);assert.equal(access.memberships[0].groupId,GROUP);assert.deepEqual(access.teachingGrants,[])
 const beforeTables=f.counts().tables
 for(const topic of ['seminars','materials','teaching','gradebook'])await assert.rejects(repository.readPage({topic,audience:'student',userId:USER,selections:[{groupId:GROUP}],from:'2026-11-02',to:'2026-11-02',period:'current',limit:31,accessRevision:access.revision}),error=>error.code==='assistant_read_repository_scope_violation')
 assert.equal(f.counts().tables,beforeTables)
 assert.equal(f.state.operations.some(row=>row.name==='xelay_classroom_workspace'),false)
})

test('catalog subject metadata stays two batched reads rather than one pair per group, with bounded concurrency',async()=>{
 const f=fixture({groups:8,delayMs:1}),result=await f.dispatch('catalog')
 assert.equal(result.status,200);assert.equal(result.body.groups.length,8)
 for(const name of ['study_group_seminar_subjects','study_group_material_subjects'])assert.equal(f.state.operations.filter(row=>row.name===name).length,1)
 assert.ok(f.counts().maxConcurrent<=6)
})

test('published news uses explicit fresh-account reads without changing its published-row filter',async()=>{
 const f=fixture({delayMs:2}),result=await f.dispatch('read','news')
 assert.equal(result.status,200);assert.deepEqual(result.body.records,[])
 console.log(JSON.stringify({fixture:'three accepted groups, no teaching, 2ms fake SDK operations',route:'news',...f.counts(),elapsedMs:result.elapsedMs}))
 assert.equal(f.counts().total,14)
})

test('public-only snapshots cannot authorize private group data or the shared organizer',async()=>{
 const f=fixture(),repository=f.repository()
 const access=await repository.readAccess({userId:USER,membershipLimit:101,teachingGrantLimit:201,publicOnly:true})
 assert.deepEqual(access.memberships,[]);assert.deepEqual(access.teachingGrants,[])
 const tables=f.counts().tables
 for(const topic of ['study','results','materials','seminars','teaching','gradebook','organizer'])await assert.rejects(repository.readPage({topic,audience:'student',userId:USER,selections:[],from:'2026-11-02',to:'2026-11-02',period:'current',limit:31,accessRevision:access.revision}),error=>error.code==='assistant_read_repository_scope_violation')
 assert.equal(f.counts().tables,tables)
 const invalid=await f.dispatch('read','news',{groupId:GROUP});assert.equal(invalid.status,400)
})

test('public-only reads still reject bans during publication retrieval and never expose records on failure',async()=>{
 const f=fixture();f.state.after=({name})=>{if(name==='news_posts')f.state.banned=true}
 const result=await f.dispatch('read','news');assert.equal(result.status,503);assert.equal(result.body.records,undefined)
 assert.ok(f.state.operations.filter(row=>row.name==='xelay_classroom_workspace').length>=4)
})
