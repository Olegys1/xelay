import { guideKey } from './onboarding'

export interface HomeGuideController {
  available: boolean
  open: boolean
  step: number
  showOffer: boolean
  start: () => void
  setStep: (step: number) => void
  pause: () => void
  finish: () => void
}

export interface HomeGuideProgress {
  status: 'active' | 'paused' | 'complete'
  step: number
}

export const HOME_GUIDE_TOPIC = 'home-dashboard-20261029'
const MAX_STEP = 50
const sessionProgress = new Map<string, HomeGuideProgress | null>()
const noop = () => {}

/** A safe default for isolated previews and surfaces outside the app provider. */
export const EMPTY_HOME_GUIDE: HomeGuideController = Object.freeze({
  available: false, open: false, step: 0, showOffer: false,
  start: noop, setStep: noop, pause: noop, finish: noop,
})

export function homeGuideKey(userId: string) {
  return guideKey(userId, HOME_GUIDE_TOPIC)
}

export function validHomeGuideStep(step: unknown): step is number {
  return typeof step === 'number' && Number.isSafeInteger(step) && step >= 0 && step <= MAX_STEP
}

function normalizeProgress(value: unknown): HomeGuideProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (!validHomeGuideStep(candidate.step) || typeof candidate.status !== 'string' || !['active', 'paused', 'complete'].includes(candidate.status)) return null
  // Store only a local UI choice. Never persist names, contacts or profile data.
  return { status: candidate.status as HomeGuideProgress['status'], step: candidate.step }
}

export function readHomeGuideProgress(key: string): HomeGuideProgress | null {
  if (sessionProgress.has(key)) {
    const saved = sessionProgress.get(key)
    return saved ? { ...saved } : null
  }
  try {
    const saved = normalizeProgress(JSON.parse(window.localStorage.getItem(key) || 'null'))
    sessionProgress.set(key, saved)
    return saved ? { ...saved } : null
  } catch { return null }
}

export function saveHomeGuideProgress(key: string, value: HomeGuideProgress) {
  const progress = normalizeProgress(value)
  if (!progress) return false
  sessionProgress.set(key, progress)
  try { window.localStorage.setItem(key, JSON.stringify(progress)) } catch { /* This session still remembers the choice. */ }
  return true
}

/** This decides visibility only. The home view supplies role-specific content. */
export function homeGuideView(input: {
  userId?: string
  pending: boolean
  pathname: string
  eligible: boolean
  legacySeen: boolean
  legacyPaused: boolean
  progress: HomeGuideProgress | null
}) {
  const available = Boolean(input.userId && !input.pending && input.pathname === '/')
  const autoStart = !input.progress && input.eligible && !input.legacySeen && !input.legacyPaused
  const open = available && (input.progress?.status === 'active' || autoStart)
  const deferred = input.progress?.status === 'paused' || (!input.progress && input.legacyPaused)
  return {
    available,
    open,
    step: input.progress?.step ?? 0,
    showOffer: available && !open && !deferred && input.progress?.status !== 'complete',
  }
}
