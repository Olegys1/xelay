import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react'

import type { User } from '@supabase/supabase-js'

import { supabase } from '../lib/supabase'
import type { XelayUser } from '../types'

interface AuthState {
  authUser: User | null
  xelayUser: XelayUser | null
  isLoading: boolean
  isAuthenticated: boolean
  refreshUser: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  authUser: null,
  xelayUser: null,
  isLoading: false,
  isAuthenticated: false,
  refreshUser: async () => {},
  signOut: async () => {},
})

export function AuthProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [authUser, setAuthUser] =
    useState<User | null>(null)

  const [xelayUser, setXelayUser] =
    useState<XelayUser | null>(null)

  const [isLoading, setIsLoading] =
    useState(false)

  const fetchProfile = async (userId: string) => {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single()

      if (!data) {
        setXelayUser(null)
        return
      }

      setXelayUser({
        id: data.id,
        userId: data.id,

        name:
          data.full_name ||
          data.name ||
          'Anonymous',

        email: data.email || '',

        country: data.country || '',

        city: data.city || '',

        experience: data.experience || '',

        categories: data.categories || [],

        rating: data.rating || 0,

        avatarUrl:
          data.avatar_url || '',

        createdAt:
          data.created_at ||
          new Date().toISOString(),
      })
    } catch (err) {
      console.error(err)
      setXelayUser(null)
    }
  }

  const refreshUser = async () => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      const user = session?.user || null

      setAuthUser(user)

      if (user?.id) {
        await fetchProfile(user.id)
      } else {
        setXelayUser(null)
      }
    } catch (err) {
      console.error(err)
    }
  }

  const signOut = async () => {
    await supabase.auth.signOut()

    setAuthUser(null)
    setXelayUser(null)
  }

  useEffect(() => {
    refreshUser()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        const user = session?.user || null

        setAuthUser(user)

        if (user?.id) {
          await fetchProfile(user.id)
        } else {
          setXelayUser(null)
        }
      }
    )

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  return (
    <AuthContext.Provider
      value={{
        authUser,
        xelayUser,
        isLoading,
        isAuthenticated: !!authUser,
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