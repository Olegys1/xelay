export type DeskTask = { id: string; title: string; subject: string; due: string; done: boolean }
export type DeskSaved = { id: string; kind: 'link' | 'snippet'; title: string; subject: string; content: string; pinned: boolean }
export type DeskTimer = { mode: 'focus' | 'break'; status: 'idle' | 'running' | 'paused' | 'finished'; durationSec: number; remainingSec: number; deadline: number | null; startedAt: number | null; runId: string | null; subject: string }
export type DeskSession = { id: string; day: string; minutes: number; subject: string }
export type DeskState = { version: 1; tasks: DeskTask[]; saved: DeskSaved[]; timer: DeskTimer; sessions: DeskSession[] }
export const DESK_STORAGE_KEY = 'xelay:local-student-desk:synthetic:v1'
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const validId = (value: unknown): value is string => typeof value === 'string' && ID.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
export function deskDay(date = new Date()): string {
  if (!Number.isFinite(date.getTime())) throw new Error('Некоректний час.')
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}
export function validDeskDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
}
export function shiftDeskDay(day: string, offset: number): string {
  if (!validDeskDay(day) || !Number.isSafeInteger(offset)) throw new Error('Некоректна дата.')
  return new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
}
export function safeDeskUrl(value: string): string | null {
  if (!string(value, 2000) || /[\u0000-\u0020\u007f]/.test(value.trim())) return null
  try { const url = new URL(value.trim()); return ['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null } catch { return null }
}
export const DESK_TEMPLATES = Object.freeze([
  { id: 'three-thoughts', title: 'Конспект у трьох думках', content: 'Що це означає?\n\nЯк це працює?\n\nДе я можу це застосувати?\n\nЩо ще хочу з’ясувати?' },
  { id: 'seminar', title: 'Підготовка до семінару', content: 'Тема та головне запитання\n\nМоя теза\n\nДва аргументи або приклади\n\nЗапитання для обговорення\n\nДжерела' },
  { id: 'problem', title: 'Розбір задачі', content: 'Що відомо?\n\nЩо потрібно знайти?\n\nМетод або формула\n\nКроки розв’язання\n\nПеревірка відповіді' },
] as const)
export function initialDeskTimer(mode: DeskTimer['mode'] = 'focus', durationSec = mode === 'focus' ? 1500 : 300): DeskTimer {
  if (!Number.isInteger(durationSec) || durationSec < 60 || durationSec > 5400) throw new Error('Оберіть тривалість від 1 до 90 хвилин.')
  return { mode, status: 'idle', durationSec, remainingSec: durationSec, deadline: null, startedAt: null, runId: null, subject: 'Моя підготовка' }
}
export function initialDeskState(today = deskDay(), empty = false): DeskState {
  if (!validDeskDay(today)) throw new Error('Некоректна дата.')
  if(empty)return {version:1,tasks:[],saved:[],timer:initialDeskTimer(),sessions:[]}
  return { version: 1, tasks: [
    { id: 'demo-task-1', title: 'Повторити попит і пропозицію', subject: 'Мікроекономіка', due: today, done: false },
    { id: 'demo-task-2', title: 'Підготувати два аргументи до семінару', subject: 'Менеджмент', due: today, done: false },
    { id: 'demo-task-3', title: 'Завершити розбір задачі', subject: 'Статистика', due: shiftDeskDay(today, 1), done: false },
  ], saved: [
    { id: 'demo-note-1', kind: 'snippet', title: 'Як не плутати зміни попиту', subject: 'Мікроекономіка', content: 'Зміна ціни товару — рух уздовж кривої. Інші чинники можуть змінити саму криву.', pinned: true },
    { id: 'demo-note-2', kind: 'snippet', title: 'Мій план відповіді на семінарі', subject: 'Менеджмент', content: 'Теза → пояснення → приклад → короткий висновок.', pinned: false },
  ], timer: initialDeskTimer(), sessions: [] }
}
export function deskRemaining(timer: DeskTimer, now: number): number {
  if (!Number.isFinite(now)) throw new Error('Некоректний час.')
  return timer.status === 'running' && timer.deadline !== null ? Math.max(0, Math.min(timer.durationSec, Math.ceil((timer.deadline - now) / 1000))) : timer.remainingSec
}
export function startDeskTimer(timer: DeskTimer, now: number, runId: string): DeskTimer {
  if (!Number.isFinite(now) || !validId(runId)) throw new Error('Некоректна сесія фокусу.')
  if (timer.status === 'running') return timer
  const remainingSec = timer.status === 'paused' && timer.remainingSec > 0 ? timer.remainingSec : timer.durationSec
  return { ...timer, status: 'running', remainingSec, startedAt: now, deadline: now + remainingSec * 1000, runId: timer.status === 'paused' && timer.runId ? timer.runId : runId }
}
export function pauseDeskTimer(timer: DeskTimer, now: number): DeskTimer {
  if (timer.status !== 'running') return timer
  const remainingSec = deskRemaining(timer, now)
  // Keep an expired run available for state reconciliation; pausing at zero must
  // never turn it into an unrecorded restart with a new identity.
  if (remainingSec === 0) return timer
  return { ...timer, status: 'paused', remainingSec, deadline: null, startedAt: null }
}
export function resetDeskFocus(state: DeskState, now: number): DeskState {
  const reconciled = reconcileDeskTimer(state, now)
  return { ...reconciled, timer: { ...initialDeskTimer(reconciled.timer.mode, reconciled.timer.durationSec), subject: reconciled.timer.subject } }
}
/** Completion is idempotent across timer ticks, refreshes and repeated React effects. */
export function reconcileDeskTimer(state: DeskState, now: number): DeskState {
  if (!Number.isFinite(now)) throw new Error('Некоректний час.')
  const timer = state.timer
  if (timer.status !== 'running' || timer.deadline === null || timer.deadline > now) return state
  let sessions = state.sessions
  if (timer.mode === 'focus' && timer.runId && !sessions.some(session => session.id === timer.runId)) {
    sessions = [...sessions, { id: timer.runId, day: deskDay(new Date(timer.deadline)), minutes: timer.durationSec / 60, subject: timer.subject }].slice(-1000)
  }
  return { ...state, timer: { ...timer, status: 'finished', remainingSec: 0, deadline: null, startedAt: null }, sessions }
}
export function filterDeskTasks(tasks: DeskTask[], filter: 'today' | 'overdue' | 'all' | 'done', today: string, subject = ''): DeskTask[] {
  return tasks.filter(task => (!subject || task.subject === subject) && (filter === 'all' || filter === 'done' ? filter === 'all' || task.done : filter === 'overdue' ? !task.done && task.due < today : task.due === today))
    .sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due) || a.title.localeCompare(b.title, 'uk'))
}
export function filterDeskSaved(saved: DeskSaved[], query: string, kind: 'all' | 'link' | 'snippet' = 'all'): DeskSaved[] {
  const text = query.trim().toLocaleLowerCase('uk-UA')
  return saved.filter(item => (kind === 'all' || item.kind === kind) && `${item.title} ${item.subject} ${item.content}`.toLocaleLowerCase('uk-UA').includes(text))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title, 'uk'))
}
export function weeklyDeskMinutes(sessions: DeskSession[], today = deskDay()) {
  return Array.from({ length: 7 }, (_, index) => { const day = shiftDeskDay(today, index - 6); return { day, minutes: sessions.filter(session => session.day === day).reduce((sum, session) => sum + session.minutes, 0) } })
}
export function parseDeskState(raw: string | null, today = deskDay(), now = Date.now(), empty = false): DeskState {
  const fallback = initialDeskState(today,empty)
  if (!raw || raw.length > 600000) return fallback
  try {
    const value: unknown = JSON.parse(raw)
    if (!object(value) || value.version !== 1 || !Array.isArray(value.tasks) || !Array.isArray(value.saved) || !Array.isArray(value.sessions)) return fallback
    const seen = new Set<string>()
    fallback.tasks = value.tasks.flatMap(item => {
      if (!object(item) || !validId(item.id) || seen.has(item.id) || !string(item.title, 200) || !item.title.trim() || !string(item.subject, 80) || !validDeskDay(item.due) || typeof item.done !== 'boolean') return []
      seen.add(item.id); return [{ id: item.id, title: item.title, subject: item.subject, due: item.due, done: item.done }]
    }).slice(0, 200)
    seen.clear()
    fallback.saved = value.saved.flatMap(item => {
      if (!object(item) || !validId(item.id) || seen.has(item.id) || !['link', 'snippet'].includes(String(item.kind)) || !string(item.title, 200) || !item.title.trim() || !string(item.subject, 80) || !string(item.content, 4000) || typeof item.pinned !== 'boolean') return []
      const content = item.kind === 'link' ? safeDeskUrl(item.content) : item.content
      if (!content) return []
      seen.add(item.id); return [{ id: item.id, kind: item.kind as DeskSaved['kind'], title: item.title, subject: item.subject, content, pinned: item.pinned }]
    }).slice(0, 200)
    seen.clear()
    fallback.sessions = value.sessions.flatMap(item => {
      if (!object(item) || !validId(item.id) || seen.has(item.id) || !validDeskDay(item.day) || !string(item.subject, 80) || typeof item.minutes !== 'number' || !Number.isFinite(item.minutes) || item.minutes < 1 || item.minutes > 90) return []
      seen.add(item.id); return [{ id: item.id, day: item.day, minutes: item.minutes, subject: item.subject }]
    }).slice(-1000)
    const t = value.timer
    if (object(t) && ['focus', 'break'].includes(String(t.mode)) && ['idle', 'running', 'paused', 'finished'].includes(String(t.status)) && Number.isInteger(t.durationSec) && Number(t.durationSec) >= 60 && Number(t.durationSec) <= 5400 && Number.isInteger(t.remainingSec) && Number(t.remainingSec) >= 0 && Number(t.remainingSec) <= Number(t.durationSec) && string(t.subject, 80) && (t.runId === null || validId(t.runId))) {
      const activeValid = t.status !== 'running' || validId(t.runId) && typeof t.deadline === 'number' && Number.isFinite(t.deadline) && typeof t.startedAt === 'number' && Number.isFinite(t.startedAt) && t.deadline >= t.startedAt && t.deadline - t.startedAt <= Number(t.durationSec) * 1000 && t.startedAt <= now
      if (activeValid) fallback.timer = { mode: t.mode as DeskTimer['mode'], status: t.status as DeskTimer['status'], durationSec: Number(t.durationSec), remainingSec: Number(t.remainingSec), subject: t.subject, runId: t.runId as string | null, deadline: t.status === 'running' ? Number(t.deadline) : null, startedAt: t.status === 'running' ? Number(t.startedAt) : null }
    }
    return reconcileDeskTimer(fallback, now)
  } catch { return fallback }
}
