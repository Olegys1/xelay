import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {createTeachingScopedFixture} from '../scripts/security/teaching-scoped-fixture.mjs'

test('online planning: staff sessions, shared read-only baseline, private jobs, immutable application and revocation',{timeout:120000},async t=>{
 const fx=await createTeachingScopedFixture();t.after(()=>fx.close());const {db,ids}=fx
 await db.exec('create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz)')
 const sessions={};for(const id of [ids.admin,ids.owner,ids.outsider]){sessions[id]=randomUUID();await db.query('insert into auth.sessions values($1,$2,null)',[sessions[id],id])}
 await db.query("insert into auth.mfa_factors(user_id,status,factor_type)values($1,'verified','totp')",[ids.owner])
 for(const file of ['20261122184146_dean_workspace.sql','20261122200956_dean_online_planning.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'))
 await db.exec('update public.xelay_privacy_consent_settings set enforce_new_signups=true')
 const workstation=randomUUID()
 await db.query('insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data) values($1,$2,$3,$4)',[workstation,'dean-012345abcd@dean.xelay.ink',{full_name:'Synthetic desk'},{dean_service:true,created_by:ids.admin}])
 assert.equal((await db.query('select full_name from profiles where id=$1',[workstation])).rows[0].full_name,'Synthetic desk')
 assert.equal((await db.query('select count(*) n from user_privacy_consents where user_id=$1',[workstation])).rows[0].n,0)
 await assert.rejects(db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[randomUUID(),'dean-012345abce@dean.xelay.ink',{full_name:'Spoof',dean_service:true,created_by:ids.admin}]),/PRIVACY_CONSENT_REQUIRED/)
 await assert.rejects(db.query('insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data) values($1,$2,$3,$4)',[randomUUID(),'dean-012345abcf@dean.xelay.ink',{full_name:'Spoof'},{dean_service:true,created_by:ids.outsider}]),/PRIVACY_CONSENT_REQUIRED/)
 async function invoke(user,name,args,aal='aal2',role='authenticated'){
  await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,session_id:sessions[user],aal,role})])
  try{return(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result}finally{await db.exec('reset role')}
 }
 const workspace=(a,p={},u=ids.admin)=>invoke(u,'xelay_dean_workspace',[a,JSON.stringify(p)])
 const online=(a,p={},u=ids.admin)=>invoke(u,'xelay_dean_online',[a,JSON.stringify(p)])
 const events=[{id:'e',course:'Synthetic',teacher:'Synthetic',teacherIds:['t'],studentIds:['s'],activity:'lecture',day:1,period:1,weeks:[1]}]
 const draft=await workspace('create',{title:'Immutable baseline',document:{source:{students:[{id:'s',name:'Synthetic',group:'G'}],events},mapping:{},rows:[],monday:''}})
 const before=JSON.stringify((await db.query('select * from study_group_schedule order by id')).rows)
 await db.query("update auth.users set raw_app_meta_data=$2,email='synthetic@dean.xelay.ink' where id=$1",[ids.owner,{dean_service:true,created_by:ids.admin}])
 await online('staff_register',{userId:ids.owner,label:'Synthetic desk',login:'synthetic@dean.xelay.ink',draftId:draft.id})
 assert.equal((await workspace('catalog',{},ids.owner)).admin,false)
 assert.equal((await workspace('catalog',{},ids.owner)).groups.length,0)
 assert.equal((await workspace('list',{},ids.owner))[0].id,draft.id)
 await assert.rejects(workspace('save',{id:draft.id,revision:1,document:{}},ids.owner),/DEAN_DRAFT_DENIED/)
 await assert.rejects(online('staff_list',{},ids.owner),/DEAN_ADMIN_REQUIRED/)
 await assert.rejects(invoke(ids.owner,'xelay_dean_online',['jobs','{}'],'aal1'),/DEAN_MFA_REQUIRED/)
 const job=await online('begin',{draftId:draft.id,revision:1,settings:{}},ids.owner)
 await assert.rejects(online('begin',{draftId:draft.id,revision:1,settings:{}},ids.owner),/DEAN_CALC_BUSY/)
 await assert.rejects(online('result',{id:job.job},ids.admin),/DEAN_JOB_DENIED/)
 await assert.rejects(invoke(ids.owner,'xelay_dean_finish_job',[job.job,'{}']),/permission denied/)
 const moved=[{...events[0],day:2}]
 await invoke(ids.admin,'xelay_dean_finish_job',[job.job,JSON.stringify({ok:true,options:[{events:moved,report:{passed:true}}]})],'aal2','service_role')
 const copy=await online('apply',{id:job.job,option:0},ids.owner)
 assert.notEqual(copy.id,draft.id);assert.equal(copy.approved_revision,null);assert.equal(copy.published_revision,null)
 assert.deepEqual(copy.document.source.events,moved);assert.deepEqual((await workspace('load',{id:draft.id})).document,draft.document)
 assert.equal((await online('apply',{id:job.job,option:0},ids.owner)).id,copy.id)
 await assert.rejects(online('apply',{id:job.job,option:1},ids.owner),/DEAN_OPTION_ALREADY_APPLIED/)
 assert.equal((await db.query('select count(*) n from dean_private.lessons')).rows[0].n,0)
 assert.equal(JSON.stringify((await db.query('select * from study_group_schedule order by id')).rows),before)
 await db.query("update dean_private.jobs set created_at=now()-interval '5 minutes'")
 const forged=await online('begin',{draftId:copy.id,revision:1,settings:{}},ids.owner)
 await invoke(ids.admin,'xelay_dean_finish_job',[forged.job,JSON.stringify({ok:true,options:[{events:[{...moved[0],weeks:[2]}],report:{passed:true}}]})],'aal2','service_role')
 await assert.rejects(online('apply',{id:forged.job,option:0},ids.owner),/DEAN_SOURCE_CHANGED/)
 await online('staff_disable',{userId:ids.owner})
 await assert.rejects(workspace('load',{id:copy.id},ids.owner),/DEAN_ACCESS_DENIED/)
 await assert.rejects(online('jobs',{},ids.owner),/DEAN_ACCESS_DENIED/)
})
