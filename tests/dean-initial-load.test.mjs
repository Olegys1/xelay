import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {createTeachingScopedFixture} from '../scripts/security/teaching-scoped-fixture.mjs'

test('dean initial reads skip rosters and write locks, preserving MFA, revocation and draft scope', {timeout:120000}, async t=>{
 const fx=await createTeachingScopedFixture();t.after(()=>fx.close());const {db,ids}=fx
 await db.exec('create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz)')
 const sessions={};for(const id of [ids.admin,ids.owner,ids.outsider]){sessions[id]=randomUUID();await db.query('insert into auth.sessions values($1,$2,null)',[sessions[id],id])}
 for(const id of [ids.owner,ids.outsider])await db.query("insert into auth.mfa_factors(user_id,status,factor_type)values($1,'verified','totp')",[id])
 for(const f of ['20261122184146_dean_workspace.sql','20261122200956_dean_online_planning.sql','20261123072500_dean_provision_reservation.sql','202611240100_dean_room_workflow.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+f,import.meta.url),'utf8'))
 const source={students:[{id:'s',name:'Synthetic',group:'G'}],events:[{id:'e',course:'Synthetic',teacher:'Teacher',teacherIds:['t'],studentIds:['s'],activity:'lecture',day:1,period:1,weeks:[1]}],metadata:{},blockers:[]}
 const document={source,mapping:{},monday:'',rows:[]}
 const shared=randomUUID(),privateId=randomUUID()
 for(const [id,owner,title] of [[shared,ids.admin,'Shared baseline'],[privateId,ids.outsider,'Private draft']])await db.query('insert into dean_private.drafts(id,owner_id,title,document)values($1,$2,$3,$4)',[id,owner,title,document])
 await db.query("insert into dean_private.staff(user_id,label,login,created_by)values($1,'Synthetic desk','synthetic@dean.xelay.ink',$2)",[ids.owner,ids.admin])
 await db.query('insert into dean_private.draft_readers values($1,$2)',[shared,ids.owner])
 await db.query('insert into dean_private.main_schedules values($1,$1,1,1,$2,$3,$4,now())',[shared,document,'Main snapshot',ids.admin])
 const snapshot=async()=>JSON.stringify((await db.query("select (select jsonb_agg(to_jsonb(d) order by id) from dean_private.drafts d) drafts,(select jsonb_agg(to_jsonb(m)) from dean_private.main_schedules m) main,(select jsonb_agg(to_jsonb(s) order by id) from study_group_schedule s) schedules,(select count(*) from dean_private.lessons) lessons,(select count(*) from dean_private.audit) audit")).rows)
 const before=await snapshot()
 const login=async(user=ids.admin,aal='aal2',role='authenticated')=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,session_id:sessions[user],aal,role})])}
 const rpc=async(action,payload={})=>(await db.query('select public.xelay_dean_workspace($1,$2) result',[action,JSON.stringify(payload)])).rows[0].result
 const invoke=async(action,payload={},user=ids.admin,aal='aal2',role='authenticated')=>{await login(user,aal,role);try{return await rpc(action,payload)}finally{await db.exec('reset role')}}
 await login()
 await db.exec('begin read only')
 await assert.rejects(rpc('load',{id:shared}),/read-only transaction/)
 await db.exec('rollback;reset role')
 await db.exec(await readFile(new URL('../supabase/migrations/20261125121125_dean_initial_load.sql',import.meta.url),'utf8'))
 // If a supposedly lightweight read rebuilds a catalog, fail immediately.
 await db.exec("alter function dean_private.workspace_previous(text,jsonb) rename to workspace_catalog_test_original;create function dean_private.workspace_previous(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin if p_action='catalog' then raise exception 'UNEXPECTED_ROSTER_BUILD';end if;return dean_private.workspace_catalog_test_original(p_action,p_payload);end $$;revoke all on function dean_private.workspace_previous(text,jsonb) from public,anon,authenticated;")
 await login(ids.owner)
 await db.exec('begin read only')
 const boot=await rpc('bootstrap');assert.equal(boot.admin,false);assert.equal(boot.drafts.length,1);assert.equal(boot.draft.id,shared);assert.equal(boot.groups,undefined);assert.equal(boot.drafts[0].document,undefined)
 assert.deepEqual((await rpc('load',{id:shared})).document,document)
 const summary=await rpc('main_summary',{id:shared});assert.equal(summary.main.draft_id,shared);assert.equal(summary.main.document,undefined)
 assert.deepEqual((await rpc('main',{id:shared})).main.document,document)
 await db.exec('commit;reset role')
 assert.equal((await invoke('bootstrap')).admin,true)
 await assert.rejects(invoke('bootstrap',{},ids.admin,'aal1'),/DEAN_MFA_REQUIRED/)
 await assert.rejects(invoke('bootstrap',{},ids.outsider),/DEAN_ACCESS_DENIED/)
 await assert.rejects(invoke('bootstrap',{},ids.admin,'aal2','anon'),/permission denied/)
 for(const action of ['load','main','main_summary'])await assert.rejects(invoke(action,{id:privateId},ids.owner),/DEAN_DRAFT_DENIED/)
 await db.query('update dean_private.staff set enabled=false where user_id=$1',[ids.owner])
 await assert.rejects(invoke('bootstrap',{},ids.owner),/DEAN_ACCESS_DENIED/)
 await db.query('update dean_private.staff set enabled=true where user_id=$1',[ids.owner])
 await db.query('delete from auth.sessions where id=$1',[sessions[ids.owner]])
 await assert.rejects(invoke('bootstrap',{},ids.owner),/DEAN_MFA_REQUIRED/)
 await login();await assert.rejects(db.exec('select dean_private.require_access()'),/permission denied/);await db.exec('reset role')
 assert.equal(await snapshot(),before)
})
