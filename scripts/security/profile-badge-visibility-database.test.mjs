// Actual migration applied to the complete existing PostgreSQL chain using
// synthetic local PGlite accounts. No live services or credentials are used.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {createFixture} from './fixture.mjs'

const migration=await readFile(new URL('../../supabase/migrations/202610180002_profile_badge_visibility.sql',import.meta.url),'utf8')
const audit=await readFile(new URL('../../supabase/audits/202610180002_profile_badge_visibility.sql',import.meta.url),'utf8')
const defaults={showParticipant:true,showTeacher:true}
const denied=p=>assert.rejects(p,error=>error.code==='42501')

test('profile badge visibility is an independent decorative preference, never an access or verification mutation',async t=>{
  const fx=await createFixture({useStagingParity:true,through:'202610180001',beforeMigrationsSql:`
    create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;`})
  t.after(()=>fx.close())
  const {db,seedUser}=fx
  const [owner,other,deleted]=[randomUUID(),randomUUID(),randomUUID()]
  const scope=(await db.query('select id,university_id from academic_units where is_active limit 1')).rows[0]
  for(const id of [owner,other,deleted])await seedUser(id,{
    username:'badge_'+id.replaceAll('-','').slice(0,10),categories:['General'],
    ...(id===owner?{account_type:'teacher',university_id:scope.university_id,academic_unit_id:scope.id}:{}),
  })
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')",[owner])
  await db.query(`insert into teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department,status)
    values($1,'Synthetic verified teacher',$2,$3,'Synthetic department','approved')`,[owner,scope.university_id,scope.id])
  await db.query(`insert into participant_entitlements(user_id,source,term_months,valid_from,valid_until)
    values($1,'admin_grant',1,now()-interval '1 day',now()+interval '29 days')`,[owner])
  const before=(await db.query(audit)).rows[0].audit
  await db.exec(migration)
  const after=(await db.query(audit)).rows[0].audit
  async function run(user,sql,args=[],role='authenticated'){
    return db.transaction(async tx=>{
      await tx.exec('set local role '+role)
      await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,role,aal:'aal1'})])
      return (await tx.query(sql,args)).rows
    })
  }
  const read=async(user,actor=null,role='anon')=>(await run(actor,'select xelay_profile_badge_preferences($1) as v',[user],role))[0].v
  const write=async(a,b,user=owner)=>(await run(user,'select xelay_set_my_profile_badges($1,$2) as v',[a,b]))[0].v
  const authority=async()=>({
    access:(await db.query('select xelay_has_participant_access($1) as v',[owner])).rows[0].v,
    teacher:(await db.query('select xelay_teaching_is_verified($1) as v',[owner])).rows[0].v,
    roles:(await db.query('select to_jsonb(r) as v from user_roles r order by id')).rows,
    entitlements:(await db.query('select to_jsonb(e) as v from participant_entitlements e order by id')).rows,
    verification:(await db.query('select to_jsonb(r) as v from teacher_verification_requests r order by id')).rows,
  })
  const authorityBefore=await authority()
  assert.equal(authorityBefore.access,true)
  assert.equal(authorityBefore.teacher,true)

  await t.test('installation preserves all existing data, function bodies, function grants, table ACLs and policies',async()=>{
    for(const key of ['existing_data','other_functions_hash','existing_table_acl_hash','existing_policies_hash'])assert.deepEqual(after[key],before[key],key)
    assert.deepEqual(before.functions,[])
    assert.deepEqual(after.table,{rls:true,anon_select:false,authenticated_select:false,authenticated_write:false,service_select:false})
    assert.equal((await db.query('select count(*)::int as n from profile_badge_preferences')).rows[0].n,0)
  })
  await t.test('both functions pin search_path and grant only the intended minimal read and own write entry points',async()=>{
    assert.equal(after.functions.length,2)
    for(const fn of after.functions){
      assert.equal(fn.security_definer,true)
      assert.ok(fn.config.includes('search_path=""'))
      assert.equal(fn.authenticated_execute,true)
      assert.equal(fn.anon_execute,fn.name==='xelay_profile_badge_preferences')
      assert.equal(fn.service_execute,fn.name==='xelay_profile_badge_preferences')
    }
    assert.deepEqual((await db.query("select policyname from pg_policies where tablename='profile_badge_preferences'")).rows,[])
    assert.equal((await db.query("select count(*)::int as n from pg_proc where pronamespace='public'::regnamespace and proname in('xelay_profile_badge_preferences','xelay_set_my_profile_badges')")).rows[0].n,2)
  })
  await t.test('read returns exactly two booleans and identical defaults for existing, unknown and null accounts',async()=>{
    for(const user of [owner,other,randomUUID(),null]){
      for(const role of ['anon','authenticated','service_role'])assert.deepEqual(await read(user,null,role),defaults)
    }
    assert.deepEqual(Object.keys(await read(owner)).sort(),['showParticipant','showTeacher'])
    assert.equal((await db.query('select count(*)::int as n from profile_badge_preferences')).rows[0].n,0)
  })
  await t.test('every hide and restore combination persists, is publicly honored, and never changes authority',async()=>{
    for(const [showParticipant,showTeacher] of [[false,true],[true,false],[false,false],[true,true]]){
      const expected={showParticipant,showTeacher}
      assert.deepEqual(await write(showParticipant,showTeacher),expected)
      for(const role of ['anon','authenticated','service_role'])assert.deepEqual(await read(owner,other,role),expected)
      assert.deepEqual(await read(other),defaults)
      assert.deepEqual(await authority(),authorityBefore)
    }
  })
  await t.test('anonymous, missing-sub and service-role callers cannot use the setter',async()=>{
    await denied(run(null,'select xelay_set_my_profile_badges(false,false)',[],'anon'))
    await denied(run(null,'select xelay_set_my_profile_badges(false,false)'))
    await denied(run(owner,'select xelay_set_my_profile_badges(false,false)',[],'service_role'))
    assert.deepEqual(await read(owner),defaults)
  })
  await t.test('nulls are rejected atomically and an authenticated caller has no owner parameter or cross-account write',async()=>{
    for(const values of [[null,true],[true,null],[null,null]])await assert.rejects(write(...values),error=>error.code==='22023')
    assert.deepEqual(await read(owner),defaults)
    await assert.rejects(run(other,'select xelay_set_my_profile_badges(false,false,$1)',[owner]),error=>error.code==='42883')
    await write(false,false,other)
    assert.deepEqual(await read(other),{showParticipant:false,showTeacher:false})
    assert.deepEqual(await read(owner),defaults)
    assert.deepEqual(await authority(),authorityBefore)
    assert.equal((await db.query('select xelay_has_participant_access($1) as v',[other])).rows[0].v,false)
    assert.equal((await db.query('select xelay_teaching_is_verified($1) as v',[other])).rows[0].v,false)
  })
  await t.test('no app role can directly read, insert, update or delete preference table rows',async()=>{
    for(const role of ['anon','authenticated','service_role']){
      for(const [sql,args] of [
        ['select * from profile_badge_preferences',[]],
        ['insert into profile_badge_preferences(user_id) values($1)',[deleted]],
        ['update profile_badge_preferences set show_teacher=true where user_id=$1',[other]],
        ['delete from profile_badge_preferences where user_id=$1',[other]],
      ])await denied(run(owner,sql,args,role))
    }
    assert.deepEqual(await read(other),{showParticipant:false,showTeacher:false})
  })
  await t.test('preferences cannot reference missing accounts and are automatically removed with their account',async()=>{
    await assert.rejects(write(false,false,randomUUID()),error=>error.code==='23503')
    await write(false,false,deleted)
    await db.query('delete from auth.users where id=$1',[deleted])
    assert.equal((await db.query('select count(*)::int as n from profile_badge_preferences where user_id=$1',[deleted])).rows[0].n,0)
    assert.deepEqual(await read(deleted),defaults)
    assert.deepEqual(await authority(),authorityBefore)
  })
})
