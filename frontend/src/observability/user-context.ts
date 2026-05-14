// Module-level mirror of the authenticated user's opaque UUID, kept in
// sync by `AuthProvider` so non-React callers (window error listeners,
// the React error boundary's `componentDidCatch`) can read it without
// going through the React context tree.
//
// Only the UUID is mirrored — never the email, handle, or display name
// (design Decision 5). The exposure is bounded to "an observer with
// Loki access can correlate a UUID with an account record" — the same
// exposure the backend access log already accepts.

let currentUserId: string | null = null

export function setCurrentUserId(id: string | null): void {
  currentUserId = id
}

export function getCurrentUserId(): string | null {
  return currentUserId
}
