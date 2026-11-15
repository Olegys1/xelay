// Synthetic loopback-only preview. No production URLs, credentials or requests.
const university = { id: '10000000-0000-4000-8000-000000000001', name: 'Київський національний університет імені Тараса Шевченка', slug: 'knu' }
const unit = { id: '10000000-0000-4000-8000-000000000002', university_id: university.id, name: 'Економічний факультет', slug: 'economics', unit_type: 'faculty' }
const specialty = { id: '10000000-0000-4000-8000-000000000003', university_id: university.id, academic_unit_id: unit.id, code: 'D3', specialty_name: 'Менеджмент', name: 'Економіка та управління бізнесом', source_url: null, is_active: true, study_levels: ['bachelor'] }
const user = { id: '20000000-0000-4000-8000-000000000001', email: 'student@example.test', full_name: 'Олена, тестовий профіль', username: 'olena_demo' }
function query(table: string) {
  const data = table === 'universities' ? [university] : table === 'academic_units' ? [unit] : table === 'academic_specialties' ? [specialty] : []
  const builder: Record<string, unknown> = { then: (done: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(done) }
  for (const method of ['select', 'eq', 'order', 'abortSignal', 'returns', 'limit', 'in']) builder[method] = () => builder
  return builder
}
export const supabase = {
  from: query,
  rpc: async () => { throw new Error('LOCAL_PREVIEW_PRODUCTION_FORBIDDEN') },
  auth: {
    signUp: async ({ email }: { email: string }) => ({ data: { user: { id: user.id, email }, session: null }, error: email.endsWith('@knu.ua') ? null : { code: 'KNU_EMAIL_REQUIRED', message: 'KNU_EMAIL_REQUIRED' } }),
    signInWithPassword: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user }, error: null }),
    resend: async () => ({ data: {}, error: null }),
    resetPasswordForEmail: async () => ({ data: {}, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
}
export const emailLinkVerifier = () => supabase
export const useAuth = () => ({ user, refreshUser: async () => undefined, loading: false, signOut: async () => undefined })
