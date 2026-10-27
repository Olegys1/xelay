// Read-only catalog data for local registration forms. All account mutations fail closed.
const universityId = '00000000-0000-4000-8000-000000000030'
const facultyId = '00000000-0000-4000-8000-000000000031'
const tables: Record<string, Record<string, unknown>[]> = {
  universities: [{ id: universityId, name: 'Київський національний університет імені Тараса Шевченка', slug: 'knu', is_active: true }],
  academic_units: [{ id: facultyId, university_id: universityId, name: 'Економічний факультет', slug: 'economics', unit_type: 'faculty', is_active: true }],
  academic_specialties: [{ id: '00000000-0000-4000-8000-000000000032', university_id: universityId, academic_unit_id: facultyId, code: 'ЕУБ', specialty_name: 'Економіка', name: 'Економіка та управління бізнесом', source_url: null, is_active: true, study_levels: ['bachelor'] }],
}
const denied = () => { throw new Error('LOCAL_PREVIEW_LIVE_BACKEND_FORBIDDEN') }
const deniedAccount = async () => ({ data: null, error: { message: 'У локальному прикладі реєстрацію й вхід вимкнено. Перегляньте форму без створення акаунта.' } })
export const supabase = {
  from(table: string) {
    const filters: [string, unknown][] = []
    const query: Record<string, unknown> = {}
    const data = () => (tables[table] || []).filter(row => filters.every(([key, value]) => row[key] === value))
    for (const method of ['select', 'order', 'abortSignal', 'returns', 'limit']) query[method] = () => query
    query.eq = (key: string, value: unknown) => { filters.push([key, value]); return query }
    query.in = () => query
    query.maybeSingle = async () => ({ data: data()[0] || null, error: null })
    query.single = query.maybeSingle
    query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve({ data: data(), error: null }).then(resolve, reject)
    for (const method of ['insert', 'upsert', 'update', 'delete']) query[method] = denied
    return query
  },
  rpc: denied,
  channel: denied,
  storage: new Proxy({}, { get: () => denied }),
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    signUp: deniedAccount, signInWithPassword: deniedAccount, signInWithOAuth: deniedAccount,
    signOut: async () => ({ error: null }), resetPasswordForEmail: deniedAccount, resend: deniedAccount,
  },
}
export const emailLinkVerifier = denied
export function useAuth() { return { authUser: null, xelayUser: null, loading: false, googleRegistrationStatus: 'ready', refreshUser: async () => {}, signOut: async () => {}, isPasswordRecovery: false } }
