// Executes the actual delivery/worker source against offline provider fixtures.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const sender = await readFile(new URL('server/notificationEmail.ts', root), 'utf8')
const retry = await readFile(new URL('server/notificationRetry.ts', root), 'utf8')
const webhook = await readFile(new URL('api/notifications/email.ts', root), 'utf8')
function compile(source, imports, extra = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, require: (name) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected offline import ${name}`)
    return imports[name]
  }, Date, Buffer, URL, AbortSignal, console: { error() {} }, process: { env: {} }, ...extra })
  return exports
}
function deliveryFixture({ type = 'answer', read = true, disabled = false, providerStatus = 200,
  providerName, context = { eligible: true, error: null }, fetchError = false, now = Date.now(), required = false,
  policySequence = [], policyError = false, digestPayload, deliveryPriority = 'normal' } = {}) {
  class Clock extends Date { static now() { return now } }
  const requests = [], finishes = [], policies = []
  const record = { id: randomUUID(), recipient_id: randomUUID(), type, is_read: read, delivery_priority: deliveryPriority,
    question_id: randomUUID(), study_group_id: randomUUID(), news_post_id: randomUUID(),
    message: 'PRIVATE_EVENT_TEXT', actor_name: 'PRIVATE_ACTOR_NAME' }
  const job = { id: randomUUID(), notification_id: record.id, lock_token: randomUUID(), attempts: 1, created_at: new Date(now).toISOString() }
  const service = {
    rpc: async (name, values) => {
      if (name === 'xelay_claim_notification_email') return { data: [job], error: null }
      if (name === 'xelay_notification_email_policy') {
        assert.equal(values.p_job_id, job.id); assert.equal(values.p_lock_token, job.lock_token); policies.push(values)
        return { data: policySequence[policies.length - 1] || { eligible: required || !disabled, required, mode: type === 'notification_digest' ? 'daily' : 'immediate', reason: disabled && !required ? 'notifications_disabled' : 'eligible' }, error: policyError ? { message: 'offline policy error' } : null }
      }
      if (name === 'xelay_notification_email_digest_context') {
        assert.equal(values.p_job_id, job.id); assert.equal(values.p_lock_token, job.lock_token)
        return { data: digestPayload || { eligible: true, reason: 'eligible', total: 3, categories: [{ key: 'assignments', count: 2 }, { key: 'grades', count: 1 }], period_start: new Date(now - 86400000).toISOString(), period_end: new Date(now).toISOString() }, error: null }
      }
      if (name === 'xelay_notification_email_message_context') return { data: { eligible: true, reason: 'eligible', conversation_id: randomUUID() }, error: null }
      assert.equal(name, 'xelay_finish_notification_email'); finishes.push(values)
      return { data: true, error: null }
    },
    from: (table) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: table === 'notification_preferences' ? { notifications_enabled: true, email_notifications_enabled: !disabled }
        : table === 'news_posts' ? { status: 'published', university_id: 'test-university', academic_unit_id: null }
          : table === 'profiles' ? { university_id: 'test-university', academic_unit_id: null } : record,
      error: null,
    }) }) }) }),
    auth: { admin: { getUserById: async (id) => {
      assert.equal(id, record.recipient_id)
      return { data: { user: { id, email: 'canonical@example.test', email_confirmed_at: new Date().toISOString() } }, error: null }
    } } },
  }
  const exports = compile(sender, {
    'node:crypto': { createHash, timingSafeEqual },
    '@supabase/supabase-js': { createClient: () => service },
    './notificationEmailContext.js': { notificationEmailContext: async () => context },
  }, { Date: Clock, fetch: async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) })
    if (fetchError) throw new Error('offline timeout')
    return { ok: providerStatus === 200, status: providerStatus, json: async () => providerStatus === 200
      ? { id: 'offline-provider-receipt' } : { name: providerName } }
  } })
  const config = { service, apiKey: 'offline-test-only', from: 'Xelay <auth@example.test>', origin: 'https://preview.example.test' }
  return { record, job, requests, finishes, policies, exports, config, deliver: () => exports.deliverNotificationEmail(config) }
}

test('every trusted type is mailed independently from its read state, without private text', async () => {
  for (const type of ['answer','question_comment','message','connection_request','connection_accepted','news_published',
    'news_comment','news_submission_published','news_submission_rejected','editor_request_approved','editor_request_rejected',
    'class_rep_approved','class_rep_rejected','group_invite','group_invite_accepted','group_homework','teaching_update',
    'chat_invite','chat_join_request','chat_join_approved','chat_message','chat_comment','group_deputy_assigned',
    'group_deputy_permissions','group_deputy_revoked','organizer_reminder','study_group_update',
    'shared_organizer_invite','shared_organizer_update','comment','answer_comment','discussion','future_server_event']) {
    const fx = deliveryFixture({ type, read: true })
    assert.equal((await fx.deliver()).status, 'sent', type)
    assert.equal(fx.requests.length, 1, type)
    const body = fx.requests[0].body
    assert.deepEqual(body.to, ['canonical@example.test'])
    assert.ok(body.subject.endsWith(' — Xelay'))
    assert.doesNotMatch(body.html + body.text, /PRIVATE_EVENT_TEXT|PRIVATE_ACTOR_NAME/)
    assert.equal(fx.requests[0].options.headers['Idempotency-Key'], `xelay-notification/${fx.job.id}`)
  }
})
test('teacher reminders link to the cabinet and action email uses a specific private-safe subject', async () => {
  for (const [type,key,subject] of [
    ['teaching_followup',null,'Що чекає на вашу увагу'],
    ['teaching_update','grade-request:'+randomUUID(),'Новий запит щодо балів'],
    ['teaching_update','classroom-submit:'+randomUUID()+':1','Робота на перевірку'],
  ]) {
    const fx = deliveryFixture({type,context:{eligible:true,error:null,path:'/teaching'}})
    fx.record.teaching_event_key = key
    assert.equal((await fx.deliver()).status,'sent')
    const {body} = fx.requests[0]
    assert.equal(body.subject,subject+' — Xelay')
    assert.match(body.text,/https:\/\/preview\.example\.test\/teaching/)
    assert.doesNotMatch(body.html + body.text,/PRIVATE_EVENT_TEXT|PRIVATE_ACTOR_NAME/)
  }
})
test('common deadline changes send urgent mail with the updated Kyiv time or explicit removal', async () => {
  for (const [dueAt,expected] of [
    [Date.parse('2026-11-05T16:30:00Z'), /5 листопада 2026 р\. о 18:30/],
    [null,/скасував загальний дедлайн/],
  ]) {
    const path = '/groups/'+randomUUID()+'?tab=schedule'
    const fx = deliveryFixture({type:'teaching_update',deliveryPriority:'urgent',context:{eligible:true,error:null,path,teachingDeadlineChange:{dueAt}}})
    fx.record.teaching_event_key = 'teaching-deadline:'+randomUUID()+':2'
    assert.equal((await fx.deliver()).status,'sent')
    const {body} = fx.requests[0]
    assert.match(body.subject,/^Терміновий пріоритет · Змінено дедлайн завдання/)
    assert.match(body.text,expected)
    assert.ok(body.text.includes(path))
    assert.doesNotMatch(body.html + body.text,/PRIVATE_EVENT_TEXT|PRIVATE_ACTOR_NAME/)
  }
})

test('academic deadlines use privacy-safe Kyiv dates and the leased assignment destination', async () => {
  const now = Date.parse('2026-11-04T10:00:00Z')
  const path = '/groups/00000000-0000-4000-8000-000000000000?tab=schedule'
  for (const [kind, deadline, expected] of [
    ['teaching', '2026-11-04T12:15:00Z', /4 листопада 2026 р\. о 14:15/],
    ['homework', '2026-11-04T12:15:00Z', /4 листопада 2026 р\. о 14:15/],
    ['long_term', '2026-11-04T22:00:00Z', /Останній день виконання довгострокового завдання — 4 листопада 2026 р\./],
  ]) {
    const fx = deliveryFixture({ type: 'academic_deadline', now, context: {
      eligible: true, error: null, path, academicDeadline: { kind, dueAt: Date.parse(deadline) },
    } })
    assert.equal((await fx.deliver()).status, 'sent')
    const { body } = fx.requests[0]
    assert.equal(body.subject, 'Нагадування про дедлайн — Xelay')
    assert.match(body.text, expected)
    assert.ok(body.text.includes('https://preview.example.test' + path))
    assert.doesNotMatch(body.html + body.text, /PRIVATE_EVENT_TEXT|PRIVATE_ACTOR_NAME|5 листопада|00:00/)
  }
})

test('deadline mail never sends after its exact expiry or on a missing leased context', async () => {
  const now = Date.parse('2026-11-04T10:00:00Z')
  const path = '/groups/00000000-0000-4000-8000-000000000000?tab=schedule'
  const overdue = deliveryFixture({ type: 'academic_deadline', now, context: {
    eligible: true, error: null, path, academicDeadline: { kind: 'teaching', dueAt: now },
  } })
  assert.equal((await overdue.deliver()).status, 'skipped')
  assert.equal(overdue.finishes[0].p_error_code, 'deadline_elapsed')
  assert.equal(overdue.requests.length, 0)
  const missing = deliveryFixture({ type: 'academic_deadline' })
  assert.equal((await missing.deliver()).status, 'pending')
  assert.equal(missing.finishes[0].p_error_code, 'context_payload_invalid')
  assert.equal(missing.requests.length, 0)
})

test('explicit opt-out and current access checks still prevent delivery', async () => {
  for (const options of [{ disabled: true }, { context: { eligible: false, error: null } },
    { context: { eligible: false, error: 'group_access_removed' } }]) {
    const fx = deliveryFixture(options)
    assert.equal((await fx.deliver()).status, 'skipped')
    assert.equal(fx.requests.length, 0)
  }
  const error = deliveryFixture({ context: { eligible: false, error: 'context_lookup_failed' } })
  assert.equal((await error.deliver()).status, 'pending')
  assert.equal(error.requests.length, 0)
})

test('mandatory mail uses the current server lease policy despite ordinary email opt-out and never carries private text', async () => {
  const fx = deliveryFixture({ type: 'teaching_update', required: true, disabled: true })
  assert.equal((await fx.deliver()).status, 'sent')
  assert.equal(fx.policies.length, 2)
  assert.match(fx.requests[0].body.subject, /^Важливе повідомлення · /)
  assert.doesNotMatch(fx.requests[0].body.subject, /Терміновий|Обов’язково/)
  assert.match(fx.requests[0].body.text, /Ознайомився/)
  assert.match(fx.requests[0].body.text, /незалежно від налаштувань/)
  assert.doesNotMatch(fx.requests[0].body.html + fx.requests[0].body.text, /PRIVATE_EVENT_TEXT|PRIVATE_ACTOR_NAME/)
})

test('email subject urgency follows the stored priority independently from required acknowledgement', async () => {
  for (const [required, deliveryPriority, prefix] of [
    [false, 'normal', ''], [false, 'attention', ''],
    [true, 'normal', 'Важливе повідомлення · '], [true, 'attention', 'Важливе повідомлення · '],
    [false, 'urgent', 'Терміновий пріоритет · '], [true, 'urgent', 'Терміновий пріоритет · '],
  ]) {
    const fx = deliveryFixture({ required, deliveryPriority })
    assert.equal((await fx.deliver()).status, 'sent')
    const mail = fx.requests[0].body, title = prefix + 'Нова відповідь на ваше запитання'
    assert.equal(mail.subject, title + ' — Xelay')
    assert.ok(mail.html.includes('>' + title + '</h1>'))
    assert.ok(mail.text.startsWith(title + '\n'))
    assert.equal(mail.text.includes('Ознайомився'), required)
    assert.equal(mail.text.includes('незалежно від налаштувань'), required)
    assert.doesNotMatch(mail.html + mail.text, /PRIVATE_EVENT_TEXT|PRIVATE_ACTOR_NAME/)
  }
})

test('a changed common deadline receives one urgency label and only for its trusted urgent priority', async () => {
  for (const deliveryPriority of ['urgent', 'normal']) {
    const fx = deliveryFixture({ type: 'teaching_update', required: true, deliveryPriority,
      context: { eligible: true, error: null, teachingDeadlineChange: { dueAt: Date.now() + 3600000 }, path: '/groups/fictional-group?tab=schedule' } })
    fx.record.teaching_event_key = 'teaching-deadline:' + randomUUID() + ':2'
    assert.equal((await fx.deliver()).status, 'sent')
    const mail = fx.requests[0].body
    assert.equal(mail.subject, (deliveryPriority === 'urgent' ? 'Терміновий пріоритет · ' : 'Важливе повідомлення · ') + 'Змінено дедлайн завдання — Xelay')
    assert.equal(mail.subject.split(' · ').length, 2)
    assert.doesNotMatch(mail.subject, /Терміново ·|Обов’язково ·/)
    assert.match(mail.text, /Ознайомився/)
  }
})

test('a changed delivery policy or lost access immediately before sending prevents the external request', async () => {
  const allowed = { eligible: true, required: false, mode: 'immediate', reason: 'eligible' }
  for (const reason of ['notifications_disabled', 'announcement_unavailable', 'digest_queued']) {
    const fx = deliveryFixture({ policySequence: [allowed, { ...allowed, eligible: false, reason, mode: reason === 'digest_queued' ? 'daily' : 'immediate' }] })
    assert.equal((await fx.deliver()).status, 'skipped'); assert.equal(fx.requests.length, 0)
    assert.equal(fx.finishes[0].p_error_code, reason)
  }
  const unavailable = deliveryFixture({ policyError: true })
  assert.equal((await unavailable.deliver()).status, 'pending'); assert.equal(unavailable.requests.length, 0)
  assert.equal(unavailable.finishes[0].p_error_code, 'email_policy_lookup_failed')
  const off = deliveryFixture({ policySequence: [{ eligible: false, required: false, mode: 'off', reason: 'notifications_disabled' }] })
  assert.equal((await off.deliver()).status, 'skipped'); assert.equal(off.requests.length, 0)
})

test('daily digest renders validated aggregate counts with the notification center destination', async () => {
  const fx = deliveryFixture({ type: 'notification_digest' })
  assert.equal((await fx.deliver()).status, 'sent'); assert.equal(fx.requests.length, 1)
  const mail = fx.requests[0].body
  assert.equal(mail.subject, 'Ваші сповіщення за день — Xelay')
  assert.match(mail.text, /Нових подій: 3/); assert.match(mail.text, /Оцінки й перевірка: 1/)
  assert.match(mail.text, /\?notifications=1/); assert.doesNotMatch(mail.html + mail.text, /PRIVATE_|canonical@example/)
})

test('malformed or inconsistent digest metadata never reaches the mail provider', async () => {
  const base = { eligible: true, reason: 'eligible', total: 2, categories: [{ key: 'grades', count: 2 }], period_start: '2026-11-04T07:00:00Z', period_end: '2026-11-05T07:00:00Z' }
  for (const change of [{ total: 3 }, { categories: [{ key: '<script>', count: 2 }] }, { categories: [{ key: 'grades', count: 1 }, { key: 'grades', count: 1 }] }, { period_end: base.period_start }, { total: '2' }]) {
    const fx = deliveryFixture({ type: 'notification_digest', digestPayload: { ...base, ...change } })
    assert.equal((await fx.deliver()).status, 'pending'); assert.equal(fx.requests.length, 0)
    assert.equal(fx.finishes[0].p_error_code, 'digest_context_lookup_failed')
  }
})

test('explicit provider quota, rate and configuration refusals remain queued and stop the drain', async () => {
  for (const [status, name, code] of [
    [429,'daily_quota_exceeded','provider_daily_quota'],[429,'monthly_quota_exceeded','provider_monthly_quota'],
    [429,'rate_limit_exceeded','provider_rate_limit'],[401,'invalid_api_key','provider_configuration'],
    [403,'restricted_api_key','provider_configuration'],
  ]) {
    const fx = deliveryFixture({ providerStatus: status, providerName: name })
    const result = await fx.deliver()
    assert.equal(result.status, 'pending'); assert.equal(result.deferred, true); assert.equal(result.stop, true)
    assert.equal(fx.finishes[0].p_error_code, code)
  }
})

test('an uncertain network response retains the same idempotency key for retry', async () => {
  const fx = deliveryFixture({ fetchError: true })
  assert.equal((await fx.deliver()).status, 'pending')
  assert.equal((await fx.deliver()).status, 'pending')
  assert.equal(fx.requests[0].options.headers['Idempotency-Key'], fx.requests[1].options.headers['Idempotency-Key'])
  assert.equal(fx.finishes[0].p_error_code, 'delivery_temporarily_unavailable')
})

test('a short remaining budget preserves time for the receipt without starting an uncertain provider send', async () => {
  const fx = deliveryFixture()
  fx.config.deadline = Date.now() + 1000
  assert.equal((await fx.deliver()).status, 'pending')
  assert.equal(fx.requests.length, 0)
  assert.equal(fx.finishes[0].p_error_code, 'worker_budget_exhausted')
})

test('public readiness reports provider quota/configuration pauses without exposing queue data', async () => {
  for (const [runtime, expected] of [
    [{ enabled: true, heartbeat_at: new Date().toISOString(), paused_until: null, pause_reason: null }, 'ready'],
    [{ enabled: true, heartbeat_at: new Date().toISOString() }, 'unavailable'],
    [{ enabled: true, heartbeat_at: new Date().toISOString(), paused_until: new Date(Date.now() + 60000).toISOString(), pause_reason: 'provider_daily_quota' }, 'limited'],
    [{ enabled: true, heartbeat_at: new Date().toISOString(), paused_until: new Date(Date.now() + 60000).toISOString(), pause_reason: 'provider_configuration' }, 'unavailable'],
    [{ enabled: true, heartbeat_at: new Date(Date.now() - 600000).toISOString() }, 'unavailable'],
  ]) {
    const service = { rpc: async () => ({ data: Object.hasOwn(runtime, 'paused_until')
      ? { delivery_mode: 'per_notification_v1', contexts_ready: true, notification_center_ready: true, ...runtime } : runtime, error: null }) }
    const exports = compile(sender, {
      'node:crypto': { createHash, timingSafeEqual }, '@supabase/supabase-js': { createClient: () => service },
      './notificationEmailContext.js': { notificationEmailContext: async () => ({ eligible: true, error: null }) },
    }, { process: { env: { NOTIFICATION_EMAIL_ENABLED: 'true', SUPABASE_URL: 'https://offline.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'offline-service-only', RESEND_API_KEY: 'offline-provider-only',
      XELAY_EMAIL_FROM: 'Xelay <auth@example.test>', XELAY_PUBLIC_URL: 'https://preview.example.test',
      NOTIFICATION_WEBHOOK_SECRET: 'offline-notification-webhook-secret-1234567890' } } })
    const status = await exports.notificationEmailAvailability()
    assert.equal(status.state, expected); assert.equal(status.available, expected === 'ready')
    assert.deepEqual(Object.keys(status).sort(), ['available', 'state'])
  }
})

function workerFixture(sequence) {
  let index = 0, heartbeat = 0, disabled = 0, now = Date.now()
  class Clock extends Date { static now() { return now } }
  const email = {
    authorizeNotificationWorker() {}, notificationPrivateResponse() {},
    notificationEmailConfiguration: () => ({ service: {}, deadline: now + 53000 }),
    notificationEmailWorkerHeartbeat: async () => { heartbeat += 1 },
    notificationEmailWorkerDisable: async () => { disabled += 1 },
    notificationEmailWorkerSchemaReady: async () => true,
    deliverNotificationEmail: async () => { now += 100; return sequence[index++] ?? { processed: false } },
    notificationWebhookJobId: () => randomUUID(), notificationEmailAvailability: async () => ({ available: true, state: 'ready' }),
    sendNotificationEmailError: (_res, error) => { throw error },
  }
  const independent = { deliverAdminRepresentativeAlert: async () => ({ processed: false }),
    deliverOpportunitiesDigest: async () => ({ processed: false }),
    deliverAdminSecurityAlerts: async () => ({ enabled: false, processed: false, state: 'disabled' }),
    processBirthdayEvents: async () => ({ enabled: false, status: 'disabled', processed: 0,
      giftsOffered: 0, groupNotifications: 0, hasMore: false }) }
  const exports = compile(retry, { './notificationEmail.js': email, './adminRepresentativeAlerts.js': independent,
    './opportunitiesDigest.js': independent, './securityMonitor.js': independent, './birthdayEvents.js': independent },
    { Date: Clock, setTimeout: (fn, delay) => { now += delay; fn() } })
  const result = { code: null, body: null, setHeader() {}, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
  return { run: () => exports.default({ method: 'POST' }, result), result, email, counts: () => ({ index, heartbeat, disabled }) }
}

test('recurring worker drains up to80 fast jobs with a bounded runtime', async () => {
  const fx = workerFixture(Array.from({ length: 100 }, () => ({ processed: true, status: 'sent' })))
  await fx.run()
  assert.equal(fx.result.body.processed, 80)
  assert.equal(fx.result.body.healthy, true)
  assert.equal(fx.counts().heartbeat, 1)
})

test('deployment waits for the new receipt schema without consuming an old job', async () => {
  const fx = workerFixture([{ processed: true, status: 'sent' }])
  fx.email.notificationEmailWorkerSchemaReady = async () => false
  await fx.run()
  assert.equal(fx.result.body.waiting_for_migration, true)
  assert.equal(fx.result.body.processed, 0)
  assert.equal(fx.counts().index, 0)
  assert.equal(fx.counts().heartbeat, 1)
})

test('quota stops the batch without destroying the next recipient job', async () => {
  const fx = workerFixture([{ processed: true, status: 'pending', deferred: true, stop: true }, { processed: true, status: 'sent' }])
  await fx.run()
  assert.equal(fx.counts().index, 1); assert.equal(fx.counts().heartbeat, 1)
  assert.equal(fx.result.body.processed, 1)
})

test('isolated failed event does not stop other recipients; an uncertain failure does', async () => {
  const fx = workerFixture([{ processed: true, status: 'failed' }, { processed: true, status: 'sent' }])
  await fx.run(); assert.equal(fx.result.body.processed, 2); assert.equal(fx.counts().disabled, 0)
  const network = workerFixture([{ processed: true, status: 'pending' }, { processed: true, status: 'sent' }])
  await network.run(); assert.equal(network.result.body.processed, 1); assert.equal(network.counts().disabled, 1)
})

test('insert webhook acknowledges durable queue without parallel provider sends', async () => {
  const fx = workerFixture([])
  const exports = compile(webhook, { '../../server/notificationEmail.js': fx.email,
    '../../server/notificationRetry.js': { default: async () => {} } })
  await exports.default({ method: 'POST', query: {} }, fx.result)
  assert.equal(fx.result.body.queued, true); assert.equal(fx.counts().index, 0)
})
