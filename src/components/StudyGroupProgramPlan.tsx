import { BookOpen, ExternalLink } from 'lucide-react'
import { resolveStudyProgramPlan } from '../lib/studyProgramPlans'

type StudyGroupProgramPlanProps = {
  universitySlug?: string | null
  unitSlug?: string | null
  programName?: string | null
  studyLevel?: string | null
  cohortStartYear?: number | null
}

export function StudyGroupProgramPlan(props: StudyGroupProgramPlanProps) {
  const plan = resolveStudyProgramPlan(props)
  if (!plan) return null

  const label = plan.match === 'program' ? 'План моєї програми' : plan.label
  const program = props.programName?.trim()
  const cohort = props.cohortStartYear
  const hasCohort = typeof cohort === 'number' && Number.isInteger(cohort) && cohort >= 1900 && cohort <= 2199
  // These official pages list admission years; the link itself is not a verified plan for this cohort.
  const description = [
    label,
    program ? `Освітня програма: ${program}.` : '',
    plan.description,
    'Офіційний сайт університету. Оберіть рік вступу на сайті.',
  ].filter(Boolean).join(' ')

  return <div className="flex min-w-0 max-w-full flex-col items-start gap-1.5 sm:items-end">
    <a
      href={plan.href}
      target="_blank"
      rel="noopener noreferrer"
      title={description}
      aria-label={`${description} Відкриється в новій вкладці.`}
      className="inline-flex min-h-11 max-w-full items-center justify-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3.5 py-2 text-sm font-semibold text-primary transition-colors hover:border-primary/40 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
    >
      <BookOpen size={16} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words text-left">{label}</span>
      <ExternalLink size={13} className="shrink-0 opacity-70" aria-hidden="true" />
    </a>
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      Офіційний сайт{hasCohort ? ` · Набір ${cohort}` : ''}
    </p>
  </div>
}
