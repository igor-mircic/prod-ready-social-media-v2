import { spawn, type ChildProcess } from 'node:child_process'
import { globSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../../')

export const BACKEND_PORT = 8080
const HEALTH_TIMEOUT_MS = 120_000
const HEALTH_POLL_INTERVAL_MS = 500

export interface BackendConfig {
  postgresHost: string
  postgresPort: number
  postgresDatabase: string
  postgresUsername: string
  postgresPassword: string
}

export interface BackendHandle {
  process: ChildProcess
  url: string
}

function resolveJarPath(): string {
  const pattern = resolve(REPO_ROOT, 'backend/build/libs/*.jar')
  const matches = globSync(pattern).filter((p) => !p.endsWith('-plain.jar'))
  if (matches.length === 0) {
    throw new Error(
      `No backend JAR found at ${pattern}. Run \`./gradlew bootJar\` in backend/ first.`,
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple backend JARs match ${pattern}: ${matches.join(', ')}. Clean and rebuild.`,
    )
  }
  return matches[0]!
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/actuator/health`)
      if (res.ok) {
        const body = (await res.json()) as { status?: string }
        if (body.status === 'UP') return
      }
    } catch (err) {
      lastError = err
    }
    await wait(HEALTH_POLL_INTERVAL_MS)
  }
  throw new Error(
    `Backend did not become healthy at ${url}/actuator/health within ${HEALTH_TIMEOUT_MS}ms. Last error: ${String(lastError)}`,
  )
}

export async function startBackend(config: BackendConfig): Promise<BackendHandle> {
  const jar = resolveJarPath()
  const url = `http://127.0.0.1:${BACKEND_PORT}`
  const jdbcUrl = `jdbc:postgresql://${config.postgresHost}:${config.postgresPort}/${config.postgresDatabase}`

  const child = spawn(
    'java',
    ['-jar', jar, `--server.port=${BACKEND_PORT}`],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        SPRING_DATASOURCE_URL: jdbcUrl,
        SPRING_DATASOURCE_USERNAME: config.postgresUsername,
        SPRING_DATASOURCE_PASSWORD: config.postgresPassword,
        // E2E runs over plain HTTP. WebKit/Safari refuses to send `Secure`
        // cookies over HTTP even to 127.0.0.1, which would break the
        // boot-time refresh flow under WebKit.
        APP_AUTH_REFRESH_COOKIE_SECURE: 'false',
        // Overrides `app.auth.access-token-ttl` (defaults to PT15M) so the
        // refresh-on-401 e2e proof can lapse the access token within a
        // Playwright test budget. Scoped to the e2e harness only.
        APP_AUTH_ACCESS_TOKEN_TTL: 'PT2S',
      },
    },
  )

  child.on('error', (err) => {
    throw err
  })

  await waitForHealth(url)
  return { process: child, url }
}

export async function stopBackend(handle: BackendHandle): Promise<void> {
  if (handle.process.exitCode !== null) return
  handle.process.kill('SIGTERM')
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => {
      handle.process.kill('SIGKILL')
    }, 10_000)
    handle.process.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}
