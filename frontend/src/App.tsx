import './App.css'
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { type ReactNode } from 'react'

import { AuthProvider, useAuth } from './features/auth/AuthContext'
import { ProtectedRoute } from './features/auth/ProtectedRoute'
import { LoginForm } from './features/login/LoginForm'
import { HomePage } from './features/home/HomePage'
import { SignupForm } from './features/signup/SignupForm'

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
          <Route path="/login" element={<LoginForm />} />
          <Route path="/signup" element={<SignupForm />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/home" element={<HomePage />} />
          </Route>
          <Route path="/" element={<RootRedirect />} />
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </AuthBridge>
    </BrowserRouter>
  )
}

export default App
