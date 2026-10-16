// Full current SQL chain, synthetic accounts and local PostgreSQL only.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import {createFixture} from './fixture.mjs'
const root=new URL('../../',import.meta.url),first=result=>result.rows[0]
const migration=await readFile(new URL('supabase/migrations/202610160009_admin_study_group_members.sql',root),'utf8')
const audit=await readFile(new URL('supabase/audits/202610160009_admin_study_group_members.sql',root),'utf8')
const denied=promise=>assert.rejects(promise,error=>error.code==='42501')
const groupKeys=['id','group_name','specialty','cohort_start_year','study_level','university_id','university_name','academic_unit_id','unit_name','representative','accepted_count','pending_count','inactive_count','created_at'].sort()
const memberKeys=['user_id','full_name','username','status','is_representative','invited_at','accepted_at'].sort()

test('admin academic-group overview is read-only, paginated and uses canonical representative-inclusive rosters',async t=>{
  const fx=await createFixture({useStagingParity:true,through:'202610160008',beforeMigrationsSql:`
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  `});t.after(()=>fx.close())
  const {db,asUser,seedUser}=fx
  const university=randomUUID(),unit=randomUUID(),specialty=randomUUID()
  await db.query("insert into universities(id,name,slug) values($1,'Roster Test University',$2)",[university,'roster-'+university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Roster Economics Faculty',$3,'faculty')",[unit,university,'roster-'+unit])
  await db.query("insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name) values($1,$2,$3,'ROSTER','Roster Programme','Roster Programme')",[specialty,university,unit])
  const ids=Object.fromEntries(['admin','noFactorAdmin','factorOnly','repA','repB','repC','repD','member','literalMember','pending','rejected','removed','outsider'].map(key=>[key,randomUUID()]))
  const username=id=>'roster_'+id.replaceAll('-','').slice(0,16)
  const seed=async(id,name)=>seedUser(id,{username:username(id),full_name:name,university_id:university,academic_unit_id:unit,specialty_id:specialty,study_year:1,experience:'bachelor',categories:['General']})
  for(const [key,id] of Object.entries(ids))await seed(id,key==='repA'?'Zeta representative':key==='member'?'Anna member':key==='literalMember'?'Literal_%\\member':key)
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN'),($2,'ADMIN')",[ids.admin,ids.noFactorAdmin])
  for(const id of [ids.admin,ids.factorOnly])await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')",[id])
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'unverified')",[ids.noFactorAdmin])
  const makeGroup=async(rep,name,cohort,level='bachelor')=>{
    const request=randomUUID(),group=randomUUID()
    await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at,cohort_start_year,study_level)
      values($1,$2,'Synthetic representative',$3,$4,'Roster Programme',$5,'roster_fixture','approved',$6,now(),$7,$8)`,[request,rep,university,unit,name,ids.admin,cohort,cohort===null?null:level])
    await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name,cohort_start_year,study_level)
      values($1,$2,$3,$4,$5,'Roster Programme',$6,$7,$8)`,[group,request,rep,university,unit,name,cohort,cohort===null?null:level])
    return group
  }
  const groups={a:await makeGroup(ids.repA,'МА-2',2026),b:await makeGroup(ids.repB,'МА-2',2025),c:await makeGroup(ids.repC,'Empty legacy',null),d:await makeGroup(ids.repD,'Rate_%\\X',2200)}
  // Existing notification triggers require a real actor while synthetic roster
  // rows are seeded; no production trigger or policy is disabled.
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:ids.admin,role:'authenticated',aal:'aal2'})])
  const member=async(group,id,status)=>db.query(`insert into study_group_members(group_id,user_id,invited_by,status,accepted_at)
    values($1,$2,$3,$4,case when $4='accepted' then now() else null end)`,[group,id,ids.admin,status])
  for(const [key,status] of [['repA','accepted'],['member','accepted'],['literalMember','accepted'],['pending','pending'],['rejected','rejected'],['removed','removed']])await member(groups.a,ids[key],status)
  // Legacy owners can lack a membership, or retain a non-accepted stale row.
  await member(groups.c,ids.repC,'pending');await member(groups.d,ids.repD,'removed')
  const extras=[]
  for(let i=0;i<52;i++){const id=randomUUID();extras.push(id);await seed(id,`Student ${String(i).padStart(3,'0')}`);await member(groups.a,id,'accepted')}
  await db.exec('reset "request.jwt.claims"')
  const runAudit=async()=>{const results=await db.exec(audit);assert.equal(results.filter(result=>result.rows?.[0]?.audit!==undefined).length,1);return results.find(result=>result.rows?.[0]?.audit!==undefined).rows[0].audit}
  const before=await runAudit()
  await db.exec(migration)
  const list=(query='',sort='name',limit=20,offset=0,actor=ids.admin,aal='aal2',role='authenticated')=>
    asUser(actor,'select xelay_admin_study_groups($1,$2,$3,$4) as value',[query,sort,limit,offset],{aal,role}).then(result=>first(result).value)
  const detail=(group=groups.a,status='accepted',query='',limit=50,offset=0,actor=ids.admin,aal='aal2',role='authenticated')=>
    asUser(actor,'select xelay_admin_study_group_members($1,$2,$3,$4,$5) as value',[group,status,query,limit,offset],{aal,role}).then(result=>first(result).value)

  await t.test('installation changes no existing rows, policies, table grants or old guards',async()=>{
    const after=await runAudit()
    assert.deepEqual(after.relations,before.relations);assert.deepEqual(after.policies,before.policies);assert.deepEqual(after.table_security,before.table_security)
    assert.equal(after.functions.length,before.functions.length+2)
    for(const old of before.functions)assert.deepEqual(after.functions.find(row=>row.signature===old.signature),old)
    const added=after.functions.filter(row=>!before.functions.some(old=>old.signature===row.signature))
    assert.ok(added.every(row=>row.security_definer&&row.volatility==='s'&&row.proconfig.includes('search_path=""')))
    for(const row of added)for(const role of ['anon','authenticated','service_role']){
      assert.equal(first(await db.query('select has_function_privilege($1,$2,\'execute\') as allowed',[role,row.signature])).allowed,role==='authenticated')
    }
    assert.equal(added.find(row=>row.signature.startsWith('xelay_admin_study_groups(')).default_argument_count,4)
    assert.equal(added.find(row=>row.signature.startsWith('xelay_admin_study_group_members(')).default_argument_count,4)
  })

  await t.test('group totals include an owner exactly once and keep same-name cohorts distinct',async()=>{
    const page=await list();assert.deepEqual(Object.keys(page).sort(),['items','total']);assert.equal(page.total,4);assert.equal(page.items.length,4)
    const a=page.items.find(row=>row.id===groups.a),b=page.items.find(row=>row.id===groups.b),c=page.items.find(row=>row.id===groups.c),d=page.items.find(row=>row.id===groups.d)
    assert.equal(a.accepted_count,55);assert.equal(a.pending_count,1);assert.equal(a.inactive_count,2)
    for(const row of [b,c,d]){assert.equal(row.accepted_count,1);assert.equal(row.pending_count,0);assert.equal(row.inactive_count,0)}
    assert.equal(a.group_name,b.group_name);assert.notEqual(a.cohort_start_year,b.cohort_start_year)
    assert.equal(c.cohort_start_year,null);assert.equal(c.study_level,null)
    assert.equal(d.cohort_start_year,2200)
    for(const row of page.items){assert.deepEqual(Object.keys(row).sort(),groupKeys);assert.deepEqual(Object.keys(row.representative).sort(),['full_name','id','username'])}
    assert.equal((await list('МА-2')).total,2)
  })

  await t.test('sort and pagination are stable, bounded and preserve totals past the end',async()=>{
    for(const sort of ['name','members_desc','members_asc']){
      const all=await list('',sort,50);const chunks=[]
      for(let offset=0;offset<4;offset++)chunks.push(...(await list('',sort,1,offset)).items)
      assert.deepEqual(chunks,all.items)
      assert.deepEqual(await list('',sort,20,2147483647),{total:4,items:[]})
    }
    assert.equal((await list('','members_desc')).items[0].id,groups.a)
    assert.equal((await list('','members_asc')).items.at(-1).id,groups.a)
    assert.equal(first(await asUser(ids.admin,'select xelay_admin_study_groups() as value',[],{aal:'aal2'})).value.total,4)
  })

  await t.test('literal, case-insensitive Unicode search covers only the intended overview fields',async()=>{
    for(const query of ['roster test university','Roster Economics','roster Programme'])assert.equal((await list(query)).total,4)
    assert.deepEqual((await list('  zEtA Representative\u00a0')).items.map(row=>row.id),[groups.a])
    assert.deepEqual((await list(username(ids.repB).toUpperCase())).items.map(row=>row.id),[groups.b])
    assert.deepEqual((await list('@'+username(ids.repB))).items.map(row=>row.id),[groups.b])
    assert.deepEqual((await list('%')).items.map(row=>row.id),[groups.d])
    assert.deepEqual((await list('_%\\')).items.map(row=>row.id),[groups.d])
    assert.equal((await list('no such group')).total,0)
    assert.equal((await list('\u0085Roster')).total,0)
    // A student's public name is intentionally not a group-list search field.
    assert.equal((await list('Anna member')).total,0)
  })

  await t.test('accepted roster is representative-first, paginated and excludes pending/inactive accounts',async()=>{
    const page=await detail();assert.deepEqual(Object.keys(page).sort(),['group','items','total']);assert.equal(page.total,55);assert.equal(page.items.length,50)
    assert.equal(page.items[0].user_id,ids.repA);assert.equal(page.items[0].is_representative,true)
    assert.ok(page.items.every(row=>row.status==='accepted'));assert.ok(!page.items.some(row=>[ids.pending,ids.rejected,ids.removed].includes(row.user_id)))
    const second=await detail(groups.a,'accepted','',50,50);assert.equal(second.total,55);assert.equal(second.items.length,5)
    assert.equal(new Set([...page.items,...second.items].map(row=>row.user_id)).size,55)
    for(const row of [...page.items,...second.items])assert.deepEqual(Object.keys(row).sort(),memberKeys)
    assert.deepEqual((await detail(groups.a,'accepted','',50,2147483647)).items,[])
    assert.equal(first(await asUser(ids.admin,'select xelay_admin_study_group_members($1) as value',[groups.a],{aal:'aal2'})).value.items.length,50)
  })

  await t.test('missing/stale representative memberships produce one accepted owner and no duplicate status',async()=>{
    for(const group of [groups.b,groups.c,groups.d]){
      const page=await detail(group);assert.equal(page.total,1);assert.equal(page.items.length,1);assert.equal(page.items[0].is_representative,true);assert.equal(page.items[0].status,'accepted')
      assert.equal((await detail(group,'pending')).total,0);assert.equal((await detail(group,'inactive')).total,0)
    }
    const absent=(await detail(groups.b)).items[0];assert.equal(absent.invited_at,null);assert.equal(absent.accepted_at,null)
    assert.notEqual((await detail(groups.c)).items[0].invited_at,null)
    assert.equal(first(await db.query('select count(*)::int as n from study_group_members where group_id=$1',[groups.b])).n,0)
  })

  await t.test('status tabs and member searches preserve unfiltered whole-group counts',async()=>{
    const pending=await detail(groups.a,'pending');assert.equal(pending.total,1);assert.equal(pending.items[0].user_id,ids.pending)
    const inactive=await detail(groups.a,'inactive');assert.equal(inactive.total,2);assert.deepEqual(inactive.items.map(row=>row.status).sort(),['rejected','removed'])
    const filtered=await detail(groups.a,'accepted','ANNA');assert.equal(filtered.total,1);assert.equal(filtered.items[0].user_id,ids.member)
    const literal=await detail(groups.a,'accepted','_%\\');assert.equal(literal.total,1);assert.equal(literal.items[0].user_id,ids.literalMember)
    for(const page of [pending,inactive,filtered,literal,await detail(groups.a,'accepted','missing')]){
      assert.equal(page.group.accepted_count,55);assert.equal(page.group.pending_count,1);assert.equal(page.group.inactive_count,2)
    }
    assert.equal((await detail(groups.a,'accepted',username(ids.member).toUpperCase())).total,1)
    assert.equal((await detail(groups.a,'accepted','@'+username(ids.member))).total,1)
  })

  await t.test('no contacts, private content, Auth fields or arbitrary profile columns are returned',async()=>{
    const data=JSON.stringify({list:await list(),accepted:await detail(),pending:await detail(groups.a,'pending'),inactive:await detail(groups.a,'inactive')})
    assert.doesNotMatch(data,/@example\.test|"email"|phone|telegram|avatar_url|password|raw_user_meta_data|banned_until|bio|billing|homework|grades|files|permissions/)
  })

  await t.test('students, representatives, factor-only identities, AAL1 and unverified admins cannot use either RPC',async()=>{
    for(const [actor,aal] of [[ids.outsider,'aal2'],[ids.repA,'aal2'],[ids.member,'aal2'],[ids.factorOnly,'aal2'],[ids.admin,'aal1'],[ids.noFactorAdmin,'aal2'],[null,'aal2'],[randomUUID(),'aal2']]){
      await denied(list('','name',20,0,actor,aal));await denied(detail(groups.a,'accepted','',50,0,actor,aal))
    }
    for(const role of ['anon','service_role']){await denied(list('','name',20,0,ids.admin,'aal2',role));await denied(detail(groups.a,'accepted','',50,0,ids.admin,'aal2',role))}
    await db.query("update auth.mfa_factors set status='unverified' where user_id=$1",[ids.admin])
    await denied(list());await denied(detail())
    await db.query("update auth.mfa_factors set status='verified' where user_id=$1",[ids.admin])
    const original=first(await db.query("select pg_get_functiondef('xelay_is_platform_admin()'::regprocedure) as definition")).definition
    try{
      await db.exec("create or replace function public.xelay_is_platform_admin() returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select true $$")
      for(const [actor,aal] of [[ids.admin,'aal1'],[ids.noFactorAdmin,'aal2'],[ids.factorOnly,'aal2']]){await denied(list('','name',20,0,actor,aal));await denied(detail(groups.a,'accepted','',50,0,actor,aal))}
    }finally{await db.exec(original)}
  })

  await t.test('a valid admin JWT cannot bypass current Auth ban or soft deletion',async()=>{
    await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1",[ids.admin])
    try{await denied(list());await denied(detail())}finally{await db.query("update auth.users set banned_until=clock_timestamp()-interval '1 day' where id=$1",[ids.admin])}
    assert.equal((await list()).total,4)
    await db.query('update auth.users set deleted_at=clock_timestamp() where id=$1',[ids.admin])
    try{await denied(list());await denied(detail())}finally{await db.query('update auth.users set deleted_at=null,banned_until=null where id=$1',[ids.admin])}
  })

  await t.test('invalid filters, limits, offsets, long queries and controls have explicit errors',async()=>{
    for(const sort of [null,'all','MEMBERS_DESC'])await assert.rejects(list('',sort),/ADMIN_STUDY_GROUP_INPUT_INVALID/)
    for(const status of [null,'all','rejected','removed'])await assert.rejects(detail(groups.a,status),/ADMIN_STUDY_GROUP_INPUT_INVALID/)
    for(const limit of [null,0,-1,51]){await assert.rejects(list('','name',limit),/ADMIN_STUDY_GROUP_INPUT_INVALID/);await assert.rejects(detail(groups.a,'accepted','',limit),/ADMIN_STUDY_GROUP_INPUT_INVALID/)}
    for(const offset of [null,-1]){await assert.rejects(list('','name',20,offset),/ADMIN_STUDY_GROUP_INPUT_INVALID/);await assert.rejects(detail(groups.a,'accepted','',50,offset),/ADMIN_STUDY_GROUP_INPUT_INVALID/)}
    for(const query of ['я'.repeat(121),'🐧'.repeat(121),'a\nb','a\u0001b','a\u007fb']){await assert.rejects(list(query),/ADMIN_STUDY_GROUP_INPUT_INVALID/);await assert.rejects(detail(groups.a,'accepted',query),/ADMIN_STUDY_GROUP_INPUT_INVALID/)}
    assert.equal((await list('🐧'.repeat(120))).total,0)
    await assert.rejects(detail(null),/ADMIN_STUDY_GROUP_INPUT_INVALID/)
    await assert.rejects(detail(randomUUID()),error=>error.code==='P0002'&&/ADMIN_STUDY_GROUP_NOT_FOUND/.test(error.message))
  })

  await t.test('real typed frontend helpers accept actual SQL JSON from both RPCs',async()=>{
    const sqlByName={
      xelay_admin_study_groups:['select xelay_admin_study_groups($1,$2,$3,$4) as value',['p_query','p_sort','p_limit','p_offset']],
      xelay_admin_study_group_members:['select xelay_admin_study_group_members($1,$2,$3,$4,$5) as value',['p_group_id','p_status','p_query','p_limit','p_offset']],
    }
    const rpc=async(name,params)=>{
      assert.ok(Object.hasOwn(sqlByName,name));const [sql,keys]=sqlByName[name];assert.deepEqual(Object.keys(params).sort(),[...keys].sort())
      try{return {data:first(await asUser(ids.admin,sql,keys.map(key=>params[key]),{aal:'aal2'})).value,error:null}}
      catch(error){return {data:null,error:{code:error.code,message:error.message}}}
    }
    const module={exports:{}}
    const source=ts.transpileModule(await readFile(new URL('src/lib/adminStudyGroups.ts',root),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
    vm.runInNewContext(source,{module,exports:module.exports,Date,require(name){assert.equal(name,'./supabase');return {supabase:{rpc}}}})
    const api=module.exports
    for(const sort of ['name','members_desc','members_asc'])assert.equal((await api.loadAdminStudyGroups('',sort)).total,4)
    for(const group of Object.values(groups))for(const status of ['accepted','pending','inactive']){
      const result=await api.loadAdminStudyGroupMembers(group,status);assert.equal(result.group.id,group)
      assert.equal(result.total,status==='accepted'?result.group.accepted_count:status==='pending'?result.group.pending_count:result.group.inactive_count)
    }
    assert.equal((await api.loadAdminStudyGroupMembers(groups.a,'accepted','Anna')).total,1)
    assert.equal((await api.loadAdminStudyGroupMembers(groups.a,'accepted','',50,50)).items.length,5)
  })

  await t.test('all reads and idempotent migration reapply preserve every roster and content row',async()=>{
    const current=await runAudit();assert.deepEqual(current.relations,before.relations);assert.deepEqual(current.policies,before.policies);assert.deepEqual(current.table_security,before.table_security)
    await db.exec(migration);assert.deepEqual(await runAudit(),current)
    assert.doesNotMatch(migration,/\b(?:insert into|update public\.|delete from|create table|create policy|alter table|grant .+ on (?:public\.)?study_)/i)
  })
})
