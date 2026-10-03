import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { User, Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { XelayUser } from '../types'

interface AuthState {
  authUser: User | null
  xelayUser: XelayUser | null
  isLoading: boolean
  isAuthenticated: boolean
  isPasswordRecovery: boolean
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

const AuthContext = createContext<AuthState>({
  authUser: null, xelayUser: null, isLoading: true, isAuthenticated: false,
  isPasswordRecovery: false, clearPasswordRecovery: () => {}, markPasswordRecovery: () => {},
  refreshUser: async () => {}, signOut: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [xelayUser, setXelayUser] = useState<XelayUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false)
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
      const { data: row, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
      if (error || !row) { if (current()) setXelayUser(null); return }
      const [rolesResult, representativeResult, membershipsResult] = await Promise.all([
        supabase.from('user_roles').select('role, university_id, academic_unit_id').eq('user_id', userId),
        supabase.from('class_representative_requests').select('id, status').eq('user_id', userId)
          .in('status', ['pending', 'approved']).order('created_at', { ascending: false }),
        supabase.from('study_group_members').select('group_id, status').eq('user_id', userId).in('status', ['pending', 'accepted']),
      ])
      if (!current()) return
      const roles = rolesResult.data || []
      const representativeRequests = representativeResult.data || []
      const approved = representativeRequests.find((item) => item.status === 'approved')
      setXelayUser({
        id: row.id, userId: row.id, name: row.full_name || row.name || 'Анонім',
        email: row.email || '', username: row.username || '', country: row.country || '',
        city: row.city || '', experience: row.experience || '', categories: row.categories || [],
        faculty: row.faculty || '', universityId: row.university_id || null, academicUnitId: row.academic_unit_id || null,
        isPlatformAdmin: roles.some((role) => role.role === 'ADMIN'),
        editorUnitIds: roles.filter((role) => role.role === 'FACULTY_EDITOR').map((role) => role.academic_unit_id),
        editorUniversityIds: roles.filter((role) => role.role === 'UNIVERSITY_EDITOR').map((role) => role.university_id),
        isClassRepresentative: Boolean(approved), classRepresentativeRequestId: approved?.id || representativeRequests[0]?.id,
        studyGroupIds: [...new Set((membershipsResult.data || []).map((item) => item.group_id))],
        specialty: row.specialty || '', specialtyId: row.specialty_id || null, studyYear: row.study_year ?? null, skills: row.skills || [],
        helpWith: row.help_with || [], wantToLearn: row.want_to_learn || [], avatarUrl: row.avatar_url || '',
        has_seen_onboarding: row.has_seen_onboarding ?? false, bio: row.bio || '',
        createdAt: row.created_at || new Date().toISOString(),
      })
    } catch {
      if (current()) setXelayUser(null)
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
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    userIdRef.current = null
    profileRequest.current += 1
    setAuthUser(null)
    setXelayUser(null)
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
        profileRequest.current += 1
        setXelayUser(null)
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
    if (!isPasswordRecovery || !authUser || !recoveryDeadline) return
    const timeout = setTimeout(clearPasswordRecovery, Math.max(0, recoveryDeadline - Date.now()))
    return () => clearTimeout(timeout)
  }, [isPasswordRecovery, authUser?.id, recoveryDeadline, clearPasswordRecovery])

  return <AuthContext.Provider value={{
    authUser, xelayUser, isLoading, isAuthenticated: Boolean(authUser), isPasswordRecovery,
    clearPasswordRecovery, markPasswordRecovery, refreshUser, signOut,
  }}>{children}</AuthContext.Provider>
}

export function useAuth() { return useContext(AuthContext) }
