import { test, expect } from '../src/fixtures/test.ts'

test('SPA root mounts and actuator health is up', async ({ page, request }) => {
  const response = await page.goto('/')
  expect(response, 'response from GET /').not.toBeNull()
  expect(response!.status()).toBe(200)

  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()

  const health = await request.get('/actuator/health')
  expect(health.status()).toBe(200)
})
