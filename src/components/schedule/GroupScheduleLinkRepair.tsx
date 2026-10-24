import { useEffect, useRef, useState } from 'react'
import { Link2, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { LESSON_TYPES } from '../../lib/studyGroupTimetable'
import { ChatDialog, chatButton, chatPrimary } from '../CommunityChatPrimitives'

type RepairPair = { source_id: string; target_id: string; subject: string; lesson_type: string; source_date: string; target_date: string; starts_at: string; ends_at: string }
type RepairPreview = { count: number; signature: string; pairs: RepairPair[]; repaired?: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
const dateLabel = (value: string) => new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', timeZone: 'Europe/Kyiv' }).format(new Date(`${value}T12:00:00Z`))
function checkedResult(value: unknown, applying: boolean): RepairPreview {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (!Number.isInteger(row.count) || Number(row.count) < 0 || Number(row.count) > 100 || typeof row.signature !== 'string' || !/^[0-9a-f]{64}$/.test(row.signature)
    || !Array.isArray(row.pairs) || row.pairs.length !== row.count || applying && (!Number.isInteger(row.repaired) || row.repaired !== row.count)) throw new Error('SCHEDULE_COPY_LINK_REPAIR_RESPONSE_INVALID')
  const pairs = row.pairs.map(value => {
    const pair = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    if (typeof pair.source_id !== 'string' || !uuid.test(pair.source_id) || typeof pair.target_id !== 'string' || !uuid.test(pair.target_id) || pair.source_id === pair.target_id
      || typeof pair.subject !== 'string' || !pair.subject.trim() || pair.subject.length > 120 || typeof pair.lesson_type !== 'string' || !date(pair.source_date) || !date(pair.target_date)
      || typeof pair.starts_at !== 'string' || typeof pair.ends_at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(pair.starts_at) || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(pair.ends_at)) throw new Error('SCHEDULE_COPY_LINK_REPAIR_RESPONSE_INVALID')
    return pair as RepairPair
  })
  if (new Set(pairs.map(pair => pair.target_id)).size !== pairs.length) throw new Error('SCHEDULE_COPY_LINK_REPAIR_RESPONSE_INVALID')
  return { count: Number(row.count), signature: row.signature, pairs, ...(applying ? { repaired: Number(row.repaired) } : {}) }
}
function repairError(failure: unknown) {
  const row = failure && typeof failure === 'object' ? failure as { code?: string; message?: string } : {}
  const message = row.message || ''
  if (message.includes('STUDY_GROUP_PERMISSION_REQUIRED') || message.includes('SEMINAR_REPRESENTATIVE_REQUIRED')) return 'Для цього потрібне право редагувати розклад цієї групи. Попросіть старосту надати його або виконати відновлення.'
  if (message.includes('SCHEDULE_COPY_LINK_REPAIR_ACTOR_CHANGED') || message.includes('AUTH_REQUIRED')) return 'Акаунт змінився або сеанс завершився. Відкрийте групу ще раз і повторіть попередній перегляд.'
  if (message.includes('GROUP_LICENSE_REQUIRED')) return 'Не вдалося підтвердити доступ до групи. Оновіть сторінку та перевірте права.'
  if (message.includes('SCHEDULE_COPY_LINK_REPAIR_CONFLICT') || row.code === '40001') return 'Розклад змінився після попереднього перегляду. Перегляньте пари ще раз перед відновленням.'
  if (message.includes('SCHEDULE_COPY_LINK_REPAIR_TOO_LARGE')) return 'У цій групі забагато відповідників для автоматичного відновлення. Зверніться до підтримки Xelay.'
  if (row.code === 'PGRST202' || row.code === '42883') return 'Відновлення посилань ще підключається. Спробуйте трохи пізніше.'
  if (message.includes('SCHEDULE_COPY_LINK_REPAIR_RESPONSE_INVALID')) return 'Не вдалося перевірити результат сервера. Оновіть перегляд перед наступною дією.'
  if (row.code === '42501') return 'Не вдалося підтвердити право редагувати розклад цієї групи. Оновіть сторінку та перевірте доступ.'
  return 'Не вдалося відновити посилання. Перевірте з’єднання й оновіть попередній перегляд.'
}

/** Uses only the current headman's/deputy's existing schedule permission. */
export function GroupScheduleLinkRepair({ groupId, userId, canEdit, onRepaired }: { groupId: string; userId: string; canEdit: boolean; onRepaired: () => void | Promise<unknown> }) {
  const [expected] = useState({ groupId, userId })
  const [preview, setPreview] = useState<RepairPreview | null>(null)
  const [open, setOpen] = useState(false), [working, setWorking] = useState<'preview' | 'apply' | ''>('')
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const mounted = useRef(false), lock = useRef<symbol | null>(null)
  const context = useRef({ groupId, userId, canEdit }); context.current = { groupId, userId, canEdit }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; lock.current = null } }, [])
  const current = () => mounted.current && context.current.canEdit && context.current.groupId === expected.groupId && context.current.userId === expected.userId
  const close = () => { if (!lock.current) { setOpen(false); setPreview(null); setError('') } }
  async function request(previewOnly: boolean) {
    if (!current() || lock.current || !previewOnly && (!preview || !preview.count)) return
    const token = Symbol('group-schedule-link-repair'), signature = previewOnly ? null : preview!.signature
    lock.current = token; setOpen(true); setWorking(previewOnly ? 'preview' : 'apply'); setError(''); setMessage('')
    if (previewOnly) setPreview(null)
    let committed = false
    try {
      const { data, error: failure } = await supabase.rpc('xelay_repair_my_schedule_copy_links', { p_group_id: expected.groupId, p_preview: previewOnly, p_signature: signature, p_expected_user_id: expected.userId })
      if (!current() || lock.current !== token) return
      if (failure) throw failure
      const result = checkedResult(data, !previewOnly)
      if (previewOnly && result.count) setPreview(result)
      else if (previewOnly) { setOpen(false); setPreview(null); setMessage('У цій групі немає порожніх суботніх копій з однозначним джерелом. Наявні посилання збережені.') }
      else {
        committed = true; setOpen(false); setPreview(null); setMessage(`Посилання підтягнуто для пар: ${result.repaired}. Подальші зміни вихідних посилань оновлюватимуть ці копії автоматично.`)
        const refreshed = await onRepaired()
        if (current() && refreshed === false) setMessage('Посилання підтягнуто. Оновіть розклад, щоб побачити їх.')
      }
    } catch (failure) {
      if (!current() || lock.current !== token) return
      setPreview(null)
      if (committed) setMessage('Посилання підтягнуто. Оновіть розклад, щоб побачити їх.')
      else setError(repairError(failure))
    } finally { if (lock.current === token) { lock.current = null; if (current()) setWorking('') } }
  }
  if (!canEdit) return null
  return <>
    <button type="button" disabled={Boolean(working)} onClick={() => void request(true)} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-primary/25 px-3 py-2 text-xs font-semibold text-primary hover:bg-accent disabled:opacity-50">{working === 'preview' ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}Підтягнути посилання до суботи</button>
    {message && <p role="status" className="basis-full text-left text-xs leading-relaxed text-primary">{message}</p>}
    {open && <ChatDialog title="Підтягнути посилання до суботніх пар" onClose={close} busy={Boolean(working)} wide>
      <div className="space-y-4"><p className="text-sm leading-relaxed text-muted-foreground">Знайдемо порожні скопійовані пари з однозначним джерелом у цій групі. Лекції та семінари перевіряються окремо. Власні суботні посилання залишаться незмінними.</p>
        {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
        {working === 'preview' ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 size={17} className="animate-spin" />Перевіряємо відповідники в розкладі…</p> : preview && <><p className="text-sm font-semibold">Буде оновлено пар: {preview.count}</p><ul className="max-h-72 space-y-2 overflow-auto" aria-label="Пари для відновлення посилань">{preview.pairs.map(pair => <li key={pair.target_id} className="rounded-xl border border-border p-3 text-sm"><p className="font-medium">{pair.subject} · {LESSON_TYPES[pair.lesson_type as keyof typeof LESSON_TYPES] || 'Заняття'}</p><p className="mt-1 text-xs text-muted-foreground">{dateLabel(pair.source_date)} → {dateLabel(pair.target_date)} · {pair.starts_at.slice(0, 5)}–{pair.ends_at.slice(0, 5)}</p></li>)}</ul><p className="text-xs leading-relaxed text-muted-foreground">Перенесемо обидва посилання та їхні назви. Дати, час, предмети й домашні завдання залишаться незмінними.</p></>}
        <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={Boolean(working)} onClick={close} className={chatButton}>Скасувати</button>{preview && <button type="button" disabled={Boolean(working)} onClick={() => void request(false)} className={chatPrimary}>{working === 'apply' && <Loader2 size={15} className="animate-spin" />}Підтягнути посилання · {preview.count}</button>}{error && <button type="button" disabled={Boolean(working)} onClick={() => void request(true)} className={chatButton}>Оновити попередній перегляд</button>}</div>
      </div>
    </ChatDialog>}
  </>
}
