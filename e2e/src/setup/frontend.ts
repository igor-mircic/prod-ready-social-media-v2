import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../../')
const FRONTEND_DIR = resolve(REPO_ROOT, 'frontend')

export const FRONTEND_PORT = 4173
const READY_TIMEOUT_MS = 30_000
const READY_POLL_INTERVAL_MS = 250

export interface FrontendHandle {
  process: ChildProcess
  url: string
}

async function waitForReady(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch (err) {
      lastError = err
    }
    await wait(READY_POLL_INTERVAL_MS)
  }
  throw new Error(
    `Frontend did not respond at ${url} within ${READY_TIMEOUT_MS}ms. Last error: ${String(lastError)}`,
  )
}

export async function startFrontend(): Promise<FrontendHandle> {
  const url = `http://127.0.0.1:${FRONTEND_PORT}`

  const child = spawn(
    'pnpm',
    [
      '--dir',
      FRONTEND_DIR,
      'exec',
      'vite',
      'preview',
      '--port',
      String(FRONTEND_PORT),
      '--host',
      '127.0.0.1',
      '--strictPort',
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env },
    },
  )

  child.on('error', (err) => {
    throw err
  })

  await waitForReady(url)
  return { process: child, url }
}

export async function stopFrontend(handle: FrontendHandle): Promise<void> {
  if (handle.process.exitCode !== null) return
  handle.process.kill('SIGTERM')
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => {
      handle.process.kill('SIGKILL')
    }, 5_000)
    handle.process.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}
