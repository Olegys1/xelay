import { useEffect, useId, useRef } from 'react'
import { ArrowLeft, ArrowRight, CalendarDays, GraduationCap, MessageCircle, Newspaper, Sparkles, X } from 'lucide-react'

export type IntroRoute = '/profile' | '/groups' | '/messages' | '/news' | '/subscription'
interface OnboardingModalProps {
  step: number
  onStepChange: (step: number) => void
  onPause: () => void
  onVisit: (route: IntroRoute) => void
  onFinish: () => void
}

const STEPS = [
  { icon: GraduationCap, title: 'Почнімо з вашого профілю', text: 'Вкажіть університет, факультет, освітню програму й курс. За ніком вас знайдуть одногрупники, а факультет визначить вашу спільноту та новини.', location: 'Профіль → Налаштування', action: 'Налаштувати профіль', route: '/profile' },
  { icon: CalendarDays, title: 'Навчальна група — усе поруч', text: 'Розклад і ДЗ, семінари, таблиця верхнього й нижнього тижнів та матеріали за предметами. Староста запрошує учасників і призначає заступників із потрібними правами.', location: 'Групи → прийміть запрошення старости. Для створення групи підтвердьте статус старости у профілі.', action: 'До навчальних груп', route: '/groups' },
  { icon: MessageCircle, title: 'Спілкуйтеся зі своїми', text: 'В особистих чатах, групах і каналах можна ділитися повідомленнями та медіа. Натисніть на повідомлення для відповіді, реакції чи копіювання; ім’я співрозмовника відкриває його профіль.', location: 'Чати → Групи: тут також є спільний чат вашого факультету. Він окремий від навчальної групи.', action: 'Відкрити чати', route: '/messages' },
  { icon: Newspaper, title: 'Новини та взаємодопомога', text: 'Перемикайте новини факультету й університету. В обговореннях спільноти ставте запитання, відповідайте та знаходьте корисний досвід інших студентів.', location: 'Бокове меню → Новини або Теми спільноти', action: 'Переглянути новини', route: '/news' },
  { icon: Sparkles, title: 'Обирайте потрібні можливості', text: 'Навчальні групи повністю безкоштовні: розклад, ДЗ, семінари та матеріали без обмеження строку. Підписка «Учасник» додає приватний особистий органайзер і спільний до 5 людей, статус, пошук людей без денного ліміту та створення опитувань і статей.', location: 'Для навчальної групи особиста підписка не потрібна. У спільному органайзері кожен має власну активну підписку й сам приймає запрошення.', action: 'Подивитися можливості', route: '/subscription' },
] as const

export const ONBOARDING_STEP_COUNT = STEPS.length

export function OnboardingModal({ step, onStepChange, onPause, onVisit, onFinish }: OnboardingModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const current = STEPS[step]
  const Icon = current.icon

  useEffect(() => {
    const previousFocus = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onPause(); return }
      if (event.key !== 'Tab') return
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]') || []).filter((item) => item.getClientRects().length > 0)
      const first = items[0], last = items[items.length - 1]
      if (!first || !last) { event.preventDefault(); dialogRef.current?.focus(); return }
      if (event.shiftKey && (!items.includes(document.activeElement as HTMLElement) || document.activeElement === first)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (!items.includes(document.activeElement as HTMLElement) || document.activeElement === last)) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', keydown)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [onPause])
  useEffect(() => { headingRef.current?.focus() }, [step])

  return <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/40 px-4 py-6 backdrop-blur-sm">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} className="relative my-auto w-full max-w-md rounded-3xl border border-border bg-card p-5 shadow-2xl outline-none sm:p-7">
      <div className="mb-5 flex items-center justify-between gap-3"><p className="text-xs font-medium text-muted-foreground">Коротко про Xelay · {step + 1} з {STEPS.length}</p><button type="button" onClick={onPause} aria-label="Відкласти навчання" className="flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"><X size={18} /></button></div>
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Icon size={24} aria-hidden="true" /></span>
      <div aria-live="polite"><h2 ref={headingRef} tabIndex={-1} id={titleId} className="text-xl font-semibold outline-none">{current.title}</h2><p id={descriptionId} className="mt-3 text-sm leading-relaxed text-muted-foreground">{current.text}</p></div>
      <p className="mt-4 rounded-xl bg-primary/5 px-3 py-3 text-xs leading-relaxed text-primary">{current.location}</p>
      <button type="button" onClick={() => onVisit(current.route)} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-full border border-primary/20 px-4 text-sm font-medium text-primary hover:bg-primary/5">{current.action}<ArrowRight size={15} /></button>
      <div className="mt-5 flex items-center justify-between gap-2 border-t border-border pt-4">
        <button type="button" onClick={() => step ? onStepChange(step - 1) : onPause()} className="inline-flex min-h-11 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground hover:bg-muted">{step > 0 && <ArrowLeft size={14} />}{step ? 'Назад' : 'Пізніше'}</button>
        <div className="flex gap-1" aria-hidden="true">{STEPS.map((_, index) => <span key={index} className={`h-1.5 rounded-full transition-all motion-reduce:transition-none ${index === step ? 'w-4 bg-primary' : 'w-1.5 bg-primary/20'}`} />)}</div>
        <button type="button" onClick={() => step + 1 < STEPS.length ? onStepChange(step + 1) : onFinish()} className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90">{step + 1 < STEPS.length ? 'Далі' : 'Почати'}{step + 1 < STEPS.length && <ArrowRight size={15} />}</button>
      </div>
      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">Перехід до розділу збереже ваш крок. Поверніться на головну, щоб продовжити огляд. Повторити його можна в боковому меню → «Як користуватися Xelay».</p>
    </div>
  </div>
}
