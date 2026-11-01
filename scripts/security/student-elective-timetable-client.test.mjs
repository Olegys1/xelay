import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as model from '../../src/lib/studentElectiveTimetable.ts'
const id=n=>`62000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const USER=id(1),OTHER=id(2),GROUP=id(10),FOREIGN=id(11),FROM='2026-11-02',UNTIL='2027-01-31'
const lesson=()=>({id:id(30),subject:'Вибірковий курс',weekday:3,starts_at:'10:00',ends_at:'11:20',lesson_type:'lecture',teacher_name:'',location:'',online_url:null,online_url_secondary:null,online_links_extra:[],conference_id:null,conference_access_code:null,week_pattern:'every',week_anchor_date:null})
const plan=(patch={})=>({id:id(20),user_id:USER,group_id:GROUP,valid_from:FROM,valid_until:UNTIL,configured:true,version:1,lessons:model.normalizeStudentElectiveMeetings([lesson()]),...patch})
const input=patch=>({groupId:GROUP,validFrom:FROM,validUntil:UNTIL,configured:true,lessons:[lesson()],...patch})
function fixture(){
 const state={actor:USER,rows:[plan()],calls:[],after:null,reply:null,error:null}
 const client={auth:{async getSession(){return{data:{session:state.actor?{user:{id:state.actor}}:null},error:null}}},from(table){
   assert.equal(table,'student_elective_plans');const filters=[],query={select(columns){state.calls.push({type:'select',table,columns,filters});return query},eq(key,value){filters.push([key,value]);return query},order(){return query},limit(value){assert.equal(value,33);return query},abortSignal(signal){assert.equal(signal instanceof AbortSignal,true);return query},then(resolve,reject){return Promise.resolve().then(()=>{state.after?.();return{data:state.reply??structuredClone(state.rows),error:state.error}}).then(resolve,reject)}};return query
  },rpc(name,args){state.calls.push({type:'rpc',name,args:structuredClone(args)});return{abortSignal(){return this},then(resolve,reject){return Promise.resolve().then(()=>{state.after?.();const data=state.reply??(name==='xelay_remove_student_elective_plan'?true:plan({id:args.p_plan_id??id(20),valid_from:args.p_valid_from,valid_until:args.p_valid_until,version:args.p_expected_version==null?1:args.p_expected_version+1,lessons:args.p_lessons,configured:args.p_configured}));return{data,error:state.error}}).then(resolve,reject)}}}}
 const module={exports:{}}
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../src/lib/studentElectiveTimetableRepository.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,AbortSignal,require(name){if(name==='./supabase')return{supabase:client};if(name==='./studentElectiveTimetable')return model;throw Error('Unexpected import '+name)}})
 return{state,repository:module.exports.createStudentElectiveRepository(client)}
}
const denied=(promise,code)=>assert.rejects(promise,error=>error.code===code)

test('client reads only current owner and group through the private plan table',async()=>{
 const f=fixture(),plans=await f.repository.load(USER,GROUP)
 assert.equal(plans.length,1);assert.equal(plans[0].user_id,USER)
 assert.deepEqual(f.state.calls[0].filters,[['user_id',USER],['group_id',GROUP]])
 assert.equal(f.state.calls.some(call=>call.table==='study_group_schedule'),false)
})

test('foreign owner, group, duplicate, malformed and overlapping returned plans are rejected',async()=>{
 for(const rows of [[plan({user_id:OTHER})],[plan({group_id:FOREIGN})],[plan(),plan()],[plan({lessons:[{...lesson(),id:'bad'}]})],[plan(),plan({id:id(21),valid_from:'2027-01-01'})]]){
  const f=fixture();f.state.rows=rows;await assert.rejects(f.repository.load(USER,GROUP))
 }
})

test('account changes and cancellation discard reads and prevent any implicit save or retry',async()=>{
 const before=fixture();before.state.actor=OTHER;await denied(before.repository.load(USER,GROUP),'STUDENT_ELECTIVE_ACCOUNT_CHANGED');assert.equal(before.state.calls.length,0)
 const during=fixture();during.state.after=()=>{during.state.actor=OTHER};await denied(during.repository.load(USER,GROUP),'STUDENT_ELECTIVE_ACCOUNT_CHANGED');assert.equal(during.state.calls.length,1)
 const abort=new AbortController();abort.abort();const cancelled=fixture();await denied(cancelled.repository.load(USER,GROUP,abort.signal),'STUDENT_ELECTIVE_CANCELLED');assert.equal(cancelled.state.calls.length,0)
})

test('save infers owner on the server, supplies only exact fields and checks the returned version',async()=>{
 const f=fixture(),result=await f.repository.save(USER,input({user_id:OTHER,group_id:FOREIGN}))
 assert.equal(result.user_id,USER);assert.equal(result.version,1)
 const call=f.state.calls[0];assert.equal(call.name,'xelay_save_student_elective_plan');assert.equal(call.args.p_group_id,GROUP);assert.equal(call.args.p_expected_version,null)
 assert.deepEqual(Object.keys(call.args).sort(),['p_configured','p_expected_version','p_group_id','p_lessons','p_plan_id','p_valid_from','p_valid_until']);assert.equal(call.args.p_plan_id,null)
 assert.equal(JSON.stringify(call.args).includes(OTHER),false);assert.equal(JSON.stringify(call.args).includes(FOREIGN),false)
 const update=await f.repository.save(USER,input({expectedVersion:2}));assert.equal(update.version,3)
})

test('malformed fields and actual personal meeting conflicts are blocked before RPC',async()=>{
 for(const patch of [{groupId:'bad'},{expectedVersion:0},{planId:'bad',expectedVersion:1},{planId:id(20)},{configured:'true'},{validUntil:'2026-01-01'},{lessons:[{...lesson(),online_url:'javascript:alert(1)'}]},{lessons:[lesson(),{...lesson(),id:id(31)}]}]){
   const f=fixture();await assert.rejects(f.repository.save(USER,input(patch)));assert.equal(f.state.calls.length,0)
 }
})

test('period changes address the same owned versioned plan atomically and reject a different returned identity',async()=>{
 const f=fixture(),next=await f.repository.save(USER,input({planId:id(20),expectedVersion:1,validFrom:'2026-11-09',validUntil:'2027-01-25'}))
 assert.equal(next.id,id(20));assert.equal(next.version,2);assert.equal(next.valid_from,'2026-11-09');assert.equal(next.valid_until,'2027-01-25')
 assert.equal(f.state.calls.length,1);assert.equal(f.state.calls[0].name,'xelay_save_student_elective_plan');assert.equal(f.state.calls[0].args.p_plan_id,id(20))
 const unexpected=fixture();unexpected.state.reply=plan({id:id(21),version:2})
 await denied(unexpected.repository.save(USER,input({planId:id(20),expectedVersion:1})),'STUDENT_ELECTIVE_INVALID_RESPONSE')
})

test('server conflicts pass through once without overwrite or automatic retry',async()=>{
 const f=fixture();f.state.error={code:'P0001',message:'STUDENT_ELECTIVE_CONFLICT'}
 await denied(f.repository.save(USER,input({expectedVersion:1})),'P0001');assert.equal(f.state.calls.length,1)
 const foreign=fixture();foreign.state.reply=plan({user_id:OTHER});await denied(foreign.repository.save(USER,input()),'STUDENT_ELECTIVE_INVALID_RESPONSE')
 const wrongVersion=fixture();wrongVersion.state.reply=plan({version:3});await denied(wrongVersion.repository.save(USER,input()),'STUDENT_ELECTIVE_INVALID_RESPONSE')
})

test('reset addresses only an owned versioned plan and cannot modify the shared calendar',async()=>{
 const f=fixture();await f.repository.remove(USER,id(20),1)
 assert.equal(f.state.calls.length,1);assert.equal(f.state.calls[0].name,'xelay_remove_student_elective_plan')
 assert.deepEqual(f.state.calls[0].args,{p_id:id(20),p_expected_version:1})
 const changed=fixture();changed.state.after=()=>{changed.state.actor=OTHER};await denied(changed.repository.remove(USER,id(20),1),'STUDENT_ELECTIVE_ACCOUNT_CHANGED')
})
