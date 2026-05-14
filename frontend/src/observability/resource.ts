import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'

type ViteEnv = {
  VITE_APP_VERSION?: string
}

// Vitest gives each module its own `import.meta.env` object, so resolve
// once at module load and expose the reference via `__envForTest` so a
// unit test can stub by mutating the same object this module reads.
// Mirrors the pattern in `tracer.ts`.
const env: ViteEnv = (import.meta as { env?: ViteEnv }).env ?? {}

export const __envForTest: ViteEnv = env

export const frontendResource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: 'frontend',
  [ATTR_SERVICE_VERSION]: env.VITE_APP_VERSION ?? 'unknown',
})
