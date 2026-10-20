import { supabase } from './supabase'

export type AdminBillingProduct = 'participant' | 'group' | 'support'
export type AdminBillingStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'refunded' | 'voided'
export type AdminBillingMode = 'test' | 'live'
export type AdminBillingFilters = { product: AdminBillingProduct | ''; status: AdminBillingStatus | ''; mode: AdminBillingMode | ''; query: string }
export type AdminBillingTransaction = {
  id: string; source: 'billing' | 'support'; user_id: string; product: AdminBillingProduct
  amount: number; currency: 'UAH'; mode: AdminBillingMode; status: AdminBillingStatus
  created_at: string; approved_at: string | null; order_reference: string; fee_amount: number | null
  full_name: string | null; username: string | null
}
export type AdminBillingPage = { transactions: AdminBillingTransaction[]; total: number; limit: number; offset: number; snapshot_at: string }
export const ADMIN_BILLING_PAGE_SIZE = 50
export const ADMIN_BILLING_EXPORT_LIMIT = 100000
export const ADMIN_BILLING_STATUS: Record<AdminBillingStatus, string> = {
  pending: 'Очікує', approved: 'Сплачено', declined: 'Відхилено', expired: 'Час вичерпано', refunded: 'Повернено', voided: 'Скасовано',
}
export const ADMIN_BILLING_PRODUCT: Record<AdminBillingProduct, string> = {
  participant: 'Учасник', group: 'Група (попередні оплати)', support: 'Підтримка Xelay',
}
const malformed = () => new Error('Отримано неповні дані оплат. Оновіть список або зверніться до адміністратора.')
const validDate = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const hasKey = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Операцію скасовано.', 'AbortError')
}
export async function assertAdminBillingIdentity(userId: string, signal?: AbortSignal) {
  abortIfNeeded(signal)
  const { data, error } = await supabase.auth.getSession()
  abortIfNeeded(signal)
  if (error || !userId || data.session?.user.id !== userId) throw new Error('Обліковий запис змінився або сесія завершилася. Увійдіть повторно.')
}
function amount(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN
  if (!Number.isFinite(number) || number < 0 || number > 1e12) throw malformed()
  return number
}
function optionalLabel(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string' || value.length > 500) throw malformed()
  return value
}
function parsePage(value: unknown, limit: number, offset: number): AdminBillingPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed()
  const row = value as Record<string, unknown>
  const total = Number(row.total)
  if ((typeof row.total !== 'number' && !(typeof row.total === 'string' && /^\d+$/.test(row.total)))
    || !Array.isArray(row.transactions) || !Number.isSafeInteger(total) || total < 0
    || row.limit !== limit || row.offset !== offset || !validDate(row.snapshot_at)
    || row.transactions.length !== Math.min(limit, Math.max(0, total - offset))) throw malformed()
  const keys = new Set<string>()
  const transactions = row.transactions.map((item): AdminBillingTransaction => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw malformed()
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || !UUID.test(record.id)
      || typeof record.user_id !== 'string' || !UUID.test(record.user_id)
      || typeof record.source !== 'string' || !['billing', 'support'].includes(record.source)
      || typeof record.product !== 'string' || !hasKey(ADMIN_BILLING_PRODUCT, record.product)
      || typeof record.status !== 'string' || !hasKey(ADMIN_BILLING_STATUS, record.status)
      || typeof record.mode !== 'string' || !['test', 'live'].includes(record.mode) || record.currency !== 'UAH'
      || !validDate(record.created_at) || (record.approved_at != null && !validDate(record.approved_at))
      || typeof record.order_reference !== 'string' || !record.order_reference || record.order_reference.length > 250
      || (record.source === 'support') !== (record.product === 'support')) throw malformed()
    const key = record.source + ':' + record.id
    if (keys.has(key)) throw malformed()
    keys.add(key)
    return { id: record.id, source: record.source as AdminBillingTransaction['source'], user_id: record.user_id,
      product: record.product as AdminBillingProduct, amount: amount(record.amount), currency: 'UAH',
      mode: record.mode as AdminBillingMode, status: record.status as AdminBillingStatus,
      created_at: record.created_at, approved_at: (record.approved_at as string | null) ?? null,
      order_reference: record.order_reference, fee_amount: record.fee_amount == null ? null : amount(record.fee_amount),
      full_name: optionalLabel(record.full_name), username: optionalLabel(record.username) }
  })
  return { transactions, total, limit, offset, snapshot_at: row.snapshot_at }
}
export async function loadAdminBillingTransactions(options: {
  userId: string; filters: AdminBillingFilters; limit?: number; offset?: number; before?: string | null; signal?: AbortSignal
}): Promise<AdminBillingPage> {
  const { userId, filters, signal } = options
  const limit = options.limit ?? ADMIN_BILLING_PAGE_SIZE, offset = options.offset ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0
    || (options.before != null && !validDate(options.before)) || filters.query.length > 120
    || (filters.product && !hasKey(ADMIN_BILLING_PRODUCT, filters.product))
    || (filters.status && !hasKey(ADMIN_BILLING_STATUS, filters.status))
    || (filters.mode && !['test', 'live'].includes(filters.mode))) throw new Error('Перевірте фільтри оплат.')
  await assertAdminBillingIdentity(userId, signal)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = window.setTimeout(abort, 30000)
  try {
    const { data, error } = await supabase.rpc('xelay_admin_billing_transactions', {
      p_limit: limit, p_offset: offset, p_product: filters.product || null, p_status: filters.status || null,
      p_mode: filters.mode || null, p_query: filters.query.trim() || null, p_before: options.before || null,
    }).abortSignal(controller.signal)
    abortIfNeeded(signal)
    if (controller.signal.aborted) throw new Error('Завантаження оплат триває задовго. Спробуйте ще раз.')
    if (error) throw new Error('Список оплат недоступний. Перевірте права адміністратора або оновіть сторінку.')
    await assertAdminBillingIdentity(userId, signal)
    const result = parsePage(data, limit, offset)
    if (options.before && Date.parse(result.snapshot_at) !== Date.parse(options.before)) throw malformed()
    return result
  } finally { window.clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
export function isSixSevenTransaction(transaction: AdminBillingTransaction): boolean {
  return transaction.source === 'support' && transaction.product === 'support' && transaction.mode === 'live'
    && transaction.status === 'approved' && transaction.amount === 67
}
function csvCell(value: unknown): string {
  const text = String(value ?? '')
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(text) ? "'" + text : text
  return '"' + safe.replace(/"/g, '""') + '"'
}
/** Complete filtered export; refuses a partial result or a changing selection. */
export async function exportAdminBillingTransactions(options: {
  userId: string; filters: AdminBillingFilters; before: string; signal: AbortSignal
  onProgress?: (loaded: number, total: number) => void
}): Promise<{ blob: Blob; count: number; snapshotAt: string }> {
  const rows: AdminBillingTransaction[] = []
  const keys = new Set<string>()
  let expectedTotal: number | null = null
  for (;;) {
    abortIfNeeded(options.signal)
    const page = await loadAdminBillingTransactions({ userId: options.userId, filters: options.filters,
      limit: 200, offset: rows.length, before: options.before, signal: options.signal })
    if (expectedTotal === null) {
      expectedTotal = page.total
      if (expectedTotal > ADMIN_BILLING_EXPORT_LIMIT) throw new Error('Вибірка перевищує 100 000 транзакцій. Звузьте фільтри. Частковий файл не створено.')
    } else if (page.total !== expectedTotal) throw new Error('Статуси оплат змінилися під час експорту. Оновіть список і повторіть експорт. Частковий файл не створено.')
    for (const transaction of page.transactions) {
      const key = transaction.source + ':' + transaction.id
      if (keys.has(key)) throw new Error('Список оплат змінився під час експорту. Оновіть його й повторіть. Частковий файл не створено.')
      keys.add(key); rows.push(transaction)
    }
    options.onProgress?.(rows.length, expectedTotal)
    if (rows.length === expectedTotal) break
    if (!page.transactions.length || rows.length > expectedTotal || rows.length >= ADMIN_BILLING_EXPORT_LIMIT) throw new Error('Не вдалося отримати повний список оплат. Оновіть його й повторіть експорт. Частковий файл не створено.')
  }
  await assertAdminBillingIdentity(options.userId, options.signal)
  const header = ['ID', 'Джерело', 'Замовлення', 'Продукт', 'Сума, грн', 'Валюта', 'Статус', 'Режим', 'Створено', 'Сплачено', 'Комісія, грн', 'ID покупця', 'Ім’я покупця', 'Нік', 'Позначка']
  const csvRows = rows.map((transaction) => [transaction.id, transaction.source === 'support' ? 'Підтримка' : 'Підписки',
    transaction.order_reference, ADMIN_BILLING_PRODUCT[transaction.product], transaction.amount, transaction.currency,
    ADMIN_BILLING_STATUS[transaction.status], transaction.mode === 'test' ? 'Тест' : 'Реальна оплата',
    transaction.created_at, transaction.approved_at, transaction.fee_amount, transaction.user_id,
    transaction.full_name, transaction.username, isSixSevenTransaction(transaction) ? '67 · Six Seven' : ''])
  return { blob: new Blob(['\uFEFF' + [header, ...csvRows].map((row) => row.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }),
    count: rows.length, snapshotAt: options.before }
}

