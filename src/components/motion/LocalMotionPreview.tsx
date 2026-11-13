import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, Heart, Moon, RotateCcw, Sparkles, Sun, X } from 'lucide-react'
import { HomeDashboard } from '../home/HomeDashboard'
import { SupportThankYou } from '../SupportThankYou'
import { SupporterContributionPreview, SupporterLevels } from '../SupporterLevels'
import { SUPPORTER_TIERS, type ActiveSupporterTier } from '../../lib/supporterTiers'
import type { HomeDashboardData, HomeDashboardRole } from '../../lib/homeDashboardModel'
import './localMotionPreview.css'

const group = { id: 'motion-group', name: 'ЕК-31 · демо', program: 'Економіка', studyYear: 3, academicYear: '2026–2027', status: 'accepted' as const, learning: true, teachingSubjectIds: ['management', 'finance'], gradingSubjectIds: ['management', 'finance'], permissions: ['schedule', 'homework', 'materials', 'members', 'assignments', 'grades'] as HomeDashboardData['groups'][number]['permissions'] }
const amounts = { 1: 100, 2: 10000, 3: 25000, 4: 50000, 5: 100000 }

function sampleDay(role: HomeDashboardRole, minutes: number): HomeDashboardData {
  const clock = `${String(9 + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  const ownGroup = { ...group, permissions: role === 'student' ? [] : group.permissions }
  return {
    role, displayName: 'Демо Xelay', firstName: 'Олександр', initials: 'О', clockIso: `2026-11-13T${clock}:00+02:00`, contexts: role === 'teacher' ? ['teaching', 'learning'] : ['learning'], teachingVerified: role === 'teacher', status: 'ready', preferredGroupId: group.id, participantCount: 1038,
    groups: [ownGroup, { ...ownGroup, id: 'motion-group-2', name: 'ЕК-32 · демо', learning: false }],
    lessons: [
      { id: 'motion-lesson', groupId: group.id, subjectId: 'management', subject: 'Менеджмент', date: '2026-11-13', startsAt: '09:00', endsAt: '10:20', type: 'Семінар', topic: 'Команда, мотивація та прийняття рішень', room: 'Аудиторія 204', teacherName: 'Викладач · демо', href: '/groups/motion-group', homeworkId: 'motion-homework', materialId: 'motion-material' },
      { id: 'motion-lesson-next', groupId: group.id, subjectId: 'finance', subject: 'Фінанси', date: '2026-11-13', startsAt: '11:30', endsAt: '12:50', type: 'Лекція', room: 'Аудиторія 306', href: '/groups/motion-group' },
      { id: 'motion-lesson-tomorrow', groupId: group.id, subjectId: 'management', subject: 'Менеджмент', date: '2026-11-14', startsAt: '10:30', endsAt: '11:50', type: 'Практична робота', href: '/groups/motion-group' },
    ],
    tasks: [
      { id: 'motion-homework', groupId: group.id, subjectId: 'management', subject: 'Менеджмент', title: 'Підготувати рішення для своєї команди', description: 'Розберіть кейс і запропонуйте три кроки для команди.', kind: 'preparation', audience: 'learning', status: 'open', dueAt: '2026-11-13T18:00:00+02:00', href: '/groups/motion-group', actionLabel: 'До завдання' },
      { id: 'motion-homework-2', groupId: group.id, subjectId: 'finance', subject: 'Фінанси', title: 'Практична робота № 4', description: 'Додайте розрахунки та короткий висновок.', kind: 'submission', audience: 'learning', status: 'in-progress', dueAt: '2026-11-14T20:00:00+02:00', href: '/groups/motion-group', actionLabel: 'Продовжити' },
      { id: 'motion-review', groupId: group.id, subjectId: 'management', subject: 'Менеджмент', title: 'Практичні роботи до перевірки', description: 'Нові роботи студентів уже чекають у кабінеті.', kind: 'review', audience: 'teaching', status: 'open', href: '/teaching', actionLabel: 'Перевірити', count: 8, requiredPermission: 'grades' },
    ],
    updates: [
      { id: 'motion-update-1', groupId: group.id, subjectId: 'management', audience: 'learning', kind: 'material', title: 'Матеріали до семінару', description: 'Кейс, короткий конспект і питання для обговорення.', createdAt: '2026-11-13T08:10:00+02:00', href: '/groups/motion-group', isNew: true },
      { id: 'motion-update-2', groupId: group.id, subjectId: 'finance', audience: 'learning', kind: 'grade', title: 'Результати вже в журналі', description: 'Перегляньте свій бал і коментар до роботи.', createdAt: '2026-11-13T08:00:00+02:00', href: '/groups/motion-group', isNew: true },
      { id: 'motion-update-3', groupId: group.id, subjectId: 'management', audience: 'teaching', kind: 'message', title: 'Нове запитання від групи', description: 'Перегляньте запитання перед наступним заняттям.', createdAt: '2026-11-13T08:30:00+02:00', href: '/teaching', isNew: true },
    ],
    publications: [{ id: 'motion-publication', groupId: group.id, subjectId: 'finance', title: 'Тест: фінансові рішення', kind: 'assignment', publishAt: '2026-11-14T10:00:00+02:00', href: '/teaching' }],
    news: [
      { id: 'motion-news-1', kind: 'platform', title: 'Маленькі деталі, які відчуваються', excerpt: 'Розвиваємо Xelay разом зі студентами, старостами та викладачами.', date: '2026-11-13', href: '/news' },
      { id: 'motion-news-2', kind: 'faculty', title: 'Зустріч студентської спільноти', excerpt: 'Ідеї, знайомства й розмова про те, що варто зробити далі.', date: '2026-11-12', href: '/news' },
    ],
    community: [
      { id: 'motion-community-1', category: 'Навчання разом', title: 'Де ви знаходите тихе місце, щоб підготуватися між парами?', author: 'Спільнота Xelay · демо', replies: 6, href: '/community' },
      { id: 'motion-community-2', category: 'Можливості', title: 'Збираємо корисні курси та стажування на цей семестр', author: 'Команда Xelay · демо', replies: 12, href: '/community' },
    ],
  }
}

export function LocalMotionPreview() {
  const [view, setView] = useState<'home' | 'support'>('home')
  const [dark, setDark] = useState(false)
  const [reduced, setReduced] = useState(false)
  const [role, setRole] = useState<HomeDashboardRole>('student')
  const [minutes, setMinutes] = useState(35)
  const [tier, setTier] = useState<ActiveSupporterTier>(4)
  const [secret, setSecret] = useState(false)
  const [replay, setReplay] = useState(0)
  const [celebrate, setCelebrate] = useState(false)
  const [notice, setNotice] = useState('')
  const sampleSummary = secret ? { tier, totalKopiykas: amounts[tier] } : { tier: 0 as const, totalKopiykas: 0 }
  const data = useMemo(() => sampleDay(role, minutes), [role, minutes])
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); return () => document.documentElement.classList.remove('dark') }, [dark])
  useEffect(() => { document.documentElement.classList.toggle('motion-preview-reduced', reduced); return () => document.documentElement.classList.remove('motion-preview-reduced') }, [reduced])
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 4500); return () => window.clearTimeout(timer) }, [notice])
  const go = (next: 'home' | 'support') => { setView(next); window.scrollTo({ top: 0, behavior: 'instant' }) }
  return <div className="mp-root" onClickCapture={event => { const anchor = (event.target as HTMLElement).closest('a[href]'); if (anchor) { event.preventDefault(); setNotice('Це демонстраційний перегляд. Робочі дані залишаються незмінними.') } }} onAuxClickCapture={event => event.preventDefault()}>
    <div className="mp-note"><span><span />Локальний перегляд</span><p>Демоанімації на вигаданих даних. Платежів немає.</p></div>
    <header className="mp-header"><button type="button" className="mp-brand" onClick={() => go('home')} aria-label="Xelay — головна">Xelay<small>K N U</small></button><nav aria-label="Приклади анімацій"><button type="button" aria-pressed={view === 'home'} onClick={() => go('home')}>Головна</button><button type="button" aria-pressed={view === 'support'} onClick={() => go('support')}>Підтримка команди</button></nav><button type="button" className="mp-theme" aria-label={dark ? 'Світла тема' : 'Темна тема'} onClick={() => setDark(value => !value)}>{dark ? <Sun size={19} /> : <Moon size={19} />}</button></header>
    <div className="mp-controls"><div><button type="button" onClick={() => { setReplay(value => value + 1); setCelebrate(false) }}><RotateCcw size={14} />Повторити появу</button><label className="mp-reduced"><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} />Без анімацій</label></div>{view === 'home' ? <div><label><span>Кабінет</span><select aria-label="Кабінет у прикладі" value={role} onChange={event => setRole(event.target.value as HomeDashboardRole)}><option value="student">Студент</option><option value="headman">Староста</option><option value="teacher">Викладач</option></select></label><label className="mp-time"><span>Час пари</span><input type="range" aria-label="Хвилини поточної пари" min="0" max="79" value={minutes} onChange={event => setMinutes(Number(event.target.value))} /><output>{minutes} хв</output></label></div> : <span className="mp-controls-caption">Оберіть рівень і перегляньте подяку</span>}</div>
    {view === 'home' ? <div className="hd-dashboard" data-theme={dark ? 'dark' : 'light'}><HomeDashboard key={`${replay}-${role}`} data={data} motionEnabled={!reduced} onNavigate={(_href, label) => setNotice(`«${label}» — приклад переходу в локальному перегляді.`)} onOpportunityInterest={() => setNotice('Ваші ідеї допомагають розвивати Xelay.')} /></div> : <main className="mp-support xelay-support-page" key={replay}>
      <header className="mp-support-intro xelay-support-header"><span className="mp-eyebrow"><Heart size={15} />Створюємо Xelay разом</span><h1>Ваша підтримка.<br /><em>Відчутна вдячність.</em></h1><p>Для кожного рівня — свій знак, матеріал і момент подяки.</p></header>
      <div className="mp-tier-picker" aria-label="Рівень для перегляду">{SUPPORTER_TIERS.map(item => <button key={item.tier} type="button" aria-pressed={tier === item.tier} onClick={() => { setTier(item.tier); setCelebrate(false) }}><small>0{item.tier}</small>{item.name}</button>)}</div>
      <SupporterLevels currentTier={0} previewTier={tier} />
      <div className="mp-support-grid"><section className="mp-support-copy"><span className="mp-eyebrow">Момент, який запам’ятається</span><h2>Ви допомагаєте<br />Xelay рухатись далі.</h2><p>Металевий знак рівня, коротка світлова хвиля й особисте «дякуємо». Після підтвердженої підтримки — від команди до вас.</p><ul><li><Check size={16} />Окрема палітра для кожного рівня</li><li><Check size={16} />Коротка анімація без нескінченного руху</li><li><Check size={16} />Зручне керування з телефона й клавіатури</li></ul></section><section className="mp-support-sample"><p className="mp-eyebrow">Приклад внеску</p><strong>{secret ? '67' : new Intl.NumberFormat('uk-UA').format(amounts[tier] / 100)}<small>грн</small></strong><p className="mp-support-disclaimer">Це лише перегляд оформлення. Гроші не списуються.</p><label className="mp-secret"><input type="checkbox" checked={secret} onChange={event => setSecret(event.target.checked)} />Показати також секретний «67»</label><SupporterContributionPreview amountKopiykas={secret ? 6700 : amounts[tier]} summary={sampleSummary} authenticated testMode /><button type="button" className="mp-celebrate xelay-btn" onClick={() => setCelebrate(true)}><Sparkles size={18} />Показати подяку<ArrowRight size={18} /></button></section></div>
      <details className="mp-details"><summary>Коли з’являється така подяка?</summary><p>На робочій платформі — після підтвердження справжньої оплати. У цьому локальному прикладі можна переглянути всі рівні без оплати.</p></details>
    </main>}
    {celebrate && <SupportThankYou key={`${tier}-${replay}`} amountKopiykas={secret ? 6700 : amounts[tier]} supporterTier={tier} sixSeven={secret} onClose={() => setCelebrate(false)} onViewProfile={() => { setCelebrate(false); setNotice('Бейдж підтримки з’явиться у вашому профілі після підтвердженої оплати.') }} />}
    {notice && <ul className="xelay-toast-stack" aria-live="polite"><li className="xelay-toast"><Check className="xelay-toast-icon" size={20} /><p className="flex-1 text-sm leading-6">{notice}</p><button type="button" className="xelay-toast-close" aria-label="Закрити повідомлення" onClick={() => setNotice('')}><X size={16} /></button></li></ul>}
  </div>
}
