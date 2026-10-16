// Synthetic contract checks; no network or production identities.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
const source=await readFile(new URL('../../src/lib/adminStudyGroups.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const ids={group:'11000000-0000-4000-8000-000000000001',rep:'11000000-0000-4000-8000-000000000002',member:'11000000-0000-4000-8000-000000000003',university:'11000000-0000-4000-8000-000000000004',unit:'11000000-0000-4000-8000-000000000005'}
const date='2026-10-16T12:00:00+00:00'
const group={id:ids.group,group_name:'МА-2',specialty:'Synthetic program',cohort_start_year:2026,study_level:'bachelor',university_id:ids.university,university_name:'Synthetic university',academic_unit_id:ids.unit,unit_name:'Synthetic faculty',representative:{id:ids.rep,full_name:'Synthetic representative',username:'synthetic_rep'},accepted_count:2,pending_count:1,inactive_count:2,created_at:date}
const member={user_id:ids.member,full_name:'Synthetic member',username:'synthetic_member',status:'accepted',is_representative:false,invited_at:date,accepted_at:date}
const plain=value=>JSON.parse(JSON.stringify(value))
function fixture(result){const calls=[],module={exports:{}};vm.runInNewContext(compiled,{module,exports:module.exports,require(name){assert.equal(name,'./supabase');return {supabase:{async rpc(name,args){calls.push({name,args});return result}}}}});return {api:module.exports,calls}}
const page={items:[group],total:1}
const detail={group,items:[member],total:2}

test('overview sends bounded normalized query and sort in one read-only RPC',async()=>{
  const {api,calls}=fixture({data:page,error:null})
  assert.deepEqual(plain(await api.loadAdminStudyGroups('  МА-2  ','members_desc')),page)
  assert.deepEqual(plain(calls),[{name:'xelay_admin_study_groups',args:{p_query:'МА-2',p_sort:'members_desc',p_limit:20,p_offset:0}}])
  assert.doesNotMatch(source,/supabase\.from\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/)
})

test('bad inputs fail before a request; search counts Unicode codepoints and treats wildcards as ordinary text',async()=>{
  const {api,calls}=fixture({data:{items:[],total:0},error:null})
  for(const args of [['x','wrong'],['x','name',51],['x','name',0],['x','name',20,-1],['x','name',20,2147483648],['x','name',20,1.5],['😀'.repeat(121)],['name\nvalue']])await assert.rejects(api.loadAdminStudyGroups(...args),/INPUT_INVALID/)
  assert.equal(calls.length,0)
  await api.loadAdminStudyGroups('😀'.repeat(120));await api.loadAdminStudyGroups('%_')
  assert.equal(calls[1].args.p_query,'%_')
  for(const args of [['invalid'],[ids.group,'unknown'],[ids.group,'accepted','',51]])await assert.rejects(api.loadAdminStudyGroupMembers(...args),/INPUT_INVALID/)
  assert.equal(calls.length,2)
})

test('overview rejects malformed counts, identity/cohort/pagination, duplicates and missing representative instead of showing zero',async()=>{
  const invalid=[null,[],{}, {...page,total:-1},{...page,items:[{...group,accepted_count:0}]},{...page,items:[{...group,pending_count:'2'}]},
    {...page,items:[{...group,representative:null}]},{...page,items:[{...group,cohort_start_year:2}]},{...page,items:[{...group,study_level:'unknown'}]},
    {...page,items:[{...group,created_at:'yesterday'}]},{items:[group,group],total:2},{items:[group],total:0}]
  for(const data of invalid)await assert.rejects(fixture({data,error:null}).api.loadAdminStudyGroups(),/RESPONSE_INVALID/)
  await assert.rejects(fixture({data:page,error:null}).api.loadAdminStudyGroups('','name',20,1),/RESPONSE_INVALID/)
  assert.deepEqual(plain(await fixture({data:{items:[],total:1},error:null}).api.loadAdminStudyGroups('','name',20,20)),{items:[],total:1})
  const legacy={...group,cohort_start_year:null,study_level:null}
  assert.equal((await fixture({data:{items:[legacy],total:1},error:null}).api.loadAdminStudyGroups()).items[0].cohort_start_year,null)
})

test('roster sends exact group/filter/page and accepts a synthesized representative once',async()=>{
  const representative={...member,user_id:ids.rep,is_representative:true,invited_at:null,accepted_at:null}
  const value={group,items:[representative,member],total:2}
  const {api,calls}=fixture({data:value,error:null})
  assert.deepEqual(plain(await api.loadAdminStudyGroupMembers(ids.group)),value)
  assert.deepEqual(plain(calls),[{name:'xelay_admin_study_group_members',args:{p_group_id:ids.group,p_status:'accepted',p_query:'',p_limit:50,p_offset:0}}])
})

test('roster refuses another group, mismatched statuses/representative flags, impossible totals and repeated users',async()=>{
  const invalid=[{...detail,group:{...group,id:ids.unit}},{...detail,items:[{...member,status:'pending'}]},
    {...detail,items:[{...member,is_representative:true}]},{...detail,items:[{...member,user_id:ids.rep}]},
    {...detail,items:[{...member,accepted_at:'wrong'}]},{...detail,total:3},{...detail,total:1},
    {...detail,items:[member,member]}]
  for(const data of invalid)await assert.rejects(fixture({data,error:null}).api.loadAdminStudyGroupMembers(ids.group),/RESPONSE_INVALID/)
  const filtered={...detail,total:1}
  assert.equal((await fixture({data:filtered,error:null}).api.loadAdminStudyGroupMembers(ids.group,'accepted','member')).total,1)
  assert.equal((await fixture({data:{group,items:[],total:0},error:null}).api.loadAdminStudyGroupMembers(ids.group,'accepted','absent')).total,0)
})

test('pending and inactive rows retain their exact status and never become accepted members',async()=>{
  const pending={...member,status:'pending',accepted_at:null}
  const accepted=await fixture({data:{group,items:[pending],total:1},error:null}).api.loadAdminStudyGroupMembers(ids.group,'pending')
  assert.equal(accepted.items[0].status,'pending')
  for(const status of ['removed','rejected']){
    const value={group,items:[{...member,status}],total:2}
    assert.equal((await fixture({data:value,error:null}).api.loadAdminStudyGroupMembers(ids.group,'inactive')).items[0].status,status)
  }
  await assert.rejects(fixture({data:{group,items:[pending],total:2},error:null}).api.loadAdminStudyGroupMembers(ids.group,'inactive'),/RESPONSE_INVALID/)
})

test('typed helpers retain only required public identity and membership fields',async()=>{
  const extra={private_contact:'must not pass',private_work:'must not pass'}
  const value=await fixture({data:{items:[{...group,...extra,representative:{...group.representative,...extra}}],total:1},error:null}).api.loadAdminStudyGroups()
  assert.deepEqual(plain(value),page)
  const people=await fixture({data:{...detail,items:[{...member,...extra}],...extra},error:null}).api.loadAdminStudyGroupMembers(ids.group)
  assert.deepEqual(plain(people),detail)
})

test('server failures propagate and Ukrainian error copy distinguishes missing group, MFA and transport',async()=>{
  const failure={code:'42501',message:'ADMIN_MFA_REQUIRED'}
  const {api}=fixture({data:null,error:failure})
  await assert.rejects(api.loadAdminStudyGroups(),error=>error===failure)
  await assert.rejects(api.loadAdminStudyGroupMembers(ids.group),error=>error===failure)
  assert.match(api.adminStudyGroupsError(failure),/двоетапним/)
  assert.match(api.adminStudyGroupsError({message:'ADMIN_STUDY_GROUP_NOT_FOUND'}),/більше не знайдено/)
  assert.match(api.adminStudyGroupsError({code:'PGRST202'}),/підключається/)
  assert.match(api.adminStudyGroupsError({message:'ADMIN_STUDY_GROUP_INPUT_INVALID'}),/120/)
  assert.match(api.adminStudyGroupsError(new Error('offline')),/з’єднання/)
})
