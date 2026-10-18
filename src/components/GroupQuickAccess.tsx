import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarDays, Check, ChevronRight, Loader2, MessageCircle, Pencil, Search, X } from 'lucide-react'
import {
  GROUP_QUICK_ACCESS_TIMEOUT_MS, groupQuickAccessPath, loadChatQuickAccess, loadScheduleQuickAccess,
  readGroupQuickAccess, saveGroupQuickAccess, type GroupQuickAccessKind, type GroupQuickAccessOption,
} from '../lib/groupQuickAccess'

type Props = { userId: string; isTeacher?: boolean; onNavigate: (path: string) => void }
const action = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'

export function GroupQuickAccess(props: Props) {
  return <section aria-label="Швидкий доступ до групи" className="border-b border-border px-6 py-4">
    <h2 className="mb-2 px-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Швидкий доступ</h2>
    <Shortcut key={`${props.userId}:schedule`} {...props} kind="schedule" />
    <Shortcut key={`${props.userId}:chat`} {...props} kind="chat" />
  </section>
}

function Shortcut({ userId, isTeacher, onNavigate, kind }: Props & { kind: GroupQuickAccessKind }) {
  const [savedId, setSavedId] = useState(() => readGroupQuickAccess(userId, kind))
  const [options, setOptions] = useState<GroupQuickAccessOption[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [storageWarning, setStorageWarning] = useState(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const request = useRef<AbortController | null>(null)
  const busy = useRef(false)
  const picker = useRef<HTMLDivElement>(null)
  const mainButton = useRef<HTMLButtonElement>(null)
  const listId = `group-quick-access-${kind}`
  const label = kind === 'schedule' ? 'Розклад і ДЗ' : 'Чат групи'
  const Icon = kind === 'schedule' ? CalendarDays : MessageCircle
  const selected = options.find(option => option.id === savedId)
  const filtered = options.filter(option => `${option.name} ${option.detail}`.toLocaleLowerCase('uk').includes(query.trim().toLocaleLowerCase('uk')))

  const load = useCallback(async (): Promise<GroupQuickAccessOption[] | null> => {
    const current = ++generation.current
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setPhase('loading')
    setOptions([])
    const timer = setTimeout(() => controller.abort(), GROUP_QUICK_ACCESS_TIMEOUT_MS)
    try {
      const result = await (kind === 'schedule' ? loadScheduleQuickAccess(userId, controller.signal) : loadChatQuickAccess(userId, controller.signal))
      if (!mounted.current || current !== generation.current) return null
      setOptions(result); setPhase('ready')
      return result
    } catch {
      if (mounted.current && current === generation.current) setPhase('error')
      return null
    } finally {
      clearTimeout(timer)
      if (request.current === controller) request.current = null
    }
  }, [userId, kind])

  useEffect(() => {
    mounted.current = true
    void load()
    const resume = () => { if (document.visibilityState === 'visible' && !busy.current) void load() }
    window.addEventListener('focus', resume)
    window.addEventListener('online', resume)
    return () => {
      mounted.current = false; generation.current++; request.current?.abort()
      window.removeEventListener('focus', resume)
      window.removeEventListener('online', resume)
    }
  }, [load])

  useEffect(() => {
    if (!expanded) return
    picker.current?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true })
  }, [expanded])

  const close = () => { setExpanded(false); setQuery(''); mainButton.current?.focus({ preventScroll: true }) }
  const choose = async (id: string, save: boolean) => {
    if (busy.current) return
    busy.current = true
    const available = await load()
    busy.current = false
    if (!mounted.current || !available) { if (mounted.current) setExpanded(true); return }
    if (!available.some(option => option.id === id)) { setExpanded(true); return }
    if (save) {
      setSavedId(id)
      setStorageWarning(!saveGroupQuickAccess(userId, kind, id))
    }
    onNavigate(groupQuickAccessPath(kind, id))
  }

  return <div className="mt-1">
    <div className="flex items-center gap-1">
      <button ref={mainButton} type="button" disabled={phase === 'loading'} aria-controls={listId}
        aria-expanded={expanded} onClick={() => { if (selected) void choose(selected.id, false); else { setExpanded(value => !value); setQuery('') } }}
        className={`${action} min-w-0 flex-1 justify-start gap-3 px-4 text-left disabled:opacity-60`}>
        {phase === 'loading' ? <Loader2 size={19} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Icon size={19} className="shrink-0 text-primary" aria-hidden="true" />}
        <span className="min-w-0 flex-1"><span className="block">{label}</span><span className="block truncate text-xs font-normal text-muted-foreground">{phase === 'loading' ? 'Перевіряємо доступ…' : phase === 'error' ? 'Не вдалося перевірити доступ' : selected?.name || 'Оберіть свою групу'}</span></span>
        <ChevronRight size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      <button type="button" aria-label={`Змінити ${kind === 'schedule' ? 'групу для розкладу' : 'груповий чат'}`} aria-controls={listId}
        aria-expanded={expanded} className={`${action} shrink-0 !px-3`} onClick={() => { setExpanded(value => !value); setQuery('') }}>
        <Pencil size={15} aria-hidden="true" />
      </button>
    </div>
    {expanded && <div ref={picker} id={listId} className="mt-2 rounded-xl border border-border bg-background p-3"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
      <div className="mb-2 flex items-center gap-2"><h3 className="min-w-0 flex-1 text-sm font-semibold">{kind === 'schedule' ? 'Оберіть навчальну групу' : 'Оберіть груповий чат'}</h3><button type="button" className={`${action} shrink-0 !px-3`} aria-label="Закрити вибір групи" onClick={close}><X size={16} /></button></div>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">Цей вибір діятиме лише для вас у цьому браузері. Його можна змінити будь-коли.</p>
      {storageWarning && <p role="status" className="mb-3 text-xs text-muted-foreground">Браузер не дозволив зберегти вибір. Ви зможете обрати групу знову.</p>}
      {phase === 'loading' ? <p role="status" className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" />Завантажуємо групи…</p>
        : phase === 'error' ? <div><p role="alert" className="text-sm text-destructive">Не вдалося завантажити {kind === 'schedule' ? 'навчальні групи' : 'групові чати'}. Спробуйте ще раз.</p><button type="button" className={`${action} mt-2 text-primary`} onClick={() => void load()}>Повторити</button></div>
        : <>
          {savedId && !selected && <p className="mb-3 text-xs text-muted-foreground">Попередня група більше не доступна. Оберіть іншу.</p>}
          {options.length > 5 && <label className="relative mb-2 block"><Search size={15} className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground" /><span className="sr-only">Знайти групу</span><input value={query} onChange={event => setQuery(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-base" placeholder="Знайти групу" /></label>}
          {options.length ? <div className="max-h-64 overflow-y-auto">{filtered.length ? filtered.map(option => <button key={option.id} type="button" onClick={() => void choose(option.id, true)}
            className={`${action} w-full justify-start gap-2 text-left`}><span className="min-w-0 flex-1"><span className="block break-words">{option.name}</span><span className="mt-0.5 block break-words text-xs font-normal text-muted-foreground">{option.detail}</span></span>{option.id === savedId && <Check size={16} className="shrink-0 text-primary" aria-label="Обрана група" />}</button>) : <p className="py-3 text-sm text-muted-foreground">Групу не знайдено. Спробуйте іншу назву.</p>}</div>
            : <p className="py-2 text-sm leading-relaxed text-muted-foreground">{kind === 'chat' ? 'Ви ще не берете участі у групових чатах. Приєднайтеся до чату в розділі «Чати», а потім оберіть його тут.' : isTeacher ? 'Тут з’являться навчальні групи, до яких ви приєдналися як учасник. Підключені групи викладача доступні в розділі «Викладання».' : 'Поки немає навчальних груп із підтвердженим доступом. Перевірте запрошення в розділі «Мої групи».'}</p>}
        </>}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-1 border-t border-border pt-2"><button type="button" className={`${action} text-primary`} onClick={() => onNavigate(kind === 'chat' ? '/messages?kind=groups' : isTeacher && !options.length ? '/teaching' : '/groups')}>{kind === 'chat' ? 'Усі групові чати' : isTeacher && !options.length ? 'До викладання' : 'Мої групи'}</button>
        {savedId && <button type="button" className={`${action} text-muted-foreground`} onClick={() => { setSavedId(null); setStorageWarning(!saveGroupQuickAccess(userId, kind, null)) }}>Прибрати вибір</button>}</div>
    </div>}
  </div>
}
