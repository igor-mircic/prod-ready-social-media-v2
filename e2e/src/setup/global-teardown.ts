import { execSync } from 'node:child_process'
import { setTimeout as wait } from 'node:timers/promises'
import { readStateOrNull } from './state.ts'

const SHUTDOWN_TIMEOUT_MS = 10_000
const SHUTDOWN_POLL_INTERVAL_MS = 200

function isAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function killByPid(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (!isAlive(pid)) return
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone.
  }
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
  while (isAlive(pid) && Date.now() < deadline) {
    await wait(SHUTDOWN_POLL_INTERVAL_MS)
  }
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

export default async function globalTeardown(): Promise<void> {
  const state = readStateOrNull()
  if (!state) return

  await killByPid(state.frontend.pid, 'SIGTERM')
  await killByPid(state.backend.pid, 'SIGTERM')

  if (state.postgres.containerId) {
    try {
      execSync(`docker rm -f ${state.postgres.containerId}`, { stdio: 'ignore' })
    } catch {
      // Container may already be gone.
    }
  }
}
