(() => {
  const root = document.documentElement
  const choiceKey = 'xelay_halloween_2026_theme_choice'
  const start = Date.parse('2026-10-18T09:00:00Z')
  const end = Date.parse('2026-11-02T22:00:00Z')
  let saved = null
  let base = null
  let choice = null
  let systemDark = false
  try { systemDark = matchMedia('(prefers-color-scheme: dark)').matches } catch {}
  try {
    saved = localStorage.getItem('xelay_theme')
    base = localStorage.getItem('xelay_theme_base')
    const row = JSON.parse(localStorage.getItem(choiceKey) || 'null')
    if (row?.campaign === 'halloween-2026' && ['light', 'dark', 'halloween'].includes(row.theme)
      && Number.isSafeInteger(row.chosenAt) && row.chosenAt >= start && row.chosenAt < end) choice = row
  } catch {}
  const normal = (value) => value === 'light' || value === 'dark' ? value : null
  const fallback = normal(saved) || normal(base) || (systemDark ? 'dark' : 'light')
  const now = Date.now()
  const available = now >= start && now < end
  const theme = available ? choice?.theme || 'halloween' : fallback
  const nextBase = normal(theme) || fallback
  if (available || saved === 'halloween') {
    try {
      localStorage.setItem('xelay_theme_base', nextBase)
      localStorage.setItem('xelay_theme', theme)
    } catch {}
  }
  root.classList.toggle('dark', theme !== 'light')
  root.dataset.theme = theme
  root.dataset.baseTheme = nextBase
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark'
})()
