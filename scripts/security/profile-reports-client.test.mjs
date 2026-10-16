// Contract validation with synthetic data only; no accounts, network or writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source=await readFile(new URL('../../src/lib/profileReports.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const ids={report:'10000000-0000-4000-8000-000000000001',reporter:'10000000-0000-4000-8000-000000000002',target:'10000000-0000-4000-8000-000000000003',request:'10000000-0000-4000-8000-000000000004',history:'10000000-0000-4000-8000-000000000005'}
const now='2026-10-16T12:00:00.000Z'
const person=id=>({user_id:id,full_name:'Synthetic person',username:'synthetic',avatar_url:null})
const snapshot={...person(ids.target),bio:'Public synthetic bio',university_id:null,academic_unit_id:null,faculty:null,specialty:null,study_year:1,experience:'student',is_premium:true,status_text:'Synthetic status',emoji_status:'sticker:penguin'}
const report={id:ids.report,kind:'status',reason:'inappropriate',details:'Synthetic public content',status:'open',version:1,created_at:now,updated_at:now,reviewed_at:null,reviewed_by:null,reporter_id:ids.reporter,target_user_id:ids.target,reporter_snapshot:person(ids.reporter),target_snapshot:snapshot}
const history=[{id:ids.history,actor_id:ids.reporter,from_status:null,to_status:'open',action:'submit',note:'',created_at:now,version:1}]
function fixture(result){
  const calls=[],module={exports:{}}
  vm.runInNewContext(compiled,{module,exports:module.exports,require(name){assert.equal(name,'./supabase');return {supabase:{async rpc(name,args){calls.push({name,args});return result}}}}})
  return {api:module.exports,calls}
}
const input={targetUserId:ids.target,targetKind:'status',reason:'inappropriate',details:'  Synthetic description  ',requestId:ids.request}
const plain=value=>JSON.parse(JSON.stringify(value))

test('all targets/reasons have Ukrainian labels, normal users need no subscription, details count Unicode characters',()=>{
  const {api}=fixture({})
  assert.deepEqual(plain(api.PROFILE_REPORT_TARGETS).map(item=>item.value),['profile','status'])
  assert.equal(api.PROFILE_REPORT_REASONS.length,7)
  assert.equal(api.validateProfileReportDetails('  too short '),'Опишіть проблему щонайменше у 10 символах.')
  assert.equal(api.validateProfileReportDetails('😀'.repeat(10)),'')
  assert.equal(api.validateProfileReportDetails(' x'.repeat(2001)),'Скоротіть опис до 2000 символів.')
  assert.ok(api.getProfileReportReasonLabel('privacy').includes('приватних'))
  assert.doesNotMatch(source,/has_participant_access|useBilling|email:|p_reporter_id/)
})

test('submit passes only target, reason, normalized description and stable request ID; receipt reveals no report body',async()=>{
  const {api,calls}=fixture({data:{id:ids.report,status:'open',duplicate:false},error:null})
  assert.deepEqual(plain(await api.submitProfileReport(input)),{id:ids.report,status:'open',duplicate:false})
  assert.deepEqual(plain(calls),[{name:'xelay_submit_profile_report',args:{p_request_id:ids.request,p_target_user_id:ids.target,p_kind:'status',p_reason:'inappropriate',p_details:'Synthetic description'}}])
  for(const patch of [{targetUserId:'invalid'},{requestId:''},{targetKind:'unknown'},{reason:'unknown'},{details:'short'}])await assert.rejects(api.submitProfileReport({...input,...patch}),/INVALID_INPUT/)
  assert.equal(calls.length,1)
})

test('submit propagates server failure and malformed success never becomes a success receipt',async()=>{
  const failure={code:'P0001',message:'REPORT_RATE_LIMIT'}
  await assert.rejects(fixture({data:null,error:failure}).api.submitProfileReport(input),error=>error===failure)
  for(const data of [null,[],{}, {id:ids.report,status:'open',duplicate:'false'},{id:ids.report,status:'forged',duplicate:false}])await assert.rejects(fixture({data,error:null}).api.submitProfileReport(input),/INVALID_RESPONSE/)
})

test('admin list is bounded and detail requires both valid report snapshots and history',async()=>{
  const {api,calls}=fixture({data:{items:[report],total:1,open_count:1},error:null})
  assert.equal((await api.loadAdminProfileReports({status:'open'})).items[0].target_snapshot.status_text,'Synthetic status')
  assert.deepEqual(plain(calls[0]),{name:'xelay_admin_profile_reports',args:{p_status:'open',p_limit:20,p_offset:0}})
  for(const input of [{status:'unknown'},{status:'all',limit:101},{status:'all',offset:-1}])await assert.rejects(api.loadAdminProfileReports(input),/INVALID_INPUT/)
  const detail={report,history,current_status:{is_premium:true,status_text:'Synthetic status',emoji_status:'sticker:penguin'}}
  assert.equal((await fixture({data:detail,error:null}).api.loadAdminProfileReport(ids.report)).history[0].action,'submit')
  for(const data of [{...detail,history:[{...history[0],action:'ban'}]},{...detail,current_status:{is_premium:'yes'}},{...detail,report:{...report,version:0}},{...detail,report:{...report,target_snapshot:{...snapshot,is_premium:undefined}}}])await assert.rejects(fixture({data,error:null}).api.loadAdminProfileReport(ids.report),/INVALID_RESPONSE/)
})

test('review sends expected version and explicit action; invalid or silent destructive states are rejected locally',async()=>{
  const {api,calls}=fixture({data:{report:{...report,status:'resolved',version:2},history},error:null})
  const review={reportId:ids.report,expectedVersion:1,status:'resolved',note:'  Checked public content  ',action:'clear_status'}
  assert.equal((await api.reviewProfileReport(review)).report.version,2)
  assert.deepEqual(plain(calls[0]),{name:'xelay_admin_review_profile_report',args:{p_report_id:ids.report,p_expected_version:1,p_status:'resolved',p_note:'Checked public content',p_action:'clear_status'}})
  for(const patch of [{expectedVersion:0},{status:'open'},{action:'ban'},{status:'dismissed'},{note:'short'}])await assert.rejects(api.reviewProfileReport({...review,...patch}),/INVALID_INPUT/)
  assert.equal(calls.length,1)
})

test('known operational failures produce safe Ukrainian guidance without backend details',()=>{
  const {api}=fixture({})
  for(const [error,pattern]of[
    [{code:'PGRST202'},/підключаються/], [{message:'ADMIN_MFA_REQUIRED'},/адміністратора/],
    [{message:'REPORT_RATE_LIMIT'},/ліміт/], [{message:'REPORT_STATUS_CHANGED'},/відрізняється/],
    [{message:'REPORT_CONFLICT'},/Інший адміністратор/], [{message:'REPORT_REQUEST_CONFLICT'},/Дані звернення/],
    [{message:'REPORT_TARGET_STATUS_NOT_FOUND'},/більше не відображається/],
    [{code:'42501',message:'private backend detail'},/недоступна/],
    [{message:'private backend detail'},/Не вдалося/],
  ]){const message=api.profileReportError(error);assert.match(message,pattern);assert.doesNotMatch(message,/private backend detail|PGRST|SQL|supabase/)}
})
