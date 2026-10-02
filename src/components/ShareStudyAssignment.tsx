import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, Megaphone, MessageCircle, RefreshCw, Search, Send, Share2, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { ChatDialog, chatButton, chatInput, chatPrimary } from './CommunityChatPrimitives'
import {
  loadStudyShareTargets, sendStudyAssignment, studyAssignmentSharingError, studyAssignmentUrl,
  type StudyAssignmentShare, type StudyShareTarget, type StudyShareTargetKind,
} from '../lib/studyAssignmentSharing'

const kinds = [
  { id: 'personal', label: 'Особисті', Icon: MessageCircle },
  { id: 'group', label: 'Групи', Icon: Users },
  { id: 'channel', label: 'Канали', Icon: Megaphone },
] as const

export function ShareStudyAssignment({ assignment, currentUserId }: { assignment: StudyAssignmentShare; currentUserId: string }) {
  const { authUser } = useAuth()
  const [open, setOpen] = useState(false)
  useEffect(() => { setOpen(false) }, [assignment.id, assignment.kind, currentUserId, authUser?.id])
  if (!authUser || authUser.id !== currentUserId) return null
  return <>
    <button type="button" className={`${chatButton} min-h-9 px-3 py-1.5 text-xs`} onClick={() => setOpen(true)} aria-label={`Переслати завдання: ${assignment.title}`}><Share2 size={15} />Переслати в чат</button>
    {open && <ShareAssignmentDialog key={`${currentUserId}:${assignment.kind}:${assignment.id}`} assignment={assignment} userId={currentUserId} onClose={() => setOpen(false)} />}
  </>
}

function ShareAssignmentDialog({ assignment, userId, onClose }: { assignment: StudyAssignmentShare; userId: string; onClose: () => void }) {
  const [targets, setTargets] = useState<StudyShareTarget[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [kind, setKind] = useState<StudyShareTargetKind>('personal')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [copying, setCopying] = useState(false)
  const [error, setError] = useState('')
  const [sentTo, setSentTo] = useState<StudyShareTarget | null>(null)
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)
  const sequence = useRef(0)
  const sendingLock = useRef(false)
  const copyLock = useRef(false)
  const title = assignment.title || (assignment.kind === 'seminar' ? 'Завдання семінару' : 'Домашнє завдання')
  const load = useCallback(async () => {
    const token = ++sequence.current
    setLoading(true); setError(''); setWarnings([]); setTargets([]); setSelected('')
    try {
      const result = await loadStudyShareTargets(userId)
      if (!alive.current || token !== sequence.current) return
      setTargets(result.targets); setWarnings(result.warnings)
    } catch (failure) { if (alive.current && token === sequence.current) setError(studyAssignmentSharingError(failure)) }
    finally { if (alive.current && token === sequence.current) setLoading(false) }
  }, [userId])
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; sequence.current += 1 } }, [load])
  const term = query.trim().replace(/^@/, '').toLocaleLowerCase('uk-UA')
  const visible = targets.filter((target) => target.kind === kind && (!term || `${target.name} ${target.username || ''}`.toLocaleLowerCase('uk-UA').includes(term)))
  const choice = targets.find((target) => `${target.kind}:${target.id}` === selected)

  const send = async () => {
    if (!choice || sendingLock.current || sentTo) return
    sendingLock.current = true; setSending(true); setError('')
    try {
      await sendStudyAssignment(assignment, choice, userId)
      if (alive.current) setSentTo(choice)
    } catch (failure) { if (alive.current) setError(studyAssignmentSharingError(failure)) }
    finally { sendingLock.current = false; if (alive.current) setSending(false) }
  }
  const copy = async () => {
    if (copyLock.current) return
    copyLock.current = true; setCopying(true); setError('')
    try { await navigator.clipboard.writeText(studyAssignmentUrl(assignment)); if (alive.current) setCopied(true) }
    catch { if (alive.current) setError('Не вдалося скопіювати посилання. Дозвольте доступ до буфера обміну й спробуйте ще раз.') }
    finally { copyLock.current = false; if (alive.current) setCopying(false) }
  }

  return <ChatDialog title="Переслати завдання" busy={sending || copying} onClose={onClose}>
    {sentTo ? <div className="space-y-4 text-center" role="status">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary"><Check size={25} /></span>
      <p className="font-semibold">Завдання надіслано</p>
      <p className="break-words text-sm text-muted-foreground">У чат «{sentTo.name}».</p>
      <div className="flex flex-wrap justify-center gap-2"><a href={sentTo.kind === 'personal' ? `/messages?kind=personal&conversation=${encodeURIComponent(sentTo.id)}` : `/messages?kind=${sentTo.kind === 'group' ? 'groups' : 'channels'}&space=${encodeURIComponent(sentTo.id)}`} className={chatPrimary}>Відкрити чат</a><button type="button" className={chatButton} onClick={onClose}>Готово</button></div>
    </div> : <div className="space-y-4">
      <div className="rounded-xl border border-border bg-muted/40 p-3"><p className="text-xs font-medium text-primary">{assignment.kind === 'seminar' ? 'Семінар' : 'Домашнє завдання'}</p><p className="mt-1 break-words font-semibold">{title}</p><p className="mt-1 break-words text-xs text-muted-foreground">{[assignment.subject, assignment.groupName, assignment.date].filter(Boolean).join(' · ')}</p></div>
      <p className="text-xs text-muted-foreground">Надсилається посилання на завдання. Його зміст і файли відкриються лише учасникам навчальної групи.</p>
      <div className="flex gap-1 rounded-full bg-muted p-1" role="group" aria-label="Тип чату">{kinds.map(({ id, label, Icon }) => <button type="button" key={id} disabled={sending} aria-pressed={kind === id} onClick={() => { setKind(id); setSelected(''); setError('') }} className={`flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium sm:text-sm ${kind === id ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}><Icon size={15} />{label}</button>)}</div>
      <label className="relative block"><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input className={`${chatInput} pl-10`} type="search" value={query} onChange={(event) => { setQuery(event.target.value); setSelected('') }} disabled={sending} placeholder="Знайти серед ваших чатів" aria-label="Знайти чат" /></label>
      {error && <p className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm" role="alert">{error}</p>}
      {warnings.length > 0 && <div className="space-y-1 rounded-xl bg-muted p-3 text-xs text-muted-foreground" role="status">{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
      {loading ? <div className="flex justify-center p-8" role="status" aria-label="Завантаження чатів"><Loader2 className="animate-spin text-primary" size={23} /></div> : <div className="max-h-[35dvh] overflow-y-auto rounded-xl border border-border" role="group" aria-label="Оберіть чат">
        {visible.length ? visible.map((target) => {
          const key = `${target.kind}:${target.id}`
          const TargetIcon = target.kind === 'personal' ? MessageCircle : target.kind === 'group' ? Users : Megaphone
          return <button key={key} type="button" disabled={sending} aria-pressed={selected === key} onClick={() => { setSelected(key); setError('') }} className={`flex min-h-16 w-full items-center gap-3 border-b border-border px-3 py-3 text-left last:border-b-0 hover:bg-muted ${selected === key ? 'bg-primary/5' : ''}`}>
            {target.avatarUrl ? <img src={target.avatarUrl} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-primary"><TargetIcon size={19} /></span>}
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{target.name}</span>{target.username && <span className="block truncate text-xs text-muted-foreground">@{target.username.replace(/^@/, '')}</span>}</span>
            {selected === key && <Check size={18} className="shrink-0 text-primary" />}
          </button>
        }) : <p className="p-6 text-center text-sm text-muted-foreground">{term ? 'Чатів із такою назвою не знайдено.' : kind === 'personal' ? 'Поки немає прийнятих особистих чатів.' : kind === 'group' ? 'Ви поки не берете участі в групових чатах.' : 'Немає каналів, у яких ви можете публікувати.'}</p>}
      </div>}
      <div className="flex flex-wrap items-center gap-2"><button type="button" className={chatButton} onClick={() => void load()} disabled={loading || sending || copying} aria-label="Оновити список чатів"><RefreshCw size={15} />Оновити</button><button type="button" className={chatButton} onClick={() => void copy()} disabled={sending || copying}>{copying ? <Loader2 size={15} className="animate-spin" /> : copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Скопійовано' : 'Копіювати посилання'}</button><button type="button" className={`${chatPrimary} ml-auto`} onClick={() => void send()} disabled={!choice || loading || sending || copying}>{sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}Надіслати</button></div>
    </div>}
  </ChatDialog>
}
