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

  newBadge: string | null

  setNewBadge: (
    badge: string | null
  ) => void

  refreshUser: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  authUser: null,
  xelayUser: null,
  isLoading: true,
  isAuthenticated: false,

  newBadge: null,

  setNewBadge: () => {},

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
useState(true)

const [newBadge, setNewBadge] =
  useState<string | null>(null)

const fetchProfile = async (
userId: string
) => {
try {
console.log(
'PROFILE FETCH START'
)


  console.log(
    'USER ID:',
    userId
  )

  const result = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)

  console.log(
    'PROFILE RESULT:',
    result
  )

  const { data, error } = result

  if (error) {
    console.error(
      'PROFILE ERROR:',
      error
    )

    setXelayUser(null)
    return
  }

  if (
    !data ||
    data.length === 0
  ) {
    console.log(
      'PROFILE NOT FOUND'
    )

    setXelayUser(null)
    return
  }

  const row = data[0]

  const profile: XelayUser = {
    id: row.id,
    userId: row.id,

    name:
      row.full_name ||
      row.name ||
      'Anonymous',

    email: row.email || '',

    country:
      row.country || '',

    city: row.city || '',

    experience:
      row.experience || '',

    categories:
      row.categories || [],

    rating:
      row.rating || 0,

    avatarUrl:
      row.avatar_url || '',

      has_seen_onboarding:
  row.has_seen_onboarding ?? false,

  bio:
  row.bio || '',

    createdAt:
      row.created_at ||
      new Date().toISOString(),
  }

  console.log(
    'SET XELAY USER:',
    profile
  )

  setXelayUser(profile)
  const { data: badges } =
  await supabase
    .from('user_badges')
    .select('badge_type')
    .eq('user_id', userId)

const seenBadges =
  JSON.parse(
    localStorage.getItem(
      'seen_badges'
    ) || '[]'
  )

const newestBadge =
  badges?.find(
    (b) =>
      !seenBadges.includes(
        b.badge_type
      )
  )

if (newestBadge) {
  setNewBadge(
    newestBadge.badge_type
  )

  localStorage.setItem(
    'seen_badges',
    JSON.stringify([
      ...seenBadges,
      newestBadge.badge_type,
    ])
  )
}
} catch (err) {
  console.error(
    'PROFILE CRASH:',
    err
  )

  setXelayUser(null)
}


}

const refreshUser = async () => {
try {
setIsLoading(true)


  const {
    data: { session },
  } = await supabase.auth.getSession()

  const user =
    session?.user || null

  setAuthUser(user)
if (user?.id) {
  setTimeout(async () => {

    await supabase.rpc(
      'award_pioneer_badge',
      {
        p_user_id: user.id
      }
    )

    await fetchProfile(user.id)

    setIsLoading(false)

  }, 0)
}
} catch (err) {
  console.error(
    'REFRESH USER ERROR:',
    err
  )
} finally {
  setIsLoading(false)
}


}

const signOut = async () => {
await supabase.auth.signOut()


setAuthUser(null)
setXelayUser(null)


}

useEffect(() => {
const {
data: { subscription },
} = supabase.auth.onAuthStateChange(
(event, session) => {
console.log(
'AUTH EVENT:',
event
)


    console.log(
      'AUTH SESSION:',
      session
    )

    const user =
      session?.user || null

    setAuthUser(user)

    if (user?.id) {
      setTimeout(() => {
        fetchProfile(user.id)
        setIsLoading(false)
      }, 0)
    } else {
      setXelayUser(null)
      setIsLoading(false)
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

    newBadge,
    setNewBadge,

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
