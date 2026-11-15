const KEY = 'xelay:partner-click:browser:v1'
const DAY = 86400000
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
let sessionId = ''

/** Created only after a visitor chooses an external tool, never at page load. */
export function partnerClickBrowserId(options: { storage?: Pick<Storage, 'getItem' | 'setItem'> | null; now?: number; randomId?: () => string } = {}): string {
  const at = options.now ?? Date.now()
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  let storage: Pick<Storage, 'getItem' | 'setItem'> | null = options.storage ?? null
  if (options.storage === undefined) {
    try { storage = typeof window === 'undefined' ? null : window.localStorage } catch { storage = null }
  }
  let id = ''
  try {
    const raw = JSON.parse(storage?.getItem(KEY) || 'null')
    if (raw && typeof raw.id === 'string' && uuid.test(raw.id) && Number.isFinite(raw.expiresAt)
      && raw.expiresAt > at && raw.expiresAt <= at + DAY + 60000) id = raw.id
  } catch { /* The signed server cookie remains the primary identity after the first click. */ }
  if (!id) id = sessionId || randomId()
  if (!uuid.test(id)) throw new Error('PARTNER_BROWSER_ID_INVALID')
  sessionId = id
  try { storage?.setItem(KEY, JSON.stringify({ id, expiresAt: at + DAY })) } catch { /* An in-memory ID still deduplicates concurrent first clicks. */ }
  return id
}
