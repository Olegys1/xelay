import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { isKnuEmail } from '../src/lib/academicEmail.ts'
import { parseEmailLink } from '../src/lib/authEmailLinks.ts'

const migration = await readFile(new URL('../supabase/migrations/20261126124545_academic_knu_email.sql', import.meta.url), 'utf8')
async function fixture() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema dean_private;
    create table auth.users(id uuid primary key,email text,email_change text,deleted_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}');
    create table public.profiles(id uuid primary key references auth.users(id),email text);
    create table public.opportunities_business_accounts(user_id uuid primary key references auth.users(id));
    create table public.preserved_work(user_id uuid references auth.users(id),kind text,data jsonb);
    create function dean_private.provisioned_identity(p_email text,p_meta jsonb) returns boolean language sql as $$
      select current_setting('role',true)='service_role' and p_email ~ '^dean-[a-f0-9]{10}@dean[.]xelay[.]ink$' and p_meta->'dean_service'='true'::jsonb $$;
    create function public.xelay_sync_profile_auth_email() returns trigger language plpgsql security definer as $$begin
      update public.profiles set email=new.email where id=new.id; return new; end $$;
    create trigger xelay_profile_auth_email_sync after update of email on auth.users for each row execute function public.xelay_sync_profile_auth_email();
    grant usage on schema auth,public to authenticated,service_role;
    grant insert,update,select on auth.users to service_role;
    grant insert,select on profiles to authenticated;
  `)
  const old = randomUUID(), business = randomUUID()
  await db.query('insert into auth.users(id,email) values($1,$2),($3,$4)', [old,'old@example.test',business,'company@example.test'])
  await db.query('insert into profiles values($1,$2)', [old,'old@example.test'])
  await db.query('insert into opportunities_business_accounts values($1)', [business])
  for (const kind of ['grades','groups','paid-subscription','gift','ai-history']) {
    await db.query('insert into preserved_work values($1,$2,$3)', [old,kind,JSON.stringify({sentinel:kind,value:42})])
  }
  await db.exec(migration)
  async function signup(email,meta={},app={}) {
    const id=randomUUID()
    await db.query('insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data) values($1,$2,$3,$4)',[id,email,JSON.stringify(meta),JSON.stringify(app)])
    return id
  }
  return {db,old,business,signup}
}

test('exact KNU domain accepts case and aliases; rejects suffix, subdomain, whitespace and control bypasses',async()=>{
  const {db}=await fixture()
  try {
    for(const [email,valid] of [['student@knu.ua',true],['Name+test@KNU.UA',true],['name@knu.ua.evil.test',false],['name@sub.knu.ua',false],['name@knu.ua@evil.test',false],['@knu.ua',false],['na me@knu.ua',false],['name@knu.ua\n',false],['name\t@knu.ua',false],[null,false]]) {
      const sql=await db.query('select academic_identity_private.is_knu_email($1) as ok',[email])
      assert.equal(sql.rows[0].ok,valid,String(email))
      // UI trims accidental outer whitespace before it sends the canonical email.
      assert.equal(isKnuEmail(email),typeof email==='string' && email.endsWith('\n') ? true : valid,String(email))
    }
  } finally {await db.close()}
})

test('server rejects direct, legacy-metadata, forged dean and new Google non-KNU signup; no row survives',async()=>{
  const {db,signup}=await fixture()
  try {
    for(const [meta,app] of [[{},{}],[{xelay_registration_version:1},{}],[{dean_service:true},{}],[{email_verified:true},{provider:'google'}]]) {
      await assert.rejects(signup('student@example.test',meta,app),/KNU_EMAIL_REQUIRED/)
    }
    await assert.rejects(signup('dean-0123456789@dean.xelay.ink',{}, {dean_service:true}),/KNU_EMAIL_REQUIRED/)
    assert.equal((await db.query('select count(*)::int as n from auth.users')).rows[0].n,2)
    const student=await signup('student@knu.ua',{xelay_registration_version:1})
    const google=await signup('google@knu.ua',{email_verified:true},{provider:'google'})
    for(const id of [student,google]) await db.query('insert into profiles values($1,$2)',[id,'ignored@test'])
    assert.equal((await db.query('select count(*)::int as n from profiles')).rows[0].n,3)
  } finally {await db.close()}
})

test('business and school signup retain any email but metadata edits cannot create an academic profile',async()=>{
  const {db,signup,business}=await fixture()
  try {
    for(const kind of ['company','school']) {
      const id=await signup(kind+'@example.test',{xelay_registration_version:'company-1',registration_kind:'company',organization_kind:kind})
      await db.query("update auth.users set raw_user_meta_data='{}',email='changed@example.test' where id=$1",[id])
      await assert.rejects(db.query('insert into profiles values($1,$2)',[id,'forged@knu.ua']),/BUSINESS_IDENTITY_SEPARATE/)
    }
    await assert.rejects(db.query('insert into profiles values($1,$2)',[business,'old@knu.ua']),/BUSINESS_IDENTITY_SEPARATE/)
  } finally {await db.close()}
})

test('legacy identity keeps all work; pending email change leaves profile unchanged; confirmed change keeps UUID',async()=>{
  const {db,old}=await fixture()
  try {
    const before=(await db.query('select * from preserved_work order by kind')).rows
    await db.query("update auth.users set raw_user_meta_data='{\"last_login\":true}' where id=$1",[old])
    await db.query("update auth.users set email_change='old@knu.ua' where id=$1",[old])
    assert.equal((await db.query('select email from profiles where id=$1',[old])).rows[0].email,'old@example.test')
    await db.query("update auth.users set email='old@knu.ua',email_change='' where id=$1",[old])
    assert.deepEqual((await db.query('select * from profiles where id=$1',[old])).rows,[{id:old,email:'old@knu.ua'}])
    assert.deepEqual((await db.query('select * from preserved_work order by kind')).rows,before)
    await assert.rejects(db.query("update auth.users set email_change='back@example.test' where id=$1",[old]),/KNU_EMAIL_REQUIRED/)
    await assert.rejects(db.query("update auth.users set email='back@example.test' where id=$1",[old]),/KNU_EMAIL_REQUIRED/)
    await db.query("update auth.users set email_change='' where id=$1",[old])
  } finally {await db.close()}
})

test('classification and functions are inaccessible to ordinary clients; trusted dean provisioning still works',async()=>{
  const {db,signup}=await fixture()
  try {
    await db.exec('set role authenticated')
    await assert.rejects(db.exec('select * from academic_identity_private.accounts'),/permission denied/)
    await assert.rejects(db.exec('select academic_identity_private.is_knu_email(\'x@knu.ua\')'),/permission denied/)
    await db.exec('set role service_role')
    const id=await signup('dean-0123456789@dean.xelay.ink',{}, {dean_service:true})
    await db.exec('reset role')
    await db.query('insert into profiles values($1,$2)',[id,'dean-0123456789@dean.xelay.ink'])
    assert.equal((await db.query('select kind from academic_identity_private.accounts where user_id=$1',[id])).rows[0].kind,'service')
  } finally {await db.close()}
})

test('email-change callback reuses explicit confirmation and never treats a different path as an auth link',()=>{
  const result=parseEmailLink(new URL('https://www.xelay.ink/auth/callback#type=email_change&access_token=synthetic-access&refresh_token=synthetic-refresh'))
  assert.equal(result.kind,'confirmation'); assert.equal(result.isEmailChange,true)
  assert.ok(result.tokens)
  assert.equal(parseEmailLink(new URL('https://www.xelay.ink/groups#type=email_change&access_token=x&refresh_token=y')).tokens,null)
})


test('first confirmation redirect is a UI hint, never a verified session',()=>{
 const url=new URL('https://www.xelay.ink/auth/callback');url.searchParams.set('message','Confirmation link accepted. Please proceed to confirm link sent to the other email');
 const result=parseEmailLink(url);assert.equal(result.emailChangeHint,true);assert.equal(result.kind,null);assert.equal(result.tokens,null);
})
