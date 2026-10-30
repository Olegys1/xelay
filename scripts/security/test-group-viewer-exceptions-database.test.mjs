// Narrow directory/RLS integration, fictional rows only. The historical fixture
// supplies simple workspace read probes; it is not a full teaching ACL fixture.
// The real historical hide migration, new predicate migration, invoker-view RLS
// and actual admin-list/MFA function execute without cloud or working accounts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root=process.env.XELAY_AUDIT_SOURCE_ROOT||fileURLToPath(new URL('../../',import.meta.url))
const {PGlite}=createRequire(path.join(process.env.XELAY_AUDIT_DEPENDENCY_ROOT||root,'package.json'))('@electric-sql/pglite')
const hidden=['437c96ae-19d1-4bed-ae69-0b83ae9ec1b4','445fcadc-95e2-4f8c-bfb3-6d0998030a01']
const allowed=['04f587f8-1604-4f53-aabc-d1699c938b1d','b6d61792-89c5-48af-ad52-73806352ae61']
const id=n=>`dc000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const admin=id(1),outsider=id(2),newHead=id(3),unit=id(4),university=id(5),normal=id(6),sameName=id(7),other=id(8)
const readMigration=name=>readFile(path.join(root,'supabase/migrations',name),'utf8')

test('only two explicit viewers list test groups while actual group RLS and admin MFA remain authoritative',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close())
  const historicalFixture=(await readFile(path.join(root,'scripts/hidden-test-study-groups-database.test.mjs'),'utf8')).replaceAll('\r\n','\n')
  const sql=historicalFixture.match(/await db\.exec\(`([\s\S]*?)`\)\n  const adminSource/)?.[1]
  assert.ok(sql,'Known historical list-probe fixture setup must remain recognizable')
  assert.ok(!sql.includes('${'),'Historical fixture SQL must not interpolate identity values')
  await db.exec(sql)
  const adminSource=await readMigration('202610160009_admin_study_group_members.sql')
  const adminFunction=adminSource.match(/create or replace function public\.xelay_admin_study_groups\([\s\S]*?\nend \$\$;/)?.[0]
  assert.ok(adminFunction);await db.exec(adminFunction)
  await db.exec(`revoke all on function public.xelay_teaching_workspace_before_group_requests_20261027(),public.xelay_teaching_workspace_before_group_course_20261029() from public,anon,authenticated,service_role;
    revoke all on function public.xelay_teaching_workspace(),public.xelay_classroom_workspace(),public.xelay_teaching_calendar(date,date),public.xelay_android_widget_groups(),public.xelay_admin_study_groups(text,text,integer,integer) from public,anon,authenticated,service_role;
    grant execute on function public.xelay_teaching_workspace(),public.xelay_classroom_workspace(),public.xelay_teaching_calendar(date,date),public.xelay_android_widget_groups(),public.xelay_admin_study_groups(text,text,integer,integer) to authenticated;`)
  await db.query('insert into universities values($1,$2)',[university,'Synthetic university'])
  await db.query('insert into academic_units values($1,$2,$3)',[unit,university,'Synthetic faculty'])
  for(const who of [...allowed,admin,outsider,newHead]){
    await db.query('insert into profiles values($1,$2,$3)',[who,'Synthetic local identity',who])
    await db.query('insert into auth.users(id)values($1)',[who])
  }
  for(const who of [...allowed,admin]){
    await db.query("insert into user_roles values($1,'ADMIN')",[who])
    await db.query("insert into auth.mfa_factors values($1,'verified')",[who])
  }
  for(const[group,name,owner]of [[hidden[0],'ооо 1',allowed[0]],[hidden[1],'ЕУБ-4',allowed[1]],[normal,'ЕУБ-4',newHead],[sameName,'ооо 1',allowed[0]],[other,'Normal other group',newHead]]){
    await db.query("insert into study_groups(id,group_name,representative_id,university_id,academic_unit_id,specialty,cohort_start_year,study_level)values($1,$2,$3,$4,$5,'Synthetic programme',2026,'bachelor')",[group,name,owner,university,unit])
    await db.query("insert into synthetic_content values($1,'material','retained local reference'),($1,'grade','87')",[group])
    for(const who of [...allowed,admin,outsider,newHead])await db.query("insert into study_group_members values($1,$2,'accepted')",[group,who])
  }
  const historical=await readMigration('202610300002_hidden_test_study_groups.sql')
  const exceptions=await readMigration('202610300005_test_group_viewer_exceptions.sql')
  await db.exec(historical)
  const routines=async()=>(await db.query("select oid,proname,prosrc,proacl::text acl,proowner,prosecdef,provolatile,proconfig from pg_proc where pronamespace='public'::regnamespace order by oid")).rows
  const contents=async()=>(await db.query("select (select jsonb_agg(to_jsonb(g)order by id)from study_groups g)groups,(select jsonb_agg(to_jsonb(m)order by group_id,user_id)from study_group_members m)members,(select jsonb_agg(to_jsonb(c)order by group_id,kind)from synthetic_content c)content")).rows
  const beforeRoutines=await routines(),beforeContents=await contents()
  await db.exec(exceptions)
  async function as(who,operation,{role='authenticated',aal='aal2'}={}){
    await db.exec('set role '+role)
    try{await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.aal',$2,false)",[who||'',aal]);return await operation()}
    finally{await db.exec('reset role')}
  }
  const rpc=(who,name,args=[],options={})=>as(who,async()=>(await db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+')value',args)).rows[0].value,options)
  const listed=who=>as(who,async()=>(await db.query('select id from xelay_listed_study_groups order by id')).rows.map(row=>row.id))
  const all=[...hidden,normal,sameName,other].sort(),ordinary=[normal,sameName,other].sort()

  await t.test('allowlisted identities see eligible hidden groups; other admins, accepted members and owners do not',async()=>{
    for(const who of allowed)assert.deepEqual(await listed(who),all)
    for(const who of [admin,outsider,newHead])assert.deepEqual(await listed(who),ordinary)
    assert.deepEqual((await as(outsider,()=>db.query('select id from study_groups where id=any($1::uuid[])',[hidden]))).rows.map(row=>row.id).sort(),[...hidden].sort(),'Ordinary membership exists but must not act as a visibility exception')
    await db.query('update study_groups set representative_id=$1 where id=$2',[newHead,hidden[0]])
    assert.deepEqual(await listed(newHead),ordinary,'Becoming a representative does not change the explicit allowlist')
    await db.query('update study_groups set representative_id=$1 where id=$2',[allowed[0],hidden[0]])
  })

  await t.test('the invoker view still denies a hidden row when an allowlisted viewer has no underlying group access',async()=>{
    await db.query('delete from study_group_members where group_id=$1 and user_id=$2',[hidden[1],allowed[0]])
    assert.deepEqual(await listed(allowed[0]),all.filter(group=>group!==hidden[1]))
    await db.query("insert into study_group_members values($1,$2,'accepted')",[hidden[1],allowed[0]])
    const view=(await db.query("select reloptions from pg_class where oid='xelay_listed_study_groups'::regclass")).rows[0]
    assert.ok(view.reloptions.includes('security_invoker=true'))
  })

  await t.test('existing workspace/classroom/calendar/widget read surfaces use the caller-aware predicate',async()=>{
    for(const who of [...allowed,admin,outsider]){
      const expected=allowed.includes(who)?all:ordinary
      const workspace=await rpc(who,'xelay_teaching_workspace')
      assert.equal(workspace.sentinel,'preserved');assert.deepEqual(workspace.groups.map(group=>group.id).sort(),expected)
      assert.deepEqual(workspace.requests.sort(),expected)
      assert.deepEqual((await rpc(who,'xelay_classroom_workspace')).classrooms.sort(),expected)
      assert.deepEqual((await rpc(who,'xelay_teaching_calendar',['2026-10-30','2026-10-31'])).lessons.sort(),expected)
    }
    assert.deepEqual((await rpc(allowed[0],'xelay_android_widget_groups')).groups.sort(),[hidden[0],sameName].sort())
    assert.deepEqual((await rpc(allowed[1],'xelay_android_widget_groups')).groups,[hidden[1]])
    assert.deepEqual((await rpc(newHead,'xelay_android_widget_groups')).groups.sort(),[normal,other].sort())
  })

  await t.test('actual admin list totals, search and pagination distinguish allowlisted viewers without relaxing MFA',async()=>{
    for(const who of [...allowed,admin]){
      const expected=allowed.includes(who)?5:3
      const page=await rpc(who,'xelay_admin_study_groups',['','name',1,0])
      const next=await rpc(who,'xelay_admin_study_groups',['','name',1,1])
      assert.equal(page.total,expected);assert.equal(next.total,expected);assert.equal(page.items.length,1);assert.notEqual(page.items[0].id,next.items[0].id)
      const matching=await rpc(who,'xelay_admin_study_groups',['ооо','name',20,0])
      assert.deepEqual(matching.items.map(row=>row.id).sort(),allowed.includes(who)?[hidden[0],sameName].sort():[sameName])
    }
    await assert.rejects(rpc(allowed[0],'xelay_admin_study_groups',['','name',20,0],{aal:'aal1'}),/ADMIN_MFA_REQUIRED/)
    await assert.rejects(rpc(outsider,'xelay_admin_study_groups',['','name',20,0]),/ADMIN_MFA_REQUIRED/)
  })

  await t.test('null-user/service visibility and anonymous grants stay restricted; normal IDs are unchanged',async()=>{
    assert.equal(await rpc(null,'xelay_study_group_is_listed',[hidden[0]]),false)
    assert.equal(await rpc(null,'xelay_study_group_is_listed',[normal]),true)
    const serviceRows=await as(null,()=>db.query('select id from xelay_listed_study_groups order by id'),{role:'service_role'})
    assert.deepEqual(serviceRows.rows.map(row=>row.id),ordinary)
    await assert.rejects(as(null,()=>db.query('select * from xelay_listed_study_groups'),{role:'anon'}),/permission denied/)
    const grants=(await db.query("select has_table_privilege('authenticated','xelay_listed_study_groups','INSERT')i,has_table_privilege('authenticated','xelay_listed_study_groups','UPDATE')u,has_table_privilege('authenticated','xelay_listed_study_groups','DELETE')d")).rows[0]
    assert.deepEqual(grants,{i:false,u:false,d:false})
  })

  await t.test('all preexisting routine bodies/ACLs and group rows remain unchanged, and replay is idempotent',async()=>{
    assert.deepEqual((await routines()).filter(row=>beforeRoutines.some(old=>old.oid===row.oid)),beforeRoutines)
    assert.deepEqual(await contents(),beforeContents)
    const after=await routines()
    await db.exec(exceptions)
    assert.deepEqual(await routines(),after)
    assert.deepEqual(await contents(),beforeContents)
  })
})
