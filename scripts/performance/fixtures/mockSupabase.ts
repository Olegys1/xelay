type Row = Record<string, any>
type Result = { data: any; error: null | { code: string; message: string }; count?: number | null }
const ownId = '11111111-1111-4111-8111-111111111111'
const peerId = '22222222-2222-4222-8222-222222222222'
const now = () => new Date().toISOString()
const profile = { id: ownId, full_name: 'Локальний студент', email: 'local@example.invalid', username: 'local_student',
  country: 'Україна', city: 'Київ', faculty: 'Економічний факультет', specialty: 'Економіка', experience: 'Студент бакалаврату',
  categories: ['General Questions'], study_year: 1, has_seen_onboarding: true, created_at: now() }
const tables: Record<string, Row[]> = {
  profiles: [profile, { ...profile, id: peerId, full_name: 'Локальний автор', username: 'local_author' }],
  questions: [
    { id: '33333333-3333-4333-8333-333333333333', user_id: peerId, title: 'Закріплене локальне запитання', content: 'Закріплене локальне запитання. ' + 'Матеріали для підготовки до семінару. '.repeat(8), category: 'General Questions', author_name: 'Локальний автор', author_avatar: '', is_pinned: true, created_at: now(), answers_count: 1, views: 5 },
    { id: '44444444-4444-4444-8444-444444444444', user_id: ownId, title: 'Моє запитання для перевірки видалення', content: 'Моє запитання для перевірки видалення', category: 'Learning', author_name: profile.full_name, author_avatar: '', is_pinned: false, created_at: now(), answers_count: 0, views: 1 },
    { id: '55555555-5555-4555-8555-555555555555', user_id: peerId, title: 'Локальне запитання без фото', content: 'Локальне запитання без фото', category: 'Career', author_name: 'Анонім', author_avatar: '', is_pinned: false, created_at: now(), answers_count: 0, views: 2 },
  ],
  question_images: [
    { id: 'image-1', question_id: '33333333-3333-4333-8333-333333333333', image_url: '/images/eub-4-timetable-example.png' },
    { id: 'unrelated-image', question_id: 'not-in-feed', image_url: '/profile-mobile-background.jpg' },
  ],
  answers: [{ id: 'answer-local', question_id: '33333333-3333-4333-8333-333333333333', user_id: peerId, author_name: 'Локальний автор', content: 'Локальна відповідь', text: 'Локальна відповідь', created_at: now() }],
  notifications: [{ id: 'notice-1', recipient_id: ownId, actor_name: 'Локальний автор', message: 'Локальне сповіщення для перевірки лічильника', is_read: false, type: 'answer', question_id: '33333333-3333-4333-8333-333333333333', created_at: now() }],
  notification_preferences: [{ user_id: ownId, notifications_enabled: true, email_notifications_enabled: false }],
  user_roles: [], class_representative_requests: [], study_group_members: [], messages: [], account_announcement_receipts: [],
}
const channels = new Set<any>()
const authListeners = new Set<any>()
const blobs = new Map<string, string>()
const requestLog: Row[] = []
const changeListeners = new Set<() => void>()
let activeUser: Row | null = { id: ownId, email: profile.email }
let delay = 20
let nextFailure: string | null = null
let nextThrownFailure: string | null = null
let nextHangingRead: string | null = null
let active = 0
let maxActive = 0
let fakeVisibility = 'visible'
let realtimeEnabled = true
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const changed = () => changeListeners.forEach(listener => listener())
function emit(table: string, eventType: string, row: Row = {}) {
  if (!realtimeEnabled) return
  for (const channel of channels) for (const sub of channel.listeners) {
    if (sub.kind !== 'postgres_changes' || sub.filter.table !== table || !['*', eventType].includes(sub.filter.event)) continue
    if (sub.filter.filter) {
      const [key, value] = sub.filter.filter.split('=eq.')
      if (eventType !== 'DELETE' && row[key] !== value) continue
    }
    sub.callback({ eventType, new: eventType === 'DELETE' ? {} : clone(row), old: eventType === 'DELETE' ? clone(row) : {} })
  }
}
async function run(name: string, detail: Row, result: Result, signal?: AbortSignal): Promise<Result> {
  const failure = nextFailure === name
  const thrown = nextThrownFailure === name
  const hanging = nextHangingRead === name && !detail.head
  if (failure) nextFailure = null
  if (thrown) nextThrownFailure = null
  if (hanging) nextHangingRead = null
  const duration = delay
  const entry = { name, detail: clone(detail), started: performance.now(), finished: false, error: failure || thrown }
  requestLog.push(entry); active += 1; maxActive = Math.max(maxActive, active); changed()
  try {
    if (hanging) {
      await new Promise<void>(resolve => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    } else await new Promise(resolve => setTimeout(resolve, duration))
    if (signal?.aborted) return { data: null, error: { code: 'ABORTED', message: 'Local request aborted' } }
    if (thrown) throw new TypeError('Local simulated transport failure')
    return failure ? { data: null, error: { code: 'LOCAL_NETWORK_ERROR', message: 'Local simulated network failure' } } : result
  } finally { active -= 1; entry.finished = true; changed() }
}
class Query {
  table: string; action = 'select'; payload: any; fields = '*'; options: Row = {}; filters: Array<(row: Row) => boolean> = []
  filterDetails: Row[] = []; ordering: Row[] = []; maximum?: number; singleRow = false; signal?: AbortSignal; promise?: Promise<Result>
  constructor(table: string) { this.table = table }
  select(fields = '*', options: Row = {}) { this.fields = fields; this.options = options; return this }
  eq(field: string, value: any) { this.filters.push(row => row[field] === value); this.filterDetails.push({ field, op: 'eq', value }); return this }
  in(field: string, values: any[]) { this.filters.push(row => values.includes(row[field])); this.filterDetails.push({ field, op: 'in', values }); return this }
  is(field: string, value: any) { this.filters.push(row => value === null ? row[field] == null : row[field] === value); return this }
  gt(field: string, value: any) { this.filters.push(row => row[field] > value); return this }
  order(field: string, options: Row = {}) { this.ordering.push({ field, ascending: options.ascending !== false }); return this }
  limit(value: number) { this.maximum = value; return this }
  range(_from: number, to: number) { this.maximum = to + 1; return this }
  or(_value: string, _options?: any) { return this }
  not(_field: string, _operator: string, _value: any) { return this }
  ilike(field: string, value: string) { const needle = value.replaceAll('%', '').toLowerCase(); this.filters.push(row => String(row[field] || '').toLowerCase().includes(needle)); return this }
  abortSignal(signal: AbortSignal) { this.signal = signal; return this }
  maybeSingle() { this.singleRow = true; return this }
  single() { this.singleRow = true; return this }
  insert(payload: any) { this.action = 'insert'; this.payload = payload; return this }
  upsert(payload: any, _options?: any) { this.action = 'upsert'; this.payload = payload; return this }
  update(payload: any) { this.action = 'update'; this.payload = payload; return this }
  delete() { this.action = 'delete'; return this }
  then(resolve: any, reject: any) { return (this.promise ||= this.execute()).then(resolve, reject) }
  execute() {
    const rows = tables[this.table] ||= []
    let selected = rows.filter(row => this.filters.every(filter => filter(row)))
    if (this.action === 'insert' || this.action === 'upsert') {
      selected = (Array.isArray(this.payload) ? this.payload : [this.payload]).map(row => ({ id: crypto.randomUUID(), created_at: now(), ...row }))
      rows.push(...selected)
      selected.forEach(row => emit(this.table, 'INSERT', row))
    } else if (this.action === 'update') {
      selected.forEach(row => Object.assign(row, this.payload))
      selected.forEach(row => emit(this.table, 'UPDATE', row))
    } else if (this.action === 'delete') {
      tables[this.table] = rows.filter(row => !selected.includes(row))
      selected.forEach(row => emit(this.table, 'DELETE', row))
    }
    const count = selected.length
    selected = [...selected].sort((a, b) => {
      for (const order of this.ordering) {
        const compare = a[order.field] === b[order.field] ? 0 : a[order.field] > b[order.field] ? 1 : -1
        if (compare) return compare * (order.ascending ? 1 : -1)
      }
      return 0
    })
    if (this.maximum !== undefined) selected = selected.slice(0, this.maximum)
    let output = clone(selected)
    if (this.fields.includes('news_posts!inner')) output = []
    const data = this.options.head ? null : this.singleRow ? output[0] || null : output
    return run(this.table, { action: this.action, fields: this.fields, filters: this.filterDetails, limit: this.maximum ?? null, head: Boolean(this.options.head) }, { data, count: this.options.count ? count : null, error: null }, this.signal)
  }
}
export const supabase: any = {
  from: (table: string) => new Query(table),
  rpc: (name: string, args: Row = {}) => {
    let data: any = null
    if (name === 'xelay_member_count') data = 208
    else if (name === 'xelay_profiles_by_ids') data = tables.profiles.filter(row => args.p_user_ids?.includes(row.id))
    else if (name === 'xelay_chat_unread_count') data = 0
    else if (name === 'xelay_free_groups_available') data = false
    else if (name === 'xelay_billing_status') data = { is_premium: false, expires_at: null, emoji_status: null, status_text: null, search_unlimited: true, search_used: 0, search_limit: null }
    else if (name === 'xelay_connection_request_status') data = { limit: 3, used: 0, remaining: 3, unlimited: true, free_communication: true, resets_at: null }
    else if (name === 'xelay_teacher_status') data = { verified: false, status: 'none', request: null }
    else if (name === 'xelay_public_premium') data = (args.p_user_ids || []).map((id: string) => ({ user_id: id, is_premium: false, emoji_status: null, status_text: null }))
    else if (name === 'xelay_delete_own_question') {
      const index = tables.questions.findIndex(row => row.id === args.p_question_id && row.user_id === activeUser?.id)
      if (index < 0) return Promise.resolve({ data: null, error: { code: '42501', message: 'Local owner mismatch' } })
      const [row] = tables.questions.splice(index, 1); tables.question_images = tables.question_images.filter(image => image.question_id !== row.id); emit('questions', 'DELETE', row)
    } else if (name === 'increment_question_views') data = 1
    else if (!['xelay_reserve_public_media_upload', 'xelay_cancel_public_media_upload'].includes(name)) {
      return run(name, args, { data: null, error: { code: 'PGRST202', message: `Isolated fixture RPC not implemented: ${name}` } })
    }
    return run(name, args, { data: clone(data), error: null })
  },
  channel: (name: string) => {
    const channel: any = { name, listeners: [], on(kind: string, filter: any, callback: any) { this.listeners.push({ kind, filter, callback }); return this },
      subscribe(callback?: any) { this.callback = callback; channels.add(this); queueMicrotask(() => channels.has(this) && callback?.(realtimeEnabled ? 'SUBSCRIBED' : 'CHANNEL_ERROR')); return this },
      unsubscribe() { channels.delete(this); return Promise.resolve('ok') }, send() { return Promise.resolve('ok') } }
    return channel
  },
  removeChannel: (channel: any) => { channels.delete(channel); return Promise.resolve('ok') },
  auth: {
    onAuthStateChange: (callback: any) => { authListeners.add(callback); queueMicrotask(() => callback('INITIAL_SESSION', activeUser ? { user: activeUser } : null)); return { data: { subscription: { unsubscribe: () => authListeners.delete(callback) } } } },
    getSession: async () => ({ data: { session: activeUser ? { user: activeUser, access_token: 'local-fixture-no-real-token' } : null }, error: null }),
    getUser: async () => ({ data: { user: activeUser }, error: null }),
    signOut: async () => { activeUser = null; authListeners.forEach(callback => callback('SIGNED_OUT', null)); return { error: null } },
    signInWithPassword: async () => { activeUser = { id: ownId, email: profile.email }; authListeners.forEach(callback => callback('SIGNED_IN', { user: activeUser })); return { data: { user: activeUser, session: { user: activeUser } }, error: null } },
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }), listFactors: async () => ({ data: { totp: [] }, error: null }) },
  },
  storage: { from: (bucket: string) => ({
    upload: async (key: string, file: File) => { blobs.set(`${bucket}/${key}`, URL.createObjectURL(file)); return { data: { path: key }, error: null } },
    getPublicUrl: (key: string) => ({ data: { publicUrl: blobs.get(`${bucket}/${key}`) || '/images/eub-4-timetable-example.png' } }),
    remove: async (paths: string[]) => ({ data: paths.map(name => ({ name })), error: null }),
  }) },
}
export function emailLinkVerifier() { return supabase }
export const fixture = {
  subscribe(listener: () => void) { changeListeners.add(listener); return () => { changeListeners.delete(listener) } },
  snapshot() { return { requests: clone(requestLog), active, maxActive, channels: channels.size, visibility: fakeVisibility, questions: tables.questions.length, notifications: tables.notifications.filter(row => !row.is_read && row.recipient_id === activeUser?.id).length } },
  clearMetrics() { requestLog.splice(0); maxActive = active; changed() },
  slow(enabled: boolean) { delay = enabled ? 1800 : 20; changed() },
  fail(table = 'question_images', thrown = false) { if (thrown) nextThrownFailure = table; else nextFailure = table; changed() },
  hang(table = 'questions') { nextHangingRead = table; changed() },
  hidden(hidden: boolean) { fakeVisibility = hidden ? 'hidden' : 'visible'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => fakeVisibility }); document.dispatchEvent(new Event('visibilitychange')); changed() },
  realtime(enabled: boolean) { realtimeEnabled = enabled; for (const channel of channels) channel.callback?.(enabled ? 'SUBSCRIBED' : 'CHANNEL_ERROR'); changed() },
  burst() { for (let i = 0; i < 8; i += 1) emit('questions', 'UPDATE', tables.questions[0]); changed() },
  externalQuestion() { const row = { ...tables.questions[2], id: crypto.randomUUID(), author_name: 'Локальний автор', content: 'Нове запитання з іншої вкладки', title: 'Нове запитання з іншої вкладки', created_at: now() }; tables.questions.push(row); emit('questions', 'INSERT', row); changed() },
  externalImage() { const row = { id: crypto.randomUUID(), question_id: tables.questions[2].id, image_url: '/images/eub-4-timetable-example.png' }; tables.question_images.push(row); emit('question_images', 'INSERT', row); changed() },
  notify() { const row = { ...tables.notifications[0], id: crypto.randomUUID(), recipient_id: activeUser?.id, is_read: false, created_at: now() }; tables.notifications.push(row); emit('notifications', 'INSERT', row); changed() },
  switchUser() { const next = activeUser?.id === ownId ? peerId : ownId; activeUser = { id: next, email: 'local@example.invalid' }; authListeners.forEach(callback => callback('SIGNED_IN', { user: activeUser })); changed() },
  guest() { void supabase.auth.signOut(); changed() },
}
