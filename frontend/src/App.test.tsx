import { test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'
import { QueryProvider } from './api/query-provider'

test('renders the App default landing content', () => {
  render(
    <QueryProvider>
      <App />
    </QueryProvider>,
  )
  expect(screen.getByText('Get started')).toBeTruthy()
})
