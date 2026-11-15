import type { TeachingTest, TeachingTestAttempt } from './teachingTests'

/** Advance only from a received server clock; local wall time is elapsed time. */
export function teachingReviewServerNow(serverNow: string | undefined, receivedAt: number, localNow: number): number {
  const server = Date.parse(serverNow || '')
  return Number.isFinite(server) ? server + Math.max(0, localNow - receivedAt) : NaN
}

export function teachingReviewReadyAt(test: TeachingTest): number {
  if (test.closed_early_at) return Date.parse(test.closed_early_at)
  const dates = [test.closes_at, test.results_ready_at, ...(test.overrides || []).map(item => item.closes_at)]
    .filter((value): value is string => Boolean(value)).map(value => Date.parse(value)).filter(Number.isFinite)
  return dates.length ? Math.max(...dates) : NaN
}

export function teachingReviewActiveAttempts(attempts: TeachingTestAttempt[], serverNow: number): number {
  return attempts.filter(attempt => attempt.status === 'in_progress'
    && (!Number.isFinite(serverNow) || !Number.isFinite(Date.parse(attempt.expires_at)) || Date.parse(attempt.expires_at) > serverNow)).length
}
