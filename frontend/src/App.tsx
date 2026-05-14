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
import RouteTimingObserver from './observability/route-timing'

// Dev-only component that throws on mount. The thrown message
// embeds a JWT-shaped substring so the slice-7 e2e spec can assert
// PII redaction end-to-end (Collector regex backstop strips the
// JWT before it reaches Loki / Tempo). The component is referenced
// only when `import.meta.env.DEV` is truthy so production builds
// tree-shake it out (and the CI lint check in `pnpm build` proves it).
function ThrowOnMount(): null {
  throw new Error(
    'Dev throw: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXYifQ.signaturesegment',
  )
}

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
      <RouteTimingObserver />
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
          {import.meta.env.DEV && (
            <Route path="/__dev/throw" element={<ThrowOnMount />} />
          )}
          <Route path="/" element={<RootRedirect />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AuthBridge>
    </BrowserRouter>
  )
}

export default App
