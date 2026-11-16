/** The local preview never exposes server modules, environment files or private AI accounting. */
export function studentPreviewBlockedPath(raw) {
  if (typeof raw !== 'string' || raw.length > 8192) return true
  let value = raw.split('?')[0]
  try {
    for (let i = 0; i < 3; i++) {
      const decoded = decodeURIComponent(value)
      if (decoded === value) break
      value = decoded
    }
  } catch { return true }
  value = value.replace(/\\/g, '/').toLowerCase()
  return /(?:^|\/)(?:server|\.git|\.env(?:\.[^/]*)?|private-server|local-tutor-private)(?:\/|$)/.test(value)
    || /(?:^|\/)\.\.(?:\/|$)/.test(value)
    || /[\u0000-\u001f\u007f]/.test(value)
}
