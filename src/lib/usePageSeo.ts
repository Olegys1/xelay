import { useEffect } from 'react'
import { SEO_IMAGE, type PageSeo } from './seo'

export function applyPageSeo(meta: PageSeo) {
  document.title = meta.title
  const setMeta = (name: string, value: string, attribute = 'name') => {
    const matches = [...document.head.querySelectorAll<HTMLMetaElement>(`meta[${attribute}="${name}"]`)]
    const node = matches.shift() || document.createElement('meta')
    for (const duplicate of matches) duplicate.remove()
    node.setAttribute(attribute, name); node.setAttribute('content', value)
    if (!node.parentNode) document.head.appendChild(node)
  }
  setMeta('description', meta.description); setMeta('robots', meta.index ? 'index,follow' : 'noindex,follow')
  setMeta('og:type', meta.canonical?.includes('/question/') ? 'article' : 'website', 'property')
  setMeta('og:title', meta.title, 'property'); setMeta('og:description', meta.description, 'property')
  setMeta('twitter:title', meta.title); setMeta('twitter:description', meta.description)
  setMeta('og:image', SEO_IMAGE, 'property'); setMeta('twitter:image', SEO_IMAGE)
  const canonicals = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="canonical"]')]
  const canonical = canonicals.shift()
  for (const duplicate of canonicals) duplicate.remove()
  if (meta.canonical) {
    const node = canonical || document.createElement('link'); node.rel = 'canonical'; node.href = meta.canonical
    if (!node.parentNode) document.head.appendChild(node)
    setMeta('og:url', meta.canonical, 'property')
  } else { canonical?.remove(); for (const node of document.head.querySelectorAll('meta[property="og:url"]')) node.remove() }
}
export function usePageSeo(meta: PageSeo | null, pathname: string, preserveServerQuestion = false) {
  useEffect(() => {
    if (!meta || (window.location.pathname.replace(/\/$/, '') || '/') !== (pathname.replace(/\/$/, '') || '/')) return
    if (preserveServerQuestion && /^\/question\//.test(pathname)
      && document.querySelector('link[rel="canonical"]')?.getAttribute('href') === meta.canonical
      && document.querySelector('meta[property="og:type"]')?.getAttribute('content') === 'article') return
    applyPageSeo(meta)
    // Route navigation owns the reset. Old pages must not restore stale tags.
  }, [meta?.title, meta?.description, meta?.canonical, meta?.index, pathname, preserveServerQuestion])
}
