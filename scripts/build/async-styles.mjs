export async function loadStylesheet(href) {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  const loaded = new Promise((resolve, reject) => {
    link.onload = resolve
    link.onerror = () => reject(new Error('Unable to load stylesheet ' + href))
  })
  document.head.append(link)
  await loaded
}
