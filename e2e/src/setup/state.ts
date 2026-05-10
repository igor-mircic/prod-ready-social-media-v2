import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const STATE_DIR = resolve(__dirname, '../../.playwright')
export const STATE_FILE = resolve(STATE_DIR, 'state.json')

export interface HarnessState {
  postgres: {
    host: string
    port: number
    database: string
    username: string
    password: string
    containerId: string
  }
  backend: {
    url: string
    pid: number
  }
  frontend: {
    url: string
    pid: number
  }
}

export function writeState(state: HarnessState): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

export function readState(): HarnessState {
  const raw = readFileSync(STATE_FILE, 'utf8')
  return JSON.parse(raw) as HarnessState
}

export function readStateOrNull(): HarnessState | null {
  if (!existsSync(STATE_FILE)) return null
  try {
    return readState()
  } catch {
    return null
  }
}

export function resolveBaseURL(): string {
  const state = readStateOrNull()
  if (state) return state.frontend.url
  // Before globalSetup runs (e.g., during config evaluation), fall back to a
  // placeholder; globalSetup writes the real URL before any test starts and
  // Playwright re-reads `use.baseURL` per-test via the fixture below.
  return 'http://127.0.0.1:0'
}
