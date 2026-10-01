import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, BadgeCheck, CalendarDays, Crown, MessageCircle, Search, Smile, Sparkles, X } from 'lucide-react'

interface ParticipantWelcomeProps {
  celebrate?: boolean
  onClose: () => void
}

const STEPS = [
  {
    icon: Smile,
    title: 'Ваш настрій поруч із ніком',
    text: 'Додайте короткий текст до 48 символів і до трьох емодзі. Статус і бейдж учасника видно поруч із вашим профілем.',
    location: 'Профіль → «Додати мій статус» або «Змінити мій статус»',
    button: 'Налаштувати статус',
    route: '/profile',
  },
  {
    icon: CalendarDays,
    title: 'Справи у власному ритмі',
    text: 'Зберігайте завдання, нотатки й дедлайни в особистому органайзері. Він відкривається з бокового меню.',
    location: 'Бокове меню → «Органайзер»',
    button: 'Відкрити органайзер',
    route: '/organizer',
  },
  {
    icon: MessageCircle,
    title: 'Більше можливостей у спілкуванні',
    text: 'Закріплюйте важливі повідомлення в директі й обирайте додаткові реакції. А пошук людей за ніком працює без денного ліміту.',
    location: 'Іконка повідомлень → чат; іконка пошуку → люди',
    button: 'Перейти в директ',
    route: '/messages',
  },
] as const

export function ParticipantWelcome({ celebrate = false, onClose }: ParticipantWelcomeProps) {
  const navigate = useNavigate()
  const [step, setStep] = useState(celebrate ? -1 : 0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const restoreFocus = useRef(true)
  const titleId = useId()
  const descriptionId = useId()
  const currentStep = step >= 0 ? STEPS[step] : null
  const Icon = currentStep?.icon || Crown

  useEffect(() => {
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]') || [])
        .filter((element) => element.getClientRects().length > 0)
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (!first || !last) { event.preventDefault(); dialogRef.current?.focus(); return }
      if (event.shiftKey && (!elements.includes(document.activeElement as HTMLElement) || document.activeElement === first)) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (!elements.includes(document.activeElement as HTMLElement) || document.activeElement === last)) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
      if (restoreFocus.current && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [onClose])

  useEffect(() => { headingRef.current?.focus() }, [step])

  const openFeature = () => {
    if (!currentStep) return
    restoreFocus.current = false
    onClose()
    if (currentStep.route === '/profile') void navigate({ to: '/profile', hash: 'participant-status' })
    else void navigate({ to: currentStep.route })
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/45 px-4 py-6 backdrop-blur-sm" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} className="xelay-participant-welcome relative my-auto w-full max-w-md overflow-hidden rounded-[28px] border border-border bg-card p-6 shadow-2xl outline-none sm:p-8">
        <button type="button" onClick={onClose} className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label="Закрити огляд можливостей"><X size={20} /></button>

        {step < 0 && <div className="xelay-participant-confetti" aria-hidden="true">{Array.from({ length: 20 }, (_, index) => <span key={index} style={{ '--piece': index, '--piece-left': `${5 + (index * 37) % 91}%`, '--piece-delay': `${(index % 5) * 70}ms`, '--piece-turn': `${index % 2 ? -210 : 240}deg` } as CSSProperties} />)}</div>}

        <div className="relative">
          <span className={`mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-3xl bg-primary/10 text-primary ${step < 0 ? 'xelay-participant-crown' : ''}`}><Icon size={36} strokeWidth={1.7} /></span>
          {step < 0 ? <>
            <p className="mb-3 flex items-center justify-center gap-1.5 text-xs font-semibold text-primary"><BadgeCheck size={14} /> Оплату підтверджено</p>
            <h2 ref={headingRef} tabIndex={-1} id={titleId} className="text-center text-2xl font-bold tracking-tight outline-none">Ви — Учасник ✨</h2>
            <p id={descriptionId} className="mt-3 text-center text-sm leading-relaxed text-muted-foreground">Ваші можливості вже відкриті. Покажемо, де знайти статуси, органайзер і зручніший директ — у трьох коротких кроках.</p>
            <div className="my-6 flex flex-wrap items-center justify-center gap-2" aria-hidden="true">{['🌿', '📚', '☕'].map((emoji) => <span key={emoji} className="rounded-full border border-primary/15 bg-primary/5 px-3 py-1.5 text-lg">{emoji}</span>)}<span className="rounded-full border border-primary/15 bg-primary/5 px-3 py-2 text-xs font-semibold text-primary">На своєму вайбі</span></div>
            <button type="button" onClick={() => setStep(0)} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-white hover:bg-primary/90">Показати мої можливості <Sparkles size={16} /></button>
            <button type="button" onClick={onClose} className="mt-3 min-h-10 w-full rounded-full text-sm text-muted-foreground hover:bg-muted">Перегляну пізніше</button>
          </> : currentStep && <>
            <p className="mb-3 text-center text-xs font-semibold text-primary">Можливості «Учасник» · {step + 1} з {STEPS.length}</p>
            <h2 ref={headingRef} tabIndex={-1} id={titleId} className="text-center text-xl font-bold tracking-tight outline-none">{currentStep.title}</h2>
            <p id={descriptionId} className="mt-3 text-center text-sm leading-relaxed text-muted-foreground">{currentStep.text}</p>
            <p className="mt-5 rounded-2xl border border-primary/15 bg-primary/5 px-4 py-3 text-center text-xs font-semibold leading-relaxed text-primary">{currentStep.location}</p>
            {step === 0 && <p className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">За непристойні статуси, образи та мову ненависті акаунт буде заблоковано.</p>}
            {step === 2 && <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground"><Search size={13} /> Пошук груп і каналів безкоштовний для всіх.</p>}
            <button type="button" onClick={openFeature} className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-white hover:bg-primary/90">{currentStep.button} <ArrowRight size={16} /></button>
            <div className="mt-4 flex items-center justify-between gap-3">
              <button type="button" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))} className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground hover:bg-muted disabled:invisible"><ArrowLeft size={15} /> Назад</button>
              <div className="flex gap-1.5" aria-hidden="true">{STEPS.map((_, index) => <span key={index} className={`h-1.5 rounded-full transition-all motion-reduce:transition-none ${index === step ? 'w-5 bg-primary' : 'w-1.5 bg-primary/20'}`} />)}</div>
              <button type="button" onClick={() => step < STEPS.length - 1 ? setStep(step + 1) : onClose()} className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-primary hover:bg-primary/5">{step < STEPS.length - 1 ? 'Далі' : 'Зрозуміло'}{step < STEPS.length - 1 && <ArrowRight size={15} />}</button>
            </div>
            <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">Огляд можна повторити на сторінці підписки.</p>
          </>}
        </div>
      </div>
    </div>
  )
}
