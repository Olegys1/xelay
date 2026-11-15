import { supabase } from './supabase'
import { partnerClickBrowserId } from './partnerClickIdentity'

export type PartnerToolCategory = 'study' | 'productivity' | 'career' | 'other'
export type PartnerToolStatus = 'draft' | 'published' | 'hidden'
export type PartnerToolSource = 'catalog' | 'home'
export interface PartnerTool {
  id: string
  name: string
  description: string
  category: PartnerToolCategory
  logoUrl: string
  destinationUrl: string
  status: PartnerToolStatus
  featured: boolean
  sortOrder: number
  updatedAt: string
}
export type PartnerToolInput = Omit<PartnerTool, 'id' | 'updatedAt'> & { id?: string; updatedAt?: string }
export interface PartnerToolDailyStat { date: string; toolId: string; source: PartnerToolSource; clicks: number }
export interface PartnerToolsAdminData { items: (PartnerTool & { clicks: number })[]; daily: PartnerToolDailyStat[] }
export interface PartnerToolsApi {
  listPublic(): Promise<PartnerTool[]>
  listAdmin(from: string, to: string): Promise<PartnerToolsAdminData>
  save(input: PartnerToolInput, actorId: string): Promise<PartnerTool>
  uploadLogo(file: File, actorId: string): Promise<string>
  recordClick(toolId: string, source: PartnerToolSource): Promise<void>
}
export const partnerToolCategories: Record<PartnerToolCategory, string> = {
  study: 'Навчання', productivity: 'Продуктивність', career: 'Кар’єра', other: 'Інше',
}
export const partnerToolStatuses: Record<PartnerToolStatus, string> = { draft: 'Чернетка', published: 'Опубліковано', hidden: 'Приховано' }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const invalid = () => new Error('PARTNER_TOOL_RESPONSE_INVALID')
const owns = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}

/** Only normal HTTPS websites. URLs are never fetched by the catalogue server. */
export function safePartnerToolUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return ''
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
      || !host.includes('.') || /[\[\]:]/.test(host) || /^\d+(?:\.\d+){3}$/.test(host)
      || /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(host)
      || host.endsWith('.') || host === 'metadata.google.internal') return ''
    return url.href
  } catch { return '' }
}

export function validatePartnerToolInput(input: PartnerToolInput): PartnerToolInput {
  const name = input.name.trim(), description = input.description.trim()
  if (name.length < 2 || name.length > 80) throw new Error('Вкажіть назву: від 2 до 80 символів.')
  if (!description || description.length > 240) throw new Error('Опишіть користь інструмента: до 240 символів.')
  const destinationUrl = safePartnerToolUrl(input.destinationUrl.trim())
  if (!destinationUrl) throw new Error('Додайте повну HTTPS-адресу публічного сайту без логіна й пароля у посиланні.')
  const logoUrl = input.logoUrl.trim()
  if (logoUrl && !safePartnerToolUrl(logoUrl)) throw new Error('Для логотипа потрібна HTTPS-адреса зображення або завантажений файл.')
  if (!owns(partnerToolCategories, input.category) || !owns(partnerToolStatuses, input.status)
    || typeof input.featured !== 'boolean' || !Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 9999
    || input.id && !uuid.test(input.id) || input.id && !input.updatedAt) throw new Error('Перевірте параметри картки та оновіть список.')
  return { ...input, name, description, destinationUrl, logoUrl }
}

function tool(value: unknown): PartnerTool {
  const row = record(value)
  if (typeof row.id !== 'string' || !uuid.test(row.id) || typeof row.name !== 'string' || typeof row.description !== 'string'
    || typeof row.category !== 'string' || !owns(partnerToolCategories, row.category)
    || typeof row.status !== 'string' || !owns(partnerToolStatuses, row.status) || typeof row.featured !== 'boolean'
    || !Number.isInteger(row.sort_order) || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) throw invalid()
  const destinationUrl = safePartnerToolUrl(row.destination_url)
  const logoUrl = row.logo_url ? safePartnerToolUrl(row.logo_url) : ''
  if (!destinationUrl || row.logo_url && !logoUrl) throw invalid()
  return { id: row.id, name: row.name, description: row.description, category: row.category as PartnerToolCategory,
    logoUrl, destinationUrl, status: row.status as PartnerToolStatus, featured: row.featured, sortOrder: Number(row.sort_order), updatedAt: row.updated_at }
}

export async function loadPartnerTools(): Promise<PartnerTool[]> {
  const { data, error } = await supabase.rpc('xelay_partner_tools')
  if (error) throw error
  const response = record(data)
  if (!Array.isArray(response.items) || response.items.length > 500) throw invalid()
  const items = response.items.map(tool)
  if (items.some(item => item.status !== 'published') || new Set(items.map(item => item.id)).size !== items.length) throw invalid()
  return items
}

export function partnerToolToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const get = (name: string) => parts.find(part => part.type === name)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}
export function partnerToolDateDaysAgo(days: number): string {
  const date = new Date(`${partnerToolToday()}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}
export function validPartnerStatsRange(from: string, to: string): boolean {
  const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s
  return valid(from) && valid(to) && from <= to && Date.parse(to) - Date.parse(from) <= 365 * 86400000
}

export async function loadAdminPartnerTools(from: string, to: string): Promise<PartnerToolsAdminData> {
  if (!validPartnerStatsRange(from, to)) throw new Error('Оберіть період до 366 днів, де початок не пізніше за кінець.')
  const { data, error } = await supabase.rpc('xelay_admin_partner_tools', { p_from: from, p_to: to })
  if (error) throw error
  const response = record(data)
  if (!Array.isArray(response.items) || !Array.isArray(response.daily)) throw invalid()
  const items = response.items.map(value => {
    const raw = record(value)
    if (!Number.isSafeInteger(raw.clicks) || Number(raw.clicks) < 0) throw invalid()
    return { ...tool(raw), clicks: Number(raw.clicks) }
  })
  const daily = response.daily.map(value => {
    const row = record(value)
    if (typeof row.date !== 'string' || !validPartnerStatsRange(row.date, row.date) || row.date < from || row.date > to
      || typeof row.tool_id !== 'string' || !uuid.test(row.tool_id) || !['home', 'catalog'].includes(String(row.source))
      || !Number.isSafeInteger(row.clicks) || Number(row.clicks) < 0) throw invalid()
    return { date: row.date, toolId: row.tool_id, source: row.source as PartnerToolSource, clicks: Number(row.clicks) }
  })
  return { items, daily }
}

export async function savePartnerTool(input: PartnerToolInput, actorId: string): Promise<PartnerTool> {
  if (!uuid.test(actorId)) throw new Error('PARTNER_ADMIN_MFA_REQUIRED')
  const valid = validatePartnerToolInput(input)
  const { data, error } = await supabase.rpc('xelay_admin_save_partner_tool', {
    p_expected_actor_id: actorId, p_payload: {
      ...(valid.id ? { id: valid.id, updated_at: valid.updatedAt } : {}),
      name: valid.name, description: valid.description, category: valid.category,
      destination_url: valid.destinationUrl, logo_url: valid.logoUrl || null,
      status: valid.status, featured: valid.featured, sort_order: valid.sortOrder,
    },
  })
  if (error) throw error
  return tool(data)
}

export async function uploadPartnerLogo(file: File, actorId: string): Promise<string> {
  if (!uuid.test(actorId) || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024 || !file.size) {
    throw new Error('Додайте PNG, JPG або WebP до 2 МБ.')
  }
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)
  const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  if (!(file.type === 'image/png' && png || file.type === 'image/jpeg' && jpg || file.type === 'image/webp' && webp)) throw new Error('Формат вмісту не відповідає зображенню. Оберіть інший файл.')
  const extension = png ? 'png' : jpg ? 'jpg' : 'webp'
  const key = `${actorId}/${crypto.randomUUID()}.${extension}`
  const { error } = await supabase.storage.from('partner-logos').upload(key, file, { contentType: file.type, cacheControl: '3600', upsert: false })
  if (error) throw error
  const result = supabase.storage.from('partner-logos').getPublicUrl(key)
  const url = safePartnerToolUrl(result.data.publicUrl)
  if (!url) throw invalid()
  return url
}

export async function recordPartnerToolClick(toolId: string, source: PartnerToolSource): Promise<void> {
  if (!uuid.test(toolId) || !['home', 'catalog'].includes(source)) return
  // A blocked collector must never interrupt opening the partner's website.
  try {
    await fetch('/api/partners/click', { method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId, source, browserId: partnerClickBrowserId() }), signal: AbortSignal.timeout(4000) })
  } catch { /* The external link remains usable when statistics are unavailable. */ }
}
export const partnerToolsApi: PartnerToolsApi = { listPublic: loadPartnerTools, listAdmin: loadAdminPartnerTools, save: savePartnerTool, uploadLogo: uploadPartnerLogo, recordClick: recordPartnerToolClick }

export function partnerToolsError(error: unknown): string {
  const item = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {}
  const message = typeof item.message === 'string' ? item.message : ''
  if (item.code === '42501' || /ADMIN.*MFA|ADMIN_MFA/.test(message)) return 'Для керування потрібен адміністраторський вхід із двоетапним підтвердженням.'
  if (/PARTNER_TOOL_CHANGED/.test(message)) return 'Картку вже змінили. Оновіть список, щоб не перезаписати чужі правки.'
  if (/PARTNER_CATALOG_LIMIT/.test(message)) return 'У каталозі вже 500 карток. Відредагуйте наявну картку.'
  if (/PARTNER_INPUT_INVALID|PARTNER_TOOL_INPUT_INVALID/.test(message)) return 'Перевірте назву, опис і HTTPS-посилання. Логотип — PNG, JPG або WebP до 2 МБ.'
  if (item.code === 'PGRST202' || item.code === '42P01') return 'Розділ ще не підключено. Спробуйте пізніше.'
  if (message && !/^[A-Z_0-9: ]+$/.test(message) && !/fetch|network|jwt|token|sql|column|relation|permission/i.test(message) && message.length <= 180) return message
  return 'Не вдалося виконати дію. Перевірте з’єднання й повторіть спробу.'
}
