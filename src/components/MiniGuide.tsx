import { useId, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, CircleHelp, Lightbulb, X } from 'lucide-react'
import { useOnboarding } from '../context/OnboardingContext'
import { guideKey, hasSeenGuide, rememberGuide } from '../lib/onboarding'

export interface GuideStep { id: string; title: string; text: string; target?: string; action?: string }
interface MiniGuideProps {
  userId: string
  topic: string
  label: string
  steps: GuideStep[]
  onAction?: (target: string) => void
}

export function MiniGuide(props: MiniGuideProps) {
  if (!props.userId || !props.steps.length) return null
  return <GuideSession key={`${props.userId}:${props.topic}`} {...props} />
}

function GuideSession({ userId, topic, label, steps, onAction }: MiniGuideProps) {
  const key = guideKey(userId, topic)
  const [closed, setClosed] = useState(() => hasSeenGuide(key))
  const [stepId, setStepId] = useState(steps[0].id)
  const titleId = useId()
  const replayRef = useRef<HTMLButtonElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { suspended } = useOnboarding()
  const index = Math.max(0, steps.findIndex((item) => item.id === stepId))
  const current = steps[index]
  const finish = () => {
    rememberGuide(key); setClosed(true)
    requestAnimationFrame(() => replayRef.current?.focus({ preventScroll: true }))
  }
  if (suspended) return null

  if (closed) return <div className="mb-3 flex justify-end">
    <button ref={replayRef} type="button" onClick={() => { setStepId(steps[0].id); setClosed(false); requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true })) }}
      className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-xs text-muted-foreground hover:bg-muted hover:text-primary"
      aria-label={`Повторити підказки: ${label}`}><CircleHelp size={14} />Підказки</button>
  </div>

  return <aside aria-labelledby={titleId} className="xelay-premium-reveal relative mb-4 rounded-2xl border border-primary/15 bg-primary/5 p-3.5 sm:p-4">
    <div className="flex items-start gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-background text-primary"><Lightbulb size={17} aria-hidden="true" /></span>
      <div className="min-w-0 flex-1" aria-live="polite" aria-atomic="true">
        <p className="text-[11px] font-medium text-muted-foreground">{label} · {index + 1} з {steps.length}</p>
        <h2 ref={headingRef} tabIndex={-1} id={titleId} className="mt-1 text-sm font-semibold outline-none">{current.title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{current.text}</p>
      </div>
      <button type="button" onClick={finish} aria-label="Закрити підказки" className="-mr-1 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"><X size={17} /></button>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {current.target && current.action && onAction && <button type="button" onClick={() => onAction(current.target!)} className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-primary/20 bg-background px-3 text-xs font-medium text-primary hover:bg-primary/5">{current.action}<ArrowRight size={13} /></button>}
        <button type="button" onClick={finish} className="min-h-10 rounded-full px-2.5 text-xs text-muted-foreground hover:text-foreground">Перегляну пізніше</button>
      </div>
      <div className="flex items-center gap-1.5">
        {index > 0 && <button type="button" onClick={() => setStepId(steps[index - 1].id)} aria-label="Попередня підказка" className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-background"><ArrowLeft size={15} /></button>}
        <button type="button" onClick={() => index + 1 < steps.length ? setStepId(steps[index + 1].id) : finish()} className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90">{index + 1 < steps.length ? 'Далі' : 'Зрозуміло'}{index + 1 < steps.length && <ArrowRight size={14} />}</button>
      </div>
    </div>
  </aside>
}
