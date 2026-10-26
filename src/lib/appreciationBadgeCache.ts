import { APPRECIATION_BADGES_CHANGED, loadAppreciationBadge } from './appreciationGifts'

const entries = new Map<string, { expires: number; value: Promise<boolean> }>()
let listening = false

/** Only the public decorative visibility flag is cached; gifts and recipient data are never cached here. */
export function loadCachedAppreciationBadge(userId: string): Promise<boolean> {
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener(APPRECIATION_BADGES_CHANGED, () => entries.clear())
    listening = true
  }
  const now = Date.now(), cached = entries.get(userId)
  if (cached && cached.expires > now) return cached.value
  const value = loadAppreciationBadge(userId)
  const entry = { expires: now + 60_000, value }
  entries.delete(userId); entries.set(userId, entry)
  while (entries.size > 64) entries.delete(entries.keys().next().value!)
  void value.catch(() => { if (entries.get(userId) === entry) entries.delete(userId) })
  return value
}
