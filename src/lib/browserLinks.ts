/** A browser navigation target from stored or user-entered text. */
export function externalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const input = value.trim()
  if (!/^https?:\/\//i.test(input) || /[\u0000-\u001f\u007f\\]/u.test(input)) return null
  try {
    const url = new URL(input)
    return url.hostname && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}
