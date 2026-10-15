import { supabase } from '../supabase'
import { authEmailRedirect } from '../authEmail'
import { registrationPrivacyFailure } from '../authRegistration'
import { PERSONAL_DATA_CONSENT_VERSION, PRIVACY_POLICY_VERSION } from '../legal'
import type { CareerFile, OpportunitiesRepository, WorkspaceCommand, WorkspaceSnapshot } from './types'

const BUCKET = 'opportunities-private'
const MAX_BYTES = 10 * 1024 * 1024

/** Independent business signup, gated by the dormant server trigger. It never
 * fabricates a student faculty/year or grants verification/admin privileges. */
export async function registerOpportunityCompanyAccount(input: {
  fullName: string; email: string; password: string; companyName: string; consent: boolean; privacyConsent: boolean;
}): Promise<{ confirmationRequired: boolean; email: string }> {
  const fullName = input.fullName.trim(); const email = input.email.trim().toLowerCase()
  const companyName = input.companyName.trim()
  if (input.privacyConsent !== true) throw new Error('Для реєстрації надайте окрему згоду на обробку персональних даних.')
  if (!input.consent || fullName.length < 2 || fullName.length > 120 || companyName.length < 2
    || companyName.length > 180 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || input.password.length < 8) {
    throw new Error('Заповніть ім’я, назву компанії, електронну пошту та пароль від 8 символів. Підтвердьте умови реєстрації.')
  }
  const { data, error } = await supabase.auth.signUp({ email, password: input.password, options: {
    emailRedirectTo: authEmailRedirect('/auth/callback'),
    data: { registration_kind: 'company', xelay_registration_version: 'company-1', full_name: fullName,
      company_name: companyName, company_terms_version: 'opportunities-v1', xelay_privacy_consent: true,
      xelay_privacy_policy_version: PRIVACY_POLICY_VERSION, xelay_privacy_consent_version: PERSONAL_DATA_CONSENT_VERSION },
  } })
  if (error) throw friendlyError(error)
  return { confirmationRequired: !data.session, email }
}
function friendlyError(error: { message?: string } | null): Error {
  const privacyFailure = registrationPrivacyFailure(error)
  if (privacyFailure) return new Error(privacyFailure.message)
  const message = error?.message ?? ''
  const code = message.match(/OPPORTUNITIES_[A-Z_]+/)?.[0]
  const descriptions: Record<string, string> = {
    OPPORTUNITIES_DEVELOPMENT: 'Розділ ще розробляється. Доступ буде відкрито після запуску.',
    OPPORTUNITIES_AUTH_REQUIRED: 'Увійдіть до облікового запису.',
    OPPORTUNITIES_FORBIDDEN: 'У вас немає доступу до цієї дії.',
    OPPORTUNITIES_NOT_FOUND: 'Матеріал не знайдено або доступ до нього закритий.',
    OPPORTUNITIES_INVALID_INPUT: 'Перевірте заповнені поля, посилання та дати.',
    OPPORTUNITIES_CONSENT_REQUIRED: 'Підтвердьте передачу резюме й вибраного контакту компанії.',
    OPPORTUNITIES_RESUME_REQUIRED: 'Спочатку заповніть і збережіть резюме.',
    OPPORTUNITIES_ALREADY_APPLIED: 'Ви вже відгукнулися на цю пропозицію.',
    OPPORTUNITIES_CLOSED: 'Подання заявок завершено.',
    OPPORTUNITIES_VERIFICATION_REQUIRED: 'Спочатку компанія має пройти перевірку.',
    OPPORTUNITIES_PAYMENT_REQUIRED: 'Запуск потребує погодженого та оплаченого замовлення.',
    OPPORTUNITIES_MANUAL_INVOICE_ONLY: 'Автоматичну оплату ще не підключено. Використайте погоджений рахунок.',
    OPPORTUNITIES_INVITATION_UNAVAILABLE: 'Запрошення не надіслано. Перевірте адресу та реєстрацію представника на Xelay.',
    OPPORTUNITIES_LIMIT: 'Досягнуто обмеження. Спробуйте пізніше.',
    OPPORTUNITIES_FILE_INVALID: 'Дозволені PDF-файли до 10 МБ.',
    OPPORTUNITIES_STALE: 'Матеріал уже змінився. Оновіть сторінку й перевірте актуальну версію перед рішенням.',
  }
  return new Error(code && descriptions[code] ? descriptions[code] : 'Не вдалося виконати дію. Спробуйте ще раз.')
}

/** Dormant production adapter. Public development page never constructs this repository. */
export function createSupabaseOpportunitiesRepository(): OpportunitiesRepository {
  return {
    mode: 'supabase',
    async load() {
      const { data, error } = await supabase.rpc('xelay_opportunities_workspace')
      if (error) throw friendlyError(error)
      if (!data || typeof data !== 'object' || !data.actor || !Array.isArray(data.opportunities)) {
        throw new Error('Не вдалося завантажити розділ можливостей.')
      }
      return data as WorkspaceSnapshot
    },
    async execute(command: WorkspaceCommand) {
      const { data, error } = await supabase.rpc('xelay_opportunities_command', { p_command: command })
      if (error) throw friendlyError(error)
      if (!data?.actor) throw new Error('Не вдалося оновити дані. Перезавантажте розділ.')
      return data as WorkspaceSnapshot
    },
    async upload(file: File, kind: CareerFile['kind']) {
      if (!['resume', 'company', 'opportunity'].includes(kind) || file.size < 5 || file.size > MAX_BYTES
        || !/\.pdf$/i.test(file.name) || (file.type && file.type !== 'application/pdf')) {
        throw new Error('Дозволені PDF-файли до 10 МБ.')
      }
      const signature = new Uint8Array(await file.slice(0, 5).arrayBuffer())
      if (String.fromCharCode(...signature) !== '%PDF-') throw new Error('Файл має бути документом PDF.')
      const { data: { user }, error: authError } = await supabase.auth.getUser()
      if (authError || !user) throw new Error('Увійдіть до облікового запису.')
      const id = crypto.randomUUID()
      const path = `${user.id}/${kind}/${id}.pdf`
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: 'application/pdf', upsert: false, cacheControl: '60',
      })
      if (uploadError) throw new Error('Не вдалося завантажити PDF. Перевірте розмір файлу та доступ до розділу.')
      const { data: { session } } = await supabase.auth.getSession()
      try {
        if (!session?.access_token) throw new Error('Вхід завершено. Увійдіть ще раз.')
        const response = await fetch('/api/security/media-cleanup?xelay_media_route=opportunities-file', {
          method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(45000),
          headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        })
        const confirmation = await response.json().catch(() => null)
        if (!response.ok || confirmation?.ok !== true) throw new Error('PDF не пройшов серверну перевірку або завантаження ще не підключено.')
      } catch (error) {
        await supabase.storage.from(BUCKET).remove([path])
        throw error instanceof Error ? error : new Error('Не вдалося перевірити PDF.')
      }
      const { data, error } = await supabase.rpc('xelay_opportunities_register_file', { p_file: {
        id, path, name: file.name.slice(0, 180), size: file.size, mime: 'application/pdf', ownerId: user.id, kind,
      } })
      if (error || !data) {
        // An unattached object can be removed only by its uploader. The DB policy
        // prevents deleting PDFs referenced by an application snapshot.
        await supabase.storage.from(BUCKET).remove([path])
        throw friendlyError(error)
      }
      return data as CareerFile
    },
    async fileUrl(file: CareerFile) {
      if (!file?.path || !/^[a-f0-9-]+\/(resume|company|opportunity)\/[a-f0-9-]+\.pdf$/i.test(file.path)) {
        throw new Error('Некоректний документ.')
      }
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(file.path, 60)
      if (error || !data?.signedUrl) throw new Error('Документ недоступний або право доступу змінено.')
      return data.signedUrl
    },
  }
}
