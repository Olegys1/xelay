import type { notificationEmailConfiguration } from './notificationEmail.js'

type EmailConfig = ReturnType<typeof notificationEmailConfiguration>
type DigestJob = { id: string; lock_token: string; attempts: number; created_at: string }
type DigestItem = { id: string; title: string; company: string; kind: string; city: string; deadline: string }
type DigestContext = { eligible: boolean; email?: string; items?: DigestItem[] }
export type OpportunitiesDigestResult = { enabled: boolean; prepared: number; sent: number; skipped: number; retry: number; state: 'disabled' | 'ready' | 'unavailable' }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const htmlEscape = (text: string) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))

function renderDigest(context: DigestContext, origin: string) {
  const settingsUrl = `${origin}/opportunities?tab=preferences`
  const rows = (context.items ?? []).slice(0, 8).map((item) => ({
    title: item.title.slice(0, 180), company: item.company.slice(0, 180), city: (item.city || '').slice(0, 120),
    // IDs come from the DB, never from an arbitrary campaign URL.
    url: `${origin}/opportunities?opportunity=${item.id}`,
  }))
  const subject = 'Нові можливості для вас — Xelay'
  const html = `<!doctype html><html lang="uk"><body style="margin:0;background:#f6f5f4;font-family:Arial,sans-serif;color:#231f20"><main style="max-width:580px;margin:24px auto;padding:32px;background:#fff;border:1px solid #e9e4e5;border-radius:20px"><p style="font-size:28px;margin:0 0 24px">Xelay</p><h1 style="font-size:24px;margin:0 0 12px">${subject}</h1><p style="line-height:1.6;color:#6b6264">Добірка нових схвалених пропозицій за вашими інтересами.</p>${rows.map((row) => `<section style="padding:18px 0;border-top:1px solid #eee"><a style="color:#800020;font-size:17px;font-weight:600" href="${htmlEscape(row.url)}">${htmlEscape(row.title)}</a><p style="color:#6b6264;margin:8px 0 0">${htmlEscape(row.company)}${row.city ? ' · ' + htmlEscape(row.city) : ''}</p></section>`).join('')}<p style="font-size:12px;line-height:1.6;color:#6b6264;margin-top:28px">Ви отримали цей лист, тому що увімкнули щотижневу добірку можливостей. Ви можете вимкнути її в налаштуваннях.</p><a href="${htmlEscape(settingsUrl)}" style="font-size:13px;color:#800020">Керувати добіркою / відписатися</a></main></body></html>`
  const text = `${subject}\n\n${rows.map((row) => `${row.title}\n${row.company}${row.city ? ' · ' + row.city : ''}\n${row.url}`).join('\n\n')}\n\nВи увімкнули щотижневу добірку. Керувати добіркою / відписатися: ${settingsUrl}`
  return { subject, html, text }
}

/** Optional branch of the existing authenticated email worker. Never throws or
 * logs recipients/content; failures cannot block messages or admin alerts. */
export async function deliverOpportunitiesDigest(config: EmailConfig, deadline: number): Promise<OpportunitiesDigestResult> {
  const result: OpportunitiesDigestResult = { enabled: false, prepared: 0, sent: 0, skipped: 0, retry: 0, state: 'disabled' }
  if (process.env.OPPORTUNITIES_DIGEST_ENABLED !== 'true') return result
  result.enabled = true
  try {
    if (Date.now() + 35000 > deadline) { result.state = 'ready'; return result }
    const prepared = await config.service.rpc('xelay_prepare_opportunities_digest')
    if (prepared.error) { result.state = 'unavailable'; return result }
    result.prepared = typeof prepared.data === 'number' ? prepared.data : 0
    let claimedCount = 0
    const outcomes: OpportunitiesDigestResult[] = []
    const worker = async () => {
      // At most five jobs per invocation, two concurrent deliveries. Fast
      // providers drain the batch; a slow provider cannot exceed the deadline.
      while (claimedCount < 5 && Date.now() + 30000 <= deadline) {
        claimedCount++
        const outcome = await deliverOneDigest(config, deadline)
        outcomes.push(outcome)
        if (outcome.sent + outcome.skipped + outcome.retry === 0 || outcome.state === 'unavailable') break
      }
    }
    await Promise.all([worker(), worker()])
    result.sent = outcomes.reduce((sum, outcome) => sum + outcome.sent, 0)
    result.skipped = outcomes.reduce((sum, outcome) => sum + outcome.skipped, 0)
    result.retry = outcomes.reduce((sum, outcome) => sum + outcome.retry, 0)
    result.state = outcomes.some((outcome) => outcome.state === 'unavailable') ? 'unavailable' : 'ready'
    return result
  } catch { result.state = 'unavailable'; return result }
}

async function deliverOneDigest(config: EmailConfig, deadline: number): Promise<OpportunitiesDigestResult> {
  const result: OpportunitiesDigestResult = { enabled: true, prepared: 0, sent: 0, skipped: 0, retry: 0, state: 'ready' }
  let job: DigestJob | undefined
  const finish = async (status: 'sent' | 'skipped' | 'pending' | 'failed', error: string | null = null, providerId: string | null = null) => {
    if (!job) return false
    const { data, error: finishError } = await config.service.rpc('xelay_finish_opportunities_digest', {
      p_job_id: job.id, p_lock_token: job.lock_token, p_status: status, p_error_code: error, p_provider_message_id: providerId,
    })
    return !finishError && data === true
  }
  try {
    const claimed = await config.service.rpc('xelay_claim_opportunities_digest')
    if (claimed.error) { result.state = 'unavailable'; return result }
    job = claimed.data || undefined
    if (!job) { result.state = 'ready'; return result }
    if (!UUID.test(job.id) || !UUID.test(job.lock_token)) { result.state = 'unavailable'; return result }
    const created = Date.parse(job.created_at)
    if (!Number.isFinite(created) || Date.now() - created >= 23 * 60 * 60 * 1000) {
      if (await finish('skipped', 'expired')) result.skipped++
      result.state = 'ready'; return result
    }
    const initial = await config.service.rpc('xelay_opportunities_digest_context', { p_job_id: job.id, p_lock_token: job.lock_token })
    if (initial.error) throw new Error('context_unavailable')
    if (initial.data?.eligible !== true) {
      if (await finish('skipped', 'preferences_changed')) result.skipped++
      result.state = 'ready'; return result
    }
    // The exact delivery-boundary context rechecks opt-out, verified Auth email,
    // disabled module, expired offers and current visibility after the claim.
    const latest = await config.service.rpc('xelay_opportunities_digest_context', { p_job_id: job.id, p_lock_token: job.lock_token })
    if (latest.error) throw new Error('context_unavailable')
    const context = latest.data as DigestContext | null
    if (context?.eligible !== true || !context.email || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(context.email)
      || !Array.isArray(context.items) || context.items.length === 0 || context.items.some((item) => !UUID.test(item.id)
        || typeof item.title !== 'string' || typeof item.company !== 'string')) {
      if (await finish('skipped', 'not_eligible')) result.skipped++
      result.state = 'ready'; return result
    }
    if (Date.now() + 11000 > deadline) throw new Error('deadline')
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now() - 6000))),
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `xelay-opportunities-digest/${job.id}` },
      body: JSON.stringify({ from: config.from, to: [context.email], ...renderDigest(context, config.origin) }),
    })
    let provider: { id?: string; name?: string } = {}
    try { provider = await response.json() } catch { /* Provider payload and recipient never enter logs. */ }
    if (response.ok && typeof provider.id === 'string' && provider.id.length <= 256) {
      if (await finish('sent', null, provider.id)) result.sent++
      else { result.retry++; result.state = 'unavailable'; return result }
    } else {
      const concurrent = response.status === 409 && provider.name === 'concurrent_idempotent_requests'
      const retryable = response.status === 429 || response.status >= 500 || concurrent || response.ok
      if (await finish(retryable && job.attempts < 5 ? 'pending' : 'failed', `provider_${response.status}`)) result.retry++
    }
    result.state = 'ready'
    return result
  } catch {
    if (job && UUID.test(job.id) && UUID.test(job.lock_token)) {
      try { await finish(job.attempts < 5 ? 'pending' : 'failed', 'delivery_unavailable') } catch { /* Lease expires for retry. */ }
      result.retry++
    }
    result.state = 'unavailable'
    return result
  }
}
