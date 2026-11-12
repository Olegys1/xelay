import type { PartnerTool, PartnerToolInput, PartnerToolsAdminData, PartnerToolsApi, PartnerToolSource } from './partnerTools'

const KEY = 'xelay:useful-tools:local-preview:v1'
const WINDOW = 30 * 60 * 1000
type PreviewStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
interface Click { toolId: string; source: PartnerToolSource; at: number }
interface PreviewState { version: 1; tools: PartnerTool[]; clicks: Click[] }
const categories = ['study', 'productivity', 'career', 'other']
const statuses = ['draft', 'published', 'hidden']

export function partnerPreviewDay(at: number): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const part = (kind: string) => p.find(item => item.type === kind)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function seed(at: number): PreviewState {
  const base = { logoUrl: '', updatedAt: new Date(at).toISOString() }
  const tools: PartnerTool[] = [
    { ...base, id: '21111111-1111-4111-8111-111111111111', name: 'Нотатник', description: 'Збирайте конспекти, посилання та ідеї в одному робочому просторі.', category: 'study', destinationUrl: 'https://example.com/notatnyk', status: 'published', featured: true, sortOrder: 10 },
    { ...base, id: '22222222-2222-4222-8222-222222222222', name: 'Ритм', description: 'Плануйте підготовку й залишайте час на головне — без десятка списків.', category: 'productivity', destinationUrl: 'https://example.com/rytm', status: 'published', featured: true, sortOrder: 20 },
    { ...base, id: '23333333-3333-4333-8333-333333333333', name: 'Перший крок', description: 'Упорядкуйте досвід та підготуйте перше резюме для стажування.', category: 'career', destinationUrl: 'https://example.com/pershyi-krok', status: 'published', featured: false, sortOrder: 30 },
    { ...base, id: '24444444-4444-4444-8444-444444444444', name: 'Спільна дошка', description: 'Простір для ідей та командних проєктів. Картка ще готується.', category: 'productivity', destinationUrl: 'https://example.com/spilna-doshka', status: 'draft', featured: false, sortOrder: 40 },
    { ...base, id: '25555555-5555-4555-8555-555555555555', name: 'Мовна практика', description: 'Невеликі мовні вправи на щодень. Приклад прихованої картки.', category: 'study', destinationUrl: 'https://example.com/movna-praktyka', status: 'hidden', featured: false, sortOrder: 50 },
  ]
  const clicks: Click[] = []
  for (let n = 0; n < 14; n++) clicks.push({ toolId: tools[n % 3].id, source: n % 2 ? 'home' : 'catalog', at: at - (n + 2) * 3 * 3600000 })
  return { version: 1, tools, clicks }
}

function destination(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) throw new Error('PARTNER_TOOL_INPUT_INVALID')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('PARTNER_TOOL_INPUT_INVALID') }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local')
    || /^(?:localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) || host.includes(':')) throw new Error('PARTNER_TOOL_INPUT_INVALID')
  return url.href
}

function validate(input: PartnerToolInput) {
  const name = input.name.trim(), description = input.description.trim()
  if (name.length < 2 || name.length > 80 || !description || description.length > 240 || !categories.includes(input.category) || !statuses.includes(input.status)
    || !Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 9999 || typeof input.featured !== 'boolean') throw new Error('PARTNER_TOOL_INPUT_INVALID')
  const logoUrl = input.logoUrl.trim()
  const localImage = logoUrl.length <= 2800000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logoUrl)
  if (logoUrl && !localImage) destination(logoUrl)
  return { ...input, name, description, destinationUrl: destination(input.destinationUrl.trim()), logoUrl }
}

export function createPartnerToolsPreview(options: { storage?: PreviewStorage; now?: () => number } = {}) {
  const now = options.now || Date.now
  const storage = options.storage
  let state = seed(now())
  const listeners = new Set<() => void>()
  try {
    const saved = JSON.parse(storage?.getItem(KEY) || 'null')
    if (saved?.version === 1 && Array.isArray(saved.tools) && saved.tools.length <= 100 && Array.isArray(saved.clicks) && saved.clicks.length <= 2000) {
      const tools = saved.tools.map((tool: PartnerTool) => ({ ...validate(tool), id: tool.id, updatedAt: tool.updatedAt }))
      if (tools.every((tool: PartnerTool) => typeof tool.id === 'string' && Number.isFinite(Date.parse(tool.updatedAt)))) {
        state = { version: 1, tools, clicks: saved.clicks.filter((item: Click) => typeof item?.toolId === 'string' && ['home', 'catalog'].includes(item.source) && Number.isFinite(item.at)) }
      }
    }
  } catch { /* Malformed local demo state is replaced with fresh synthetic data. */ }
  function changed() {
    try { storage?.setItem(KEY, JSON.stringify(state)) } catch { /* The current session still works if browser storage is full. */ }
    listeners.forEach(listener => listener())
  }
  const api: PartnerToolsApi = {
    async listPublic() { return state.tools.filter(tool => tool.status === 'published').sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'uk')).map(tool => ({ ...tool })) },
    async listAdmin(from, to): Promise<PartnerToolsAdminData> {
      const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
      if (!date(from) || !date(to) || from > to || Date.parse(to) - Date.parse(from) > 365 * 86400000) throw new Error('PARTNER_TOOL_INPUT_INVALID')
      const selected = state.clicks.filter(click => { const day = partnerPreviewDay(click.at); return day >= from && day <= to })
      const grouped = new Map<string, { date: string; toolId: string; source: PartnerToolSource; clicks: number }>()
      for (const item of selected) {
        const date = partnerPreviewDay(item.at), key = `${date}:${item.toolId}:${item.source}`
        const current = grouped.get(key) || { date, toolId: item.toolId, source: item.source, clicks: 0 }
        current.clicks++; grouped.set(key, current)
      }
      return { items: [...state.tools].sort((a, b) => a.sortOrder - b.sortOrder).map(tool => ({ ...tool, clicks: selected.filter(click => click.toolId === tool.id).length })), daily: [...grouped.values()].sort((a, b) => b.date.localeCompare(a.date)) }
    },
    async save(input, actorId) {
      if (!actorId) throw new Error('PARTNER_TOOL_ADMIN_MFA_REQUIRED')
      const valid = validate(input)
      const previous = input.id ? state.tools.find(tool => tool.id === input.id) : undefined
      if (input.id && !previous) throw new Error('PARTNER_TOOL_NOT_FOUND')
      if (previous && input.updatedAt !== previous.updatedAt) throw new Error('PARTNER_TOOL_CHANGED')
      const updatedAt = new Date(Math.max(now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString()
      const row: PartnerTool = { ...valid, id: previous?.id || crypto.randomUUID(), updatedAt }
      state.tools = previous ? state.tools.map(tool => tool.id === previous.id ? row : tool) : [...state.tools, row]
      changed(); return { ...row }
    },
    async uploadLogo(file, actorId) {
      if (!actorId) throw new Error('PARTNER_TOOL_ADMIN_MFA_REQUIRED')
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024 || !file.size) throw new Error('PARTNER_TOOL_LOGO_INVALID')
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('PARTNER_TOOL_LOGO_INVALID'))
        reader.readAsDataURL(file)
      })
    },
    async recordClick(toolId, source) {
      if (!['home', 'catalog'].includes(source) || !state.tools.some(tool => tool.id === toolId && tool.status === 'published')) return
      const at = now()
      if (state.clicks.some(click => click.toolId === toolId && at >= click.at && at - click.at < WINDOW)) return
      state.clicks = [...state.clicks, { toolId, source, at }].slice(-2000)
      changed()
    },
  }
  return {
    api,
    reset() { state = seed(now()); changed() },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
