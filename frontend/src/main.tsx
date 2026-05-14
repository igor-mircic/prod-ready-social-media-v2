import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { QueryProvider } from './api/query-provider'
import { bootstrapMetrics } from './observability/meter'
import { bootstrapTelemetry } from './observability/tracer'

bootstrapTelemetry()
bootstrapMetrics()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
      <App />
    </QueryProvider>
  </StrictMode>,
)
