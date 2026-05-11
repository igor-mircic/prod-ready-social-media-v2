// Prefix of the orval-generated list query key. TanStack Query treats this
// as a prefix match during invalidation, so a single invalidate refetches
// every cursor page of the same author's timeline.
export function postsByAuthorListKeyPrefix(userId: string) {
  return [`/api/v1/users/${userId}/posts`] as const
}
