export type ResourceLinkLabels = Record<string, string>

export const MAX_RESOURCE_LINK_LABEL_LENGTH = 80

const controls = /[\u0000-\u001f\u007f-\u009f]/u

function resourceUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed) || controls.test(trimmed) || trimmed.length > 2048) return null
  try {
    const url = new URL(trimmed)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && url.href.length <= 2048 ? url.href : null
  } catch { return null }
}

function validLabel(value: unknown): value is string {
  return typeof value === 'string' && !controls.test(value)
    && Array.from(value.trim()).length <= MAX_RESOURCE_LINK_LABEL_LENGTH
}

export function getResourceLinkLabels(value: unknown, urls: string[]): ResourceLinkLabels {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const allowed = new Set(urls.map(resourceUrl).filter((url): url is string => Boolean(url)))
  const labels: ResourceLinkLabels = {}
  for (const [key, candidate] of Object.entries(value)) {
    const url = resourceUrl(key)
    if (!url || !allowed.has(url) || !validLabel(candidate)) continue
    const label = candidate.trim()
    if (label && !Object.prototype.hasOwnProperty.call(labels, url)) labels[url] = label
  }
  return labels
}

export function getResourceLinkTitles(urls: string[], value: unknown): string[] {
  const labels = getResourceLinkLabels(value, urls)
  return urls.map((url) => labels[resourceUrl(url) || ''] || '')
}

export function normalizeResourceLinkLabels(rawLinks: string[], titles: string[]): ResourceLinkLabels {
  const labels: ResourceLinkLabels = {}
  for (let index = 0; index < rawLinks.length; index += 1) {
    if (!rawLinks[index].trim()) continue
    const url = resourceUrl(rawLinks[index])
    if (!url) throw new Error('Введіть повне посилання, що починається з https:// або http://, до 2048 символів.')
    const title = titles[index] ?? ''
    if (!validLabel(title)) {
      throw new Error(`Назва посилання має містити не більше ${MAX_RESOURCE_LINK_LABEL_LENGTH} символів без перенесення рядка.`)
    }
    const label = title.trim()
    if (label && !Object.prototype.hasOwnProperty.call(labels, url)) labels[url] = label
  }
  return labels
}
