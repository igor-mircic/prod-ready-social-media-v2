import { readState } from '../setup/state.ts'

export function resolveBaseURLFromState(): string {
  return readState().frontend.url
}

export function resolveBackendURLFromState(): string {
  return readState().backend.url
}
