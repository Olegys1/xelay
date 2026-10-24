import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { User, Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { XelayUser } from '../types'
import { currentAcademicYear, isActiveStudentStatus } from '../lib/studyYearProgression'
import { loadTeacherVerification } from '../lib/teacherVerification'
import { googleAuthEnabled, googleRegistrationRequired as loadGoogleRegistrationRequired } from '../lib/authGoogle'
import { clearOfflineStudy, establishOfflineOwner } from '../lib/offlineStudy'
import { clearPendingTeacherAcademicProfile, consumePendingTeacherAcademicProfile } from '../lib/teacherAcademicProfile'

export type GoogleRegistrationStatus = 'checking' | 'required' | 'ready' | 'error'

interface AuthState {
  authUser: User | null
  xelayUser: XelayUser | null
  isLoading: boolean
  isAuthenticated: boolean
  isPasswordRecovery: boolean
  googleRegistrationStatus: GoogleRegistrationStatus
  clearPasswordRecovery: () => void
  markPasswordRecovery: (session: Session) => void
  refreshUser: () => Promise<void>
  signOut: () => Promise<void>
}

const RECOVERY_KEY = 'xelay_password_recovery'
const RECOVERY_TTL = 20 * 60 * 1000

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
  const browser = value?.name === 'AuthUnknownError' && value.originalError && typeof value.originalError === 'object'
    ? value.originalError as { name?: string; message?: string } : value
  if (['AbortError', 'TimeoutError', 'AuthRetryableFetchError'].includes(browser?.name || '')) return true
  return code === 'request_timeout' || /^(?:TypeError:\s*)?(?:failed to fetch|fetch failed|load failed|network request failed|networkerror(?: when attempting to fetch resource\.)?)$/i.test(browser?.message?.trim() || '')
}

async function profileLookup<T>(query: PromiseLike<T>): Promise<T | { data: null; error: unknown; status?: number }> {
  try { return await query } catch (error) { return { data: null, error } }
}

const AuthContext = createContext<AuthState>({
  authUser: null, xelayUser: null, isLoading: true, isAuthenticated: false,
  isPasswordRecovery: false, clearPasswordRecovery: () => {}, markPasswordRecovery: () => {},
  googleRegistrationStatus: 'ready',
  refreshUser: async () => {}, signOut: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [xelayUser, setXelayUser] = useState<XelayUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false)
  const [googleRegistration, setGoogleRegistration] = useState<{ userId: string | null; status: GoogleRegistrationStatus }>({ userId: null, status: 'ready' })
  const [recoveryDeadline, setRecoveryDeadline] = useState(0)
  const userIdRef = useRef<string | null>(null)
  const profileRequest = useRef(0)
  const authGeneration = useRef(0)
  const mounted = useRef(false)

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

  const fetchProfile = useCallback(async (userId: string) => {
    const request = ++profileRequest.current
    const current = () => mounted.current && request === profileRequest.current && userIdRef.current === userId
    try {
      if (googleAuthEnabled) {
        try {
          const required = await loadGoogleRegistrationRequired()
          if (!current()) return
          setGoogleRegistration({ userId, status: required ? 'required' : 'ready' })
          if (required) { setXelayUser(null); return }
        } catch {
          if (!current()) return
          // A failed status lookup must not expose platform functions before
          // the first Google registration and explicit consent are complete.
          setGoogleRegistration({ userId, status: 'error' })
          setXelayUser(null)
          return
        }
      }
      const result = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
      let row = result.data
      const error = result.error
      if (error || !row) {
        if (current()) setXelayUser((previous) => error && transientProfileFailure(error, result.status)
          && previous?.id === userId ? previous : null)
        return
      }
      if (row.study_year_auto_advance === true && row.study_year
        && isActiveStudentStatus(row.experience || '')
        && typeof row.study_year_academic_year === 'number'
        && row.study_year_academic_year < currentAcademicYear()) {
        // The database clock decides the course; the browser only requests catch-up.
        // A failed catch-up must not block signing in or password recovery.
        try {
          const { error: progressionError } = await supabase.rpc('xelay_refresh_my_study_year')
          if (!progressionError && current()) {
            const refreshed = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
            if (!refreshed.error && refreshed.data) row = refreshed.data
          } else if (progressionError) console.warn('[Xelay] Course refresh unavailable:', progressionError.code)
        } catch { console.warn('[Xelay] Course refresh connection unavailable') }
      }
      if (!current()) return
      const [rolesResult, representativeResult, membershipsResult, teacherResult] = await Promise.all([
        profileLookup(supabase.from('user_roles').select('role, university_id, academic_unit_id').eq('user_id', userId)),
        profileLookup(supabase.from('class_representative_requests').select('id, status').eq('user_id', userId)
          .in('status', ['pending', 'approved']).order('created_at', { ascending: false })),
        profileLookup(supabase.from('study_group_members').select('group_id, status').eq('user_id', userId).in('status', ['pending', 'accepted'])),
        // Missing teaching services must not prevent ordinary account access.
        loadTeacherVerification().then((data) => ({ data, error: null as unknown }))
          .catch((error: unknown) => ({ data: null, error })),
      ])
      if (!current()) return
      const relatedResults: Array<{ error: unknown; status?: number }> = [rolesResult, representativeResult, membershipsResult, teacherResult]
      if (relatedResults.some((result) => result.error && ((result.status ?? (result.error as { status?: number }).status) === 401
        || ['28000', '28P01', 'PGRST301', 'PGRST302', 'PGRST303'].includes(String((result.error as { code?: string }).code || ''))))) {
        setXelayUser(null)
        return
      }
      const relatedTransient = relatedResults.some((result) => result.error
        && transientProfileFailure(result.error, result.status))
      const relatedAuthoritative = relatedResults.some((result) => result.error
        && !transientProfileFailure(result.error, result.status))
      const teacherStatus = teacherResult.data
      const roles = rolesResult.data || []
      const representativeRequests = representativeResult.data || []
      const approved = representativeRequests.find((item) => item.status === 'approved')
      const profile: XelayUser = {
        id: row.id, userId: row.id, name: row.full_name || row.name || 'Анонім',
        email: row.email || '', username: row.username || '', country: row.country || '',
        city: row.city || '', experience: row.experience || '', categories: row.categories || [],
        faculty: row.faculty || '', universityId: row.university_id || null, academicUnitId: row.academic_unit_id || null,
        isPlatformAdmin: roles.some((role) => role.role === 'ADMIN'),
        accountType: row.account_type === 'teacher' ? 'teacher' : 'student',
        isTeacher: teacherStatus?.verified === true,
        teacherVerificationStatus: teacherStatus?.status || 'none',
        teacherDepartment: teacherStatus?.request?.department || '',
        teacherPosition: teacherStatus?.request?.position || '',
        editorUnitIds: roles.filter((role) => role.role === 'FACULTY_EDITOR').map((role) => role.academic_unit_id),
        editorUniversityIds: roles.filter((role) => role.role === 'UNIVERSITY_EDITOR').map((role) => role.university_id),
        isPlatformNewsEditor: roles.some((role) => role.role === 'PLATFORM_EDITOR' && role.university_id === null && role.academic_unit_id === null),
        isClassRepresentative: Boolean(approved), classRepresentativeRequestId: approved?.id || representativeRequests[0]?.id,
        studyGroupIds: [...new Set((membershipsResult.data || []).map((item) => item.group_id))],
        specialty: row.specialty || '', specialtyId: row.specialty_id || null, studyYear: row.study_year ?? null, skills: row.skills || [],
        studyYearAutoAdvance: typeof row.study_year_auto_advance === 'boolean' ? row.study_year_auto_advance : undefined,
        studyYearAcademicYear: row.study_year_academic_year ?? null,
        studyProgramYears: row.study_program_years ?? null,
        studyYearNeedsReview: row.study_year_needs_review === true,
        helpWith: row.help_with || [], wantToLearn: row.want_to_learn || [], avatarUrl: row.avatar_url || '',
        has_seen_onboarding: row.has_seen_onboarding ?? false, bio: row.bio || '',
        createdAt: row.created_at || new Date().toISOString(),
      }
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
          ...(representativeResult.error && transientProfileFailure(representativeResult.error, representativeResult.status) ? {
            isClassRepresentative: previous.isClassRepresentative,
            classRepresentativeRequestId: previous.classRepresentativeRequestId,
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
      if (current()) setXelayUser((previous) => transientProfileFailure(error) && previous?.id === userId ? previous : null)
    } finally {
      if (current()) setIsLoading(false)
    }
  }, [])

  const refreshUser = useCallback(async () => {
    const request = ++authGeneration.current
    setIsLoading(true)
    try {
      const { data: { session }, error } = await supabase.auth.getSession()
      if (!mounted.current || request !== authGeneration.current) return
      if (error) throw error
      const user = session?.user || null
      if (user) void establishOfflineOwner(user.id).catch(() => {})
      else void clearOfflineStudy().catch(() => {})
      if (userIdRef.current !== (user?.id || null)) {
        profileRequest.current += 1
        setXelayUser(null)
      }
      userIdRef.current = user?.id || null
      setAuthUser(user)
      if (user) await fetchProfile(user.id)
      else { setXelayUser(null); clearPasswordRecovery(); setIsLoading(false) }
    } catch {
      if (mounted.current) setIsLoading(false)
    }
  }, [fetchProfile, clearPasswordRecovery])

  const signOut = useCallback(async () => {
    authGeneration.current += 1
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
    setGoogleRegistration({ userId: null, status: 'ready' })
    clearPasswordRecovery()
  }, [clearPasswordRecovery])

  useEffect(() => {
    mounted.current = true
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      authGeneration.current += 1
      const user = session?.user || null
      const sessionId = sessionIdentity(session?.access_token)
      const changedUser = userIdRef.current !== (user?.id || null)
      // Reconcile saved content with the local auth identity before profile
      // requests finish. Same-owner refreshes retain already saved snapshots.
      if (user) void establishOfflineOwner(user.id).catch(() => {})
      userIdRef.current = user?.id || null
      setAuthUser(user)
      if (changedUser) { setXelayUser(null); setIsLoading(Boolean(user)) }
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
      const timer = setTimeout(() => { timers.delete(timer); void fetchProfile(user.id) }, 0)
      timers.add(timer)
    })
    return () => {
      mounted.current = false
      profileRequest.current += 1
      subscription.unsubscribe()
      timers.forEach(clearTimeout)
    }
  }, [fetchProfile, clearPasswordRecovery])

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
    authUser, xelayUser, isLoading, isAuthenticated: Boolean(authUser), isPasswordRecovery,
    googleRegistrationStatus: !authUser || !googleAuthEnabled ? 'ready' : googleRegistration.userId === authUser.id ? googleRegistration.status : 'checking',
    clearPasswordRecovery, markPasswordRecovery, refreshUser, signOut,
  }}>{children}</AuthContext.Provider>
}

export function useAuth() { return useContext(AuthContext) }
