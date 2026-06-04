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
useState(true)

const fetchProfile = async (
userId: string
) => {
try {
console.log(
'PROFILE FETCH START'
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

    createdAt:
      row.created_at ||
      new Date().toISOString(),
  }

  console.log(
    'SET XELAY USER:',
    profile
  )

  setXelayUser(profile)
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

  console.log(
    'SESSION:',
    session
  )

  const user =
    session?.user || null

  console.log(
    'AUTH USER:',
    user
  )

  setAuthUser(user)

  if (user?.id) {
    await fetchProfile(user.id)
  } else {
    setXelayUser(null)
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
refreshUser()


const {
  data: { subscription },
} = supabase.auth.onAuthStateChange(
  async (
    event,
    session
  ) => {
    console.log(
      'AUTH EVENT:',
      event
    )

    console.log(
      'AUTH SESSION:',
      session
    )

    setIsLoading(true)

    try {
      const user =
        session?.user || null

      setAuthUser(user)

      if (user?.id) {
        await fetchProfile(
          user.id
        )
      } else {
        setXelayUser(null)
      }
    } finally {
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
isAuthenticated:
!!authUser,
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
