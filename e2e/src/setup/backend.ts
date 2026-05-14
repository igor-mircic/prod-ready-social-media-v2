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
  const matches = globSync(pattern).filter(
    (p) => !p.endsWith('-plain.jar') && !p.endsWith('opentelemetry-javaagent.jar'),
  )
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

function resolveOtelAgentPath(): string {
  // The `bootJar` task in backend/build.gradle.kts depends on
  // `copyOtelAgentForBootJar`, which deposits the agent JAR alongside the
  // application JAR at this stable path.
  return resolve(REPO_ROOT, 'backend/build/libs/opentelemetry-javaagent.jar')
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
  const otelAgent = resolveOtelAgentPath()
  const url = `http://127.0.0.1:${BACKEND_PORT}`
  const jdbcUrl = `jdbc:postgresql://${config.postgresHost}:${config.postgresPort}/${config.postgresDatabase}`

  const child = spawn(
    'java',
    [`-javaagent:${otelAgent}`, '-jar', jar, `--server.port=${BACKEND_PORT}`],
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
        // OTel agent defaults. Each yields to the parent env when set
        // (e.g. CI exports `OTEL_TRACES_EXPORTER=none` to silence the
        // exporter retries against a non-existent collector). When the
        // parent env is clean, the harness's defaults take effect and
        // the agent's OTLP exporter logs a connection-refused warning
        // and continues — span emission is verified by TracingIT, not
        // e2e, so the warning is acceptable noise in that path.
        OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME ?? 'backend',
        OTEL_RESOURCE_ATTRIBUTES:
          process.env.OTEL_RESOURCE_ATTRIBUTES ??
          'service.environment=local,deployment.environment=local',
        OTEL_TRACES_EXPORTER: process.env.OTEL_TRACES_EXPORTER ?? 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL:
          process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf',
        OTEL_EXPORTER_OTLP_ENDPOINT:
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
        OTEL_METRICS_EXPORTER: process.env.OTEL_METRICS_EXPORTER ?? 'none',
        OTEL_LOGS_EXPORTER: process.env.OTEL_LOGS_EXPORTER ?? 'none',
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
