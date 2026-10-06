export const OPEN_PLATFORM_GUIDE = 'xelay:open-platform-guide'
const seenThisSession = new Set<string>()
const progressThisSession = new Map<string, { step: number; paused: boolean } | null>()

export function onboardingProgress(key: string) {
  if (progressThisSession.has(key)) return progressThisSession.get(key) ?? null
  try {
    const value = JSON.parse(window.localStorage.getItem(`${key}:progress`) || 'null')
    return value && Number.isInteger(value.step) && value.step >= 0 && typeof value.paused === 'boolean'
      ? { step: value.step as number, paused: value.paused as boolean } : null
  } catch { return null }
}

export function saveOnboardingProgress(key: string, progress: { step: number; paused: boolean } | null) {
  progressThisSession.set(key, progress)
  try {
    if (progress) window.localStorage.setItem(`${key}:progress`, JSON.stringify(progress))
    else window.localStorage.removeItem(`${key}:progress`)
  } catch { /* Keep progress in memory when browser storage is unavailable. */ }
}

export function guideKey(userId: string, topic: string) {
  return `xelay:guide:v2:${userId}:${topic}`
}

export function hasSeenGuide(key: string) {
  if (seenThisSession.has(key)) return true
  try { return window.localStorage.getItem(key) === 'seen' } catch { return false }
}

export function rememberGuide(key: string) {
  seenThisSession.add(key)
  try { window.localStorage.setItem(key, 'seen') } catch { /* Still dismiss for this session. */ }
}

export function openPlatformGuide() {
  window.dispatchEvent(new Event(OPEN_PLATFORM_GUIDE))
}
