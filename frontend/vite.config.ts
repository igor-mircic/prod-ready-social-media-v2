/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const backendProxy = {
  '/actuator': 'http://localhost:8080',
  '/api/v1': {
    target: 'http://localhost:8080',
    changeOrigin: true,
  },
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
