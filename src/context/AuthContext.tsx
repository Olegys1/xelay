import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { blink } from '../blink/client'
import type { XelayUser } from '../types'

interface BlinkUser {
  id: string
  email?: string
  displayName?: string
}

interface AuthState {
  blinkUser: BlinkUser | null
  xelayUser: XelayUser | null
  isLoading: boolean
  isAuthenticated: boolean
  refreshUser: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  blinkUser: null,
  xelayUser: null,
  isLoading: true,
  isAuthenticated: false,
  refreshUser: async () => {},
  signOut: async () => {},
})

function parseXelayUser(u: Record<string, unknown>): XelayUser {
  // SDK converts snake_case → camelCase, but we handle both just in case
  const categories = (() => {
    const raw = (u.categories as string) || '[]'
    try { return JSON.parse(raw) as string[] } catch { return [] }
  })()

  return {
    id: (u.id as string) || '',
    userId: (u.userId as string) || (u.user_id as string) || '',
    name: (u.name as string) || '',
    email: (u.email as string) || '',
    country: (u.country as string) || '',
    city: ((u.city as string) || undefined),
    experience: (u.experience as string) || '',
    categories,
    rating: Number(u.rating) || 0,
    // SDK converts avatar_url → avatarUrl; handle both
    avatarUrl: ((u.avatarUrl as string) || (u.avatar_url as string) || undefined),
    createdAt: (u.createdAt as string) || (u.created_at as string) || '',
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [blinkUser, setBlinkUser] = useState<BlinkUser | null>(null)
  const [xelayUser, setXelayUser] = useState<XelayUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const fetchXelayUser = useCallback(async (userId: string) => {
    try {
      const results = await blink.db.xelayUsers.list({
        where: { userId },
        limit: 1,
      })
      if (results && results.length > 0) {
        setXelayUser(parseXelayUser(results[0] as Record<string, unknown>))
      } else {
        setXelayUser(null)
      }
    } catch (err) {
      console.warn('[Xelay] Failed to fetch user profile:', err)
      setXelayUser(null)
    }
  }, [])

  const refreshUser = useCallback(async () => {
    // Re-check auth state and reload profile
    try {
      const me = await blink.auth.me()
      const user = me as BlinkUser | null
      if (user?.id) {
        setBlinkUser(user)
        await fetchXelayUser(user.id)
      }
    } catch (err) {
      console.warn('[Xelay] refreshUser error:', err)
    }
  }, [fetchXelayUser])

  const signOut = async () => {
    try {
      await blink.auth.signOut()
    } catch { /* ignore */ }
    setBlinkUser(null)
    setXelayUser(null)
  }

  useEffect(() => {
    let settled = false

    // Primary: listen to auth state changes (works on most devices)
    const unsubscribe = blink.auth.onAuthStateChanged(async (state) => {
      const user = state.user as BlinkUser | null
      setBlinkUser(user)

      if (user?.id) {
        await fetchXelayUser(user.id)
      } else {
        setXelayUser(null)
      }

      if (!state.isLoading) {
        settled = true
        setIsLoading(false)
      }
    })

    // Fallback for mobile: if onAuthStateChanged never resolves loading
    // within 4 seconds, manually check session via blink.auth.me()
    const fallbackTimer = setTimeout(async () => {
      if (settled) return
      try {
        const me = await blink.auth.me()
        const user = me as BlinkUser | null
        if (user?.id) {
          setBlinkUser(user)
          await fetchXelayUser(user.id)
        } else {
          setBlinkUser(null)
          setXelayUser(null)
        }
      } catch {
        setBlinkUser(null)
        setXelayUser(null)
      } finally {
        setIsLoading(false)
      }
    }, 4000)

    return () => {
      unsubscribe()
      clearTimeout(fallbackTimer)
    }
  }, [fetchXelayUser])

  return (
    <AuthContext.Provider
      value={{
        blinkUser,
        xelayUser,
        isLoading,
        isAuthenticated: !!blinkUser,
        refreshUser,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

export type { XelayUser }
