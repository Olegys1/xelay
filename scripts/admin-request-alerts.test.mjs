// Offline regressions for the real Telegram worker. No live provider or DB.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../server/adminRepresentativeAlerts.ts', import.meta.url), 'utf8')
const token = randomUUID()
const chatId = '-1001234567890'
const teacherUrl = 'https://www.xelay.ink/admin#teacher-verification-requests'
const representativeUrl = 'https://www.xelay.ink/admin#class-representative-requests'
const base = { lease_token: token, pending_count: 1, oldest_pending_at: '2026-10-27T09:00:00.000Z' }
const typed = (representatives, teachers) => ({ ...base, pending_count: representatives + teachers,
  representative_pending_count: representatives, teacher_pending_count: teachers })
const plain = value => JSON.parse(JSON.stringify(value))

function fixture(options = {}) {
  const requests = [], calls = [], finishes = []
  const claimed = Object.hasOwn(options, 'claimed') ? options.claimed : typed(0, 1)
  const live = Object.hasOwn(options, 'live') ? options.live : claimed
  const service = { rpc: async (name, args) => {
    calls.push({ name, args: plain(args ?? {}) })
    if (name === 'xelay_claim_admin_representative_alert') return { data: claimed, error: options.claimError ?? null }
    if (name === 'xelay_admin_representative_alert_delivery_context') return { data: live, error: options.liveError ?? null }
    assert.equal(name, 'xelay_finish_admin_representative_alert')
    finishes.push(plain(args))
    if (options.receiptThrow) throw Error('offline receipt unavailable')
    return { data: !options.receiptFailure, error: null }
  } }
  const exports = {}
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    exports, require(name) { assert.equal(name, '@supabase/supabase-js'); return { createClient: () => service } },
    Date, AbortSignal, TextDecoder, Uint8Array,
    process: { env: { ADMIN_ALERT_TELEGRAM_ENABLED: 'true',
      ADMIN_ALERT_TELEGRAM_BOT_TOKEN: `123456789:${'offline_'.repeat(5)}`,
      ADMIN_ALERT_TELEGRAM_CHAT_ID: chatId, SUPABASE_URL: 'https://offline.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'offline-service-role-only', ...options.env } },
    fetch: async (url, request) => {
      assert.ok(url.startsWith('https://api.telegram.org/bot123456789:offline_'))
      const method = url.slice(url.lastIndexOf('/') + 1)
      assert.ok(['getChat', 'sendMessage'].includes(method), `Unexpected provider method: ${method}`)
      requests.push({ method, body: JSON.parse(request.body), redirect: request.redirect })
      if (options.fetchThrow === method) throw Error('offline token must never leak')
      const reply = options[method] ?? (method === 'getChat'
        ? { status: 200, body: { ok: true, result: { id: chatId, type: 'supergroup' } } }
        : { status: 200, body: { ok: true, result: { message_id: 42, chat: { id: chatId } } } })
      return new Response(JSON.stringify(reply.body), { status: reply.status })
    },
  })
  return { requests, calls, finishes,
    run: (deadline = Date.now() + 53000) => exports.deliverAdminRepresentativeAlert(deadline),
    message: () => requests.find(request => request.method === 'sendMessage')?.body,
  }
}

test('teacher-only pending queue produces a protected teacher message with the correct admin link', async () => {
  const fx = fixture({ claimed: { ...typed(0, 2), full_name: 'PRIVATE_NAME', email: 'private@example.test',
    note: 'PRIVATE_NOTE', contact_telegram: 'PRIVATE_CONTACT', latest_request_id: randomUUID() } })
  assert.equal((await fx.run()).state, 'sent')
  const message = fx.message()
  assert.match(message.text, /викладач/)
  assert.match(message.text, /2/)
  assert.doesNotMatch(JSON.stringify(message), /PRIVATE_|private@example|latest_request_id/)
  assert.deepEqual(message.reply_markup.inline_keyboard.flat().map(button => button.url), [teacherUrl])
  assert.equal(message.protect_content, true)
  assert.equal(message.link_preview_options.is_disabled, true)
  assert.equal(message.chat_id, chatId)
  assert.equal(fx.finishes[0].p_status, 'sent')
  assert.deepEqual(fx.calls.map(call => call.name), [
    'xelay_claim_admin_representative_alert', 'xelay_admin_representative_alert_delivery_context',
    'xelay_finish_admin_representative_alert',
  ])
})

test('representative-only and mixed queues keep distinct links and count breakdowns', async () => {
  const representatives = fixture({ claimed: typed(3, 0) })
  assert.equal((await representatives.run()).state, 'sent')
  assert.match(representatives.message().text, /старост/)
  assert.deepEqual(representatives.message().reply_markup.inline_keyboard.flat().map(button => button.url), [representativeUrl])
  const mixed = fixture({ claimed: typed(3, 2) })
  assert.equal((await mixed.run()).state, 'sent')
  assert.match(mixed.message().text, /старост/)
  assert.match(mixed.message().text, /викладач/)
  assert.match(mixed.message().text, /3/)
  assert.match(mixed.message().text, /2/)
  assert.deepEqual(new Set(mixed.message().reply_markup.inline_keyboard.flat().map(button => button.url)),
    new Set([representativeUrl, teacherUrl]))
})

test('rolling deployment still understands a legacy representative-only summary', async () => {
  const fx = fixture({ claimed: base })
  assert.equal((await fx.run()).state, 'sent')
  assert.match(fx.message().text, /старост/)
  assert.deepEqual(fx.message().reply_markup.inline_keyboard.flat().map(button => button.url), [representativeUrl])
})

test('malformed typed summaries are retried without contacting Telegram', async () => {
  for (const claimed of [
    { ...base, teacher_pending_count: 1 }, { ...base, representative_pending_count: 1 },
    { ...typed(0, 1), teacher_pending_count: -1 }, { ...typed(0, 1), teacher_pending_count: 1.5 },
    { ...typed(0, 1), representative_pending_count: '0' },
    { ...typed(1, 1), pending_count: 1 }, { ...typed(0, 1), teacher_pending_count: null },
    { ...typed(0, 1), representative_pending_count: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const fx = fixture({ claimed })
    assert.equal((await fx.run()).state, 'retry', JSON.stringify(claimed))
    assert.equal(fx.requests.length, 0)
    assert.equal(fx.finishes[0].p_error_code, 'malformed_queue')
  }
})

test('live queue reread controls recipients and counts immediately before the send', async () => {
  const fx = fixture({ claimed: typed(5, 0), live: typed(0, 2) })
  assert.equal((await fx.run()).state, 'sent')
  assert.match(fx.message().text, /викладач/)
  assert.deepEqual(fx.message().reply_markup.inline_keyboard.flat().map(button => button.url), [teacherUrl])
  const reviewed = fixture({ claimed: typed(0, 2), live: null })
  assert.equal((await reviewed.run()).state, 'skipped')
  assert.equal(reviewed.message(), undefined)
  assert.equal(reviewed.finishes[0].p_status, 'skipped')
  const stale = fixture({ live: { ...typed(0, 1), lease_token: randomUUID() } })
  assert.equal((await stale.run()).state, 'retry')
  assert.equal(stale.message(), undefined)
  assert.equal(stale.finishes[0].p_error_code, 'malformed_queue')
  const unavailable = fixture({ liveError: { code: 'offline' } })
  assert.equal((await unavailable.run()).state, 'retry')
  assert.equal(unavailable.message(), undefined)
})

test('Telegram rate limits preserve a bounded Retry-After for durable retry', async () => {
  for (const method of ['getChat', 'sendMessage']) {
    const fx = fixture({ [method]: { status: 429, body: { ok: false, error_code: 429,
      description: 'PRIVATE_PROVIDER_TEXT', parameters: { retry_after: 999999 } } } })
    assert.equal((await fx.run()).state, 'retry')
    assert.equal(fx.finishes[0].p_error_code, 'telegram_rate_limited')
    assert.equal(fx.finishes[0].p_retry_after_seconds, 86400)
    assert.doesNotMatch(JSON.stringify(fx.finishes), /PRIVATE_PROVIDER_TEXT|offline_/)
  }
})

test('public, mismatched or direct-message chats fail closed without a message', async () => {
  for (const result of [
    { id: chatId, type: 'supergroup', username: 'public_chat' },
    { id: chatId, type: 'supergroup', active_usernames: ['public_chat'] },
    { id: chatId, type: 'supergroup', is_direct_messages: true },
    { id: chatId, type: 'channel' }, { id: chatId, type: 'private' },
    { id: '-999', type: 'supergroup' },
  ]) {
    const fx = fixture({ getChat: { status: 200, body: { ok: true, result } } })
    assert.equal((await fx.run()).state, 'retry')
    assert.equal(fx.message(), undefined)
    assert.equal(fx.finishes[0].p_error_code, 'telegram_chat_not_private')
  }
})

test('provider errors and uncertain network sends retain the queue with sanitized status', async () => {
  for (const options of [
    { fetchThrow: 'sendMessage' },
    { sendMessage: { status: 503, body: { ok: false, description: 'PRIVATE_ERROR' } } },
    { sendMessage: { status: 403, body: { ok: false, error_code: 403, description: 'PRIVATE_ERROR' } } },
    { sendMessage: { status: 200, body: { ok: true, result: { message_id: 42, chat: { id: '-999' } } } } },
  ]) {
    const fx = fixture(options)
    const result = await fx.run()
    assert.equal(result.state, 'retry')
    assert.equal(fx.finishes[0].p_status, 'failed')
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(fx.finishes), /PRIVATE_ERROR|offline_/)
  }
})

test('lost delivery receipt is reported as uncertain rather than falsely acknowledged', async () => {
  for (const options of [{ receiptFailure: true }, { receiptThrow: true }]) {
    const fx = fixture(options)
    assert.equal((await fx.run()).state, 'receipt_unavailable')
    assert.equal(fx.finishes[0].p_status, 'sent')
    assert.equal(fx.requests.filter(request => request.method === 'sendMessage').length, 1)
  }
})

test('empty queue and insufficient time do not send or claim unnecessarily', async () => {
  const empty = fixture({ claimed: null })
  assert.equal((await empty.run()).state, 'idle')
  assert.equal(empty.requests.length, 0)
  assert.equal(empty.finishes.length, 0)
  const disabled = fixture({ env: { ADMIN_ALERT_TELEGRAM_ENABLED: 'false' } })
  assert.equal((await disabled.run()).state, 'disabled')
  assert.equal(disabled.calls.length, 0)
  const invalid = fixture({ env: { ADMIN_ALERT_TELEGRAM_CHAT_ID: '@public_chat' } })
  assert.equal((await invalid.run()).state, 'not_configured')
  assert.equal(invalid.calls.length, 0)
  const shortBudget = fixture()
  assert.equal((await shortBudget.run(Date.now() + 1000)).state, 'deadline')
  assert.equal(shortBudget.calls.length, 0)
  assert.equal(shortBudget.requests.length, 0)
})
