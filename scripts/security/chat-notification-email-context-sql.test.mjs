// Actual private chat schemas and leased RPC in offline PostgreSQL. No network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const unread = await readFile(new URL('supabase/migrations/202610070008_notification_email_unread.sql', root), 'utf8')
const mail = await readFile(new URL('supabase/migrations/202610140002_all_notification_email.sql', root), 'utf8')
const migration = await readFile(new URL('supabase/migrations/202610140004_chat_notification_email_context.sql', root), 'utf8')
const first = result => result.rows[0]
const denied = work => assert.rejects(work, error => error.code === '42501')

test('leased chat email context works without direct service-role access to private chat tables', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610030003' })
  const { db, asUser, seedUser } = fx
  const owner = randomUUID(), member = randomUUID(), target = randomUUID(), applicant = randomUUID(), outsider = randomUUID()
  let space
  const context = async (job, token = job.lock_token) => first(await asUser(null,
    'select xelay_chat_notification_email_context($1,$2) as context', [job.id, token], { role: 'service_role' }
  )).context
  const event = async (recipient, actor, type = 'chat_message', spaceId = space) => {
    const notice = first(await asUser(null,
      `insert into notifications(recipient_id,actor_id,actor_name,type,message,is_read,chat_space_id)
       values($1,$2,'PRIVATE_ACTOR_NAME',$3,'PRIVATE_NOTIFICATION_TEXT',true,$4) returning id`,
      [recipient,actor,type,spaceId], { role: 'service_role' }
    ))
    const queued = first(await db.query('select id from notification_email_outbox where notification_id=$1', [notice.id]))
    assert.ok(queued)
    const job = first(await asUser(null, 'select * from xelay_claim_notification_email($1)', [queued.id], { role: 'service_role' }))
    assert.ok(job)
    return { ...job, noticeId: notice.id }
  }
  const safe = (data, expectedSpace = space) => {
    assert.equal(data.eligible, true); assert.equal(data.path, `/messages?space=${expectedSpace}`)
    assert.deepEqual(Object.keys(data).sort(), ['eligible','path','reason'])
    assert.doesNotMatch(JSON.stringify(data), /PRIVATE_|@|body|attachment|full_name/)
  }
  try {
    await db.exec('alter table public.messages add column if not exists deleted_at timestamptz')
    await db.exec(unread); await db.exec(mail); await db.exec(migration)
    for (const id of [owner,member,target,applicant,outsider]) await seedUser(id, {
      username: 'chatmail_' + id.slice(0,12).replaceAll('-',''),
    })
    space = first(await db.query(
      "insert into chat_spaces(kind,visibility,name,owner_id) values('group','private','PRIVATE_SPACE_NAME',$1) returning id", [owner]
    )).id
    await db.query(`insert into chat_members(space_id,user_id,role,status)
      values($1,$2,'owner','active'),($1,$3,'member','active')`, [space,owner,member])
    await asUser(null, 'select xelay_notification_email_worker_heartbeat()', [], { role: 'service_role' })

    await t.test('migration is repeatable and grants only leased metadata RPC execution', async () => {
      await db.exec(migration)
      for (const table of ['chat_spaces','chat_members','chat_invitations','chat_join_requests']) {
        assert.equal(first(await db.query('select has_table_privilege(\'service_role\',$1,\'SELECT\') as allowed', [`public.${table}`])).allowed, false)
        await denied(asUser(null, `select * from ${table}`, [], { role: 'service_role' }))
      }
      for (const role of ['anon','authenticated']) {
        assert.equal(first(await db.query("select has_function_privilege($1,'public.xelay_chat_notification_email_context(uuid,uuid)','EXECUTE') as allowed", [role])).allowed, false)
        await denied(asUser(role === 'authenticated' ? member : null,
          'select xelay_chat_notification_email_context($1,$2)', [randomUUID(),randomUUID()], { role }))
      }
      assert.equal(first(await db.query("select has_function_privilege('service_role','public.xelay_chat_notification_email_context(uuid,uuid)','EXECUTE') as allowed")).allowed, true)
    })

    await t.test('only the live matching notification lease can expose a fixed route', async () => {
      const job = await event(member,owner)
      safe(await context(job))
      assert.equal((await context(job,randomUUID())).reason, 'lease_lost')
      assert.equal((await context({ id: randomUUID(),lock_token: job.lock_token })).reason, 'lease_lost')
      await db.query('update notifications set actor_id=$2 where id=$1', [job.noticeId,outsider])
      assert.equal((await context(job)).reason, 'chat_context_mismatch')
      await db.query('update notifications set actor_id=$2 where id=$1', [job.noticeId,owner])
      await db.query("update notification_email_outbox set locked_until=now()-interval '1 second' where id=$1", [job.id])
      assert.equal((await context(job)).reason, 'lease_lost')
      const nonChat = await event(member,owner,'answer')
      assert.equal((await context(nonChat)).reason, 'chat_context_missing')
    })

    await t.test('read chat events require current active and unmuted membership', async () => {
      for (const type of ['chat_message','chat_comment','chat_future_server_event']) safe(await context(await event(member,owner,type)))
      const job = await event(member,owner)
      await db.query('update chat_members set muted=true where space_id=$1 and user_id=$2', [space,member])
      assert.equal((await context(job)).reason, 'chat_muted')
      await db.query("update chat_members set muted=false,status='left' where space_id=$1 and user_id=$2", [space,member])
      assert.equal((await context(job)).reason, 'chat_access_removed')
      await db.query("update chat_members set status='banned' where space_id=$1 and user_id=$2", [space,member])
      assert.equal((await context(job)).reason, 'chat_access_removed')
      await db.query("update chat_members set status='active' where space_id=$1 and user_id=$2", [space,member])
      safe(await context(job))
    })

    await t.test('pending invitation checks exact target/inviter; accepted invitation still mails with active membership', async () => {
      await db.query('insert into chat_invitations(space_id,user_id,invited_by) values($1,$2,$3)', [space,target,owner])
      const job = await event(target,owner,'chat_invite')
      safe(await context(job))
      const wrongActor = await event(target,outsider,'chat_invite')
      assert.equal((await context(wrongActor)).reason, 'chat_invitation_unavailable')
      await db.query("update chat_invitations set status='accepted' where space_id=$1 and user_id=$2", [space,target])
      assert.equal((await context(job)).reason, 'chat_invitation_unavailable', 'Accepted without active membership cannot disclose context')
      await db.query('insert into chat_members(space_id,user_id,status) values($1,$2,\'active\')', [space,target])
      safe(await context(job))
      await db.query("update chat_invitations set status='revoked' where space_id=$1 and user_id=$2", [space,target])
      assert.equal((await context(job)).reason, 'chat_invitation_unavailable')
    })

    await t.test('processed join requests still mail only their current moderators', async () => {
      await db.query('insert into chat_join_requests(space_id,user_id) values($1,$2)', [space,applicant])
      const job = await event(owner,applicant,'chat_join_request')
      for (const status of ['pending','accepted','rejected']) {
        await db.query('update chat_join_requests set status=$3 where space_id=$1 and user_id=$2', [space,applicant,status])
        safe(await context(job))
      }
      await db.query("update chat_join_requests set status='cancelled' where space_id=$1 and user_id=$2", [space,applicant])
      assert.equal((await context(job)).reason, 'chat_join_request_unavailable')
      await db.query("update chat_join_requests set status='pending' where space_id=$1 and user_id=$2", [space,applicant])
      await db.query("update chat_members set role='member' where space_id=$1 and user_id=$2", [space,owner])
      assert.equal((await context(job)).reason, 'chat_moderator_required')
      await db.query("update chat_members set role='admin' where space_id=$1 and user_id=$2", [space,owner])
      safe(await context(job))
    })

    await t.test('join approval requires accepted request and active target', async () => {
      await db.query('insert into chat_members(space_id,user_id,status) values($1,$2,\'active\')', [space,applicant])
      await db.query("update chat_join_requests set status='accepted' where space_id=$1 and user_id=$2", [space,applicant])
      const job = await event(applicant,owner,'chat_join_approved')
      safe(await context(job))
      await db.query("update chat_join_requests set status='rejected' where space_id=$1 and user_id=$2", [space,applicant])
      assert.equal((await context(job)).reason, 'chat_join_request_unavailable')
      await db.query("update chat_join_requests set status='accepted' where space_id=$1 and user_id=$2", [space,applicant])
      await db.query("update chat_members set status='left' where space_id=$1 and user_id=$2", [space,applicant])
      assert.equal((await context(job)).reason, 'chat_access_removed')
    })

    await t.test('faculty scope checks current profile and enabled university/unit even with stale membership', async () => {
      const university = randomUUID(), unit = randomUUID(), specialty = randomUUID()
      await db.query('insert into universities(id,name,slug) values($1,\'Synthetic chat university\',$2)', [university,'chatmail-'+university])
      await db.query('insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,\'Synthetic faculty\',$3,\'faculty\')', [unit,university,'chatmail-'+unit])
      await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
        values($1,$2,$3,'CHATMAIL','Synthetic economics','Synthetic economics program')`, [specialty,university,unit])
      for (const user of [owner,member]) await db.query(
        'update profiles set university_id=$2,academic_unit_id=$3,specialty_id=$4 where id=$1', [user,university,unit,specialty])
      const faculty = first(await db.query("select id from chat_spaces where system_kind='faculty' and university_id=$1 and academic_unit_id=$2", [university,unit])).id
      const job = await event(member,owner,'chat_message',faculty)
      safe(await context(job), faculty)
      await db.query('update academic_units set is_active=false where id=$1', [unit])
      assert.equal((await context(job)).reason, 'chat_faculty_scope_removed')
      await db.query('update academic_units set is_active=true where id=$1', [unit])
      await db.query('update universities set is_active=false where id=$1', [university])
      assert.equal((await context(job)).reason, 'chat_faculty_scope_removed')
      await db.query('update universities set is_active=true where id=$1', [university])
      const otherUnit = randomUUID(), otherSpecialty = randomUUID()
      await db.query('insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,\'Other synthetic faculty\',$3,\'faculty\')',
        [otherUnit,university,'chatmail-other-'+otherUnit])
      await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
        values($1,$2,$3,'CHATMAIL2','Synthetic marketing','Synthetic marketing program')`, [otherSpecialty,university,otherUnit])
      await db.query('update profiles set academic_unit_id=$2,specialty_id=$3 where id=$1', [member,otherUnit,otherSpecialty])
      assert.equal((await context(job)).eligible, false)
      assert.deepEqual(Object.keys(await context(job)).sort(), ['eligible','path','reason'])
    })
  } finally { await fx.close() }
})
