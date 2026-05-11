import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './AuthContext'

export function ProtectedRoute() {
  const { currentUser, booting } = useAuth()
  if (booting) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }
  if (!currentUser) {
    return <Navigate to="/login" replace />
  }
  return <Outlet />
}
