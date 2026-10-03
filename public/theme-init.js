(() => {
  let theme = 'light'
  try { if (localStorage.getItem('xelay_theme') === 'dark') theme = 'dark' } catch {}
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.dataset.theme = theme
  root.style.colorScheme = theme
})()
