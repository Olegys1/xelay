import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { CalendarCheck, Check, Loader2, ShieldAlert, Smile, Sparkles, X } from 'lucide-react'
import { useBilling } from '../context/BillingContext'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { PremiumBadge } from './PremiumBadge'
import { PushReminderSettings } from './PushReminderSettings'
import { isMissingDatabaseFunction } from '../lib/databaseCompatibility'
import { PARTICIPANT_STATUS_EMOJI_GROUPS, PARTICIPANT_STATUS_MAX_EMOJIS, PARTICIPANT_STATUS_MAX_LENGTH } from '../lib/participantStatus'
import { supabase } from '../lib/supabase'

export function ParticipantProfileCard() {
  const navigate = useNavigate()
  const { notify } = useToast()
  const { authUser, xelayUser } = useAuth()
  const { isPremium, expiresAt, emojiStatus, textStatus, isLoading, error: billingError, refreshBilling } = useBilling()
  const [editorOpen, setEditorOpen] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [draftEmojis, setDraftEmojis] = useState<string[]>([])
  const [emojiGroup, setEmojiGroup] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const ownerRef = useRef(authUser?.id)
  ownerRef.current = authUser?.id
  const requestSequence = useRef(0)
  const savingRef = useRef(false)
  const deepLinkHandled = useRef(false)
  const sectionRef = useRef<HTMLElement>(null)
  const textRef = useRef<HTMLInputElement>(null)
  const length = Array.from(draftText.trim()).length
  const tooLong = length > PARTICIPANT_STATUS_MAX_LENGTH

  useEffect(() => {
    ++requestSequence.current
    savingRef.current = false
    deepLinkHandled.current = false
    setSaving(false)
    setEditorOpen(false)
    setDraftText('')
    setDraftEmojis([])
    setError('')
    setSaved(false)
    return () => { ++requestSequence.current }
  }, [authUser?.id])

  useEffect(() => {
    if (!isPremium) { setEditorOpen(false); setSaved(false) }
  }, [isPremium])

  useEffect(() => {
    if (!isPremium || isLoading || deepLinkHandled.current || window.location.hash !== '#participant-status') return
    deepLinkHandled.current = true
    setDraftText(textStatus || '')
    setDraftEmojis(emojiStatus?.split(' ').filter(Boolean) || [])
    setEditorOpen(true)
    const frame = window.requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ block: 'start' })
      textRef.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [isPremium, isLoading, textStatus, emojiStatus])

  const openEditor = () => {
    setDraftText(textStatus || '')
    setDraftEmojis(emojiStatus?.split(' ').filter(Boolean) || [])
    setEditorOpen(true)
    setSaved(false)
    setError('')
  }

  const toggleEmoji = (emoji: string) => {
    setDraftEmojis((current) => current.includes(emoji)
      ? current.filter((item) => item !== emoji)
      : current.length < PARTICIPANT_STATUS_MAX_EMOJIS ? [...current, emoji] : current)
    setSaved(false)
  }

  const saveStatus = async (event: FormEvent) => {
    event.preventDefault()
    if (savingRef.current || !authUser || !isPremium || isLoading) return
    if (tooLong) {
      const message = `Скоротіть текст статусу до ${PARTICIPANT_STATUS_MAX_LENGTH} символів.`
      setError(message)
      textRef.current?.focus()
      notify({ id: 'participant-status', tone: 'warning', title: 'Статус задовгий', description: message })
      return
    }
    const ownerId = authUser.id
    const sequence = ++requestSequence.current
    const isCurrent = () => ownerRef.current === ownerId && sequence === requestSequence.current
    savingRef.current = true
    setSaving(true)
    setSaved(false)
    setError('')
    let committed = false
    try {
      const { error: updateError } = await supabase.rpc('xelay_set_participant_status', {
        p_text: draftText.trim() || null,
        p_emoji: draftEmojis.join(' ') || null,
      })
      if (!isCurrent()) return
      if (updateError) throw updateError
      committed = true
      const refreshed = await refreshBilling()
      if (!isCurrent()) return
      setEditorOpen(false)
      if (refreshed) {
        setSaved(true)
        notify({ id: 'participant-status', tone: 'success', title: 'Статус збережено' })
      } else {
        const message = 'Статус збережено, але профіль не вдалося оновити. Оновіть сторінку.'
        setError(message)
        notify({ id: 'participant-status', tone: 'warning', title: 'Статус збережено', description: message })
      }
    } catch (updateError) {
      if (!isCurrent()) return
      const message = committed ? 'Статус збережено, але профіль не вдалося оновити. Оновіть сторінку.' : isMissingDatabaseFunction(updateError as { code?: string })
        ? 'Нові статуси ще не підключені. Потрібно застосувати оновлення бази даних.'
        : 'Не вдалося зберегти статус. Перевірте підписку та спробуйте ще раз.'
      setError(message)
      notify({ id: 'participant-status', tone: committed ? 'warning' : 'error', title: committed ? 'Статус збережено' : 'Статус не збережено', description: message })
    } finally {
      if (isCurrent()) { savingRef.current = false; setSaving(false) }
    }
  }

  return <section ref={sectionRef} id="participant-status" className="xelay-card mb-6 scroll-mt-24 overflow-hidden border-primary/15 p-4 sm:p-5" aria-label="Підписка Учасник">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Sparkles size={21} /></span>
        <div>
          <h2 className="font-semibold">{isPremium ? 'Ви — Учасник' : 'Більше можливостей із підпискою'}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{isLoading ? 'Перевіряємо підписку…' : isPremium && expiresAt ? `Доступ до ${new Date(expiresAt).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })}` : 'Текстові статуси, емодзі, органайзер і зручніший директ'}</p>
        </div>
      </div>
      <button type="button" onClick={() => navigate({ to: '/subscription' })} className="rounded-full bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground">{isPremium ? 'Моя підписка' : '100 грн/місяць'}</button>
    </div>
    {isPremium && <div className="mt-4 flex flex-wrap gap-2 border-t border-primary/10 pt-4">
      <button type="button" onClick={() => editorOpen ? setEditorOpen(false) : openEditor()} disabled={saving || isLoading} aria-expanded={editorOpen} aria-controls="participant-status-editor" className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-primary"><Smile size={16} />{emojiStatus || textStatus ? 'Змінити мій статус' : 'Додати мій статус'}</button>
      <button type="button" onClick={() => navigate({ to: '/organizer' })} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2.5 text-sm"><CalendarCheck size={16} className="text-primary" /> Органайзер</button>
    </div>}
    {editorOpen && isPremium && <form id="participant-status-editor" onSubmit={(event) => void saveStatus(event)} aria-busy={saving} className="xelay-popover mt-4 rounded-2xl border border-border bg-background p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-muted/50 p-3" aria-label="Попередній перегляд статусу">
        <span className="max-w-full truncate text-sm font-semibold">@{xelayUser?.username || 'ваш_нік'}</span>
        <PremiumBadge isPremium textStatus={draftText.trim()} emojiStatus={draftEmojis.join(' ')} />
      </div>
      <label htmlFor="participant-status-text" className="block text-sm font-medium">Короткий текст біля ніку</label>
      <input ref={textRef} id="participant-status-text" value={draftText} disabled={saving} onChange={(event) => { setDraftText(event.target.value); setSaved(false); setError('') }} aria-describedby="participant-status-length participant-status-rules" aria-invalid={tooLong} placeholder="Наприклад, готуюся до сесії 📚" className="mt-2 w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10" />
      <p id="participant-status-length" className={`mt-1.5 text-xs ${tooLong ? 'text-destructive' : 'text-muted-foreground'}`}>{length}/{PARTICIPANT_STATUS_MAX_LENGTH} символів · текст і емодзі можна використовувати окремо</p>
      <div className="mb-3 mt-5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Емодзі <span className="font-normal text-muted-foreground">{draftEmojis.length}/{PARTICIPANT_STATUS_MAX_EMOJIS}</span></p>
        {draftEmojis.length > 0 && <button type="button" disabled={saving} onClick={() => setDraftEmojis([])} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><X size={12} /> Прибрати емодзі</button>}
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Категорії емодзі">
        {PARTICIPANT_STATUS_EMOJI_GROUPS.map((group, index) => <button key={group.name} type="button" disabled={saving} aria-pressed={emojiGroup === index} onClick={() => setEmojiGroup(index)} className={`rounded-full px-3 py-1.5 text-xs font-medium ${emojiGroup === index ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'}`}>{group.name}</button>)}
      </div>
      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-10">
        {PARTICIPANT_STATUS_EMOJI_GROUPS[emojiGroup].emojis.map((emoji) => {
          const selected = draftEmojis.includes(emoji)
          return <button key={emoji} type="button" onClick={() => toggleEmoji(emoji)} disabled={saving || (!selected && draftEmojis.length >= PARTICIPANT_STATUS_MAX_EMOJIS)} aria-label={`${selected ? 'Прибрати' : 'Додати'} емодзі ${emoji}`} aria-pressed={selected} className={`flex h-11 items-center justify-center rounded-xl text-xl transition-colors disabled:opacity-35 ${selected ? 'bg-primary/10 ring-1 ring-primary' : 'hover:bg-accent'}`}>{emoji}</button>
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">До трьох емодзі. Щоб замінити, натисніть обраний ще раз.</p>
      <div id="participant-status-rules" className="mt-4 flex gap-2 rounded-xl border border-primary/15 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground"><ShieldAlert size={16} className="mt-0.5 shrink-0 text-primary" /><p>За непристойні статуси, образи та мову ненависті акаунт буде заблоковано. Дотримуйтеся правил спільноти.</p></div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={saving || isLoading} className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">{saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}{saving ? 'Зберігаємо…' : 'Зберегти статус'}</button>
        <button type="button" disabled={saving} onClick={() => { setEditorOpen(false); setError('') }} className="rounded-full px-3 py-2.5 text-sm text-muted-foreground hover:bg-muted">Скасувати</button>
        {(draftText || draftEmojis.length > 0) && <button type="button" disabled={saving} onClick={() => { setDraftText(''); setDraftEmojis([]) }} className="inline-flex items-center gap-1 rounded-full px-3 py-2.5 text-xs text-muted-foreground hover:bg-muted"><X size={13} /> Очистити статус</button>}
      </div>
    </form>}
    {saved && <p role="status" className="mt-3 flex items-center gap-1.5 text-xs text-primary"><Check size={14} /> Статус збережено</p>}
    {(error || billingError) && <p role="alert" className="mt-3 text-xs text-destructive">{error || billingError}</p>}
    <details className="mt-4 border-t border-primary/10 pt-3"><summary className="min-h-10 cursor-pointer py-2 text-sm font-medium text-primary">Push-нагадування</summary><PushReminderSettings /></details>
  </section>
}
