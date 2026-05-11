import { Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'

import { useAuth } from './AuthContext'

interface RedirectIfAuthenticatedProps {
  children: ReactNode
}

export function RedirectIfAuthenticated({ children }: RedirectIfAuthenticatedProps) {
  const { currentUser, booting } = useAuth()
  if (!booting && currentUser) {
    return <Navigate to="/home" replace />
  }
  return <>{children}</>
}
