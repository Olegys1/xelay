import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, Check, Gift, MoonStar, Sparkles } from 'lucide-react'
import { useHalloweenHunt } from '../context/HalloweenHuntContext'
import { useTheme } from '../context/ThemeContext'
import { useAuth } from '../context/AuthContext'
import { AuthModal } from '../components/AuthModal'
import { PumpkinArt } from '../components/halloween/HalloweenPumpkin'
import { PumpkinProgress } from '../components/halloween/HalloweenExperience'

const hints = [
  { id: 'home', route: '/' as const, name: 'Там, де починається Xelay', hint: 'Наш маленький мешканець теж любить головну.' },
  { id: 'questions', route: '/categories' as const, name: 'Між запитаннями та відповідями', hint: 'Іноді відповідь знаходиться у спільноті.' },
  { id: 'news', route: '/news' as const, name: 'Осінь теж має новини', hint: 'Один гарбузик стежить за подіями.' },
  { id: 'groups', route: '/groups' as const, name: 'У добрій компанії тепліше', hint: 'Загляньте до своїх навчальних груп.' },
  { id: 'people', route: '/search' as const, name: 'Шукаємо друзів, знаходимо магію', hint: 'Пошук знайде не лише людей.' },
  { id: 'messages', route: '/messages' as const, name: 'Псс… вам повідомлення', hint: 'Скринька зберігає маленький секрет.' },
  { id: 'support', route: '/support' as const, name: 'Там, де Xelay кажуть «дякую»', hint: 'Для цього гарбузика достатньо завітати.' },
  { id: 'opportunities', route: '/opportunities' as const, name: 'Майбутнє повне можливостей', hint: 'Навіть там, де ще готуються до запуску.' },
  { id: 'subscription', route: '/subscription' as const, name: 'За лаштунками «Учасника»', hint: 'Маленький гість уже приміряє зірочку.' },
  { id: 'profile', route: '/profile' as const, name: 'Остання зупинка — у вас', hint: 'Ваша власна сторінка має осінній настрій.' },
]
export function HalloweenPage() {
  const hunt = useHalloweenHunt()
  const { isAuthenticated } = useAuth()
  const { theme, setTheme, halloweenAvailable } = useTheme()
  const [authOpen, setAuthOpen] = useState(false)
  const [showHints, setShowHints] = useState(false)
  useEffect(() => { if (hunt.userId && !hunt.available) void hunt.refresh() }, [hunt.userId, hunt.available, hunt.refresh])
  const collected = hunt.state?.collected || []
  const ended = Date.now() >= Date.parse('2026-11-01T22:00:00Z') && !hunt.available
  return <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6">
    {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
    <Link to="/" className="inline-flex min-h-10 items-center gap-2 text-xs text-muted-foreground hover:text-primary"><ArrowLeft size={14} />На головну</Link>
    <section className="halloween-event-hero">
      <div className="relative z-[1] flex flex-col-reverse items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div><span className="halloween-kicker">Xelay · маленька осіння пригода</span><h1 className="mt-3">Знайдіть свої<br />10 гарбузиків.</h1><p className="mt-5">Вони заховалися між навчанням, новинами та знайомствами. Зберіть компанію — і залиште собі трохи осінньої магії.</p>
          <div className="mt-5 flex flex-wrap items-center gap-3">{halloweenAvailable && <button type="button" className="halloween-cta" onClick={() => setTheme(theme === 'halloween' ? 'light' : 'halloween')}><MoonStar size={15} />{theme === 'halloween' ? 'Повернути світлу тему' : 'Увімкнути «Гарбузовий вечір»'}</button>}{!isAuthenticated && !ended && <button type="button" className="halloween-cta" onClick={() => setAuthOpen(true)}>Увійти та збирати<ArrowRight size={14} /></button>}</div>
        </div><PumpkinArt className="halloween-hero-mascot" size={220} />
      </div>
    </section>
    <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
      <section className="halloween-detail-card"><div className="flex items-center justify-between gap-3"><h2>{hunt.state?.completed ? 'Усі разом. Усі ваші ✧' : ended ? 'Полювання завершилося' : 'Ваша гарбузова компанія'}</h2><span className="rounded-full bg-primary/10 px-3 py-1 text-sm font-bold text-primary">{collected.length}/10</span></div><PumpkinProgress collected={collected} />
        {hunt.state?.completed ? <><p>{hunt.state.subscriptionWon ? 'Бейдж із гарбузом отримано, місяць «Учасника» додано до вашого акаунта.' : hunt.state.winnersRemaining > 0 ? 'Бейдж із гарбузом отримано! Додаткові призи призначені тільки для тих, хто вперше завершить збір після старту додаткової акції. Повторної нагороди за вже завершений збір немає.' : 'Бейдж із гарбузом отримано! Усі призові місяці вже розібрали.'}</p>{hunt.state.subscriptionEndsAt && <p className="mt-2">Доданий місяць діє до {new Intl.DateTimeFormat('uk-UA', { dateStyle: 'long', timeZone: 'Europe/Kyiv' }).format(new Date(hunt.state.subscriptionEndsAt))}.</p>}<Link to="/profile" className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-primary">До свого бейджа<ArrowRight size={14} /></Link></> : <><p>{ended ? 'Дякуємо всім, хто долучився. Отримані бейджі залишаються у профілі.' : 'Натискайте на гарбузиків у різних розділах — прогрес зберігається у вашому акаунті між пристроями.'}</p>{hunt.state && !ended && <p className="mt-3 flex items-center gap-2"><Gift size={15} className="text-primary" />Додаткових призових місяців залишилося: <strong className="text-foreground">{hunt.state.winnersRemaining}/5</strong></p>}</>}
        {hunt.loading && <p className="mt-2" role="status">Перевіряємо колекцію…</p>}{hunt.error && <p className="mt-2" role="alert">{hunt.error}<button type="button" onClick={() => { void hunt.refresh() }} className="ml-2 underline">Повторити</button></p>}
        {hunt.state && !hunt.state.eligible && <p className="mt-3 rounded-xl bg-primary/5 p-3">{hunt.state.ineligibleReason === 'email_unconfirmed' ? 'Підтвердьте електронну пошту свого акаунта, щоб долучитися до полювання.' : 'Завершіть налаштування свого профілю, щоб долучитися до полювання.'}</p>}
        {!hunt.available && !ended && <p className="mt-3 font-medium text-primary">Старт — 18 жовтня о 12:00 за Києвом.</p>}
      </section>
      <section className="halloween-detail-card"><span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Sparkles size={20} /></span><h2 className="mt-3">Знайдіть 10. Збережіть магію.</h2><p className="mt-2"><strong className="text-foreground">Кожному</strong>, хто збере всі 10 гарбузиків, — бейдж із гарбузом біля імені. Він залишиться після завершення акції.</p><p className="mt-3"><strong className="text-foreground">Ще 5 учасників</strong>, які вперше завершать збір після старту додаткової акції, отримають один календарний місяць «Учасника». Якщо підписка вже діє, подарунок продовжить її.</p></section>
    </div>
    {!ended && !hunt.state?.completed && <section className="halloween-detail-card"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2>Загубили гарбузовий слід?</h2><p className="mt-1">Тут є підказки, якщо захочеться маленької допомоги.</p></div><button type="button" aria-expanded={showHints} aria-controls="halloween-hints" onClick={() => setShowHints(value => !value)} className="min-h-10 rounded-full border border-border px-4 py-2 text-xs font-semibold text-primary">{showHints ? 'Сховати підказки' : 'Показати підказки ✧'}</button></div>{showHints && <div id="halloween-hints" className="mt-4 grid gap-2 sm:grid-cols-2">{hints.map(item => <Link key={item.id} to={item.route} className="halloween-hint"><span>{item.name}<small className="mt-1 block">{item.hint}</small></span>{collected.includes(item.id as never) ? <Check size={17} className="shrink-0 text-primary" aria-label="Знайдено" /> : <ArrowRight size={15} className="shrink-0 text-muted-foreground" />}</Link>)}</div>}</section>}
    <section className="halloween-detail-card"><h2>Коротко про правила</h2><ul className="mt-3 list-disc space-y-2 pl-4"><li>Полювання: з 18 жовтня 2026 року, 12:00, до кінця 1 листопада 2026 року за київським часом. Участь безкоштовна.</li><li>Потрібен акаунт із підтвердженою поштою. Усі 10 розділів доступні без оплати або членства в навчальній групі.</li><li>Кожен гарбузик враховується один раз. Сервер зберігає прогрес. Перші 10 призових місяців уже видано. Додали ще 5 місяців «Учасника» для наступних учасників, які вперше завершать збір після старту додаткової акції. Якщо зібрали всі гарбузики раніше, повторної нагороди немає. Одна призова підписка на акаунт.</li><li>Бейдж із гарбузом отримають усі, хто завершить збір у строк. Його можна приховати або знову показати в налаштуваннях профілю.</li><li>«Гарбузовий вечір» — необов’язкова тема оформлення. Її можна змінити будь-коли; після 2 листопада повернеться ваша звична тема.</li></ul></section>
  </main>
}
