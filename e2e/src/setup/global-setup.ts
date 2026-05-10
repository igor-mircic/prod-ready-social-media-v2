import { startPostgres } from './postgres.ts'
import { startBackend } from './backend.ts'
import { startFrontend } from './frontend.ts'
import { writeState } from './state.ts'

export default async function globalSetup(): Promise<void> {
  const postgres = await startPostgres()
  const backend = await startBackend({
    postgresHost: postgres.host,
    postgresPort: postgres.port,
    postgresDatabase: postgres.database,
    postgresUsername: postgres.username,
    postgresPassword: postgres.password,
  })
  const frontend = await startFrontend()

  writeState({
    postgres: {
      host: postgres.host,
      port: postgres.port,
      database: postgres.database,
      username: postgres.username,
      password: postgres.password,
      containerId: postgres.container.getId(),
    },
    backend: { url: backend.url, pid: backend.process.pid ?? -1 },
    frontend: { url: frontend.url, pid: frontend.process.pid ?? -1 },
  })
}
