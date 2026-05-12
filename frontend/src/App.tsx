import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from 'react-router-dom'
import { type ReactNode } from 'react'

import { AuthProvider, useAuth } from './features/auth/AuthContext'
import { ProtectedRoute } from './features/auth/ProtectedRoute'
import { RedirectIfAuthenticated } from './features/auth/RedirectIfAuthenticated'
import { LoginForm } from './features/login/LoginForm'
import { HomePage } from './features/home/HomePage'
import { ProfilePage } from './features/profile/ProfilePage'
import { SignupForm } from './features/signup/SignupForm'
import { NotFoundPage } from './features/notfound/NotFoundPage'

function AuthBridge({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  return (
    <AuthProvider onSessionExpired={() => navigate('/login')}>
      {children}
    </AuthProvider>
  )
}

function RootRedirect() {
  const { currentUser } = useAuth()
  return <Navigate to={currentUser ? '/home' : '/login'} replace />
}

function App() {
  return (
    <BrowserRouter>
      <AuthBridge>
        <Routes>
          <Route
            path="/login"
            element={
              <RedirectIfAuthenticated>
                <LoginForm />
              </RedirectIfAuthenticated>
            }
          />
          <Route
            path="/signup"
            element={
              <RedirectIfAuthenticated>
                <SignupForm />
              </RedirectIfAuthenticated>
            }
          />
          <Route element={<ProtectedRoute />}>
            <Route path="/home" element={<HomePage />} />
            <Route path="/users/:userId" element={<ProfilePage />} />
          </Route>
          <Route path="/" element={<RootRedirect />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AuthBridge>
    </BrowserRouter>
  )
}

export default App
