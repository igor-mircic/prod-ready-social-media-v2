import AxeBuilder from '@axe-core/playwright'
import type { Page, TestInfo } from '@playwright/test'

export async function runAxeScan(page: Page, testInfo: TestInfo): Promise<void> {
  // Axe cannot scan the empty about:blank page (no document to analyse).
  if (page.url() === 'about:blank' || !page.url().startsWith('http')) return

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  if (results.violations.length > 0) {
    await testInfo.attach('axe-violations.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    })
    const summary = results.violations
      .map((v) => `- ${v.id} (${v.impact ?? 'unknown'}): ${v.help} [${v.nodes.length} node(s)]`)
      .join('\n')
    throw new Error(`Accessibility violations on ${page.url()}:\n${summary}`)
  }
}
