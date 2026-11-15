import { useRouterState } from '@tanstack/react-router'
import { categoryToSlug } from '../types'
import { metadataForPath } from '../lib/seo'
import { usePageSeo } from '../lib/usePageSeo'
export function RouteSeo() {
  const location = useRouterState({ select: state => state.location })
  const category = (location.search as { category?: string }).category
  const path = category && ['/', '/community'].includes(location.pathname) ? `/category/${categoryToSlug(category)}` : location.pathname
  usePageSeo(metadataForPath(path), location.pathname, true)
  return null
}
