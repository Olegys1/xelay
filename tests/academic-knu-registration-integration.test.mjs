// Execute real registration, consent, profile protection and Google-completion
// triggers with the new gate. Isolated PostgreSQL, synthetic identities only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from '../scripts/security/fixture.mjs'

const sql = name => readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8')
const one = result => result.rows[0]
const version = '2026-10-15.1'

test('KNU gate composes with real signup and Google completion without changing old profiles or business registration', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610160003', beforeMigrationsSql: `
    alter table auth.users add column raw_app_meta_data jsonb default '{}', add column email_change text;
    create table auth.identities(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),provider text,identity_data jsonb);
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
  ` })
  t.after(() => fx.close())
  const { db, asUser } = fx
  await db.exec(await sql('202610220001_google_registration.sql'))
  // The gate delegates the reserved dean exception to the existing helper;
  // its separate role/2FA contract is covered by the dean provisioning tests.
  await db.exec(`create schema dean_private;
    create function dean_private.provisioned_identity(text,jsonb) returns boolean language sql as $$select false$$;
    update xelay_privacy_consent_settings set enforce_new_signups=true where singleton;`)
  const university=randomUUID(),unit=randomUUID(),specialty=randomUUID()
  await db.query("insert into universities(id,name,slug) values($1,'Synthetic university',$2)",[university,'knu-'+university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Synthetic faculty',$3,'faculty')",[unit,university,'knu-'+unit])
  await db.query("insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name) values($1,$2,$3,'KNU','Synthetic program','Synthetic program')",[specialty,university,unit])
  const metadata = (id,changes={}) => ({
    xelay_registration_version:1,account_type:'student',full_name:'Synthetic Student',
    username:'knu_'+id.replaceAll('-','').slice(0,16),country:'Україна',city:'Київ',bio:'',
    experience:'bachelor',study_year:3,categories:['General'],university_id:university,
    academic_unit_id:unit,specialty_id:specialty,specialty:'Synthetic program',
    xelay_privacy_consent:true,xelay_privacy_policy_version:version,xelay_privacy_consent_version:version,...changes,
  })
  const signup = (id,email,meta=metadata(id),app={}) => db.query(
    'insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data,email_confirmed_at) values($1,$2,$3,$4,now())',
    [id,email,JSON.stringify(meta),JSON.stringify(app)])
  const old = randomUUID(), oldGoogle=randomUUID()
  await signup(old,'old@example.test')
  await signup(oldGoogle,'old-google@example.test',{email_verified:true},{provider:'google'})
  await db.query("insert into auth.identities(user_id,provider,identity_data) values($1,'google','{\"email_verified\":true}')",[oldGoogle])
  const before = one(await db.query('select to_jsonb(p) row from profiles p where id=$1',[old])).row
  // Production never installed the unrelated profile/news security bundle.
  // The new email flow must establish its own confirmed-address protections.
  await db.exec('drop trigger if exists xelay_profile_auth_email_sync on auth.users; drop trigger if exists xelay_profile_server_fields_guard on public.profiles; drop function public.xelay_sync_profile_auth_email();')
  await db.exec(await sql('20261126124545_academic_knu_email.sql'))
  assert.deepEqual(one(await db.query('select to_jsonb(p) row from profiles p where id=$1',[old])).row,before)

  await t.test('student and teacher email signup create their profiles and real consent receipts', async () => {
    for(const kind of ['student','teacher']) {
      const id=randomUUID()
      const meta=metadata(id,kind==='teacher'?{account_type:'teacher',experience:'',specialty_id:null,specialty:'',categories:[],teacher_department:'Synthetic department',teacher_position:'Lecturer'}:{})
      await signup(id,kind+'@knu.ua',meta)
      const stored=one(await db.query('select id,email,account_type from profiles where id=$1',[id]))
      assert.deepEqual(stored,{id,email:kind+'@knu.ua',account_type:kind})
      assert.equal(one(await db.query('select count(*)::int n from user_privacy_consents where user_id=$1',[id])).n,1)
      await assert.rejects(signup(randomUUID(),kind+'@example.test',meta),/KNU_EMAIL_REQUIRED/)
    }
  })
  await t.test('KNU does not bypass required privacy consent', async () => {
    const id=randomUUID()
    await assert.rejects(signup(id,'missing-consent@knu.ua',metadata(id,{xelay_privacy_consent:false})),/PRIVACY_CONSENT_REQUIRED/)
    assert.equal(one(await db.query('select count(*)::int n from auth.users where id=$1',[id])).n,0)
  })
  await t.test('business email signup still creates only its separate organization account', async () => {
    await db.exec(`update opportunities_settings set data=jsonb_set(data,'{enabled}','true') where id`)
    const id=randomUUID(),meta=metadata(id,{
      xelay_registration_version:'company-1',registration_kind:'company',
      company_name:'Synthetic Company',company_terms_version:'opportunities-v1',
    })
    await signup(id,'business@example.test',meta)
    assert.equal(one(await db.query('select user_id from opportunities_business_accounts where user_id=$1',[id])).user_id,id)
    assert.equal(one(await db.query('select count(*)::int n from profiles where id=$1',[id])).n,0)
    await db.query("update auth.users set raw_user_meta_data='{}' where id=$1",[id])
    await assert.rejects(db.query("insert into profiles(id,email,full_name,username) values($1,'student@knu.ua','Synthetic','forged')",[id]),/BUSINESS_IDENTITY_SEPARATE/)
  })
  await t.test('new Google users require KNU and explicit profile completion; old provisional identities retain completion', async () => {
    await assert.rejects(signup(randomUUID(),'new-google@example.test',{email_verified:true},{provider:'google'}),/KNU_EMAIL_REQUIRED/)
    const id=randomUUID()
    await signup(id,'new-google@knu.ua',{email_verified:true},{provider:'google'})
    await db.query("insert into auth.identities(user_id,provider,identity_data) values($1,'google','{\"email_verified\":true}')",[id])
    for(const user of [id,oldGoogle]) {
      assert.equal(one(await db.query('select count(*)::int n from profiles where id=$1',[user])).n,0)
      const data={...metadata(user),expected_user_id:user}
      await assert.rejects(asUser(user,'select xelay_complete_google_registration($1,$2,$3,false)',[JSON.stringify(data),version,version]),/PRIVACY_CONSENT_REQUIRED/)
      await asUser(user,'select xelay_complete_google_registration($1,$2,$3,true)',[JSON.stringify(data),version,version])
      assert.equal(one(await db.query('select id from profiles where id=$1',[user])).id,user)
    }
  })
  await t.test('legacy email change retains profile identity and user edits cannot spoof its address', async () => {
    await db.query("update auth.users set email_change='legacy@knu.ua' where id=$1",[old])
    assert.equal(one(await db.query('select email from profiles where id=$1',[old])).email,'old@example.test')
    await db.query("update auth.users set email='legacy@knu.ua',email_change='' where id=$1",[old])
    assert.equal(one(await db.query('select email from profiles where id=$1',[old])).email,'legacy@knu.ua')
    await asUser(old,"update profiles set email='forged@knu.ua' where id=$1",[old])
    assert.equal(one(await db.query('select email from profiles where id=$1',[old])).email,'legacy@knu.ua')
  })
  await t.test('Auth soft deletion is still possible and does not create a replacement identity', async () => {
    const id=randomUUID()
    await signup(id,'delete@knu.ua')
    await db.query("update auth.users set deleted_at=now(),email='removed@deleted.invalid' where id=$1",[id])
    assert.ok(one(await db.query('select deleted_at from auth.users where id=$1',[id])).deleted_at)
  })
})
