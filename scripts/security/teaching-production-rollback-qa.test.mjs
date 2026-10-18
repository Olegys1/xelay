// Execute the exact production SQL QA script against the real migration chain.
// No network, credentials, Auth provider or production mutations.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const script = await readFile(new URL('../../supabase/audits/202610180005_teaching_workflow_rollback.sql', import.meta.url),'utf8')
const tables = ['auth.users','auth.mfa_factors','profiles','universities','academic_units','academic_specialties',
  'teacher_verification_requests','class_representative_requests','study_groups','study_group_members',
  'teaching_courses','teaching_course_groups','teaching_entries','teaching_items','teaching_item_targets',
  'teaching_submissions','teaching_submission_history','teaching_activities','teaching_grades','teaching_grade_audit',
  'classroom_request_receipts','teaching_create_receipts','notifications','notification_email_outbox','user_privacy_consents']

test('exact production teaching QA proves register-to-grade and leaves every tested table unchanged',async t => {
  const fx = await createFixture({useStagingParity:true,beforeMigrationsSql:`
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
  `})
  t.after(()=>fx.close())
  const {db,seedUser}=fx
  const scope=(await db.query('select id,university_id from academic_units where is_active limit 1')).rows[0]
  const specialty=(await db.query('select id from academic_specialties where academic_unit_id=$1 and is_active limit 1',[scope.id])).rows[0]
  const admin=randomUUID()
  await seedUser(admin,{username:'qa_admin_'+admin.replaceAll('-','').slice(0,16),university_id:scope.university_id,academic_unit_id:scope.id,specialty_id:specialty.id,experience:'bachelor',categories:['General']})
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')",[admin])
  await db.query("insert into auth.mfa_factors(user_id,status,factor_type) values($1,'verified','totp')",[admin])
  const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await db.query('select count(*)::int as n from '+table)).rows[0].n])))
  const before=await counts()
  const output=await db.exec(script)
  assert.deepEqual(output.find(result=>result.rows?.[0]?.passed!==undefined)?.rows,[{passed:true,no_test_rows:true}])
  assert.deepEqual(await counts(),before)
  assert.equal((await db.query("select current_setting('role') as role")).rows[0].role,'none')
  assert.equal((await db.query("select current_setting('request.jwt.claims',true) as claims")).rows[0].claims || '', '')

  // A real failure must escape instead of being caught as a successful rollback.
  const broken=script.replace("'score',9,'grade_version',0","'score',11,'grade_version',0")
  await assert.rejects(db.exec(broken),/TEACHING_INVALID_INPUT|TEACHING_SCORE|maximum|MAX|score/i)
  await db.exec('rollback')
  assert.deepEqual(await counts(),before)
  await db.query('delete from auth.mfa_factors where user_id=$1',[admin])
  const noAdmin=await counts()
  await assert.rejects(db.exec(script),/QA_NEEDS_EXISTING_ADMIN_WITH_VERIFIED_TOTP/)
  await db.exec('rollback')
  assert.deepEqual(await counts(),noAdmin)
})
