(() => {
  const root = document.documentElement
  let preference = 'auto'
  try {
    const saved = localStorage.getItem('xelay_theme_preference_v2')
    if (['auto', 'light', 'dark', 'halloween'].includes(saved)) preference = saved
  } catch {}
  const now = Date.now(), hour = new Date(now).getHours()
  const automatic = hour >= 7 && hour < 19 ? 'light' : 'dark'
  const available = now >= Date.parse('2026-10-18T09:00:00Z') && now < Date.parse('2026-11-02T22:00:00Z')
  const theme = preference === 'halloween' && available ? 'halloween'
    : preference === 'light' || preference === 'dark' ? preference : automatic
  root.classList.toggle('dark', theme !== 'light')
  root.dataset.theme = theme
  root.dataset.themePreference = preference
  root.dataset.baseTheme = theme === 'halloween' ? automatic : theme
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark'
})()
