/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// `/v1/{traces,logs,metrics}` entries proxy browser-OTLP POSTs to the
// compose collector on host :4318 so `pnpm dev` (5173) and
// `pnpm preview` (4173) see same-origin OTLP just like the in-k3s
// nginx-served bundle on :13000. Slice 18c removed the compose
// collector's CORS allowlist; without these proxy entries the relative
// `/v1/*` URLs would 404 from the vite dev server.
const browserOtlpProxy = {
  '/v1/traces': {
    target: 'http://localhost:4318',
    changeOrigin: true,
  },
  '/v1/logs': {
    target: 'http://localhost:4318',
    changeOrigin: true,
  },
  '/v1/metrics': {
    target: 'http://localhost:4318',
    changeOrigin: true,
  },
}

const backendProxy = {
  '/actuator': 'http://localhost:8080',
  '/api/v1': {
    target: 'http://localhost:8080',
    changeOrigin: true,
  },
  ...browserOtlpProxy,
}

const { version: packageVersion } = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
) as { version: string }

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // The browser OTel SDK reads `import.meta.env.VITE_APP_VERSION` to populate
  // the `service.version` resource attribute on every emitted span. We inject
  // the value from package.json at config-eval time so the literal lands in
  // the built bundle without requiring a `VITE_APP_VERSION=...` in `.env`.
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const appVersion = env.VITE_APP_VERSION ?? packageVersion
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    },
    server: {
      proxy: backendProxy,
    },
    preview: {
      proxy: backendProxy,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test-setup.ts',
    },
  }
})
