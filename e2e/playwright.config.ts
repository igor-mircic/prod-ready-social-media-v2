import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  globalSetup: './src/setup/global-setup.ts',
  globalTeardown: './src/setup/global-teardown.ts',

  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
