// Accept a public username or a profile link, then rebuild destinations ourselves.
// A syntactically valid username is not proof that the account exists.
export function normalizeTelegramUsername(value: string | null | undefined): string | null {
  let username = (value || '').trim()
  if (!username || username.length > 128 || /[\s\u0000-\u001f\u007f]/.test(username)) return null

  if (/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i.test(username)) {
    // Check the original path before URL normalizes dot segments or backslashes.
    if (!/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/@?[A-Za-z0-9_]+\/?(?:[?#].*)?$/i.test(username)) return null
    try {
      const url = new URL(/^https?:\/\//i.test(username) ? username : `https://${username}`)
      if (!['https:', 'http:'].includes(url.protocol)
        || !['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me'].includes(url.hostname.toLowerCase())
        || url.username || url.password || url.port
        || !/^\/@?[A-Za-z0-9_]+\/?$/.test(url.pathname)) return null
      // Query strings on copied profile links do not become part of the username.
      username = url.pathname.replace(/^\/@?/, '').replace(/\/$/, '')
    } catch { return null }
  } else {
    username = username.replace(/^@/, '')
  }

  if (!/^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(username)
    || ['joinchat', 'share', 'addstickers', 'addemoji', 'proxy', 'socks', 'login', 'confirmphone', 'setlanguage', 'iv'].includes(username.toLowerCase())) return null
  return username
}

export function telegramContactLinks(username: string) {
  const safe = normalizeTelegramUsername(username)
  if (!safe) return null
  return {
    username: safe,
    app: `tg://resolve?domain=${encodeURIComponent(safe)}`,
    web: `https://web.telegram.org/k/#@${encodeURIComponent(safe)}`,
  }
}
