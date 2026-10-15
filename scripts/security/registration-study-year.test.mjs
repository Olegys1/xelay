// Synthetic email-confirmation registrations against isolated PostgreSQL only.
// No Supabase Auth/provider requests, real accounts, emails or production data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

const first=result=>result.rows[0]
const migration=await readFile(new URL('../../supabase/migrations/202610160003_registration_study_year.sql',import.meta.url),'utf8')

test('server signup snapshot saves an explicit current course without changing privacy, identity or progression contracts',async t=>{
  const fx=await createFixture({useStagingParity:true,through:'202610160002',beforeMigrationsSql:`
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  `})
  t.after(()=>fx.close())
  const {db,asUser}=fx
  const university=randomUUID(),unit=randomUUID(),specialty=randomUUID()
  await db.query("insert into universities(id,name,slug) values($1,'Course signup university',$2)",[university,'course-'+university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Course signup faculty',$3,'faculty')",[unit,university,'course-'+unit])
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'YEAR','Course signup program','Course signup program')`,[specialty,university,unit])
  await db.exec('update xelay_privacy_consent_settings set enforce_new_signups=true where singleton')
  const academicYear=first(await db.query('select xelay_current_academic_year() as year')).year
  const functionBefore=first(await db.query(`select proowner::text as owner,proacl::text as acl from pg_proc
    where oid='public.xelay_create_registration_profile()'::regprocedure`))
  const triggerBefore=(await db.query(`select tgname,pg_get_triggerdef(oid) as body from pg_trigger
    where tgrelid in('auth.users'::regclass,'public.profiles'::regclass) and not tgisinternal order by tgname`)).rows
  await db.exec(migration)
  const signup=async(patch={},id=randomUUID())=>{
    const metadata={xelay_registration_version:1,xelay_privacy_consent:true,xelay_privacy_policy_version:'2026-10-15.1',
      xelay_privacy_consent_version:'2026-10-15.1',account_type:'student',full_name:'Synthetic course student',
      username:'year_'+id.replaceAll('-','').slice(0,16),country:'Україна',city:'Київ',bio:'Synthetic signup',
      experience:'bachelor',categories:['General'],university_id:university,academic_unit_id:unit,
      specialty_id:specialty,specialty:'Ignored forged client label',...patch}
    await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,null,$3::jsonb)',
      [id,id+'@example.test',JSON.stringify(metadata)])
    return id
  }
  const profile=async id=>first(await db.query('select to_jsonb(p) as value from profiles p where id=$1',[id]))?.value
  const counts=async()=>first(await db.query(`select (select count(*)::int from auth.users) as auth,
    (select count(*)::int from profiles) as profiles,(select count(*)::int from user_privacy_consents) as consents`))

  await t.test('active student courses 1 through6 survive the no-session email-confirmation registration path',async()=>{
    for(const experience of ['bachelor','master','postgraduate']) for(const course of [1,2,3,4,5,6]) {
      const id=await signup({experience,study_year:course}),stored=await profile(id)
      assert.equal(stored.study_year,course)
      assert.equal(stored.experience,experience)
      assert.equal(stored.study_year_auto_advance,true)
      assert.equal(stored.study_year_academic_year,academicYear)
      assert.equal(stored.study_year_needs_review,false)
      assert.equal(stored.study_program_years,null)
      const defaultYears={bachelor:4,master:2,postgraduate:4}[experience]
      assert.ok(Math.max(defaultYears,stored.study_year)>=course)
      assert.equal(stored.specialty,'Course signup program')
      assert.equal(stored.faculty,'Course signup faculty')
      assert.equal(first(await db.query('select email_confirmed_at from auth.users where id=$1',[id])).email_confirmed_at,null)
      assert.equal(first(await db.query("select count(*)::int as n from user_privacy_consents where user_id=$1 and source='signup'",[id])).n,1)
    }
  })

  await t.test('cached missing/null courses remain optional, while exact numeric strings are compatible',async()=>{
    for(const experience of ['bachelor','master','postgraduate']) {
      assert.equal((await profile(await signup({experience}))).study_year,null)
      assert.equal((await profile(await signup({experience,study_year:null}))).study_year,null)
      assert.equal((await profile(await signup({experience,study_year:'2'}))).study_year,2)
    }
  })

  await t.test('malformed explicit active courses fail atomically with a stable field error and no orphan Auth/profile/consent rows',async()=>{
    for(const course of [0,-1,7,100000,1.5,'1.0','2foo',' 2 ','',true,{},[],[2]]) {
      const id=randomUUID(),before=await counts()
      await assert.rejects(signup({study_year:course},id),error=>error.code==='23514'&&error.message.includes('STUDY_YEAR_INVALID'))
      assert.deepEqual(await counts(),before)
      assert.equal(await profile(id),undefined)
    }
  })

  await t.test('graduates and teacher-only registrations have no course, while teacher verification still works',async()=>{
    for(const study_year of [3,'6',{}]) {
      const graduate=await signup({experience:'graduate',study_year})
      assert.equal((await profile(graduate)).study_year,null)
      const teacher=await signup({account_type:'teacher',experience:'',study_year,teacher_department:'Synthetic department',
        teacher_position:'Synthetic lecturer',categories:[],specialty_id:null,specialty:''})
      const stored=await profile(teacher)
      assert.equal(stored.study_year,null)
      assert.equal(stored.account_type,'teacher')
      assert.equal(stored.experience,'')
      assert.equal(stored.specialty_id,null)
      const verification=first(await db.query('select status,department,position from teacher_verification_requests where user_id=$1',[teacher]))
      assert.equal(verification.status,'pending')
      assert.equal(verification.department,'Synthetic department')
    }
  })

  await t.test('the current course cannot forge an academic-year baseline or override progression/consent evidence with extra metadata',async()=>{
    const id=await signup({study_year:5,study_year_academic_year:2200,study_year_needs_review:true,
      study_program_years:1,study_year_auto_advance:false,xelay_privacy_accepted_at:'1900-01-01T00:00:00Z'})
    const before=await profile(id)
    assert.equal(before.study_year,5)
    assert.equal(before.study_year_academic_year,academicYear)
    assert.equal(before.study_year_needs_review,false)
    assert.equal(before.study_year_auto_advance,true)
    assert.equal(before.study_program_years,null)
    const receipt=first(await db.query('select accepted_at::text as accepted_at from user_privacy_consents where user_id=$1',[id]))
    assert.ok(!receipt.accepted_at.startsWith('1900'))
    await db.query(`update auth.users set raw_user_meta_data=raw_user_meta_data||'{"study_year":2,"study_year_academic_year":2200}' where id=$1`,[id])
    assert.deepEqual(await profile(id),before)
    await assert.rejects(asUser(id,'update profiles set study_year_academic_year=2200 where id=$1',[id]),/PROFILE_ACADEMIC_ANCHOR_SERVER_OWNED/)
    assert.deepEqual(await profile(id),before)
  })

  await t.test('nickname collision fallback still preserves the selected course and never updates another account',async()=>{
    const handle='course_'+randomUUID().replaceAll('-','').slice(0,12)
    const original=await signup({username:handle,study_year:1}),before=await profile(original)
    const second=await signup({username:handle,study_year:4}),stored=await profile(second)
    assert.notEqual(stored.username,handle)
    assert.ok(stored.username)
    assert.equal(stored.study_year,4)
    assert.deepEqual(await profile(original),before)
  })

  await t.test('migration rerun preserves all accounts, receipts, Auth/profile triggers, function owner and execution permissions',async()=>{
    const before=(await db.query('select to_jsonb(p) as value from profiles p order by id')).rows
    const receipts=(await db.query('select to_jsonb(c) as value from user_privacy_consents c order by user_id')).rows
    await db.exec(migration)
    assert.deepEqual((await db.query('select to_jsonb(p) as value from profiles p order by id')).rows,before)
    assert.deepEqual((await db.query('select to_jsonb(c) as value from user_privacy_consents c order by user_id')).rows,receipts)
    assert.deepEqual(first(await db.query(`select proowner::text as owner,proacl::text as acl from pg_proc
      where oid='public.xelay_create_registration_profile()'::regprocedure`)),functionBefore)
    assert.deepEqual((await db.query(`select tgname,pg_get_triggerdef(oid) as body from pg_trigger
      where tgrelid in('auth.users'::regclass,'public.profiles'::regclass) and not tgisinternal order by tgname`)).rows,triggerBefore)
  })
})
