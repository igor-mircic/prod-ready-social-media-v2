import { test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

test('renders the App default landing content', () => {
  render(<App />)
  expect(screen.getByText('Get started')).toBeTruthy()
})
