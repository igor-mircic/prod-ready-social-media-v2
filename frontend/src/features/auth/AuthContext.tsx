import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { refreshOnce, setAccessTokenGetter, setRefreshHandlers } from '../../api/client'
import { me } from '../../api/generated/queries/auth-controller/auth-controller'
import type { UserResponse } from '../../api/generated/queries/openAPIDefinition.schemas'

export type CurrentUser = Pick<UserResponse, 'id' | 'email' | 'displayName' | 'createdAt'>

interface AuthContextValue {
  accessToken: string | null
  currentUser: CurrentUser | null
  booting: boolean
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
  const [booting, setBooting] = useState(true)

  // Keep latest onSessionExpired accessible from the stable failure handler
  // without re-running the mount effect (which would re-fire boot-time refresh).
  const onSessionExpiredRef = useRef(onSessionExpired)
  useEffect(() => {
    onSessionExpiredRef.current = onSessionExpired
  }, [onSessionExpired])

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
    setAccessTokenGetter(() => moduleAccessToken)

    const handleRefreshSuccess = (newToken: string) => {
      moduleAccessToken = newToken
      setAccessTokenState(newToken)
    }

    // Task 1.4: register the success handler BEFORE the boot-time refresh
    // fires so the module-level access token is updated in one place. The
    // failure handler is deliberately null during the boot window — a 401
    // here just means "no valid refresh cookie", not "the user was kicked
    // out", so we must not navigate (e.g., away from /signup). After the
    // boot flow settles we install the runtime failure handler that calls
    // onSessionExpired on subsequent refresh failures.
    setRefreshHandlers(handleRefreshSuccess, null)

    let cancelled = false
    void (async () => {
      const token = await refreshOnce()
      if (cancelled) return
      if (token) {
        try {
          const meResult = await me()
          if (cancelled) return
          if (meResult.status === 200 && meResult.data) {
            setCurrentUser({
              id: meResult.data.id,
              email: meResult.data.email,
              displayName: meResult.data.displayName,
              createdAt: meResult.data.createdAt,
            })
          }
        } catch {
          // Leave unauthenticated on /me failure.
        }
      }
      if (cancelled) return
      setRefreshHandlers(handleRefreshSuccess, () => {
        moduleAccessToken = null
        setAccessTokenState(null)
        setCurrentUser(null)
        onSessionExpiredRef.current?.()
      })
      setBooting(false)
    })()

    return () => {
      cancelled = true
      setAccessTokenGetter(null)
      setRefreshHandlers(null, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ accessToken, currentUser, booting, login, logout, setAccessToken }),
    [accessToken, currentUser, booting, login, logout, setAccessToken],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
