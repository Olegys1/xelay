import { readFile } from 'node:fs/promises'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

// The actual sender and actual database lease/policy run here. Its sole fetch
// is an offline recording provider; no provider key, environment or network.
export async function createPreviewNotificationMail(fx, origin) {
  const messages = []
  const service = {
    rpc: async (name, args = {}) => {
      try {
        if (!/^xelay_[a-z_]+$/.test(name)) throw Error('LOCAL_MAIL_RPC_DENIED')
        const values = Object.values(args).map(value => value && typeof value === 'object' ? JSON.stringify(value) : value)
        const query = name === 'xelay_claim_notification_email' ? `select * from public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')})` : `select public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) data`
        const result = await fx.asUser(null, query, values, { role: 'service_role' })
        return { data: name === 'xelay_claim_notification_email' ? result.rows : result.rows[0]?.data, error: null }
      } catch (error) { return { data: null, error: { message: error.message } } }
    },
    from(table) {
      if (!/^[a-z_]+$/.test(table)) throw Error('LOCAL_MAIL_TABLE_DENIED')
      let fields = '', filters = []
      const query = { select(value) { if (!/^[a-z0-9_,]+$/.test(value)) throw Error('LOCAL_MAIL_COLUMNS_DENIED'); fields = value; return query },
        eq(field, value) { if (!/^[a-z_]+$/.test(field)) throw Error('LOCAL_MAIL_FILTER_DENIED'); filters.push([field, value]); return query },
        async maybeSingle() {
          try { const result = await fx.db.query(`select ${fields} from public.${table} where ${filters.map(([field], i) => `${field}=$${i + 1}`).join(' and ') || 'true'} limit 1`, filters.map(([, value]) => value)); return { data: result.rows[0] || null, error: null } }
          catch (error) { return { data: null, error: { message: error.message } } }
        } }
      return query
    },
    auth: { admin: { getUserById: async id => ({ data: { user: { id, email: `preview-${id}@example.test`, email_confirmed_at: new Date().toISOString() } }, error: null }) } },
  }
  function compile(source, imports, extra = {}) {
    const module = { exports: {} }
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, Date, Intl, Buffer, URL, AbortSignal, console: { error() {} }, process: { env: {} },
        require(name) { if (!Object.hasOwn(imports, name)) throw Error('LOCAL_MAIL_IMPORT_DENIED'); return imports[name] }, ...extra })
    return module.exports
  }
  const context = compile(await readFile(new URL('../../server/notificationEmailContext.ts', import.meta.url), 'utf8'), {})
  const sender = compile(await readFile(new URL('../../server/notificationEmail.ts', import.meta.url), 'utf8'), {
    'node:crypto': { createHash, timingSafeEqual }, '@supabase/supabase-js': { createClient() { throw Error('LOCAL_MAIL_REAL_CLIENT_DISABLED') } }, './notificationEmailContext.js': context,
  }, { fetch: async (url, options) => {
    if (url !== 'https://api.resend.com/emails') throw Error('LOCAL_MAIL_NETWORK_DISABLED')
    const body = JSON.parse(options.body), recipient = String(body.to?.[0] || '').match(/^preview-([a-f0-9-]{36})@example\.test$/)?.[1]
    if (!recipient) throw Error('LOCAL_MAIL_RECIPIENT_DENIED')
    const key = options.headers['Idempotency-Key']
    let receipt = messages.find(row => row.key === key)
    if (!receipt) { receipt = { id: randomUUID(), key, recipient, subject: body.subject, html: body.html, text: body.text, created_at: new Date().toISOString() }; messages.push(receipt) }
    return { ok: true, status: 200, json: async () => ({ id: receipt.id }) }
  } })
  const config = { service, origin, from: 'Xelay <preview@example.test>', apiKey: 'local-offline-placeholder' }
  return { messages, async deliver(recipient, daily = false) {
    await fx.db.exec('update notification_email_runtime set worker_enabled=true,last_heartbeat_at=clock_timestamp()')
    if (daily) await fx.db.query("update notification_email_outbox set available_at=clock_timestamp()-interval '1 second' where recipient_id=$1 and notification_type='notification_digest' and status='pending'", [recipient])
    const jobs = (await fx.db.query("select id from notification_email_outbox where recipient_id=$1 and status='pending' and available_at<=clock_timestamp() order by created_at,id limit 60", [recipient])).rows
    const results = []
    for (const job of jobs) results.push(await sender.deliverNotificationEmail(config, job.id))
    return results
  } }
}
