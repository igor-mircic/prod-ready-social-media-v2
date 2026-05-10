import { test as base, expect } from '@playwright/test'
import { runAxeScan } from './axe.ts'
import { resolveBackendURLFromState, resolveBaseURLFromState } from './baseURL.ts'
import { createApiClient, type ApiClient } from '../helpers/apiClient.ts'

interface E2EFixtures {
  apiClient: ApiClient
  backendURL: string
}

export const test = base.extend<E2EFixtures>({
  baseURL: async ({}, use) => {
    await use(resolveBaseURLFromState())
  },

  backendURL: async ({}, use) => {
    await use(resolveBackendURLFromState())
  },

  apiClient: async ({ backendURL }, use) => {
    await use(createApiClient(backendURL))
  },
})

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === 'failed' || testInfo.status === 'timedOut') return
  if (!page.url().startsWith('http')) return
  await runAxeScan(page, testInfo)
})

export { expect }
