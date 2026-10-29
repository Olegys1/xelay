import { FormEvent, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { BadgeCheck, Loader2, ShieldQuestion } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { academicStatusLabel } from '../lib/academicStatus'
import { isActiveStudentStatus } from '../lib/studyYearProgression'
import { normalizeTelegramUsername } from '../lib/telegram'

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
  const statusSource = xelayUser?.studyGroupRepresentativeStatusSource
  const status = xelayUser?.studyGroupRepresentativeStatus
  const currentOwner = statusSource === 'current' && Boolean(status?.ownedGroupIds.length)
  const statusUnavailable = statusSource === 'unavailable'
  const historicalApproval = request?.status === 'approved' && statusSource === 'current'
    && !status?.availableRequestIds.includes(request.id)
  const availableApproval = request?.status === 'approved' && !historicalApproval && !statusUnavailable

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

  const profileHasIdentity = Boolean(
    xelayUser?.name?.trim() && xelayUser.universityId && xelayUser.academicUnitId && xelayUser.specialty?.trim(),
  )
  const profileHasCourse = typeof xelayUser?.studyYear === 'number'
    && Number.isInteger(xelayUser.studyYear) && xelayUser.studyYear >= 1 && xelayUser.studyYear <= 6
  const profileHasStudyStatus = isActiveStudentStatus(xelayUser?.experience || '')
  const profileIsReady = profileHasIdentity && profileHasCourse && profileHasStudyStatus
  const profileRequirements = [
    ...(!profileHasIdentity ? ['Заповніть у профілі ім’я, університет, факультет і спеціальність.'] : []),
    ...(!profileHasCourse ? ['Вкажіть поточний курс — ціле число від 1 до 6.'] : []),
    ...(!profileHasStudyStatus ? ['Оберіть навчальний статус: студент бакалаврату, студент магістратури або аспірант / аспірантка.'] : []),
  ]

  const submitRequest = async (event: FormEvent) => {
    event.preventDefault()
    if (!authUser?.id || saving) return
    setError('')
    if (!profileIsReady) {
      setError(`${profileRequirements.join(' ')} Збережіть зміни в налаштуваннях профілю й повторіть подання заявки.`)
      return
    }
    const telegramUsername = contactType === 'telegram' ? normalizeTelegramUsername(contact) : null
    if (contactType === 'telegram' && !telegramUsername) {
      setError('Вкажіть нік у Telegram, наприклад @username, або посилання https://t.me/username. Ім’я профілю чи запрошення до групи не підходять.')
      return
    }
    setSaving(true)
    const { error: submitError } = await supabase.rpc('xelay_submit_class_representative_request', {
      p_group_name: groupName.trim(),
      p_telegram_username: telegramUsername,
      p_phone: contactType === 'phone' ? contact.trim() : null,
    })
    if (submitError) {
      console.error('Could not submit class representative request:', submitError)
      setError(submitError.message.includes('GROUP_COHORT_REQUIRED')
        ? 'Щоб визначити курс вашої групи, вкажіть у профілі поточний курс від 1 до 6 і навчальний статус: бакалаврат, магістратура або аспірантура. Збережіть налаштування й повторіть спробу.'
        : submitError.message.includes('duplicate')
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
          {currentOwner || availableApproval ? <BadgeCheck size={20} /> : <ShieldQuestion size={20} />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-foreground">{currentOwner ? 'Ви староста групи' : historicalApproval ? 'Історія заявки старости' : 'Ви староста?'}</h2>
          {loading ? (
            <p className="mt-1 text-sm text-muted-foreground">Перевіряємо статус заявки…</p>
          ) : statusUnavailable ? (
            <><p className="mt-1 text-sm text-muted-foreground">Не вдалося перевірити поточні повноваження старости. Історія заявки не замінює цю перевірку.</p>
              {request?.status === 'pending' && <p className="mt-2 text-xs text-muted-foreground">Заявка для групи «{request.group_name}» очікує перевірки адміністратора.</p>}
              {request?.status === 'approved' && <p className="mt-2 text-xs text-muted-foreground">Раніше заявку для групи «{request.group_name}» було схвалено. Це запис історії, а не підтвердження поточних повноважень.</p>}
              <button type="button" onClick={() => { void refreshUser() }} className="mt-3 inline-flex min-h-10 items-center justify-center rounded-full border border-border px-4 py-2 text-sm font-medium text-primary hover:bg-accent">Перевірити статус ще раз</button></>
          ) : currentOwner ? (
            <><p className="mt-1 text-sm text-muted-foreground">Ви зараз керуєте навчальною групою. Поточні повноваження підтверджено за групою.</p>
              {request?.status === 'pending' && <p className="mt-2 text-xs text-muted-foreground">Окрема заявка для групи «{request.group_name}» ще очікує перевірки адміністратора.</p>}
              {historicalApproval && <p className="mt-2 text-xs text-muted-foreground">Раніше схвалена заявка для групи «{request.group_name}» залишається в історії та не визначає ваші поточні повноваження.</p>}
              <button type="button" onClick={() => navigate({ to: '/groups' })} className="mt-3 inline-flex min-h-10 items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">До моїх груп</button></>
          ) : historicalApproval ? (
            <><p className="mt-1 text-sm text-muted-foreground">Вашу заявку для групи «{request.group_name}» раніше було схвалено. Це запис історії, який зараз не надає вам повноважень старости цієї групи.</p>
              <button type="button" onClick={() => navigate({ to: '/groups' })} className="mt-3 inline-flex min-h-10 items-center justify-center rounded-full border border-border px-4 py-2 text-sm font-medium text-primary hover:bg-accent">До моїх груп</button></>
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
          {!loading && !currentOwner && !historicalApproval && !statusUnavailable && !profileIsReady && <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm">
            <p className="font-medium text-foreground">{request?.status === 'approved' ? 'Уточніть дані профілю для створення групи' : 'Для заявки старости потрібні дані профілю'}</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-muted-foreground">{profileRequirements.map((requirement) => <li key={requirement}>{requirement}</li>)}</ul>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Курс і навчальний статус потрібні, щоб не переплутати однойменні групи різних років набору.</p>
            <button type="button" onClick={onEditProfile} className="mt-2 inline-flex min-h-10 items-center justify-center rounded-full border border-primary/20 px-3 py-2 text-sm font-medium text-primary hover:bg-accent">Відкрити налаштування профілю</button>
          </div>}
          {formOpen && !currentOwner && !statusUnavailable && (!request || request.status === 'rejected') && (
            <form onSubmit={(event) => void submitRequest(event)} className="mt-4 space-y-4">
              {profileIsReady && (
                <div className="rounded-xl bg-muted/60 p-3 text-sm">
                  <p className="font-medium text-foreground">Дані з профілю</p>
                  <p className="mt-1 break-words text-muted-foreground">
                    {xelayUser?.name} · {xelayUser?.specialty} · група факультету
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {xelayUser?.faculty || 'Факультет не вказаний'} · університет підтягнуто з профілю
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{xelayUser?.studyYear} курс · {academicStatusLabel(xelayUser?.experience || '')}</p>
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
                  {contactType === 'telegram' ? 'Нік або посилання на Telegram' : 'Номер телефону'}
                  <input
                    type={contactType === 'phone' ? 'tel' : 'text'}
                    value={contact}
                    onChange={(event) => setContact(event.target.value)}
                    required
                    minLength={contactType === 'phone' ? 7 : 3}
                    maxLength={contactType === 'phone' ? 24 : 128}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={contactType === 'telegram' ? '@username або https://t.me/username' : '+380…'}
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
      <div className="mt-5 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">Заступники старости</h3>
        <p className="mt-1 text-sm text-muted-foreground">Староста самостійно призначає заступників із учасників навчальної групи та може будь-коли змінювати їхні права. Свій статус і дозволені дії можна переглянути в групі.</p>
        <button type="button" onClick={() => navigate({ to: '/groups' })} className="mt-3 inline-flex min-h-10 items-center justify-center rounded-full border border-border px-4 py-2 text-sm font-medium text-primary hover:bg-accent">До моїх груп</button>
      </div>
    </section>
  )
}
