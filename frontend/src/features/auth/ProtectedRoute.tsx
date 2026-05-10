import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './AuthContext'

export function ProtectedRoute() {
  const { currentUser } = useAuth()
  if (!currentUser) {
    return <Navigate to="/login" replace />
  }
  return <Outlet />
}
