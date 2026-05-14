import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { QueryProvider } from './api/query-provider'
import { FrontendErrorBoundary } from './observability/ErrorBoundary'
import { bootstrapErrorReporting } from './observability/errors'
import { bootstrapMetrics } from './observability/meter'
import { bootstrapTelemetry } from './observability/tracer'

bootstrapTelemetry()
bootstrapMetrics()
bootstrapErrorReporting()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FrontendErrorBoundary>
      <QueryProvider>
        <App />
      </QueryProvider>
    </FrontendErrorBoundary>
  </StrictMode>,
)
