// Offline PostgreSQL and real worker-source tests. Never sends email or contacts a project.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/202610030013_question_comment_email.sql', root), 'utf8')
const original = await readFile(new URL('supabase/migrations/202610010004_email_notifications.sql', root), 'utf8')
const workerSource = await readFile(new URL('server/notificationEmail.ts', root), 'utf8')
const first = (result) => result.rows[0]
const denied = (work) => assert.rejects(work, (error) => error.code === '42501')
const queueDefinition = (source) => source.replaceAll('\r\n', '\n').match(
  /create or replace function public\.xelay_queue_notification_email\(\)[\s\S]*?\n\$\$;/
)[0]

test('013 changes only the existing queue whitelist and closes internal helper execution', () => {
  assert.equal(queueDefinition(migration), queueDefinition(original).replace(
    "('answer', 'connection_request'", "('answer', 'question_comment', 'connection_request'"
  ))
  assert.match(migration, /revoke all on function public\.xelay_queue_notification_email\(\) from public, anon, authenticated, service_role/)
  assert.doesNotMatch(migration, /create\s+(?:table|trigger)|alter\s+table|grant\s|insert\s+into\s+public\.notifications/i)
})

test('future question comments queue safely on the full legacy parity schema', async (t) => {
  const fx = await createFixture({ useStagingParity: true, through: '202610030012' })
  const { db, asUser, seedUser } = fx
  const owner = randomUUID(), actor = randomUUID()
  const recipient = async () => { const id = randomUUID(); await seedUser(id); return id }
  const queueCount = async (id) => first(await db.query(
    'select count(*)::int as count from notification_email_outbox where recipient_id=$1', [id]
  )).count
  const notify = async (id, type = 'question_comment', fields = {}) => first(await asUser(null,
    `insert into notifications(recipient_id,actor_id,actor_name,type,message,is_read,answer_id)
     values($1,$2,'Synthetic actor',$3,'Synthetic notification',$4,$5) returning id`,
    [id, fields.actor ?? actor, type, fields.isRead ?? false, fields.answerId ?? null], { role: 'service_role' }
  )).id
  try {
    await seedUser(owner); await seedUser(actor)
    const question = first(await asUser(owner,
      "insert into questions(user_id,title,content,category) values($1,'Test question','Synthetic body','IT') returning id", [owner]
    )).id

    await t.test('reproduces pre013 gap; queues only future comments and is safe to rerun', async () => {
      await asUser(actor, "insert into question_comments(question_id,user_id,body) values($1,$2,'Before013')", [question, actor])
      assert.equal((await asUser(owner, "select id from notifications where type='question_comment'")).rows.length, 1)
      assert.equal(await queueCount(owner), 0)
      await db.exec(migration)
      assert.equal(await queueCount(owner), 0, 'No existing notifications are backfilled')
      await asUser(actor, "insert into question_comments(question_id,user_id,body) values($1,$2,'After013')", [question, actor])
      const notification = first(await asUser(owner, "select id from notifications where type='question_comment' order by created_at,id desc"))
      const jobs = (await db.query('select * from notification_email_outbox where recipient_id=$1', [owner])).rows
      assert.equal(jobs.length, 1)
      assert.ok((await asUser(owner, 'select id from notifications where id::text=$1', [jobs[0].notification_id])).rows.length)
      assert.ok(notification)
      assert.equal(jobs[0].notification_type, 'question_comment')
      assert.equal(jobs[0].event_key, `notification:${jobs[0].notification_id}`)
      await db.exec(migration)
      assert.equal(await queueCount(owner), 1)
      assert.equal(first(await db.query("select count(*)::int as count from pg_trigger where tgrelid='notifications'::regclass and tgname='notification_email_queue'")).count, 1)
      await asUser(owner, "insert into question_comments(question_id,user_id,body) values($1,$2,'Own comment')", [question, owner])
      assert.equal(await queueCount(owner), 1, 'Own comments do not create notification email')
    })

    await t.test('legacy nonUUID questions retain generic references; missing recipients do not queue', async () => {
      const id = await recipient()
      const legacy = `legacy-${randomUUID()}`
      await asUser(id, "insert into questions(id,user_id,title,content,category) values($1,$2,'Legacy','Synthetic body','IT')", [legacy, id])
      await asUser(actor, "insert into question_comments(question_id,user_id,body) values($1,$2,'Legacy comment')", [legacy, actor])
      assert.equal(first(await asUser(id, "select question_id from notifications where type='question_comment'")).question_id, null)
      assert.equal(await queueCount(id), 1)
      const missing = first(await asUser(null,
        "insert into questions(user_id,title,content,category) values('retired-test-author','Orphan owner','Synthetic body','IT') returning id", [], { role: 'service_role' }
      )).id
      await asUser(actor, "insert into question_comments(question_id,user_id,body) values($1,$2,'No owner profile')", [missing, actor])
      assert.equal(first(await db.query('select count(*)::int as count from notifications where question_id=$1::uuid', [missing])).count, 0)
    })

    await t.test('both preferences, canonical Auth confirmation and deletion guards remain', async () => {
      for (const column of ['notifications_enabled', 'email_notifications_enabled']) {
        const id = await recipient()
        await asUser(id, `insert into notification_preferences(user_id,${column}) values($1,false)`, [id])
        await notify(id)
        assert.equal(await queueCount(id), 0, column)
      }
      for (const change of ['email_confirmed_at=null', 'deleted_at=now()']) {
        const id = await recipient()
        await db.query(`update auth.users set ${change} where id=$1`, [id])
        await notify(id)
        assert.equal(await queueCount(id), 0, change)
      }
    })

    await t.test('read state, self actor and unsupported aliases remain excluded', async () => {
      const id = await recipient()
      await notify(id, 'question_comment', { isRead: true })
      await notify(id, 'question_comment', { actor: id })
      for (const type of ['comment', 'answer_comment', 'discussion', 'question_comment_unknown']) await notify(id, type)
      assert.equal(await queueCount(id), 0)
    })

    await t.test('thirty-per-recipient hourly cap still bounds new comment emails', async () => {
      const id = await recipient()
      for (let i = 0; i < 31; i++) await notify(id)
      assert.equal(await queueCount(id), 30)
      assert.equal(first(await db.query('select count(*)::int as count from notifications where recipient_id=$1', [id])).count, 31)
    })

    await t.test('old answer event keys and message cooldown retain exact behavior', async () => {
      const id = await recipient()
      const oldQuestion = first(await asUser(id,
        "insert into questions(user_id,title,content,category) values($1,'Answer regression','Synthetic body','IT') returning id", [id]
      )).id
      const answer = first(await asUser(actor,
        "insert into answers(question_id,user_id,content) values($1,$2,'Synthetic answer') returning id", [oldQuestion, actor]
      )).id
      await notify(id, 'answer', { answerId: answer })
      assert.equal(await queueCount(id), 1, 'Duplicate answer event key is ignored')
      await notify(id, 'message'); await notify(id, 'message')
      assert.equal(await queueCount(id), 2, 'Same actor message is limited to one per ten minutes')
    })

    await t.test('client ACLs stay closed; service claim and finish work without MFA', async () => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.equal(first(await db.query("select has_function_privilege($1,'public.xelay_queue_notification_email()','EXECUTE') as allowed", [role])).allowed, false)
      }
      for (const role of ['anon', 'authenticated']) {
        const user = role === 'authenticated' ? owner : null
        await denied(asUser(user, 'select id from notification_email_outbox', [], { role }))
        await denied(asUser(user, "insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$2,'Forged','question_comment','Forged')", [owner, actor], { role }))
        await denied(asUser(user, 'select * from xelay_claim_notification_email(null)', [], { role }))
        await denied(asUser(user, "select xelay_finish_notification_email($1,$2,'sent',null,null)", [randomUUID(), randomUUID()], { role }))
      }
      const id = await recipient(); await notify(id)
      const job = first(await db.query('select id from notification_email_outbox where recipient_id=$1', [id]))
      const claimed = first(await asUser(null, 'select * from xelay_claim_notification_email($1)', [job.id], { role: 'service_role', aal: 'aal1' }))
      assert.equal(claimed.id, job.id)
      assert.equal(first(await asUser(null, "select xelay_finish_notification_email($1,$2,'sent',null,'synthetic-provider') as finished", [job.id, claimed.lock_token], { role: 'service_role', aal: 'aal1' })).finished, true)
    })
  } finally { await fx.close() }
})

function workerFixture({ notification = {}, preferences = {}, user = {}, missing = false } = {}) {
  const calls = [], requests = [], finishes = []
  let claimed = false
  const job = { id: randomUUID(), lock_token: randomUUID(), notification_id: randomUUID(), attempts: 1, created_at: new Date().toISOString() }
  const record = { id: job.notification_id, recipient_id: randomUUID(), type: 'question_comment', is_read: false,
    question_id: randomUUID(), ...notification }
  const canonical = { id: record.recipient_id, email: 'canonical@example.test', email_confirmed_at: new Date().toISOString(), ...user }
  const service = {
    rpc: async (name, values) => {
      calls.push([name, values])
      if (name === 'xelay_claim_notification_email') {
        const data = claimed ? [] : [job]; claimed = true; return { data, error: null }
      }
      assert.equal(name, 'xelay_finish_notification_email'); finishes.push(values); return { data: true, error: null }
    },
    from: (table) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => {
      assert.ok(['notifications', 'notification_preferences'].includes(table))
      return { data: table === 'notifications' ? (missing ? null : record)
        : { notifications_enabled: true, email_notifications_enabled: true, ...preferences }, error: null }
    } }) }) }),
    auth: { admin: { getUserById: async (id) => {
      assert.equal(id, record.recipient_id); return { data: { user: canonical }, error: null }
    } } },
  }
  const exports = {}
  const compiled = ts.transpileModule(workerSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(compiled, {
    exports, require: (name) => {
      if (name === 'node:crypto') return { createHash, timingSafeEqual }
      assert.equal(name, '@supabase/supabase-js')
      return { createClient: () => { throw new Error('Unexpected client construction in offline delivery test') } }
    },
    process: { env: {} }, console: { error() {} }, Date, Buffer, URL, AbortSignal,
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) })
      return { ok: true, status: 200, json: async () => ({ id: 'synthetic-provider-id' }) }
    },
  })
  const config = { apiKey: 'offline-test-only', from: 'Xelay <test@example.test>', origin: 'https://staging.example.test', service }
  return { deliver: () => exports.deliverNotificationEmail(config, job.id), calls, requests, finishes, record, job }
}

test('real worker renders generic question-comment email to verified canonical Auth address', async () => {
  const secret = 'PRIVATE_COMMENT_BODY_DO_NOT_EMAIL'
  const fixture = workerFixture({ notification: { message: secret, body: secret,
    actor_name: '<img src=x onerror=alert(1)>', email: 'forged@example.test' } })
  const result = await fixture.deliver()
  assert.equal(result.status, 'sent'); assert.equal(fixture.requests.length, 1)
  const { url, options, body } = fixture.requests[0]
  assert.equal(url, 'https://api.resend.com/emails')
  assert.deepEqual(body.to, ['canonical@example.test'])
  assert.equal(body.subject, 'Новий коментар до вашого запитання — Xelay')
  assert.match(body.text, /До вашого запитання додали коментар/)
  assert.ok(body.html.includes(`https://staging.example.test/question/${fixture.record.question_id}`))
  assert.ok(body.text.includes('https://staging.example.test/?notifications=settings'))
  assert.doesNotMatch(body.html + body.text, /PRIVATE_COMMENT_BODY|<img|onerror|forged@example/)
  assert.equal(options.headers['Idempotency-Key'], `xelay-notification/${fixture.job.id}`)
  assert.equal(fixture.finishes[0].p_provider_message_id, 'synthetic-provider-id')
  assert.equal((await fixture.deliver()).processed, false)
  assert.equal(fixture.requests.length, 1, 'Repeated completed job never calls the provider again')
})

test('legacy and unsafe question references only use a fixed categories fallback', async () => {
  for (const question_id of [null, '../outside?redirect=https://other.test', 'https://other.test', 'bad"onmouseover="x']) {
    const fixture = workerFixture({ notification: { question_id } })
    assert.equal((await fixture.deliver()).status, 'sent')
    const { body } = fixture.requests[0]
    assert.ok(body.text.includes('Відкрити Xelay: https://staging.example.test/categories'))
    assert.doesNotMatch(body.text + body.html, /other\.test|onmouseover/)
  }
})

for (const [label, settings, reason] of [
  ['email preferences turned off after queueing', { preferences: { email_notifications_enabled: false } }, 'notifications_disabled'],
  ['all notifications turned off after queueing', { preferences: { notifications_enabled: false } }, 'notifications_disabled'],
  ['already-read notification', { notification: { is_read: true } }, 'already_read'],
  ['removed notification', { missing: true }, 'notification_removed'],
  ['unverified canonical Auth email', { user: { email_confirmed_at: null } }, 'email_unverified'],
  ['unsupported notification type', { notification: { type: 'question_comment_unknown' } }, 'unsupported_type'],
]) {
  test(`question-comment worker skips ${label} without a provider request`, async () => {
    const fixture = workerFixture(settings)
    assert.equal((await fixture.deliver()).status, 'skipped')
    assert.equal(fixture.requests.length, 0)
    assert.equal(fixture.finishes[0].p_error_code, reason)
  })
}
