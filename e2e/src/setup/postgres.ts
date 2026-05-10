import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

const POSTGRES_DB = 'social'
const POSTGRES_USER = 'social'
const POSTGRES_PASSWORD = 'social'
const POSTGRES_INTERNAL_PORT = 5432

export interface PostgresHandle {
  container: StartedTestContainer
  host: string
  port: number
  database: string
  username: string
  password: string
}

export async function startPostgres(): Promise<PostgresHandle> {
  const container = await new GenericContainer('postgres:16')
    .withEnvironment({
      POSTGRES_DB,
      POSTGRES_USER,
      POSTGRES_PASSWORD,
    })
    .withExposedPorts(POSTGRES_INTERNAL_PORT)
    // Postgres logs "ready to accept connections" once during init scripts and
    // again on the final startup. Wait for the second occurrence so connections
    // do not race the boot sequence.
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start()

  return {
    container,
    host: container.getHost(),
    port: container.getMappedPort(POSTGRES_INTERNAL_PORT),
    database: POSTGRES_DB,
    username: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
  }
}

export async function stopPostgres(container: StartedTestContainer): Promise<void> {
  await container.stop()
}
