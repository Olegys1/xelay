import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { User, Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { XelayUser } from '../types'
import { currentAcademicYear, isActiveStudentStatus } from '../lib/studyYearProgression'
import { loadTeacherVerification } from '../lib/teacherVerification'
import { googleAuthEnabled, googleRegistrationRequired as loadGoogleRegistrationRequired } from '../lib/authGoogle'
import { clearOfflineStudy, establishOfflineOwner, getOfflineOwner, removeOfflineTeacherCalendar } from '../lib/offlineStudy'
import { clearPendingTeacherAcademicProfile, consumePendingTeacherAcademicProfile } from '../lib/teacherAcademicProfile'
import { isRepresentativeStatusMissing, parseRepresentativeStatus } from '../lib/studyGroupRepresentativeTransfer'
import { composeProfileName, profileNameParts } from '../lib/profileNames'
import { clearAllTeachingTestPractice, purgeLegacyTeachingTestPractice } from '../lib/teachingTestPractice'
import { clearTeachingTestAnswerOutbox } from '../lib/teachingTestAnswerOutbox'
import { AUTH_SESSION_TIMEOUT_MS, createAuthProfileFlight, createAuthReadScope } from '../lib/authBootstrap'
import { createAccountBootstrapReader } from '../lib/authAccountBootstrap'

export type GoogleRegistrationStatus = 'checking' | 'required' | 'ready' | 'error'
export interface ProfileRefreshOptions { representativeStatusChanged?: boolean }

interface AuthState {
  authUser: User | null
  xelayUser: XelayUser | null
  authReadEpoch: number
  authReadBlocked: boolean
  isLoading: boolean
  sessionUnavailable: boolean
  isAuthenticated: boolean
  isPasswordRecovery: boolean
  googleRegistrationStatus: GoogleRegistrationStatus
  clearPasswordRecovery: () => void
  markPasswordRecovery: (session: Session) => void
  refreshUser: (options?: ProfileRefreshOptions) => Promise<void>
  signOut: () => Promise<void>
}

const RECOVERY_KEY = 'xelay_password_recovery'
const RECOVERY_TTL = 20 * 60 * 1000
const PRACTICE_AUTH_KEY = 'xelay:teacher-practice:auth:v1'
type PracticeAuthIdentity = { userId: string; sessionId: string | null }

function savedPracticeAuthIdentity(): PracticeAuthIdentity | null {
  try {
    const identity = JSON.parse(sessionStorage.getItem(PRACTICE_AUTH_KEY) || 'null')
    return typeof identity?.userId === 'string' && identity.userId.length > 0 && identity.userId.length <= 200
      && (identity.sessionId === null || typeof identity.sessionId === 'string' && identity.sessionId.length > 0 && identity.sessionId.length <= 200)
      ? { userId: identity.userId, sessionId: identity.sessionId } : null
  } catch { return null }
}

function sessionIdentity(token: string | undefined): string | null {
  try {
    const payload = token?.split('.')[1]
    if (!payload) return null
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof claims.session_id === 'string' ? claims.session_id : null
  } catch { return null }
}

function recoveryDeadlineFor(userId: string, sessionId: string | null): number {
  try {
    const marker = JSON.parse(sessionStorage.getItem(RECOVERY_KEY) || 'null')
    const valid = Boolean(sessionId) && marker?.userId === userId && marker.sessionId === sessionId && typeof marker.startedAt === 'number'
      && Date.now() >= marker.startedAt && Date.now() - marker.startedAt < RECOVERY_TTL
    return valid ? marker.startedAt + RECOVERY_TTL : 0
  } catch { return 0 }
}

function transientProfileFailure(error: unknown, status?: number): boolean {
  const value = error && typeof error === 'object'
    ? error as { code?: string; name?: string; message?: string; status?: number; originalError?: unknown }
    : null
  const responseStatus = status ?? value?.status
  const code = String(value?.code || '')
  // A completed denial is authoritative. A stale profile must never hide an
  // expired/invalid identity, a permission failure or a missing profile/table.
  if ([401, 403, 404].includes(responseStatus || 0)
    || ['42501', '28000', '28P01', 'PGRST301', 'PGRST302', 'PGRST303'].includes(code)) return false
  if (responseStatus === 0 || responseStatus === 408 || responseStatus === 429
    || typeof responseStatus === 'number' && responseStatus >= 500 && responseStatus <= 599) return true
  if (typeof responseStatus === 'number' && responseStatus > 0) return false
  const browser = ['AuthUnknownError', 'GoogleRegistrationStatusError'].includes(value?.name || '') && value?.originalError && typeof value.originalError === 'object'
    ? value.originalError as { name?: string; message?: string } : value
  if (['AbortError', 'TimeoutError', 'AuthRetryableFetchError'].includes(browser?.name || '')) return true
  return code === 'request_timeout' || /^(?:TypeError:\s*)?(?:failed to fetch|fetch failed|load failed|network request failed|networkerror(?: when attempting to fetch resource\.)?)$/i.test(browser?.message?.trim() || '')
}

async function profileLookup<T>(query: PromiseLike<T>): Promise<T | { data: null; error: unknown; status?: number }> {
  try { return await query } catch (error) { return { data: null, error } }
}

const AuthContext = createContext<AuthState>({
  authUser: null, xelayUser: null, isLoading: true, isAuthenticated: false,
  authReadEpoch: 0, authReadBlocked: true,
  sessionUnavailable: false,
  isPasswordRecovery: false, clearPasswordRecovery: () => {}, markPasswordRecovery: () => {},
  googleRegistrationStatus: 'ready',
  refreshUser: async () => {}, signOut: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [xelayUser, setXelayUser] = useState<XelayUser | null>(null)
  const [authReadEpoch, setAuthReadEpoch] = useState(0)
  const [authReadBlocked, setAuthReadBlocked] = useState(true)
  const authReadFence = useRef<'initial' | 'logout' | 'denied' | null>('initial')
  const [isLoading, setIsLoading] = useState(true)
  const [sessionUnavailable, setSessionUnavailable] = useState(false)
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false)
  const [googleRegistration, setGoogleRegistration] = useState<{ userId: string | null; status: GoogleRegistrationStatus }>({ userId: null, status: 'ready' })
  const [recoveryDeadline, setRecoveryDeadline] = useState(0)
  const userIdRef = useRef<string | null>(null)
  const profileRequest = useRef(0)
  const authGeneration = useRef(0)
  const mounted = useRef(false)
  const profileFlight = useRef(createAuthProfileFlight())
  const accountBootstrap = useRef(createAccountBootstrapReader(supabase))
  const practiceAuthIdentity = useRef<PracticeAuthIdentity | null | undefined>(undefined)
  // A memory-only receipt of a successful registration-status read. It is
  // valid only inside the same verified user/session boundary, never a grant.
  const googleRegistrationReceipt = useRef<PracticeAuthIdentity | null>(null)
  // Schema availability belongs to this project, not an account's authority.
  // Once observed, a later cache miss must not revive historical approvals.
  const representativeStatusSchemaKnown = useRef(false)

  // Consumers may combine in-flight reads only inside one verified identity
  // boundary. This is a local generation, never a credential or cached grant.
  const setReadFence = useCallback((reason: 'initial' | 'logout' | 'denied' | null) => {
    authReadFence.current = reason
    if (reason !== null) googleRegistrationReceipt.current = null
    setAuthReadBlocked(reason !== null)
  }, [])
  const rejectPrivateReads = useCallback(() => {
    setAuthReadEpoch(value => value + 1)
    setReadFence('denied')
  }, [setReadFence])

  const reconcilePracticeAuth = useCallback((session: Session | null, explicitLogout = false) => {
    purgeLegacyTeachingTestPractice()
    const next = session?.user?.id ? { userId: session.user.id, sessionId: sessionIdentity(session.access_token) } : null
    const previous = practiceAuthIdentity.current === undefined ? savedPracticeAuthIdentity() : practiceAuthIdentity.current
    const receipt = googleRegistrationReceipt.current
    if (explicitLogout || !next?.sessionId || receipt && (receipt.userId !== next.userId || receipt.sessionId !== next.sessionId)) googleRegistrationReceipt.current = null
    // An interrupted identity refresh is not a logout. Keep unsent answers
    // until the same owner can be verified again; never carry them into a
    // confirmed different account or newly established session.
    if (explicitLogout || previous && next && (previous.userId !== next.userId
      || previous.sessionId && next.sessionId && previous.sessionId !== next.sessionId)) clearTeachingTestAnswerOutbox()
    // This marker is not a credential or an authorization receipt. It only
    // preserves harmless progress across a same-session reload. A real session
    // boundary invalidates old in-memory repositories before asynchronous Auth.
    if (explicitLogout || !next?.sessionId || !previous?.sessionId
      || next.userId !== previous.userId || next.sessionId !== previous.sessionId) clearAllTeachingTestPractice()
    if (explicitLogout || !next?.sessionId || !previous?.sessionId
      || next.userId !== previous.userId || next.sessionId !== previous.sessionId) setAuthReadEpoch(value => value + 1)
    practiceAuthIdentity.current = next
    try {
      if (next) sessionStorage.setItem(PRACTICE_AUTH_KEY, JSON.stringify(next))
      else sessionStorage.removeItem(PRACTICE_AUTH_KEY)
    } catch { /* Disabled storage cannot retain a practice authorization marker. */ }
  }, [])

  const clearPasswordRecovery = useCallback(() => {
    try { sessionStorage.removeItem(RECOVERY_KEY) } catch { /* Storage can be disabled. */ }
    setIsPasswordRecovery(false)
    setRecoveryDeadline(0)
  }, [])

  // This is a UI flow marker; server-side password policy remains enforced by Auth.
  const markPasswordRecovery = useCallback((session: Session) => {
    const startedAt = Date.now()
    try { sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ userId: session.user.id, sessionId: sessionIdentity(session.access_token), startedAt })) } catch { /* Optional refresh persistence. */ }
    setRecoveryDeadline(startedAt + RECOVERY_TTL)
    setIsPasswordRecovery(true)
  }, [])

  const fetchProfile = useCallback((userId: string) => profileFlight.current.run(userId, async (reads) => {
    const request = ++profileRequest.current
    const current = () => mounted.current && request === profileRequest.current && userIdRef.current === userId
    try {
      if (googleAuthEnabled) {
        const identity = practiceAuthIdentity.current
        try {
          const required = await reads.read(signal => loadGoogleRegistrationRequired(signal))
          if (!current()) return
          googleRegistrationReceipt.current = !required && identity?.userId === userId && identity.sessionId
            ? { userId, sessionId: identity.sessionId } : null
          setGoogleRegistration({ userId, status: required ? 'required' : 'ready' })
          if (required) { rejectPrivateReads(); setXelayUser(null); return }
        } catch (error) {
          if (!current()) return
          const receipt = googleRegistrationReceipt.current, active = practiceAuthIdentity.current
          // A brief outage must not unmount an already verified, active test.
          // First registration, a changed session, denial and malformed data
          // still fail closed; no stored profile or editable metadata proves it.
          if (transientProfileFailure(error) && authReadFence.current === null
            && identity?.sessionId && active?.userId === userId && active.sessionId === identity.sessionId
            && receipt?.userId === userId && receipt.sessionId === identity.sessionId) return
          // A failed status lookup must not expose platform functions before
          // the first Google registration and explicit consent are complete.
          rejectPrivateReads()
          setGoogleRegistration({ userId, status: 'error' })
          setXelayUser(null)
          return
        }
      }
      const bundle = await accountBootstrap.current(userId, reads)
      const result = bundle?.profile ?? await reads.read(signal => supabase.from('profiles').select('*').eq('id', userId).abortSignal(signal).maybeSingle())
      let row = result.data
      const error = result.error
      if (error || !row) {
        if (current()) {
          if (!error || !transientProfileFailure(error, result.status)) rejectPrivateReads()
          setXelayUser((previous) => error && transientProfileFailure(error, result.status)
            && previous?.id === userId ? previous : null)
        }
        return
      }
      if (row.study_year_auto_advance === true && row.study_year
        && isActiveStudentStatus(row.experience || '')
        && typeof row.study_year_academic_year === 'number'
        && row.study_year_academic_year < currentAcademicYear()) {
        // The database clock decides the course; the browser only requests catch-up.
        // A failed catch-up must not block signing in or password recovery.
        try {
          const { error: progressionError } = await reads.read(signal => supabase.rpc('xelay_refresh_my_study_year').abortSignal(signal))
          if (!progressionError && current()) {
            const refreshed = await reads.read(signal => supabase.from('profiles').select('*').eq('id', userId).abortSignal(signal).maybeSingle())
            if (!refreshed.error && refreshed.data) row = refreshed.data
          } else if (progressionError) console.warn('[Xelay] Course refresh unavailable:', progressionError.code)
        } catch { console.warn('[Xelay] Course refresh connection unavailable') }
      }
      if (!current()) return
      const [rolesResult, representativeResult, membershipsResult, teacherResult, rawRepresentativeStatusResult] = bundle
        ? [bundle.roles, bundle.representative_requests, bundle.memberships, bundle.teacher, bundle.representative_status]
        : await Promise.all([
        profileLookup(reads.read(signal => supabase.from('user_roles').select('role, university_id, academic_unit_id').eq('user_id', userId).abortSignal(signal))),
        profileLookup(reads.read(signal => supabase.from('class_representative_requests').select('id, status').eq('user_id', userId)
          .in('status', ['pending', 'approved']).order('created_at', { ascending: false }).abortSignal(signal))),
        profileLookup(reads.read(signal => supabase.from('study_group_members').select('group_id, status').eq('user_id', userId).in('status', ['pending', 'accepted']).abortSignal(signal))),
        // Missing teaching services must not prevent ordinary account access.
        reads.read(signal => loadTeacherVerification(signal)).then((data) => ({ data, error: null as unknown }))
          .catch((error: unknown) => ({ data: null, error })),
        profileLookup(reads.read(signal => supabase.rpc('xelay_my_study_group_representative_status').abortSignal(signal))),
      ])
      const representativeStatusResult = (() => {
        if (rawRepresentativeStatusResult.error) return { ...rawRepresentativeStatusResult, data: null }
        try { return { ...rawRepresentativeStatusResult, data: parseRepresentativeStatus(rawRepresentativeStatusResult.data) } }
        catch { return { data: null, error: { code: 'REPRESENTATIVE_STATUS_INVALID' }, status: rawRepresentativeStatusResult.status } }
      })()
      if (!current() || !row) return
      if (representativeStatusResult.data) representativeStatusSchemaKnown.current = true
      const representativeStatusMissing = isRepresentativeStatusMissing(representativeStatusResult.error)
      const legacyRepresentativeStatus = representativeStatusMissing && !representativeStatusSchemaKnown.current
      const relatedResults: Array<{ error: unknown; status?: number }> = [rolesResult, representativeResult, membershipsResult, teacherResult,
        ...(legacyRepresentativeStatus ? [] : [representativeStatusResult])]
      if (relatedResults.some((result) => result.error && ((result.status ?? (result.error as { status?: number }).status) === 401
        || ['28000', '28P01', 'PGRST301', 'PGRST302', 'PGRST303'].includes(String((result.error as { code?: string }).code || ''))))) {
        rejectPrivateReads()
        setXelayUser(null)
        return
      }
      const relatedTransient = relatedResults.some((result) => result.error
        && transientProfileFailure(result.error, result.status))
      const relatedAuthoritative = relatedResults.some((result) => result.error
        && !transientProfileFailure(result.error, result.status))
      const teacherStatus = teacherResult.data
      if (teacherStatus && (teacherStatus.verified === false || teacherStatus.has_current_access === false)) {
        void getOfflineOwner().then(owner => {
          if (current() && owner?.id === userId) return removeOfflineTeacherCalendar(userId, owner.sessionId)
        }).catch(() => {})
      }
      const roles = rolesResult.data || []
      const representativeRequests = representativeResult.data || []
      const representativeStatus = representativeStatusResult.data
      const approved = representativeRequests.find((item) => item.status === 'approved'
        && (legacyRepresentativeStatus || representativeStatus?.availableRequestIds.includes(item.id)))
      const pendingRequest = representativeRequests.find((item) => item.status === 'pending')
      const nameParts = profileNameParts(row)
      const profile: XelayUser = {
        id: row.id, userId: row.id, name: nameParts.hasStructuredName ? composeProfileName(nameParts.lastName, nameParts.firstName) : row.full_name || row.name || 'Анонім',
        firstName: nameParts.firstName, lastName: nameParts.lastName,
        email: row.email || '', username: row.username || '', country: row.country || '',
        city: row.city || '', experience: row.experience || '', categories: row.categories || [],
        faculty: row.faculty || '', universityId: row.university_id || null, academicUnitId: row.academic_unit_id || null,
        isPlatformAdmin: roles.some((role) => role.role === 'ADMIN'),
        accountType: row.account_type === 'teacher' ? 'teacher' : 'student',
        isTeacher: teacherStatus?.verified === true,
        teacherVerificationStatus: teacherStatus?.status || 'none',
        teacherDepartment: teacherStatus?.academic_profile?.department || teacherStatus?.request?.department || '',
        teacherPosition: teacherStatus?.request?.position || '',
        editorUnitIds: roles.filter((role) => role.role === 'FACULTY_EDITOR').map((role) => role.academic_unit_id),
        editorUniversityIds: roles.filter((role) => role.role === 'UNIVERSITY_EDITOR').map((role) => role.university_id),
        isPlatformNewsEditor: roles.some((role) => role.role === 'PLATFORM_EDITOR' && role.university_id === null && role.academic_unit_id === null),
        isClassRepresentative: representativeStatus?.isRepresentative || (legacyRepresentativeStatus && Boolean(approved)),
        classRepresentativeRequestId: approved?.id || pendingRequest?.id,
        studyGroupRepresentativeStatus: representativeStatus || undefined,
        studyGroupRepresentativeStatusSource: representativeStatus ? 'current' : legacyRepresentativeStatus ? 'legacy' : 'unavailable',
        studyGroupIds: [...new Set([...(membershipsResult.data || []).map((item) => item.group_id), ...(representativeStatus?.ownedGroupIds || [])])],
        specialty: row.specialty || '', specialtyId: row.specialty_id || null, studyYear: row.study_year ?? null, skills: row.skills || [],
        studyYearAutoAdvance: typeof row.study_year_auto_advance === 'boolean' ? row.study_year_auto_advance : undefined,
        studyYearAcademicYear: row.study_year_academic_year ?? null,
        studyProgramYears: row.study_program_years ?? null,
        studyYearNeedsReview: row.study_year_needs_review === true,
        helpWith: row.help_with || [], wantToLearn: row.want_to_learn || [], avatarUrl: row.avatar_url || '',
        has_seen_onboarding: row.has_seen_onboarding ?? false, bio: row.bio || '',
        createdAt: row.created_at || new Date().toISOString(),
      }
      // A fresh successful server read may recover a previous denial. A late
      // callback must never reopen readers during an explicit logout instead.
      if (authReadFence.current === 'denied' && !relatedTransient && !relatedAuthoritative) setReadFence(null)
      // Reuse only fields whose own lookup failed transiently. Successful role
      // revocations and fresh profile data must win over an unrelated outage.
      // On first load, missing permissions remain absent.
      setXelayUser((previous) => {
        if (!relatedTransient || relatedAuthoritative || previous?.id !== userId) return profile
        return {
          ...profile,
          ...(rolesResult.error && transientProfileFailure(rolesResult.error, rolesResult.status) ? {
            isPlatformAdmin: previous.isPlatformAdmin,
            editorUnitIds: previous.editorUnitIds,
            editorUniversityIds: previous.editorUniversityIds,
            isPlatformNewsEditor: previous.isPlatformNewsEditor,
          } : {}),
          ...((representativeStatusResult.error && !representativeStatusMissing
            && transientProfileFailure(representativeStatusResult.error, representativeStatusResult.status)
            || legacyRepresentativeStatus && representativeResult.error
              && transientProfileFailure(representativeResult.error, representativeResult.status)) ? {
            isClassRepresentative: previous.isClassRepresentative,
            classRepresentativeRequestId: previous.classRepresentativeRequestId,
            studyGroupRepresentativeStatus: previous.studyGroupRepresentativeStatus,
            studyGroupRepresentativeStatusSource: previous.studyGroupRepresentativeStatusSource,
          } : {}),
          ...(membershipsResult.error && transientProfileFailure(membershipsResult.error, membershipsResult.status) ? {
            studyGroupIds: previous.studyGroupIds,
          } : {}),
          ...(teacherResult.error && transientProfileFailure(teacherResult.error) ? {
            isTeacher: previous.isTeacher,
            teacherVerificationStatus: previous.teacherVerificationStatus,
            teacherDepartment: previous.teacherDepartment,
            teacherPosition: previous.teacherPosition,
          } : {}),
        }
      })
    } catch (error) {
      if (current()) {
        if (!transientProfileFailure(error)) rejectPrivateReads()
        setXelayUser((previous) => transientProfileFailure(error) && previous?.id === userId ? previous : null)
      }
    } finally {
      if (current()) setIsLoading(false)
    }
  }), [rejectPrivateReads, setReadFence])

  const refreshUser = useCallback(async (options: ProfileRefreshOptions = {}) => {
    // An action completing after logout may request a profile refresh. It must
    // not adopt the still-cached old session while logout is pending/failed.
    // Only a fresh sign-in event can reopen this explicit boundary.
    if (authReadFence.current === 'logout') return
    if (options.representativeStatusChanged) {
      // A receipt or freshly read group has already proved the role changed.
      // Do not restore its former UI authority from a primary-profile outage.
      profileRequest.current += 1
      profileFlight.current.cancel()
      representativeStatusSchemaKnown.current = true
      setAuthReadEpoch(value => value + 1)
      setXelayUser(previous => previous?.id === userIdRef.current ? { ...previous,
        isClassRepresentative: false, classRepresentativeRequestId: undefined,
        studyGroupRepresentativeStatus: undefined, studyGroupRepresentativeStatusSource: 'unavailable',
      } : previous)
    }
    const request = ++authGeneration.current
    const reads = createAuthReadScope(AUTH_SESSION_TIMEOUT_MS)
    setIsLoading(true)
    setSessionUnavailable(false)
    try {
      const { data: { session }, error } = await reads.read(() => supabase.auth.getSession())
      if (!mounted.current || request !== authGeneration.current) return
      if (error) throw error
      const user = session?.user || null
      const oldSessionId = practiceAuthIdentity.current?.sessionId
      const changedSession = Boolean(oldSessionId) && oldSessionId !== sessionIdentity(session?.access_token)
      reconcilePracticeAuth(session)
      setReadFence(user ? null : 'denied')
      if (user) void establishOfflineOwner(user.id).catch(() => {})
      else void clearOfflineStudy().catch(() => {})
      if (userIdRef.current !== (user?.id || null) || changedSession) {
        profileFlight.current.cancel()
        profileRequest.current += 1
        setXelayUser(null)
        if (googleAuthEnabled) setGoogleRegistration({ userId: user?.id || null, status: user ? 'checking' : 'ready' })
      }
      userIdRef.current = user?.id || null
      setAuthUser(user)
      if (user) await fetchProfile(user.id)
      else { setXelayUser(null); clearPasswordRecovery(); setIsLoading(false) }
    } catch (error) {
      if (mounted.current && request === authGeneration.current) {
        // A failed identity read must never turn a signed-in student into a
        // guest, or retain roles after an authoritative Auth rejection.
        if (!transientProfileFailure(error)) {
          rejectPrivateReads()
          profileFlight.current.cancel()
          profileRequest.current += 1
          userIdRef.current = null
          setAuthUser(null)
          setXelayUser(null)
        }
        setSessionUnavailable(true)
        setIsLoading(false)
      }
    } finally { reads.dispose() }
  }, [fetchProfile, clearPasswordRecovery, reconcilePracticeAuth, rejectPrivateReads, setReadFence])

  const signOut = useCallback(async () => {
    authGeneration.current += 1
    profileFlight.current.cancel()
    profileRequest.current += 1
    setReadFence('logout')
    reconcilePracticeAuth(null, true)
    clearPendingTeacherAcademicProfile()
    // Explicit logout removes downloaded study content even if the server is
    // temporarily unreachable. The offline receipt is never a login session.
    await clearOfflineStudy().catch((error: unknown) => {
      // Do not report a completed logout if neither the durable deny marker
      // nor deletion worked. A pending physical purge is safe once blocked.
      if (error instanceof Error && error.message === 'OFFLINE_CLEAR_NOT_CONFIRMED') throw error
    })
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    userIdRef.current = null
    profileRequest.current += 1
    setAuthUser(null)
    setXelayUser(null)
    setSessionUnavailable(false)
    setGoogleRegistration({ userId: null, status: 'ready' })
    clearPasswordRecovery()
  }, [clearPasswordRecovery, reconcilePracticeAuth, setReadFence])

  useEffect(() => {
    mounted.current = true
    const timers = new Set<ReturnType<typeof setTimeout>>()
    // Auth initialization may itself wait on a refresh/network lock. Expose a
    // retry instead of an endless spinner; this grants no identity or profile.
    const bootstrapTimer = setTimeout(() => {
      if (mounted.current && authGeneration.current === 0) {
        setSessionUnavailable(true)
        setIsLoading(false)
      }
    }, AUTH_SESSION_TIMEOUT_MS)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      clearTimeout(bootstrapTimer)
      authGeneration.current += 1
      setSessionUnavailable(false)
      const user = event === 'SIGNED_OUT' ? null : session?.user || null
      const sessionId = sessionIdentity(session?.access_token)
      const changedUser = userIdRef.current !== (user?.id || null)
      const oldSessionId = practiceAuthIdentity.current?.sessionId
      const changedSession = Boolean(oldSessionId) && oldSessionId !== sessionId
      reconcilePracticeAuth(user ? session : null, event === 'SIGNED_OUT')
      if (!user) setReadFence(event === 'SIGNED_OUT' ? 'logout' : 'denied')
      else if (authReadFence.current === null || authReadFence.current === 'initial'
        || event === 'SIGNED_IN' && (changedUser || changedSession)) setReadFence(null)
      // Reconcile saved content with the local auth identity before profile
      // requests finish. Same-owner refreshes retain already saved snapshots.
      if (user) void establishOfflineOwner(user.id).catch(() => {})
      userIdRef.current = user?.id || null
      setAuthUser(user)
      if (changedUser || changedSession) {
        profileFlight.current.cancel()
        profileRequest.current += 1
        setXelayUser(null); setIsLoading(Boolean(user))
        if (googleAuthEnabled) setGoogleRegistration({ userId: user?.id || null, status: user ? 'checking' : 'ready' })
      }
      if (event === 'PASSWORD_RECOVERY' && user) {
        const startedAt = Date.now()
        try { sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ userId: user.id, sessionId, startedAt })) } catch { /* Optional refresh persistence. */ }
        setRecoveryDeadline(startedAt + RECOVERY_TTL)
        setIsPasswordRecovery(true)
      } else if (!user) clearPasswordRecovery()
      else if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || changedUser) {
        const deadline = recoveryDeadlineFor(user.id, sessionId)
        if (deadline) { setIsPasswordRecovery(true); setRecoveryDeadline(deadline) }
        else clearPasswordRecovery()
      }

      if (!user) {
        profileFlight.current.cancel()
        // INITIAL_SESSION may be null because an expired token could not be
        // refreshed over a broken connection. That is not an explicit logout.
        if (event === 'SIGNED_OUT') { clearPendingTeacherAcademicProfile(); void clearOfflineStudy().catch(() => {}) }
        profileRequest.current += 1
        setXelayUser(null)
        setGoogleRegistration({ userId: null, status: 'ready' })
        setIsLoading(false)
        return
      }
      // Auth callbacks must return before issuing another Supabase request.
      const callbackGeneration = authGeneration.current
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (mounted.current && callbackGeneration === authGeneration.current && userIdRef.current === user.id) void fetchProfile(user.id)
      }, 0)
      timers.add(timer)
    })
    return () => {
      mounted.current = false
      clearTimeout(bootstrapTimer)
      profileFlight.current.cancel()
      profileRequest.current += 1
      subscription.unsubscribe()
      timers.forEach(clearTimeout)
    }
  }, [fetchProfile, clearPasswordRecovery, reconcilePracticeAuth, setReadFence])

  useEffect(() => {
    if (!authUser?.id || xelayUser?.id !== authUser.id || isPasswordRecovery
      || googleAuthEnabled && (googleRegistration.userId !== authUser.id || googleRegistration.status !== 'ready')) return
    // A completed profile supplies a display name only. No role or token is
    // persisted; snapshot capture independently rechecks group membership.
    void establishOfflineOwner(authUser.id, xelayUser.name).catch(() => {})
    // Optional registration contacts are saved only for the same confirmed,
    // fully registered identity, never through public authentication metadata.
    void consumePendingTeacherAcademicProfile(authUser.id).catch(() => {})
  }, [authUser?.id, xelayUser?.id, xelayUser?.name, isPasswordRecovery, googleRegistration.userId, googleRegistration.status])

  useEffect(() => {
    if (!authUser?.id) return
    const userId = authUser.id
    let academicYear = currentAcademicYear()
    const refreshAtAcademicYearChange = () => {
      if (document.visibilityState !== 'visible') return
      const nextYear = currentAcademicYear()
      if (nextYear === academicYear) return
      academicYear = nextYear
      void fetchProfile(userId)
    }
    const timer = window.setInterval(refreshAtAcademicYearChange, 60_000)
    document.addEventListener('visibilitychange', refreshAtAcademicYearChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshAtAcademicYearChange)
    }
  }, [authUser?.id, fetchProfile])

  useEffect(() => {
    if (!isPasswordRecovery || !authUser || !recoveryDeadline) return
    const timeout = setTimeout(clearPasswordRecovery, Math.max(0, recoveryDeadline - Date.now()))
    return () => clearTimeout(timeout)
  }, [isPasswordRecovery, authUser?.id, recoveryDeadline, clearPasswordRecovery])

  return <AuthContext.Provider value={{
    authUser, xelayUser, authReadEpoch, authReadBlocked, isLoading, sessionUnavailable, isAuthenticated: Boolean(authUser), isPasswordRecovery,
    googleRegistrationStatus: !authUser || !googleAuthEnabled ? 'ready' : googleRegistration.userId === authUser.id ? googleRegistration.status : 'checking',
    clearPasswordRecovery, markPasswordRecovery, refreshUser, signOut,
  }}>{children}</AuthContext.Provider>
}

export function useAuth() { return useContext(AuthContext) }
