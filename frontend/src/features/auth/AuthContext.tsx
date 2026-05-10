import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { setAccessTokenGetter, setRefreshHandlers } from '../../api/client'
import type { UserResponse } from '../../api/generated/queries/openAPIDefinition.schemas'

export type CurrentUser = Pick<UserResponse, 'id' | 'email' | 'displayName' | 'createdAt'>

interface AuthContextValue {
  accessToken: string | null
  currentUser: CurrentUser | null
  login: (token: string, user: CurrentUser) => void
  logout: () => void
  setAccessToken: (token: string | null) => void
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

// Module-level token mirror so the apiFetch request interceptor can read it
// synchronously between when `login`/`setAccessToken` is called and when the
// next render commits the matching React state update.
let moduleAccessToken: string | null = null

interface AuthProviderProps {
  children: ReactNode
  onSessionExpired?: () => void
}

export function AuthProvider({ children, onSessionExpired }: AuthProviderProps) {
  const [accessToken, setAccessTokenState] = useState<string | null>(null)
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)

  useEffect(() => {
    setAccessTokenGetter(() => moduleAccessToken)
    return () => setAccessTokenGetter(null)
  }, [])

  const setAccessToken = useCallback((token: string | null) => {
    moduleAccessToken = token
    setAccessTokenState(token)
  }, [])

  const login = useCallback((token: string, user: CurrentUser) => {
    moduleAccessToken = token
    setAccessTokenState(token)
    setCurrentUser(user)
  }, [])

  const logout = useCallback(() => {
    moduleAccessToken = null
    setAccessTokenState(null)
    setCurrentUser(null)
  }, [])

  useEffect(() => {
    setRefreshHandlers(
      (newToken) => {
        moduleAccessToken = newToken
        setAccessTokenState(newToken)
      },
      () => {
        moduleAccessToken = null
        setAccessTokenState(null)
        setCurrentUser(null)
        onSessionExpired?.()
      },
    )
    return () => setRefreshHandlers(null, null)
  }, [onSessionExpired])

  const value = useMemo<AuthContextValue>(
    () => ({ accessToken, currentUser, login, logout, setAccessToken }),
    [accessToken, currentUser, login, logout, setAccessToken],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
