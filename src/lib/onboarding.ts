export const OPEN_PLATFORM_GUIDE = 'xelay:open-platform-guide'
const seenThisSession = new Set<string>()

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
