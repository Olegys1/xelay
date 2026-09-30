import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { CalendarCheck, Check, Loader2, Smile, Sparkles, X } from 'lucide-react'
import { useBilling } from '../context/BillingContext'
import { useAuth } from '../context/AuthContext'
import { isMissingDatabaseFunction } from '../lib/databaseCompatibility'
import { supabase } from '../lib/supabase'

const STATUSES = ['🎓', '📚', '💻', '☕', '✨', '🚀', '🧠', '🎨', '🌿', '💼', '😴', '🔥']

export function ParticipantProfileCard() {
  const navigate = useNavigate()
  const { authUser } = useAuth()
  const { isPremium, expiresAt, emojiStatus, isLoading, error: billingError, refreshBilling } = useBilling()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const ownerRef = useRef(authUser?.id)
  ownerRef.current = authUser?.id
  const requestSequence = useRef(0)
  const savingRef = useRef(false)

  useEffect(() => {
    ++requestSequence.current
    savingRef.current = false
    setSaving(false)
    setPickerOpen(false)
    setError('')
    setSaved(false)
    return () => { ++requestSequence.current }
  }, [authUser?.id])

  useEffect(() => {
    if (!isPremium) { setPickerOpen(false); setSaved(false) }
  }, [isPremium])

  const setStatus = async (emoji: string | null) => {
    if (savingRef.current || !authUser || !isPremium || isLoading) return
    const ownerId = authUser.id
    const sequence = ++requestSequence.current
    const isCurrent = () => ownerRef.current === ownerId && sequence === requestSequence.current
    savingRef.current = true
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const { error: updateError } = await supabase.rpc('xelay_set_emoji_status', { p_emoji: emoji })
      if (!isCurrent()) return
      if (updateError) throw updateError
      const refreshed = await refreshBilling()
      if (!isCurrent()) return
      setPickerOpen(false)
      if (refreshed) setSaved(true)
      else setError('Статус збережено, але профіль не вдалося оновити. Оновіть сторінку.')
    } catch (updateError) {
      if (!isCurrent()) return
      setError(isMissingDatabaseFunction(updateError as { code?: string })
        ? 'Емодзі-статус ще готується до запуску. Спробуйте пізніше.'
        : 'Не вдалося зберегти статус. Перевірте підписку та спробуйте ще раз.')
    } finally {
      if (isCurrent()) { savingRef.current = false; setSaving(false) }
    }
  }

  return <section className="xelay-card mb-6 overflow-hidden border-primary/15 p-4 sm:p-5" aria-label="Підписка Учасник">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Sparkles size={21} /></span>
        <div>
          <h2 className="font-semibold">{isPremium ? 'Ви — Учасник' : 'Більше можливостей із підпискою'}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{isLoading ? 'Перевіряємо підписку…' : isPremium && expiresAt ? `Доступ до ${new Date(expiresAt).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })}` : 'Бейдж, емодзі-статус, органайзер і преміум-директ'}</p>
        </div>
      </div>
      <button onClick={() => navigate({ to: '/subscription' })} className="rounded-full bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground">{isPremium ? 'Моя підписка' : '100 грн/місяць'}</button>
    </div>
    {isPremium && <div className="mt-4 flex flex-wrap gap-2 border-t border-primary/10 pt-4">
      <button onClick={() => { setPickerOpen((open) => !open); setSaved(false) }} disabled={saving} aria-expanded={pickerOpen} className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-primary"><Smile size={16} />{emojiStatus ? `${emojiStatus} Змінити статус` : 'Емодзі-статус'}</button>
      <button onClick={() => navigate({ to: '/organizer' })} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2.5 text-sm"><CalendarCheck size={16} className="text-primary" /> Органайзер</button>
    </div>}
    {pickerOpen && isPremium && <div className="mt-4 animate-fade-in rounded-2xl border border-border bg-background p-3">
      <p className="mb-3 text-xs text-muted-foreground">Статус відображається біля імені у профілі та директі.</p>
      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
        {STATUSES.map((emoji) => <button key={emoji} onClick={() => void setStatus(emoji)} disabled={saving} aria-label={`Обрати статус ${emoji}`} aria-pressed={emojiStatus === emoji} className={`flex h-10 items-center justify-center rounded-xl text-xl ${emojiStatus === emoji ? 'bg-primary/10 ring-1 ring-primary' : 'hover:bg-accent'}`}>{emoji}</button>)}
      </div>
      {emojiStatus && <button onClick={() => void setStatus(null)} disabled={saving} className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><X size={14} /> Прибрати статус</button>}
    </div>}
    {saving && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" /> Зберігаємо…</p>}
    {saved && <p role="status" className="mt-3 flex items-center gap-1.5 text-xs text-primary"><Check size={14} /> Статус збережено</p>}
    {(error || billingError) && <p role="alert" className="mt-3 text-xs text-destructive">{error || billingError}</p>}
  </section>
}
