// Named fixtures shared across the composer hardening spec(s).

// A known XSS payload. If a renderer ever treats this string as HTML, the
// `<script>` runs and `window.__xss` becomes true; the `<img onerror=...>` is
// a secondary path. Used by `posts.composer.hardening.spec.ts` to prove the
// SPA renders post bodies as literal text.
export const XSS_PAYLOAD =
  '<script>window.__xss=true</script><img src=x onerror="window.__xss=true">'

// Returns a deterministic `n`-character string built from a recognisable
// repeating pattern, distinguishable from typical user input.
export function maxLengthBody(n: number): string {
  if (n <= 0) return ''
  return 'abcd'.repeat(Math.ceil(n / 4)).slice(0, n)
}
