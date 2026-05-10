import { afterEach, beforeEach, test, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import App from './App'
import { QueryProvider } from './api/query-provider'
import { __resetClientState } from './api/client'

beforeEach(() => {
  window.history.pushState({}, '', '/')
})

afterEach(() => {
  __resetClientState()
})

test('root redirects unauthenticated users to /login', async () => {
  render(
    <QueryProvider>
      <App />
    </QueryProvider>,
  )
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: /log in/i })).toBeTruthy()
  })
})
