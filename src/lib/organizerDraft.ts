export interface OrganizerDraft {
  title: string
  notes: string
  subject: string
  dueDate: string
  dueTime: string
  timed: boolean
  reminder: 'none' | 'day' | 'hour' | 'custom'
  reminderCustom: string
}

export const EMPTY_ORGANIZER_DRAFT: OrganizerDraft = {
  title: '', notes: '', subject: '', dueDate: '', dueTime: '18:00', timed: false,
  reminder: 'none', reminderCustom: '',
}
const key = (owner: string) => `xelay.organizer.draft.v1.${owner}`

export function readOrganizerDraft(owner: string): { draft: OrganizerDraft; editingId: string | null; editingVersion: string | null } | null {
  try {
    const raw = sessionStorage.getItem(key(owner))
    if (!raw || raw.length > 24000) return null
    const value = JSON.parse(raw)
    const draft = value.draft
    if (!draft || typeof draft.title !== 'string' || typeof draft.notes !== 'string'
      || typeof draft.subject !== 'string' || typeof draft.dueDate !== 'string'
      || typeof draft.dueTime !== 'string' || typeof draft.timed !== 'boolean'
      || !['none', 'day', 'hour', 'custom'].includes(draft.reminder)
      || typeof draft.reminderCustom !== 'string') return null
    return {
      draft: { title: draft.title.slice(0, 200), notes: draft.notes.slice(0, 10000), subject: draft.subject.slice(0, 120),
        dueDate: draft.dueDate.slice(0, 10), dueTime: draft.dueTime.slice(0, 5), timed: draft.timed,
        reminder: draft.reminder, reminderCustom: draft.reminderCustom.slice(0, 16) },
      editingId: typeof value.editingId === 'string' && /^[0-9a-f-]{36}$/i.test(value.editingId) ? value.editingId : null,
      editingVersion: typeof value.editingVersion === 'string' && Number.isFinite(Date.parse(value.editingVersion))
        ? value.editingVersion : null,
    }
  } catch { return null }
}

export function saveOrganizerDraft(owner: string, draft: OrganizerDraft, editingId: string | null, editingVersion: string | null = null) {
  try {
    if (!draft.title.trim() && !draft.notes.trim() && !draft.subject.trim() && !draft.dueDate) {
      sessionStorage.removeItem(key(owner))
    } else sessionStorage.setItem(key(owner), JSON.stringify({ draft, editingId, editingVersion }))
  } catch { /* Editing still works when session storage is unavailable. */ }
}

export function clearOrganizerDraft(owner: string) {
  try { sessionStorage.removeItem(key(owner)) } catch { /* Browser storage may be unavailable. */ }
}
