import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, GraduationCap, Mail, Moon, Sun, Users } from 'lucide-react'
import { useTheme } from '../context/ThemeContext'
import type { NotificationPreferences } from '../context/NotificationPreferencesContext'
import { supabase } from '../lib/supabase'
import { createNotificationCenterRepository, notificationCategorySettings } from '../lib/notificationCenter'
import { supabaseTeachingRepository } from '../lib/teaching'
import { createSupabaseTeachingTestRepository } from '../lib/teachingTests'
import { createSupabaseTeachingCourseModuleRepository } from '../lib/teachingCourseModules'
import { NotificationCenterContent } from './NotificationCenterContent'
import { TeachingWorkspace } from './teaching/TeachingWorkspace'
import { GroupTeachingPanel } from './teaching/GroupTeachingPanel'
import { TeachingButton } from './teaching/TeachingUI'
import './teaching/teaching.css'
import './teaching/teaching-workflow.css'

type Role = 'teacher' | 'student' | 'head' | 'other'
type View = 'inbox' | 'workspace' | 'group' | 'mail'
type Configuration = { courseId: string; groupId: string; otherGroupId: string; roles: Record<Role, { userId: string; fullName: string }> }
type PreviewLetter = { id: string; subject: string; html: string; text: string; created_at: string }
const labels: Record<Role, string> = { teacher: 'Викладачка Олена', student: 'Студентка Марія', head: 'Староста Андрій', other: 'Данило · інша група' }
const defaults: NotificationPreferences = { notificationsEnabled: true, emailNotificationsEnabled: true, categorySettings: notificationCategorySettings() }
export function LocalNotificationCenterPreview() {
  const [configuration, setConfiguration] = useState<Configuration | null>(null), [error, setError] = useState('')
  const [role, setRole] = useState<Role>(() => { const value = sessionStorage.getItem('xelay-notification-center-preview-role'); return value && value in labels ? value as Role : 'student' })
  const [view, setView] = useState<View>('inbox'), [preferences, setPreferences] = useState(defaults), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false)
  const [letters, setLetters] = useState<PreviewLetter[]>([]), [mailBusy, setMailBusy] = useState(false), [mailReady, setMailReady] = useState(false), [selectedLetter, setSelectedLetter] = useState('')
  const currentRole = useRef(role); currentRole.current = role
  const { theme, toggleTheme } = useTheme()
  const notifications = useMemo(() => createNotificationCenterRepository(), [])
  const repository = useMemo(() => ({ ...supabaseTeachingRepository, mode: 'local' as const }), [])
  const tests = useMemo(() => createSupabaseTeachingTestRepository(), []), modules = useMemo(() => createSupabaseTeachingCourseModuleRepository(), [])
  useEffect(() => {
    sessionStorage.setItem('xelay-notification-center-preview-role', role)
    let active = true
    void fetch('/__notification-center/config').then(response => response.json()).then(data => { if (active) setConfiguration(data) }).catch(() => { if (active) setError('Не вдалося відкрити локальний приклад.') })
    return () => { active = false }
  }, [])
  async function refreshPreferences() {
    const captured = role
    setLoading(true)
    try {
      const result = await fetch('/__notification-center/preferences?role=' + role).then(response => response.json())
      if (currentRole.current !== captured) return
      if (result.error) throw Error(result.error.message)
      setPreferences({ notificationsEnabled: result.data.notifications_enabled !== false, emailNotificationsEnabled: result.data.email_notifications_enabled !== false, categorySettings: notificationCategorySettings(result.data.category_settings) })
    } catch { if (currentRole.current === captured) setError('Не вдалося прочитати налаштування.') }
    finally { if (currentRole.current === captured) setLoading(false) }
  }
  useEffect(() => { setPreferences(defaults); setLetters([]); setMailReady(false); setError(''); setSaving(false); setMailBusy(false); void refreshPreferences() }, [role])
  const identity = configuration?.roles[role]
  async function updatePreferences(changes: Partial<NotificationPreferences>) {
    if (!identity || saving || loading) return false
    const captured = role, next = { ...preferences, ...changes }
    setSaving(true); setError('')
    try {
      const { error: failure } = await supabase.rpc('xelay_notification_preferences_save', { p_settings: { notifications_enabled: next.notificationsEnabled, email_notifications_enabled: next.emailNotificationsEnabled, category_settings: next.categorySettings }, p_expected_user_id: identity.userId })
      if (failure) throw failure
      if (currentRole.current !== captured) return false
      setPreferences(next); return true
    } catch { if (currentRole.current === captured) setError('Налаштування не збережено. Спробуйте ще раз.'); return false }
    finally { if (currentRole.current === captured) setSaving(false) }
  }
  function choose(next: Role) { sessionStorage.setItem('xelay-notification-center-preview-role', next); setRole(next); setView('inbox') }
  async function generateMail(daily: boolean) {
    if (mailBusy) return
    const captured = role; setMailBusy(true); setError('')
    try {
      const result = await fetch('/__notification-center/mail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, daily }) }).then(response => response.json())
      if (currentRole.current !== captured) return
      if (result.error) throw Error(result.error.message)
      setLetters(result.data); setSelectedLetter(result.data[result.data.length - 1]?.id || ''); setMailReady(true)
    } catch { if (currentRole.current === captured) setError('Не вдалося підготувати локальний лист.') }
    finally { if (currentRole.current === captured) setMailBusy(false) }
  }
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card"><div className="mx-auto max-w-7xl px-5 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-widest text-primary">Xelay · Локальний перегляд</p><h1 className="mt-2 text-2xl font-semibold sm:text-3xl">Важливе не загубиться</h1></div><TeachingButton onClick={toggleTheme}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}{theme === 'light' ? 'Темна тема' : 'Світла тема'}</TeachingButton></div>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">Сповіщення за вашими правилами, обов’язкові повідомлення з підтвердженням і підказки в кабінеті викладача. Усі люди та дані тут вигадані. Листи не надсилаються.</p>
      <nav className="mt-5 flex flex-wrap gap-2" aria-label="Акаунт у локальному прикладі">{(Object.keys(labels) as Role[]).map(key => <TeachingButton key={key} primary={role === key} onClick={() => choose(key)}>{key === 'teacher' ? <GraduationCap size={16} /> : <Users size={16} />}{labels[key]}</TeachingButton>)}</nav>
      <nav className="mt-4 flex flex-wrap gap-2" aria-label="Розділ локального прикладу"><TeachingButton primary={view === 'inbox'} onClick={() => setView('inbox')}><Bell size={16} />Сповіщення</TeachingButton><TeachingButton primary={view === (role === 'teacher' ? 'workspace' : 'group')} onClick={() => setView(role === 'teacher' ? 'workspace' : 'group')}>{role === 'teacher' ? 'Кабінет і підказки' : 'Моя група'}</TeachingButton><TeachingButton primary={view === 'mail'} onClick={() => setView('mail')}><Mail size={16} />Приклади листів</TeachingButton></nav>
      <details className="mt-4 text-sm"><summary className="cursor-pointer text-primary">Що перевірити</summary><div className="mt-3 max-w-4xl space-y-2 rounded-xl border border-border p-4 leading-relaxed"><p>Як Марія натисніть «Ознайомився» під обов’язковим повідомленням про онлайн-заняття. Звичайне «Прочитано» цього не підтверджує. Обов’язкові залишаються видимими навіть з іншими фільтрами.</p><p>Як викладачка відкрийте кабінет, «Повідомлення». У «Хто ознайомився» буде результат Марії. Нове повідомлення спочатку показує одержувачів і чекає вашого підтвердження.</p><p>У кабінеті є «Підказки» для кожного розділу. У налаштуваннях сповіщень можна змінити окремо Xelay та пошту. Для Андрія підготовлено приклад щоденної добірки.</p></div></details>
      {error && <p role="alert" className="teaching-error mt-3">{error}</p>}
    </div></header>
    {!configuration || !identity ? <main className="teaching-page"><p role="status">{error || 'Готуємо приклад…'}</p></main> : view === 'inbox'
      ? <main className="mx-auto max-w-4xl px-3 py-6 sm:px-5"><div className="overflow-hidden rounded-2xl border border-border bg-card"><NotificationCenterContent key={role} userId={identity.userId} repository={notifications} preferences={preferences} preferencesLoading={loading} saving={saving} preferencesError={error} updatePreferences={updatePreferences} refreshPreferences={refreshPreferences} emailState="ready" onOpen={() => setView(role === 'teacher' ? 'workspace' : 'group')} /></div></main>
      : view === 'workspace' && role === 'teacher' ? <TeachingWorkspace key={role} repository={repository} testRepository={tests} moduleRepository={modules} userId={identity.userId} fullName={identity.fullName} initialCourseId={configuration.courseId} initialGroupId={configuration.groupId} initialTab="messages" />
      : view === 'mail' ? <main className="mx-auto max-w-4xl space-y-4 px-5 py-7"><h2 className="text-xl font-semibold">Як виглядатиме лист</h2><p className="text-sm text-muted-foreground">Це локальний приклад без надсилання. Ті самі правила черги, перевірки доступу й шаблони листів працюють на вигаданих даних.</p><div className="flex flex-wrap gap-2"><TeachingButton primary busy={mailBusy} onClick={() => void generateMail(false)}>Показати готові листи</TeachingButton><TeachingButton disabled={mailBusy} onClick={() => void generateMail(true)}>Приклад щоденної добірки</TeachingButton></div>{mailReady && !letters.length && <p role="status">Немає листів, готових за поточними налаштуваннями. Обов’язкові повідомлення не залежать від звичайних перемикачів.</p>}{Boolean(letters.length) && <label className="block text-sm">Готових листів: {letters.length}<select aria-label="Приклад листа" className="mt-2 block w-full rounded-xl border border-border bg-card p-3" value={selectedLetter} onChange={event => setSelectedLetter(event.target.value)}>{letters.map((letter, index) => <option key={letter.id} value={letter.id}>{index + 1}. {letter.subject}</option>)}</select></label>}{letters.filter(letter => letter.id === selectedLetter).map(letter => <article key={letter.id} className="overflow-hidden rounded-2xl border border-border bg-card"><h3 className="border-b border-border px-5 py-4 font-semibold">{letter.subject}</h3><iframe title={letter.subject} sandbox="" srcDoc={letter.html} className="h-[560px] w-full border-0 bg-white" /><details className="px-5 py-4 text-sm"><summary>Текстова версія</summary><p className="mt-3 whitespace-pre-wrap">{letter.text}</p></details></article>)}</main>
      : <main className="teaching-page" key={role}><h2 className="mb-4 text-xl font-semibold">{identity.fullName} · {role === 'other' ? 'Інша група' : 'ЕУБ · навчальний приклад'}</h2><GroupTeachingPanel repository={repository} testRepository={tests} moduleRepository={modules} groupId={role === 'other' ? configuration.otherGroupId : configuration.groupId} userId={identity.userId} canInvite={false} /></main>}
    <footer className="mx-auto max-w-7xl px-5 py-8 text-center text-xs leading-relaxed text-muted-foreground">Окрема локальна база. Зміни зберігаються, доки працює цей перегляд. Робочий Xelay і реальна пошта не змінюються.</footer>
  </div>
}
