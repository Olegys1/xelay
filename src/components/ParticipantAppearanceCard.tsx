import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, Loader2, Palette } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useBilling } from '../context/BillingContext'
import { useToast } from '../context/ToastContext'
import { supabase } from '../lib/supabase'
import { announceAppearanceUpdate, CHAT_THEMES, CHAT_WALLPAPERS, PROFILE_COVERS, useParticipantAppearance, type ParticipantAppearance } from '../lib/participantAppearance'
import '../pages/participantAppearance.css'

export function ParticipantAppearanceCard() {
  const { authUser } = useAuth()
  const { isPremium, isLoading: billingLoading } = useBilling()
  const appearance = useParticipantAppearance()
  const [draft, setDraft] = useState<ParticipantAppearance>(appearance)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const { notify } = useToast()
  const owner = useRef(authUser?.id)
  owner.current = authUser?.id
  const lock = useRef(false)
  useEffect(() => { setDraft(appearance) }, [authUser?.id, appearance.profileCover, appearance.chatTheme, appearance.chatWallpaper])
  useEffect(() => { setError(''); setSaving(false); lock.current = false }, [authUser?.id])
  const save = async () => {
    if (!authUser || !isPremium || billingLoading || lock.current) return
    const actor = authUser.id
    lock.current = true; setSaving(true); setError('')
    try {
      const { data: { session }, error: authError } = await supabase.auth.getSession()
      if (authError || session?.user.id !== actor) throw new Error('identity')
      const { error: updateError } = await supabase.rpc('xelay_set_participant_appearance', {
        p_cover: draft.profileCover, p_theme: draft.chatTheme, p_wallpaper: draft.chatWallpaper,
      }).setHeader('Authorization', `Bearer ${session.access_token}`)
      if (owner.current !== actor) return
      if (updateError) throw updateError
      announceAppearanceUpdate()
      notify({ id: 'participant-appearance', tone: 'success', title: 'Оформлення збережено' })
    } catch { if (owner.current === actor) setError('Не вдалося зберегти оформлення. Перевірте підписку та доступність оновлення.') }
    finally { if (owner.current === actor) { setSaving(false); lock.current = false } }
  }
  const choices = (key: keyof ParticipantAppearance, items: readonly { id: string; label: string }[], kind: string) => <div className="flex flex-wrap gap-2">
    {items.map((item) => <button key={item.id} type="button" disabled={!isPremium || saving || billingLoading || appearance.isLoading} aria-pressed={draft[key] === item.id}
      onClick={() => setDraft((old) => ({ ...old, [key]: item.id }))}
      className={`inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 py-2 text-xs disabled:opacity-50 ${draft[key] === item.id ? 'border-primary bg-primary/5 text-primary' : 'border-border hover:bg-muted'}`}>
      <span aria-hidden="true" className={`h-5 w-5 rounded-md xelay-${kind}-${item.id} border border-black/10 ${kind === 'chat-theme' ? 'bg-primary' : 'bg-muted'}`} />{item.label}{draft[key] === item.id && <Check size={12} />}
    </button>)}
  </div>
  return <details className="xelay-card mb-6 p-4 sm:p-5" id="participant-appearance">
    <summary className="flex min-h-10 cursor-pointer items-center gap-2 font-semibold"><Palette size={18} className="text-primary" />Оформлення профілю та чатів</summary>
    {!isPremium ? <p className="mt-3 text-sm text-muted-foreground">Обкладинки, теми й фони доступні з <Link to="/subscription" className="font-medium text-primary underline">підпискою «Учасник»</Link>.</p> : <div className="mt-4 space-y-4">
      <fieldset disabled={saving}><legend className="mb-2 text-sm font-medium">Обкладинка профілю</legend>{choices('profileCover', PROFILE_COVERS, 'cover')}</fieldset>
      <fieldset disabled={saving}><legend className="mb-2 text-sm font-medium">Тема ваших переписок</legend>{choices('chatTheme', CHAT_THEMES, 'chat-theme')}</fieldset>
      <fieldset disabled={saving}><legend className="mb-2 text-sm font-medium">Фон ваших переписок</legend>{choices('chatWallpaper', CHAT_WALLPAPERS, 'chat-wallpaper')}</fieldset>
      <div aria-label="Попередній перегляд" className={`rounded-2xl border border-border p-4 xelay-chat-theme-${draft.chatTheme} xelay-chat-wallpaper-${draft.chatWallpaper}`}><span className="inline-block rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">Ваш настрій у Xelay ✨</span></div>
      <p className="text-xs text-muted-foreground">Обкладинку видно у профілі. Тему й фон чатів бачите тільки ви. Після завершення підписки використовується стандартне оформлення; ваш вибір зберігається.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <button type="button" onClick={() => void save()} disabled={saving || appearance.isLoading || billingLoading} className="inline-flex min-h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">{saving && <Loader2 size={15} className="animate-spin" />}Зберегти оформлення</button>
    </div>}
  </details>
}
