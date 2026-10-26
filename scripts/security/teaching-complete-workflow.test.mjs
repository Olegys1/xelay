// Real repository migrations and RPCs, synthetic accounts, isolated PostgreSQL.
// This never contacts Supabase Auth, email providers, or the production database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

test('teacher registration, approval, group connection, submission, resubmission and private published grade', async t => {
  const fx = await createFixture({ useStagingParity: true, beforeMigrationsSql: `
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  const [teacher, head, student, otherStudent, admin, course, assignment, submission] = Array.from({length:8}, () => randomUUID())
  const scope = (await db.query('select id,university_id from academic_units where is_active limit 1')).rows[0]
  assert.ok(scope)
  const specialty = randomUUID()
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'QA','Synthetic programme','Synthetic programme')`,[specialty,scope.university_id,scope.id])
  const rpc = async (who, name, args = [], { aal = 'aal1', role = 'authenticated' } = {}) =>
    (await asUser(who, `select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as value`, args, { aal, role })).rows[0].value
  const mutate = (who, action, payload, options) => rpc(who, 'xelay_teaching_mutate', [action, JSON.stringify(payload)], options)
  const classroom = (who, action, payload) => rpc(who, 'xelay_classroom_mutate', [action, JSON.stringify(payload)])
  const readWork = who => rpc(who, 'xelay_classroom_assignment', [assignment, group])
  const failure = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message))
  for (const id of [head, student, otherStudent, admin]) await seedUser(id, {
    full_name: 'Synthetic ' + id.slice(0,8), username: 'tw_' + id.replaceAll('-','').slice(0,16),
    university_id: scope.university_id, academic_unit_id: scope.id, specialty_id:specialty, experience:'bachelor', categories: ['General'],
  })
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [admin])
  await db.query("insert into auth.mfa_factors(user_id,status,factor_type) values($1,'verified','totp')", [admin])
  const metadata = {
    xelay_registration_version: 1, xelay_privacy_consent: true,
    xelay_privacy_policy_version: '2026-10-15.1', xelay_privacy_consent_version: '2026-10-15.1',
    account_type: 'teacher', full_name: 'Synthetic workflow teacher',
    username: 'tw_' + teacher.replaceAll('-','').slice(0,16), country: 'Україна', city: 'Київ', bio: '',
    experience: '', categories: [], university_id: scope.university_id, academic_unit_id: scope.id,
    teacher_department: 'Synthetic department', teacher_position: 'Synthetic lecturer',
  }
  await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,null,$3::jsonb)',
    [teacher, teacher + '@example.test', JSON.stringify(metadata)])
  const row = async (table, id) => (await db.query(`select to_jsonb(t) as value from ${table} t where id=$1`, [id])).rows[0]?.value
  const teacherProfile = await row('profiles', teacher)
  assert.equal(teacherProfile.account_type, 'teacher')
  assert.equal((await db.query('select id from teacher_verification_requests where user_id=$1', [teacher])).rows.length, 0)
  const application = ['Synthetic department', 'Synthetic lecturer', 'Synthetic explicit teacher application', 'synthetic_teacher', '']
  await failure(rpc(teacher, 'xelay_teacher_request', application), /TEACHING_AUTH_REQUIRED/)
  await db.query('update auth.users set email_confirmed_at=now() where id=$1', [teacher])
  assert.equal((await db.query('select id from teacher_verification_requests where user_id=$1', [teacher])).rows.length, 0)
  await rpc(teacher, 'xelay_teacher_request', application)
  const request = (await db.query('select * from teacher_verification_requests where user_id=$1', [teacher])).rows[0]
  assert.equal(request.status, 'pending')
  assert.equal(request.contact_telegram, 'synthetic_teacher')
  assert.equal(request.contact_phone, '')
  const dates = (await db.query("select (current_date-30)::text as start,(current_date+180)::text as finish,(current_date+7)::text as due")).rows[0]
  const newCourse = {id:course, version:0, title:'Synthetic assessment', semester:'Synthetic semester', starts_on:dates.start, ends_on:dates.finish}

  await t.test('unverified teacher and unstepped admin cannot grant themselves teaching access', async () => {
    assert.equal((await rpc(teacher,'xelay_teacher_status')).verified, false)
    await failure(mutate(teacher,'create_course',newCourse), /TEACHER_VERIFICATION_REQUIRED/)
    await failure(mutate(admin,'review_teacher',{request_id:request.id,status:'approved'}), /FORBIDDEN|MFA|AAL/)
  })
  await t.test('admin approval enables an independently registered teacher', async () => {
    await mutate(admin,'review_teacher',{request_id:request.id,status:'approved'}, {aal:'aal2'})
    assert.equal((await rpc(teacher,'xelay_teacher_status')).verified, true)
    const result = await mutate(teacher,'create_course',newCourse)
    assert.equal(result.id,course)
    assert.equal((await mutate(teacher,'create_course',newCourse)).id,course)
  })
  const repRequest = randomUUID(), group = randomUUID()
  await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,
    specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
    values($1,$2,'Synthetic head',$3,$4,'Synthetic programme','QA teacher group','synthetic_head','approved',$5,now())`,
    [repRequest,head,scope.university_id,scope.id,admin])
  await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name)
    values($1,$2,$3,$4,$5,'Synthetic programme','QA teacher group')`, [group,repRequest,head,scope.university_id,scope.id])
  for (const who of [student,otherStudent]) await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now())",[group,who,head])
  let link
  await t.test('group connection needs its representative and does not admit an unrelated student', async () => {
    link = await mutate(teacher,'invite_group',{course_id:course,group_id:group})
    await failure(mutate(student,'respond_group',{link_id:link.id,accept:true}),/FORBIDDEN/)
    await mutate(head,'respond_group',{link_id:link.id,accept:true})
    const workspace = await rpc(teacher,'xelay_classroom_workspace')
    assert.ok(workspace.classrooms.some(item => item.group_id===group))
  })
  await t.test('published assessed assignment appears in the group and creates one gradebook activity', async () => {
    const payload = {id:assignment,version:0,course_id:course,title:'Synthetic homework',body:'Explain the calculation',
      links:['https://example.test/lecture'],link_labels:{'https://example.test/lecture':'Лекція'},attachments:[],
      targets:[{group_id:group,due_at:dates.due+'T15:00:00Z'}],status:'published',max_points:10,category:''}
    await classroom(teacher,'save_group_assignment',payload)
    const visible = await readWork(student)
    assert.equal(visible.item.title,payload.title)
    assert.equal(visible.item.link_labels?.[payload.links[0]],'Лекція')
    assert.equal(visible.max_points,10)
    assert.equal((await db.query('select count(*)::int as n from teaching_activities where item_id=$1',[assignment])).rows[0].n,1)
  })
  let version
  const attachment = {storage_path:`${submission}/${student}/${randomUUID()}.txt`,name:'Synthetic answer.txt',mime_type:'text/plain',size:30}
  await t.test('student draft is private; empty work cannot be submitted', async () => {
    const reserved = await classroom(student,'reserve_submission',{id:submission,item_id:assignment,group_id:group})
    version = reserved.version
    await failure(classroom(student,'submit_submission',{id:submission,version}),/EMPTY_SUBMISSION/)
    await asUser(student,`insert into storage.objects(bucket_id,name,owner,owner_id,metadata)
      values('xelay-submission-files',$1,$2,$3,$4::jsonb)`,[attachment.storage_path,student,student,JSON.stringify({size:30,mimetype:'text/plain'})])
    const saved = await classroom(student,'save_submission',{id:submission,item_id:assignment,group_id:group,version,body:'Private draft answer',links:[],attachments:[attachment]})
    version = saved.version
    const staff = await readWork(teacher)
    assert.equal(staff.submissions.length,0)
    assert.ok(!JSON.stringify(staff).includes('Private draft answer'))
    assert.ok(!JSON.stringify(await readWork(otherStudent)).includes('Private draft answer'))
    assert.equal((await asUser(teacher,'select name from storage.objects where name=$1',[attachment.storage_path])).rows.length,0)
  })
  await t.test('hand-in is visible to teacher, locked for edits, and private from classmates and representative', async () => {
    version = (await classroom(student,'submit_submission',{id:submission,version})).version
    const staff = await readWork(teacher)
    assert.equal(staff.submissions.find(item=>item.id===submission).body,'Private draft answer')
    assert.equal((await asUser(teacher,'select name from storage.objects where name=$1',[attachment.storage_path])).rows.length,1)
    for (const who of [head,otherStudent]) assert.equal((await asUser(who,'select name from storage.objects where name=$1',[attachment.storage_path])).rows.length,0)
    await failure(classroom(student,'save_submission',{id:submission,version,body:'Illegal edit',links:[],attachments:[]}),/LOCKED/)
    for (const who of [head,otherStudent]) assert.ok(!JSON.stringify(await readWork(who)).includes('Private draft answer'))
  })
  await t.test('teacher returns with feedback; new private edits do not replace the handed-in snapshot', async () => {
    version = (await classroom(teacher,'review_submission',{id:submission,version,status:'returned',feedback:'Add the second calculation'})).version
    assert.equal((await readWork(student)).my_submission.feedback,'Add the second calculation')
    version = (await classroom(student,'save_submission',{id:submission,version,body:'Corrected final answer',links:[],attachments:[attachment]})).version
    const staff = JSON.stringify(await readWork(teacher))
    assert.ok(staff.includes('Private draft answer'))
    assert.ok(!staff.includes('Corrected final answer'))
    version = (await classroom(student,'submit_submission',{id:submission,version})).version
    assert.equal((await readWork(teacher)).submissions.find(item=>item.id===submission).attempt,2)
  })
  await t.test('review publishes feedback and score atomically; only the owner sees the result', async () => {
    version = (await classroom(teacher,'review_submission',{id:submission,version,status:'reviewed',feedback:'Well explained',score:9,grade_version:0})).version
    const own = await readWork(student)
    assert.equal(own.my_submission.status,'reviewed')
    assert.equal(own.my_submission.published_score,9)
    assert.equal(own.my_submission.feedback,'Well explained')
    const groupView = await rpc(student,'xelay_teaching_group',[group])
    assert.equal(groupView.grades.find(item=>item.published_score===9)?.published_score,9)
    for (const who of [head,otherStudent]) {
      const visible = await readWork(who)
      assert.ok(!JSON.stringify(visible).includes('Well explained'))
      assert.ok(!JSON.stringify(visible).includes('Corrected final answer'))
    }
    const messages = (await db.query("select message from notifications where teaching_event_key like 'classroom-%'")).rows
    assert.ok(messages.length>=3)
    for (const item of messages) assert.ok(!/Well explained|Corrected final answer|Private draft answer/.test(item.message))
  })
  await t.test('stale review cannot overwrite the result and the handed-in file cannot be replaced', async () => {
    await failure(classroom(teacher,'review_submission',{id:submission,version:version-1,status:'reviewed',feedback:'Stale score',score:1,grade_version:1}),/CONFLICT/)
    const own = await readWork(student)
    assert.equal(own.my_submission.published_score,9)
    const replaced = await asUser(student,"update storage.objects set metadata=$1::jsonb where name=$2 returning name",[JSON.stringify({size:31,mimetype:'text/plain'}),attachment.storage_path])
    assert.equal(replaced.rows.length,0)
    assert.equal((await db.query('select metadata from storage.objects where name=$1',[attachment.storage_path])).rows[0].metadata.size,30)
    await failure(classroom(teacher,'delete_group_assignment',{id:assignment,version:(await row('teaching_items',assignment)).version,group_id:group}),/HAS_SUBMISSIONS/)
  })
})
