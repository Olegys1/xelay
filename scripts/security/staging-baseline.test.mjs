// Empty-project bootstrap with explicit privileges, not production policies/default grants.
// Synthetic PostgreSQL only: no Supabase requests, credentials, mail, files or payments.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const baseline = await readFile(new URL('../../supabase/setup/security_staging_legacy_baseline.sql',import.meta.url),'utf8')
const first = (result) => result.rows[0]
const rejects = (work,code) => assert.rejects(work,(error)=>error.message.includes(code))

for(const useStagingParity of [false,true]) {
test(`${useStagingParity?'Catalog parity':'Minimal baseline'}: guarded staging bootstrap and full migration chain without implicit public table grants`,async(t)=>{
  const fx=await createFixture({useStagingBaseline:true,useStagingParity})
  const {db,asUser}=fx
  const a=randomUUID(), b=randomUUID(), admin=randomUUID(), legacy=randomUUID()
  let question, answer, conversation, group
  try {
    await t.test('bootstrap refuses omitted confirmation, existing tables and the known production reference',async()=>{
      await rejects(db.exec(baseline),'set xelay.security_staging=true')
      await db.exec('rollback')
      await db.exec("set xelay.security_staging='true'")
      await rejects(db.exec(baseline),'already exists')
      await db.exec('rollback')
      await db.exec("set xelay.security_staging='true'; set app.settings.supabase_url='https://baohfpadxvhqhhjjqtil.supabase.co'")
      await rejects(db.exec(baseline),'known production project is forbidden')
      await db.exec('rollback; reset app.settings.supabase_url; reset xelay.security_staging')
      assert.equal(first(await db.query("select count(*)::int as count from pg_default_acl where defaclnamespace='public'::regnamespace and defaclobjtype='r'")).count,0)
      assert.equal(first(await db.query("select has_table_privilege('anon','profiles','SELECT') as allowed")).allowed,false)
      assert.equal(first(await db.query("select count(*)::int as count from pg_constraint where conrelid='profiles'::regclass and conname='profiles_university_id_fkey'")).count,1)
      assert.ok(!/create\s+(?:or\s+replace\s+)?(?:schema|table|function)\s+(?:auth|storage)\./i.test(baseline))
    })
    await t.test('real registration/profile triggers and explicit owner grants work',async()=>{
      const scope=first(await db.query('select id,university_id,academic_unit_id from academic_specialties where is_active limit 1'))
      assert.ok(scope,'Repository catalog must provide a valid registration specialty')
      for(const [id,username] of [[a,'staging_owner'],[b,'staging_member'],[admin,'staging_admin']]) {
        await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3::jsonb)',[id,`${username}@example.test`,JSON.stringify({
          xelay_registration_version:'1',full_name:username,username,country:'Ukraine',city:'Staging',
          experience:'Student / Fresh Graduate',categories:['IT'],university_id:scope.university_id,
          academic_unit_id:scope.academic_unit_id,specialty_id:scope.id,
        })])
      }
      const own=first(await asUser(a,'select id,email,username,rating from profiles where id=$1',[a]))
      assert.equal(own.id,a); assert.equal(own.username,'staging_owner'); assert.equal(own.rating,0)
      assert.equal((await asUser(a,'select id from profiles where id=$1',[b])).rows.length,0)
      await asUser(a,"update profiles set bio='Updated staging profile' where id=$1",[a])
      assert.equal(first(await asUser(a,'select bio from profiles where id=$1',[a])).bio,'Updated staging profile')
      await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[legacy,'staging_legacy@example.test'])
      await asUser(legacy,"insert into profiles(id,full_name,username,country,experience) values($1,'Legacy staging','staging_legacy','Ukraine','Student / Fresh Graduate')",[legacy])
      assert.equal(first(await asUser(legacy,'select email from profiles where id=$1',[legacy])).email,'staging_legacy@example.test')
      await rejects(asUser(a,'select increment_profile_rating($1)',[a]),'permission denied')
      await rejects(asUser(null,'select id from profiles',[],{role:'anon'}),'permission denied')
      await rejects(asUser(a,'select * from xelay_users'),'permission denied')
    })
    await t.test('public content, counters and attachment grants preserve ordinary author workflows',async()=>{
      question=first(await asUser(a,"insert into questions(user_id,title,content,category) values($1,'Staging question','Question content','IT') returning id",[a])).id
      answer=first(await asUser(b,"insert into answers(question_id,user_id,content) values($1,$2,'Staging answer') returning id",[question,b])).id
      await asUser(a,"update questions set content='Edited question' where id=$1",[question])
      await asUser(b,"update answers set content='Edited answer' where id=$1",[answer])
      assert.equal(first(await asUser(null,'select answers_count from questions where id=$1',[question],{role:'anon'})).answers_count,1)
      assert.equal((await asUser(null,'select id from answers where id=$1',[answer],{role:'anon'})).rows.length,1)
      const path=`${a}/questions/staging.png`,url=`https://staging.supabase.co/storage/v1/object/public/answer-media/${path}`
      await asUser(a,"select xelay_reserve_public_media_upload('answer-media',$1,100,'image/png')",[path])
      await asUser(a,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('answer-media',$1,$2,$3::jsonb) returning id",[path,a,JSON.stringify({size:100,mimetype:'image/png'})])
      await asUser(a,'insert into question_images(question_id,image_url) values($1,$2)',[question,url])
      assert.equal((await asUser(null,'select id from question_images where question_id=$1',[question],{role:'anon'})).rows.length,1)
      assert.equal((await asUser(b,"update questions set content='Foreign change' where id=$1 returning id",[question])).rows.length,0)
      assert.ok((await asUser(null,'select id from notifications',[],{role:'service_role'})).rows.length>0)
      await asUser(b,'select xelay_delete_own_answer($1)',[answer])
      assert.equal(first(await asUser(a,'select answers_count from questions where id=$1',[question])).answers_count,0)
    })
    await t.test('connection/direct media flows work with explicit grants and private read isolation',async()=>{
      const request=first(await asUser(a,'select send_connection_request($1) as id',[b])).id
      conversation=first(await asUser(b,'select accept_connection_request($1) as id',[request])).id
      assert.equal((await asUser(a,'select id from conversations where id=$1',[conversation])).rows.length,1)
      const message=randomUUID(),path=`${conversation}/${a}/${message}/staging.png`
      await asUser(a,"select xelay_private_reserve_media('xelay-message-media',$1)",[path])
      await asUser(a,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('xelay-message-media',$1,$2,$3::jsonb) returning id",[path,a,JSON.stringify({size:100,mimetype:'image/png'})])
      await asUser(a,'select xelay_send_direct_message($1,$2,$3,null,$4::jsonb)',[message,conversation,'Staging direct message',JSON.stringify([{storage_path:path,file_name:'staging.png',mime_type:'image/png',media_type:'image'}])])
      assert.equal((await asUser(b,'select id from messages where id=$1',[message])).rows.length,1)
      assert.equal((await asUser(b,'select id from storage.objects where name=$1',[path])).rows.length,1)
      assert.equal((await asUser(admin,'select id from storage.objects where name=$1',[path])).rows.length,0)
      await asUser(a,'select xelay_delete_message($1)',[message])
      assert.equal((await asUser(a,'delete from storage.objects where name=$1 returning id',[path])).rows.length,1)
      assert.equal(first(await db.query('select count(*)::int as count from private_media_cleanup where storage_path=$1',[path])).count,0)
    })
    await t.test('MFA review, paid annual license, timetable and group membership preserve explicit access',async()=>{
      await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')",[admin])
      await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')",[admin])
      const request=first(await asUser(a,"select xelay_submit_class_representative_request('STAGING-01','@staging_owner',null) as id")).id
      await rejects(asUser(admin,'select xelay_review_class_representative_request($1,true)',[request]),'permission')
      await asUser(admin,'select xelay_review_class_representative_request($1,true)',[request],{aal:'aal2'})
      await asUser(null,'update billing_settings set first_free_group_claimed=true,enforce_group_payment=true where singleton',[],{role:'service_role'})
      group=first(await asUser(a,'select xelay_create_study_group($1) as id',[request])).id
      // This existing payment/refund case begins after the synthetic free week.
      await db.query("update group_trial_entitlements set started_at=now()-interval '192 hours',expires_at=now()-interval '24 hours' where group_id=$1",[group])
      assert.equal(first(await asUser(a,'select xelay_group_billing_status($1) as value',[group])).value.payment_required,true)
      const order=first(await asUser(null,"select xelay_create_billing_order($1,'group','live','staging-group-order',$2) as value",[a,group],{role:'service_role'})).value
      assert.equal(order.group_term_months,12); assert.equal(order.amount,750)
      await asUser(null,"update billing_orders set terms_version='staging-terms',terms_accepted_at=now() where id=$1",[order.id],{role:'service_role'})
      assert.equal((await asUser(null,'select id from billing_orders where id=$1',[order.id],{role:'service_role'})).rows.length,1)
      await rejects(asUser(b,"select xelay_apply_billing_event('staging-group-order','live',$1,'Approved',750,'UAH',null)",['a'.repeat(64)]),'permission denied')
      const apply=(fingerprint,status)=>asUser(null,"select xelay_apply_billing_event('staging-group-order','live',$1,$2,750,'UAH',null) as value",[fingerprint.repeat(64),status],{role:'service_role'})
      await apply('a','Approved'); assert.equal(first(await apply('a','Approved')).value.duplicate,true)
      await apply('b','Approved')
      assert.equal(first(await db.query('select count(*)::int as count from group_annual_entitlements where group_id=$1',[group])).count,1)
      assert.equal(first(await asUser(a,'select xelay_group_billing_status($1) as value',[group])).value.is_active,true)
      const lessons=JSON.stringify([{weekday:1,starts_at:'09:00',ends_at:'10:00',subject:'Staging lesson',valid_from:'2026-10-01',valid_until:'2027-01-01',week_pattern:'upper',week_anchor_date:'2026-10-05'}])
      assert.equal(first(await asUser(a,'select xelay_import_study_group_timetable($1,$2::jsonb) as count',[group,lessons])).count,1)
      const member=first(await asUser(a,"select xelay_invite_to_study_group($1,'staging_member') as id",[group])).id
      await asUser(b,'select xelay_respond_study_group_invitation($1,true)',[member])
      assert.equal((await asUser(b,'select id from study_group_schedule where group_id=$1',[group])).rows.length,1)
      await rejects(asUser(b,'select xelay_import_study_group_timetable($1,$2::jsonb)',[group,lessons]),'PERMISSION')
      await apply('c','Refunded'); await apply('d','Approved')
      assert.equal(first(await asUser(a,'select xelay_group_billing_status($1) as value',[group])).value.is_active,false)
    })
  } finally { await fx.close() }
})
}
