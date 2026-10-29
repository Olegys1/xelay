import { supabase } from './supabase'

export type GroupStudyLevel = 'bachelor' | 'master' | 'postgraduate'
export type GroupCourseStatus = { groupId: string; academicYear: number; cohortStartYear: number | null; level: GroupStudyLevel | null; course: number | null; archived: boolean; outsideCurrentPeriod: boolean; confirmed: boolean; needsConfirmation: boolean }
export type GroupCourseChoice = { course: number; level: GroupStudyLevel; academicYear: number }
export type GroupIdentityReview = { id: string; status: 'pending' | 'resolved' | 'closed'; requestId: string | null; groupId: string | null; course: number; academicYear: number; level: GroupStudyLevel; resolutionReason: string | null; createdAt: string }
export type GroupIdentityReviewAdmin = GroupIdentityReview & { kind: 'creation' | 'group'; groupName: string; specialty: string; unit: string; university: string; message: string; applicant: { id: string | null; name: string; username: string }; collisionGroups: { id: string; name: string; representative: string; cohort: number | null; level: GroupStudyLevel | null; unchanged: boolean }[] }
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const level = (value: unknown): value is GroupStudyLevel => typeof value === 'string' && ['bachelor', 'master', 'postgraduate'].includes(value)
const integer = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && Number(value) >= min && Number(value) <= max
const safeId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value)
const unavailable = () => new Error('Не вдалося перевірити дані групи. Оновіть сторінку й спробуйте ще раз.')
const uncertain = () => new Error('Не вдалося перевірити результат. Оновіть групу або повторіть цю саму дію.')
const text = (value: unknown, max = 240) => { if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw unavailable(); return value }
const maybeId = (value: unknown) => { if (value !== null && !safeId(value)) throw unavailable(); return value as string | null }
const reviewStatus = (value: unknown): value is GroupIdentityReview['status'] => typeof value === 'string' && ['pending', 'resolved', 'closed'].includes(value)
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 64) return false
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!parts || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59 || !Number.isFinite(Date.parse(value))) return false
  const date = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])))
  return date.getUTCFullYear() === Number(parts[1]) && date.getUTCMonth() === Number(parts[2]) - 1 && date.getUTCDate() === Number(parts[3])
}
const nullableText = (value: unknown, max = 240) => value === null ? '' : text(value, max)
const sessionActor = (value: unknown): string | null => object(value) && !value.error && object(value.data) && object(value.data.session)
  && object(value.data.session.user) && safeId(value.data.session.user.id) ? value.data.session.user.id : null
export function groupCourseError(failure: unknown): Error {
  const code = object(failure) && typeof failure.code === 'string' ? failure.code.slice(0, 32) : ''
  const message = object(failure) && typeof failure.message === 'string' ? failure.message.slice(0, 4096) : ''
  if (/GROUP_IDENTITY_NEEDS_REVIEW|GROUP_ALREADY_EXISTS|GROUP_COURSE_IDENTITY_MISMATCH|GROUP_COURSE_APPROVAL_MISMATCH/.test(message) || code === '23505') return new Error('Дані збігаються з іншою групою або відрізняються від підтвердженого набору. Передайте їх адміністратору на перевірку.')
  if (/GROUP_REVIEW_SELF_REVIEW/.test(message)) return new Error('Цю власну заявку має перевірити інший адміністратор.')
  if (/ADMIN_MFA_REQUIRED/.test(message)) return new Error('Підтвердьте двоетапний вхід адміністратора, потім повторіть дію.')
  if (/GROUP_REVIEW_STALE|GROUP_REVIEW_ALREADY_BOUND/.test(message)) return new Error('Група або заявка вже змінилася. Оновіть список перед рішенням.')
  if (/REQUEST_REUSED|IDEMPOTENCY/.test(message)) return new Error('Цю спробу вже використано для інших даних. Оновіть сторінку перед новою дією.')
  if (/CONFIRMATION_REQUIRED/.test(message)) return new Error('Старості потрібно підтвердити курс у своїй групі перед новим підключенням викладача.')
  if (/NOT_OWNER|FORBIDDEN|AUTH_REQUIRED|STUDY_GROUP_REQUEST_TRANSFERRED/.test(message) || code === '42501') return new Error('Немає чинного доступу до цієї дії. Оновіть групу або увійдіть знову.')
  if (/GROUP_REVIEW_PENDING/.test(message)) return new Error('Звернення вже очікує на перевірку адміністратора.')
  if (/GROUP_REVIEW_CAPACITY/.test(message)) return new Error('Зараз надто багато звернень. Спробуйте пізніше.')
  if (/INVALID_INPUT|GROUP_COURSE_REQUIRED|GROUP_COHORT_REQUIRED/.test(message) || code === '22023') return new Error('Перевірте курс, рівень навчання й поточний навчальний рік. Після зміни року потрібно оновити форму.')
  if (code === 'PGRST202' || code === '42883') return new Error('Уточнення курсу ще підключається. Спробуйте після оновлення платформи.')
  return unavailable()
}
export function groupCourseNeedsReview(failure: unknown): boolean { return /збігаються з іншою групою|відрізняються від підтвердженого набору/.test(failure instanceof Error ? failure.message : '') }
async function rpc(actor: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (!safeId(actor)) throw unavailable()
  const controller = new AbortController(), abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
  const timer = window.setTimeout(abort, 20_000)
  let subscription: { unsubscribe(): void } | undefined
  let rejectAbort: (() => void) | undefined
  const check = () => { if (controller.signal.aborted) throw uncertain() }
  try {
    try { subscription = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || session && (!object(session) || !object(session.user) || session.user.id !== actor)) abort()
    }).data.subscription } catch { throw uncertain() }
    check()
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = () => reject(uncertain()); controller.signal.addEventListener('abort', rejectAbort, { once: true }) })
    return await Promise.race([interrupted, (async () => {
      let before
      try { before = await supabase.auth.getSession() } catch { throw uncertain() }
      check(); if (sessionActor(before) !== actor) throw unavailable()
      let response
      try { response = await supabase.rpc(name, args).abortSignal(controller.signal) } catch { throw uncertain() }
      check()
      let after
      try { after = await supabase.auth.getSession() } catch { throw uncertain() }
      check(); if (sessionActor(after) !== actor) throw unavailable()
      if (!object(response)) throw uncertain()
      if (response.error) throw groupCourseError(response.error)
      return response.data
    })()])
  } finally { window.clearTimeout(timer); signal?.removeEventListener('abort', abort); if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort); try { subscription?.unsubscribe() } catch { /* Cleanup must not disclose SDK details or override an already settled result. */ } }
}
export function parseGroupCourseStatus(value: unknown, groupId: string): GroupCourseStatus {
  if (!safeId(groupId) || !object(value) || value.group_id !== groupId || !integer(value.academic_year, 1900, 2199)
    || !(value.cohort_start_year === null || integer(value.cohort_start_year, 1900, 2200)) || !(value.study_level === null || level(value.study_level))
    || !(value.current_course === null || integer(value.current_course, 1, 6)) || ['archived', 'outside_current_period', 'confirmed', 'needs_confirmation'].some(key => typeof value[key] !== 'boolean')) throw unavailable()
  const calculated = value.cohort_start_year === null ? null : Number(value.academic_year) - Number(value.cohort_start_year) + 1
  const outside = calculated !== null && (calculated < 1 || calculated > 6)
  if ((value.cohort_start_year === null) !== (value.study_level === null) || value.confirmed && value.cohort_start_year === null
    || value.archived !== outside || value.outside_current_period !== outside || value.needs_confirmation !== (!outside && !value.confirmed)
    || value.current_course !== (calculated === null || outside ? null : calculated)) throw unavailable()
  return { groupId, academicYear: value.academic_year, cohortStartYear: value.cohort_start_year as number | null, level: value.study_level as GroupStudyLevel | null,
    course: value.current_course as number | null, archived: value.archived as boolean, outsideCurrentPeriod: value.outside_current_period as boolean,
    confirmed: value.confirmed as boolean, needsConfirmation: value.needs_confirmation as boolean }
}
function choiceArgs(choice: GroupCourseChoice) {
  if (!object(choice) || !integer(choice.course, 1, 6) || !level(choice.level) || !integer(choice.academicYear, 1900, 2199)
    || !integer(choice.academicYear - choice.course + 1, 1900, 2200)) throw unavailable()
  return { p_course: choice.course, p_study_level: choice.level, p_academic_year: choice.academicYear }
}
export async function loadGroupCourse(actor: string, groupId: string, signal?: AbortSignal) {
  if (!safeId(groupId)) throw unavailable()
  return parseGroupCourseStatus(await rpc(actor, 'xelay_study_group_course_status', { p_group_id: groupId }, signal), groupId)
}
export async function confirmGroupCourse(actor: string, groupId: string, choice: GroupCourseChoice, requestId: string, signal?: AbortSignal) {
  if (!safeId(groupId) || !safeId(requestId)) throw unavailable()
  const value = await rpc(actor, 'xelay_confirm_study_group_course', { p_group_id: groupId, ...choiceArgs(choice), p_request_id: requestId }, signal)
  if (!object(value) || value.group_id !== groupId || value.course !== choice.course || value.study_level !== choice.level || value.academic_year !== choice.academicYear
    || value.cohort_start_year !== choice.academicYear - choice.course + 1 || typeof value.replayed !== 'boolean' || !timestamp(value.confirmed_at)) throw uncertain()
  return { groupId, ...choice, cohortStartYear: Number(value.cohort_start_year), replayed: value.replayed }
}
export async function createStudyGroupWithCourse(actor: string, applicationId: string, choice: GroupCourseChoice, requestId: string, signal?: AbortSignal): Promise<string> {
  if (!safeId(applicationId) || !safeId(requestId)) throw unavailable()
  const result = await rpc(actor, 'xelay_create_study_group_with_course', { p_request_id: applicationId, ...choiceArgs(choice), p_request_idempotency: requestId }, signal)
  if (!safeId(result)) throw uncertain()
  return result
}
export async function requestGroupIdentityReview(actor: string, scope: { applicationId?: string; groupId?: string }, choice: GroupCourseChoice, message: string, commandId: string, signal?: AbortSignal) {
  if (!object(scope) || Boolean(scope.applicationId) === Boolean(scope.groupId) || !safeId(scope.applicationId || scope.groupId)
    || scope.applicationId !== undefined && !safeId(scope.applicationId) || scope.groupId !== undefined && !safeId(scope.groupId) || !safeId(commandId)) throw unavailable()
  const normalizedMessage = text(message, 1000).trim()
  const result = await rpc(actor, 'xelay_request_study_group_identity_review', { p_request_id: scope.applicationId || null, p_group_id: scope.groupId || null,
    ...choiceArgs(choice), p_message: normalizedMessage, p_command_id: commandId }, signal)
  if (!object(result) || !safeId(result.id) || !reviewStatus(result.status) || typeof result.reused !== 'boolean'
    || !result.reused && (result.id !== commandId || result.status !== 'pending')) throw uncertain()
  return { id: result.id, reused: result.reused, status: result.status }
}
function parseReview(row: unknown): GroupIdentityReview {
  if (!object(row) || !safeId(row.id) || !reviewStatus(row.status) || !integer(row.course, 1, 6) || !integer(row.academic_year, 1900, 2199) || !level(row.study_level)
    || !integer(row.cohort_start_year, 1900, 2200) || row.cohort_start_year !== row.academic_year - row.course + 1 || !timestamp(row.created_at)) throw unavailable()
  const requestId = maybeId(row.request_id), groupId = maybeId(row.group_id)
  const resolutionReason = row.resolution_reason === null ? null : text(row.resolution_reason, 1000)
  if ((requestId === null) === (groupId === null) || row.status === 'pending' && resolutionReason !== null
    || row.status !== 'pending' && (!resolutionReason || resolutionReason.trim().length < 10)) throw unavailable()
  return { id: row.id, status: row.status, requestId, groupId,
    course: row.course, academicYear: row.academic_year, level: row.study_level, resolutionReason, createdAt: row.created_at }
}
export async function loadOwnGroupIdentityReviews(actor: string, signal?: AbortSignal): Promise<GroupIdentityReview[]> {
  const result = await rpc(actor, 'xelay_my_study_group_identity_reviews', {}, signal)
  if (!Array.isArray(result) || result.length > 20) throw unavailable()
  const rows = result.map(parseReview); if (new Set(rows.map(row => row.id)).size !== rows.length) throw unavailable(); return rows
}
export async function loadAdminGroupIdentityReviews(actor: string, status = 'pending', offset = 0, signal?: AbortSignal): Promise<{ total: number; items: GroupIdentityReviewAdmin[] }> {
  if (!['pending', 'resolved', 'closed', 'all'].includes(status) || !integer(offset, 0, 100000)) throw unavailable()
  const result = await rpc(actor, 'xelay_admin_study_group_identity_reviews', { p_status: status, p_limit: 20, p_offset: offset }, signal)
  if (!object(result) || !integer(result.total, 0, 1000000) || !Array.isArray(result.items) || result.items.length > 20 || result.total < result.items.length) throw unavailable()
  const items = result.items.map(row => {
    const base = parseReview(row)
    if (!object(row) || !object(row.applicant) || !(row.applicant.id === null || safeId(row.applicant.id)) || typeof row.kind !== 'string' || !['creation', 'group'].includes(row.kind)
      || row.kind === 'creation' && base.requestId === null || row.kind === 'group' && base.groupId === null
      || row.applicant.id === null && (row.applicant.full_name !== null || row.applicant.username !== null)
      || !Array.isArray(row.collision_groups) || row.collision_groups.length > 200
      || new Set(row.collision_groups.map(value => object(value) ? value.id : null)).size !== row.collision_groups.length) throw unavailable()
    return { ...base, kind: row.kind as GroupIdentityReviewAdmin['kind'], groupName: text(row.group_name), specialty: text(row.specialty), unit: text(row.academic_unit_name), university: text(row.university_name), message: text(row.message, 1000),
      applicant: { id: row.applicant.id as string | null, name: nullableText(row.applicant.full_name), username: nullableText(row.applicant.username) },
      collisionGroups: row.collision_groups.map(value => {
        if (!object(value) || !safeId(value.id) || !(value.cohort_start_year === null || integer(value.cohort_start_year, 1900, 2200)) || !(value.study_level === null || level(value.study_level))
          || (value.cohort_start_year === null) !== (value.study_level === null) || !(value.snapshot_unchanged === null || typeof value.snapshot_unchanged === 'boolean')) throw unavailable()
        return { id: value.id, name: text(value.group_name), representative: nullableText(value.representative_name), cohort: value.cohort_start_year as number | null, level: value.study_level as GroupStudyLevel | null, unchanged: value.snapshot_unchanged === true }
      }) }
  })
  if (new Set(items.map(item => item.id)).size !== items.length) throw unavailable()
  return { total: result.total, items }
}
export async function resolveGroupIdentityReview(actor: string, reviewId: string, action: 'close' | 'confirm_identity' | 'distinct', reason: string, groupId: string | null, choice: GroupCourseChoice | null, signal?: AbortSignal) {
  const normalizedReason = text(reason, 1000).trim()
  if (!safeId(reviewId) || !['close', 'confirm_identity', 'distinct'].includes(action) || normalizedReason.length < 10 || groupId !== null && !safeId(groupId)) throw unavailable()
  if (action !== 'close' && (!choice || !groupId)) throw unavailable()
  if (choice) choiceArgs(choice)
  const result = await rpc(actor, 'xelay_admin_resolve_study_group_identity_review', { p_review_id: reviewId, p_action: action, p_reason: normalizedReason, p_existing_group_id: groupId,
    p_course: choice?.course ?? null, p_study_level: choice?.level ?? null, p_academic_year: choice?.academicYear ?? null }, signal)
  if (!object(result) || result.id !== reviewId || result.action !== action || result.status !== (action === 'close' ? 'closed' : 'resolved')
    || result.group_id !== null && !safeId(result.group_id) || action !== 'close' && result.group_id !== groupId) throw uncertain()
  return { id: reviewId, status: result.status, groupId: result.group_id as string | null }
}
