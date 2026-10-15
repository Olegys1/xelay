export const ANNOUNCEMENT_SLOT_RELEASED = 'xelay:announcement-slot-released'

let owner: string | null = null

export function acquireAnnouncementSlot(requester: string) {
  if (owner !== null && owner !== requester) return false
  owner = requester
  return true
}

export function releaseAnnouncementSlot(requester: string) {
  if (owner !== requester) return
  owner = null
  window.dispatchEvent(new Event(ANNOUNCEMENT_SLOT_RELEASED))
}
