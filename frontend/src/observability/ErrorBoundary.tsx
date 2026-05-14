import { Component, type ErrorInfo, type ReactNode } from 'react'

import { recordFrontendError } from './error-sink'

interface FrontendErrorBoundaryProps {
  children: ReactNode
}

interface FrontendErrorBoundaryState {
  hasError: boolean
}

export class FrontendErrorBoundary extends Component<
  FrontendErrorBoundaryProps,
  FrontendErrorBoundaryState
> {
  state: FrontendErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): FrontendErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    recordFrontendError(error, 'boundary', {
      componentStack: info.componentStack ?? undefined,
    })
  }

  handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div role="alert" style={{ padding: '2rem', textAlign: 'center' }}>
          <h1>Something went wrong.</h1>
          <p>Refresh to retry.</p>
          <button type="button" onClick={this.handleReload}>
            Refresh
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default FrontendErrorBoundary
