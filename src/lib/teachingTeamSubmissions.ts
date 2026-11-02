import type { TeachingSubmission, TeachingSubmissionData } from './teaching'

/** The server is authoritative; this check also drops a stale team's response on account changes. */
export function ownTeachingSubmission(data: TeachingSubmissionData | null, userId: string): TeachingSubmission | null {
  const submission = data?.my_submission
  if (!submission || !userId) return null
  if (submission.team_id) {
    const team = data?.my_team
    return team && team.id === submission.team_id && team.members.some(member => member.user_id === userId) ? submission : null
  }
  return submission.user_id === userId ? submission : null
}

export function teachingTeamGradePreview(submission: TeachingSubmission, maximum: number, score: number | null) {
  if (!submission.team_id || !Number.isFinite(maximum) || maximum <= 0 || score === null || !Number.isFinite(score) || score < 0 || score > maximum) throw new Error('Перевірте бал і максимальну кількість балів.')
  const members = submission.team_members || []
  if (!members.length || members.some(member => !member.entry_id || !Number.isSafeInteger(member.grade_version) || member.grade_version! < 0)) throw new Error('Для всіх учасників команди потрібні підтверджені записи журналу. Оновіть роботу або відкрийте журнал.')
  const entryIds = members.map(member => member.entry_id!)
  if (new Set(entryIds).size !== members.length || new Set(members.map(member => member.user_id)).size !== members.length) throw new Error('Склад команди змінився. Оновіть роботу.')
  return members.map(member => ({ ...member, score }))
}

export function teachingTeamGradePayload(submission: TeachingSubmission, maximum: number, score: number | null, feedback: string, reason: string, confirmed: boolean, expectedUserId: string) {
  if (!confirmed) throw new Error('Підтвердьте виставлення балів усій команді.')
  if (!expectedUserId) throw new Error('Акаунт викладача змінився. Відкрийте роботу повторно.')
  const rows = teachingTeamGradePreview(submission, maximum, score)
  if (rows.some(member => member.published_at || member.published_score !== undefined && member.published_score !== null) && reason.trim().length < 2) throw new Error('Додайте причину зміни вже опублікованих балів.')
  return { id: submission.id, version: submission.version, expected_user_id: expectedUserId, score, feedback: feedback.trim(), reason: reason.trim(), publish: true, confirm_team: true, grade_versions: Object.fromEntries(rows.map(member => [member.entry_id!, member.grade_version!])) }
}
