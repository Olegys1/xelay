import { FormEvent, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { BadgeCheck, Loader2, ShieldQuestion } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

type RepresentativeRequest = {
  id: string
  status: 'pending' | 'approved' | 'rejected'
  group_name: string
  created_at: string
}

export function ClassRepresentativeRequestCard({ onEditProfile }: { onEditProfile: () => void }) {
  const { authUser, xelayUser, refreshUser } = useAuth()
  const navigate = useNavigate()
  const [request, setRequest] = useState<RepresentativeRequest | null>(null)
  const [loading, setLoading] = useState(true)
  const [formOpen, setFormOpen] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [contactType, setContactType] = useState<'telegram' | 'phone'>('telegram')
  const [contact, setContact] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!authUser?.id) return
    let active = true
    const loadRequest = async () => {
      setLoading(true)
      const { data, error: loadError } = await supabase
        .from('class_representative_requests')
        .select('id, status, group_name, created_at')
        .eq('user_id', authUser.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!active) return
      if (loadError) setError('Не вдалося завантажити заявки старости. Перевірте, чи застосована міграція навчальних груп.')
      else setRequest(data as RepresentativeRequest | null)
      setLoading(false)
    }
    void loadRequest()
    return () => { active = false }
  }, [authUser?.id])

  const profileIsReady = Boolean(
    xelayUser?.name && xelayUser.universityId && xelayUser.academicUnitId && xelayUser.specialty?.trim(),
  )

  const submitRequest = async (event: FormEvent) => {
    event.preventDefault()
    if (!authUser?.id) return
    setSaving(true)
    setError('')
    const { error: submitError } = await supabase.rpc('xelay_submit_class_representative_request', {
      p_group_name: groupName.trim(),
      p_telegram_username: contactType === 'telegram' ? contact.trim().replace(/^@/, '') : null,
      p_phone: contactType === 'phone' ? contact.trim() : null,
    })
    if (submitError) {
      console.error('Could not submit class representative request:', submitError)
      setError(submitError.message.includes('duplicate')
        ? 'У вас уже є активна заявка або підтвердження старости.'
        : 'Не вдалося надіслати заявку. Перевірте дані профілю та спробуйте ще раз.')
    } else {
      const { data } = await supabase
        .from('class_representative_requests')
        .select('id, status, group_name, created_at')
        .eq('user_id', authUser.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      setRequest(data as RepresentativeRequest | null)
      setFormOpen(false)
      setGroupName('')
      setContact('')
      await refreshUser()
    }
    setSaving(false)
  }

  return (
    <section className="xelay-card mb-6 min-w-0 p-4 sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-primary">
          {request?.status === 'approved' ? <BadgeCheck size={20} /> : <ShieldQuestion size={20} />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-foreground">Ви староста?</h2>
          {loading ? (
            <p className="mt-1 text-sm text-muted-foreground">Перевіряємо статус заявки…</p>
          ) : request?.status === 'pending' ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Заявка для групи <span className="font-medium text-foreground">{request.group_name}</span> очікує перевірки адміністратора.
            </p>
          ) : request?.status === 'approved' ? (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                Статус підтверджено для групи <span className="font-medium text-foreground">{request.group_name}</span>.
              </p>
              <button
                type="button"
                onClick={() => navigate({ to: '/groups' })}
                className="mt-3 inline-flex items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Перейти до групи
              </button>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                Подайте заявку — після перевірки адміністратора ви зможете створити групу й вести її розклад.
              </p>
              {!formOpen && (
                <button
                  type="button"
                  onClick={() => { setError(''); setFormOpen(true) }}
                  className="mt-3 inline-flex items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {request?.status === 'rejected' ? 'Подати заявку ще раз' : 'Подати заявку'}
                </button>
              )}
            </>
          )}
          {formOpen && (!request || request.status === 'rejected') && (
            <form onSubmit={(event) => void submitRequest(event)} className="mt-4 space-y-4">
              {profileIsReady ? (
                <div className="rounded-xl bg-muted/60 p-3 text-sm">
                  <p className="font-medium text-foreground">Дані з профілю</p>
                  <p className="mt-1 break-words text-muted-foreground">
                    {xelayUser?.name} · {xelayUser?.specialty} · група факультету
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {xelayUser?.faculty || 'Факультет не вказаний'} · університет підтягнуто з профілю
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-border p-3 text-sm text-muted-foreground">
                  Спершу заповніть у профілі ім’я, університет, факультет і спеціальність.
                  <button type="button" onClick={onEditProfile} className="ml-1 font-medium text-primary hover:underline">Відкрити налаштування</button>
                </div>
              )}

              <label className="block text-sm font-medium text-foreground">
                Назва академічної групи
                <input
                  value={groupName}
                  onChange={(event) => setGroupName(event.target.value)}
                  required
                  minLength={1}
                  maxLength={80}
                  placeholder="Наприклад, ЕК-21"
                  className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
                <label className="block text-sm font-medium text-foreground">
                  Контакт
                  <select
                    value={contactType}
                    onChange={(event) => { setContactType(event.target.value as 'telegram' | 'phone'); setContact('') }}
                    className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5"
                  >
                    <option value="telegram">Telegram</option>
                    <option value="phone">Телефон</option>
                  </select>
                </label>
                <label className="block text-sm font-medium text-foreground">
                  {contactType === 'telegram' ? 'Нік у Telegram' : 'Номер телефону'}
                  <input
                    type={contactType === 'phone' ? 'tel' : 'text'}
                    value={contact}
                    onChange={(event) => setContact(event.target.value)}
                    required
                    minLength={contactType === 'phone' ? 7 : 3}
                    maxLength={contactType === 'phone' ? 24 : 40}
                    placeholder={contactType === 'telegram' ? '@username' : '+380…'}
                    className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal"
                  />
                </label>
              </div>

              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={saving || !profileIsReady} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  {saving && <Loader2 size={15} className="animate-spin" />}
                  Надіслати на перевірку
                </button>
                <button type="button" onClick={() => setFormOpen(false)} className="min-h-10 rounded-full border border-border px-4 py-2 text-sm hover:bg-muted">Скасувати</button>
              </div>
            </form>
          )}
          {error && !formOpen && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        </div>
      </div>
    </section>
  )
}
