// Real isolated PostgreSQL guards. This does not prove GoTrue/SMTP settings.
// No test uses production identities, triggers disabled after activation, or mail.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'
const migration=await readFile(new URL('../../supabase/migrations/202611030002_knu_email_registration.sql',import.meta.url),'utf8')
const blank={verifiedEmail:null,verifiedAt:null,authEmailVerified:false}
const hmac=(user,email,id,code='123456')=>createHmac('sha256','fictional-test-only-challenge-secret').update(['xelay-knu-v1',user,email,id,code].join('\n')).digest('hex')

test('KNU signup and secondary proof preserve legacy identity and resist bypass or replay',async t=>{
  const fx=await createFixture({setupOnly:true,useStagingBaseline:true,beforeMigrationsSql:`
    alter table auth.users add column raw_app_meta_data jsonb not null default '{}';
    create table public.fixture_legacy_records(user_id uuid primary key references auth.users(id),saved jsonb not null);
  `});t.after(()=>fx.close())
  const {db,asUser}=fx
  const legacy=randomUUID(),other=randomUUID(),googleIncomplete=randomUUID(),staff=randomUUID(),newUser=randomUUID(),squat=randomUUID(),probe=randomUUID()
  const personal='old.login@example.test',secondary='first.proof@knu.ua',squatted='second.proof@knu.ua'
  const insert=(id,email,confirmed=false,provider='email',user={})=>db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values($1,$2,case when $3::boolean then now() end,jsonb_build_object('provider',$4::text),$5::jsonb)`,[id,email,confirmed,provider,JSON.stringify(user)])
  await insert(legacy,personal,true);await insert(other,'other@example.test',true)
  await insert(probe,'probe@example.test',true)
  await insert(googleIncomplete,'old.google@example.test',true,'google',{email_verified:true})
  await insert(staff,'Synthetic.Staff@KNU.UA',true)
  await db.query("insert into fixture_legacy_records values($1,'{\"group\":\"synthetic\",\"grade\":9,\"subscription\":true}')",[legacy])
  const oldData=(await db.query('select * from fixture_legacy_records')).rows
  const oldAuth=(await db.query('select id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data from auth.users order by id')).rows
  await db.exec(migration)
  const call=async(user,name,args=[],role='service_role')=>(await asUser(user,`select ${name}(${args.map((_,index)=>'$'+(index+1)).join(',')}) data`,args,{role})).rows[0].data
  const status=user=>call(user,'xelay_knu_email_status',[],'authenticated')
  const prepare=(user,id,email)=>call(user,'xelay_knu_email_prepare',[user,id,email,hmac(user,email,id)])
  const deliver=(user,id,sent=true)=>call(user,'xelay_knu_email_delivery',[user,id,sent])
  const verify=(user,id,email,code='123456')=>call(user,'xelay_knu_email_verify',[user,id,hmac(user,email,id,code)])
  const moveCooldown=async id=>db.query("update xelay_knu_email_challenges set created_at=now()-interval '61 seconds',expires_at=now()+interval '8 minutes',resend_at=now()-interval '1 second' where id=$1",[id])

  await t.test('all prior Auth IDs and canonical addresses are grandfathered without profile or role changes',async()=>{
    assert.deepEqual((await db.query('select id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data from auth.users order by id')).rows,oldAuth)
    assert.deepEqual((await db.query('select user_id from xelay_knu_email_legacy_users order by user_id')).rows.map(r=>r.user_id),oldAuth.map(r=>r.id))
    assert.deepEqual(await status(legacy),blank)
    assert.deepEqual(await status(googleIncomplete),blank,'existing Auth ID need not have finished its Google profile')
    assert.equal((await status(staff)).verifiedEmail,'synthetic.staff@knu.ua');assert.equal((await status(staff)).authEmailVerified,true)
    await db.query("update auth.users set email='old.google.changed@example.test' where id=$1",[googleIncomplete])
    assert.deepEqual(await status(googleIncomplete),blank)
  })
  await t.test('real Auth INSERT and the restricted hook reject non-KNU paths regardless of metadata/provider',async()=>{
    const bad=['x@gmail.com','x@faculty.knu.ua','x@knu.ua.attacker.test','x@fakeknu.ua','a..b@knu.ua','a@knu.ua@other.test','a\u200b@knu.ua','x@Knu.ua']
    for(const address of bad){
      const hook=await call(null,'xelay_before_user_created_knu',[JSON.stringify({user:{email:address,raw_app_meta_data:{provider:'google'},user_metadata:{email:'forged@knu.ua',account_type:'teacher',email_verified:true}}})],'supabase_auth_admin')
      assert.equal(hook.error.http_code,400);assert.match(hook.error.message,/KNU_EMAIL_REQUIRED/)
      await assert.rejects(insert(randomUUID(),address,false,'google',{email:'forged@knu.ua',email_verified:true}),/KNU_EMAIL_REQUIRED/)
    }
    assert.deepEqual(await call(null,'xelay_before_user_created_knu',[JSON.stringify({user:{email:' Name+Office@KNU.UA '}})],'supabase_auth_admin'),{})
    await assert.rejects(call(legacy,'xelay_before_user_created_knu',[JSON.stringify({user:{email:secondary}})],'authenticated'),e=>e.code==='42501')
    await insert(newUser,'new.user@knu.ua')
    assert.equal((await db.query('select count(*)n from xelay_knu_email_affiliations where user_id=$1',[newUser])).rows[0].n,0)
    await assert.rejects(status(newUser),/KNU_EMAIL_AUTH_REQUIRED/)
    await db.query('update auth.users set email_confirmed_at=now() where id=$1',[newUser])
    assert.equal((await status(newUser)).authEmailVerified,true)
    assert.equal((await prepare(newUser,randomUUID(),'different.knu@knu.ua')).alreadyVerified,true,'a canonical KNU account cannot claim a second address')
    await assert.rejects(db.query("update auth.users set email='bypass@example.test' where id=$1",[newUser]),/KNU_EMAIL_REQUIRED/)
    assert.equal((await db.query('select email from auth.users where id=$1',[newUser])).rows[0].email,'new.user@knu.ua')
  })
  await t.test('direct clients cannot read challenges, set proof, see another user or reserve mail',async()=>{
    for(const table of['xelay_knu_email_challenges','xelay_knu_email_affiliations','xelay_knu_email_legacy_users'])
      await assert.rejects(asUser(legacy,`select * from ${table}`),e=>e.code==='42501')
    await assert.rejects(call(legacy,'xelay_private_knu_status',[staff],'authenticated'),e=>e.code==='42501')
    await assert.rejects(call(legacy,'xelay_knu_email_prepare',[legacy,randomUUID(),secondary,'a'.repeat(64)],'authenticated'),e=>e.code==='42501')
    await assert.rejects(call(legacy,'xelay_knu_email_verify',[legacy,randomUUID(),'a'.repeat(64)],'authenticated'),e=>e.code==='42501')
  })
  let occupiedChallenge
  await t.test('request and wrong code do not disclose that another account already owns an address',async()=>{
    occupiedChallenge=randomUUID();const email='synthetic.staff@knu.ua'
    assert.deepEqual(await prepare(probe,occupiedChallenge,email),{ok:true,id:occupiedChallenge})
    await deliver(probe,occupiedChallenge)
    assert.equal((await verify(probe,occupiedChallenge,email,'999999')).code,'KNU_EMAIL_CODE_INVALID')
    assert.equal((await verify(probe,occupiedChallenge,email)).code,'KNU_EMAIL_IN_USE','only a correct code may reveal the collision')
    assert.equal((await status(probe)).verifiedEmail,null)
  })
  let first,second
  await t.test('pending delivery cannot prove ownership; cooldown and five wrong guesses persist',async()=>{
    first=randomUUID();assert.equal((await prepare(legacy,first,secondary)).ok,true)
    assert.deepEqual(await status(legacy),blank)
    assert.equal((await verify(legacy,first,secondary)).code,'KNU_EMAIL_CODE_INVALID')
    assert.equal((await prepare(legacy,randomUUID(),secondary)).code,'KNU_EMAIL_RATE_LIMIT')
    assert.equal((await deliver(legacy,first)).status.challenge.id,first)
    assert.equal((await call(other,'xelay_knu_email_challenge',[other,first])).code,'KNU_EMAIL_CODE_INVALID')
    assert.equal((await verify(other,first,secondary)).code,'KNU_EMAIL_CODE_INVALID')
    assert.equal((await db.query('select attempts from xelay_knu_email_challenges where id=$1',[first])).rows[0].attempts,0)
    for(let index=0;index<5;index++)assert.equal((await verify(legacy,first,secondary,'999999')).code,'KNU_EMAIL_CODE_INVALID')
    assert.equal((await db.query('select attempts from xelay_knu_email_challenges where id=$1',[first])).rows[0].attempts,5)
    assert.equal((await verify(legacy,first,secondary)).code,'KNU_EMAIL_CODE_INVALID')
    assert.deepEqual(await status(legacy),blank)
  })
  await t.test('new proof invalidates an older challenge and keeps the original Auth account and data',async()=>{
    await moveCooldown(first);second=randomUUID();assert.equal((await prepare(legacy,second,secondary)).ok,true)
    assert.equal((await db.query('select state from xelay_knu_email_challenges where id=$1',[first])).rows[0].state,'invalidated')
    await deliver(legacy,second)
    const verified=await verify(legacy,second,secondary);assert.equal(verified.ok,true);assert.equal(verified.status.verifiedEmail,secondary)
    assert.equal(verified.status.authEmailVerified,false);assert.equal(verified.status.challenge,undefined)
    assert.equal((await verify(legacy,second,secondary)).code,'KNU_EMAIL_CODE_INVALID')
    await moveCooldown(occupiedChallenge)
    const duplicate=randomUUID();assert.equal((await prepare(probe,duplicate,secondary)).ok,true)
    await deliver(probe,duplicate)
    assert.equal((await verify(probe,duplicate,secondary,'999999')).code,'KNU_EMAIL_CODE_INVALID')
    assert.equal((await verify(probe,duplicate,secondary)).code,'KNU_EMAIL_IN_USE')
    await assert.rejects(insert(randomUUID(),secondary,true,'google'),/KNU_EMAIL_IN_USE/)
    const pending=randomUUID();await insert(pending,secondary)
    await assert.rejects(db.query('update auth.users set email_confirmed_at=now() where id=$1',[pending]),/KNU_EMAIL_IN_USE/)
    assert.equal((await db.query('select email from auth.users where id=$1',[legacy])).rows[0].email,personal)
    assert.deepEqual((await db.query('select * from fixture_legacy_records')).rows,oldData)
  })
  await t.test('pending Auth reservation cannot squat a legitimate proof or later confirm as a second identity',async()=>{
    await insert(squat,squatted)
    await moveCooldown(second)
    const id=randomUUID();assert.equal((await prepare(legacy,id,squatted)).ok,true)
    await deliver(legacy,id)
    assert.equal((await verify(legacy,id,squatted)).status.verifiedEmail,squatted)
    await assert.rejects(db.query('update auth.users set email_confirmed_at=now() where id=$1',[squat]),/KNU_EMAIL_IN_USE/)
    assert.equal((await db.query('select email_confirmed_at from auth.users where id=$1',[squat])).rows[0].email_confirmed_at,null)
    const rows=(await db.query('select user_id,email from xelay_knu_email_affiliations where user_id=$1 or email=$2',[legacy,squatted])).rows
    assert.deepEqual(rows,[{user_id:legacy,email:squatted}])
    await moveCooldown(id)
    assert.equal((await prepare(legacy,randomUUID(),'rate.bound@knu.ua')).code,'KNU_EMAIL_RATE_LIMIT')
  })
  await t.test('failed delivery and expired challenges never verify, and expired codes remain private',async()=>{
    const failed=randomUUID(),expired=randomUUID(),email='expiry@knu.ua'
    assert.equal((await prepare(other,failed,email)).ok,true);await deliver(other,failed,false)
    assert.equal((await verify(other,failed,email)).code,'KNU_EMAIL_CODE_INVALID')
    await moveCooldown(failed);assert.equal((await prepare(other,expired,email)).ok,true);await deliver(other,expired)
    await db.query("update xelay_knu_email_challenges set created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute',resend_at=now()-interval '10 minutes' where id=$1",[expired])
    assert.equal((await verify(other,expired,email)).code,'KNU_EMAIL_CODE_EXPIRED')
    assert.deepEqual(await status(other),blank)
  })
  await t.test('managed anonymization can remove a KNU account but cannot restore a non-KNU login',async()=>{
    await db.query("update auth.users set deleted_at=now(),email='deleted.fixture@example.test' where id=$1",[newUser])
    assert.equal((await db.query('select count(*)n from xelay_knu_email_affiliations where user_id=$1',[newUser])).rows[0].n,0)
    await assert.rejects(status(newUser),/KNU_EMAIL_AUTH_REQUIRED/)
    await assert.rejects(db.query('update auth.users set deleted_at=null where id=$1',[newUser]),/KNU_EMAIL_REQUIRED/)
  })
})
