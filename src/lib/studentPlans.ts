/** Catalogue for the local student-workspace release. It does not change checkout prices. */
export type StudentPlanId = 'start' | 'plus' | 'max'
export type BillingAudience = 'student' | 'teacher'

export interface StudentPlan {
  id: StudentPlanId
  name: string
  eyebrow: string
  description: string
  monthlyPriceUah: number
  monthlyAiBudgetUsd: number
  accent: string
  features: readonly string[]
}

export const STUDENT_FREE_FEATURES = Object.freeze([
  'Розклад, домашні завдання та навчальні матеріали групи',
  'Семінари та спільна таблиця записів на участь',
  'Тести викладачів, здача робіт і власні опубліковані бали',
  'Чати, зміни дедлайнів і сповіщення на пошту',
] as const)

/** Existing benefits remain available for every active legacy grant. */
export const LEGACY_PARTICIPANT_FEATURES = Object.freeze([
  'Відзнака «Учасник», текстовий статус та емодзі',
  'Пошук в історії чатів і заплановані особисті повідомлення',
  'Особистий і спільний органайзер із нагадуваннями',
  'Оформлення профілю та чатів, створення опитувань і статей',
] as const)

export const LEGACY_PARTICIPANT_CAPABILITIES = Object.freeze([
  'participant_badge', 'text_status', 'emoji_status', 'chat_history_search',
  'scheduled_direct_messages', 'personal_organizer', 'shared_organizer',
  'organizer_push_reminders', 'profile_appearance', 'chat_appearance',
  'create_polls', 'create_articles',
] as const)

export type StudentFeatureCategory = 'appearance' | 'communication' | 'organization' | 'study' | 'practice' | 'planning' | 'progress' | 'research' | 'projects'
export type StudentFeatureStatus = 'existing' | 'local' | 'planned' | 'paused'
export interface StudentPlanFeature {
  id: string
  title: string
  description: string
  category: StudentFeatureCategory
  status: StudentFeatureStatus
  minimumPlan: StudentPlanId
  legacyCapability?: typeof LEGACY_PARTICIPANT_CAPABILITIES[number]
}

export const STUDENT_FEATURE_CATEGORIES = Object.freeze([
  { id: 'organization' as const, label: 'Свій порядок у справах' },
  { id: 'study' as const, label: 'Матеріали й нотатки' },
  { id: 'practice' as const, label: 'Практика та повторення' },
  { id: 'research' as const, label: 'Робота з джерелами' },
  { id: 'projects' as const, label: 'Курсові та великі роботи' },
  { id: 'planning' as const, label: 'Підготовка до заліків' },
  { id: 'progress' as const, label: 'Прогрес і результати' },
  { id: 'communication' as const, label: 'Спілкування' },
  { id: 'appearance' as const, label: 'Твій стиль' },
].map(category => Object.freeze(category)))
export const STUDENT_FEATURE_STATUS_LABELS: Readonly<Record<StudentFeatureStatus, string>> = Object.freeze({
  existing: 'Вже на платформі', local: 'Можна спробувати локально', planned: 'Заплановано', paused: 'Відкладено',
})

/** Display catalogue only. A row never grants access; production endpoints enforce their own permissions. */
export const STUDENT_PLAN_FEATURES: readonly StudentPlanFeature[] = Object.freeze([
  { id: 'start_badge', title: 'Бейдж «Старт»', description: 'Позначка активної підписки поруч із вашим ім’ям. «Старт» замінює назву колишнього пакета, зберігаючи його можливості.', category: 'appearance', status: 'existing', minimumPlan: 'start', legacyCapability: 'participant_badge' },
  { id: 'text_status', title: 'Власний текстовий статус', description: 'До 48 символів поруч із ніком: коротка фраза, настрій або те, над чим зараз працюєте.', category: 'appearance', status: 'existing', minimumPlan: 'start', legacyCapability: 'text_status' },
  { id: 'emoji_status', title: 'До трьох емодзі у статусі', description: 'Оберіть до трьох емодзі з розширеної добірки та змінюйте їх у профілі.', category: 'appearance', status: 'existing', minimumPlan: 'start', legacyCapability: 'emoji_status' },
  { id: 'chat_search', title: 'Пошук у всій доступній історії чатів', description: 'Знаходьте текст, автора, дату, файли, фото, відео та посилання у своїх особистих чатах, групах і каналах.', category: 'communication', status: 'existing', minimumPlan: 'start', legacyCapability: 'chat_history_search' },
  { id: 'scheduled_messages', title: 'Відкладені особисті повідомлення', description: 'Напишіть повідомлення зараз, оберіть час надсилання, а до відправлення відредагуйте або скасуйте його.', category: 'communication', status: 'existing', minimumPlan: 'start', legacyCapability: 'scheduled_direct_messages' },
  { id: 'personal_organizer', title: 'Особистий органайзер із повторами', description: 'Приватні завдання й нотатки, щоденні, щотижневі та щомісячні повтори, кілька нагадувань. Додавайте ДЗ і семінари безпосередньо з групи.', category: 'organization', status: 'existing', minimumPlan: 'start', legacyCapability: 'personal_organizer' },
  { id: 'shared_organizer', title: 'Спільний органайзер до 35 людей', description: 'Спільні завдання, предмети, дедлайни, відповідальні та відмітки виконання. До 35 людей разом із власником; кожному потрібна активна підписка й згода на запрошення.', category: 'organization', status: 'existing', minimumPlan: 'start', legacyCapability: 'shared_organizer' },
  { id: 'organizer_push', title: 'Push-нагадування органайзера', description: 'Нагадування про особисті справи на підтримуваних пристроях. Вмикаються окремо після дозволу браузера.', category: 'organization', status: 'existing', minimumPlan: 'start', legacyCapability: 'organizer_push_reminders' },
  { id: 'profile_style', title: 'Обкладинки та оформлення профілю', description: 'Добірка обкладинок для вашого профілю, щоб оформити особисту сторінку під себе.', category: 'appearance', status: 'existing', minimumPlan: 'start', legacyCapability: 'profile_appearance' },
  { id: 'chat_style', title: 'Теми й фони переписок', description: 'Персональне оформлення ваших чатів із доступної добірки тем і фонів.', category: 'appearance', status: 'existing', minimumPlan: 'start', legacyCapability: 'chat_appearance' },
  { id: 'chat_polls', title: 'Створення опитувань у чатах', description: 'Один або кілька варіантів відповіді, анонімне чи відкрите голосування та завершення опитування.', category: 'communication', status: 'existing', minimumPlan: 'start', legacyCapability: 'create_polls' },
  { id: 'chat_articles', title: 'Статті з обкладинкою й форматуванням', description: 'Публікації із заголовком, обкладинкою та форматованим текстом у ваших переписках.', category: 'communication', status: 'existing', minimumPlan: 'start', legacyCapability: 'create_articles' },
  { id: 'subject_notes', title: 'Особисті навчальні нотатки', description: 'Власний конспект поруч із предметом, автоматичне збереження на цьому пристрої та завантаження тексту у .txt.', category: 'study', status: 'local', minimumPlan: 'start' },
  { id: 'note_templates', title: 'Шаблони конспекту й самоперевірки', description: 'Почніть із готової структури: головні тези, поняття, приклад і запитання, до яких хочете повернутися.', category: 'study', status: 'local', minimumPlan: 'start' },
  { id: 'study_bookmarks', title: 'Добірка посилань і важливих фрагментів', description: 'Зберігайте корисні ресурси й текстові фрагменти з предметом; шукайте у своїй добірці за назвою та змістом.', category: 'study', status: 'local', minimumPlan: 'start' },
  { id: 'daily_checklist', title: 'Список навчальних справ на день', description: 'Власні справи зі строком виконання, відміткою готовності та фільтрами. Нічого не публікується в журнал викладача.', category: 'organization', status: 'local', minimumPlan: 'start' },
  { id: 'focus_sessions', title: 'Фокус-таймер та історія занять', description: 'Сесії навчання й перерви: запуск, пауза та продовження після оновлення сторінки. Завершені сесії формують історію й підсумок часу за тиждень.', category: 'organization', status: 'local', minimumPlan: 'start' },
  { id: 'daily_study_plan', title: 'Особиста ціль і план підготовки', description: 'Оберіть дату заліку й доступні хвилини на день, отримайте послідовність кроків і відмічайте виконані дні.', category: 'planning', status: 'local', minimumPlan: 'start' },
  { id: 'manual_flashcards', title: 'Власні картки та інтервали повторення', description: 'Створюйте картки з пар терміна та пояснення, перевертайте й оцінюйте, наскільки легко згадали. Дата наступного повторення зберігається.', category: 'practice', status: 'local', minimumPlan: 'plus' },
  { id: 'personal_quiz_builder', title: 'Конструктор особистих тренувань', description: 'Додавайте свої запитання, варіанти, правильну відповідь, пояснення, предмет і тему. Це особиста практика, відокремлена від тестів викладача.', category: 'practice', status: 'local', minimumPlan: 'plus' },
  { id: 'quiz_import', title: 'Імпорт запитань із JSON та CSV', description: 'Підготуйте набір за зрозумілим шаблоном, перевірте попередній перегляд і виправте помилки формату до збереження. Розпізнавання ШІ не використовується.', category: 'practice', status: 'local', minimumPlan: 'plus' },
  { id: 'focused_practice', title: 'Практика за темою та перемішування питань', description: 'Оберіть тему для повторення або перемішайте свій набір, щоб тренувати розуміння без звичного порядку запитань.', category: 'practice', status: 'local', minimumPlan: 'plus' },
  { id: 'mistake_review', title: 'Робота над помилками з поясненнями', description: 'Після тренування перегляньте свої відповіді та пояснення; повторіть лише помилкові питання.', category: 'practice', status: 'local', minimumPlan: 'plus' },
  { id: 'practice_history', title: 'Історія спроб і прогрес за темами', description: 'Збережені результати особистих тренувань допомагають побачити, що вже виходить і до яких тем варто повернутися.', category: 'progress', status: 'local', minimumPlan: 'plus' },
  { id: 'practice_export', title: 'Експорт своїх тренувальних наборів', description: 'Завантажуйте власні запитання у JSON чи CSV для резервної копії й подальшого редагування. Читання та експорт власного збереженого залишаються доступними після завершення підписки.', category: 'study', status: 'local', minimumPlan: 'plus' },
  { id: 'timed_rehearsal', title: 'Пробний іспит із таймером', description: 'Оберіть тривалість особистої репетиції, працюйте з відліком часу та отримайте результат після завершення. Оновлення сторінки продовжує цю саму спробу.', category: 'practice', status: 'local', minimumPlan: 'max' },
  { id: 'multi_exam_plan', title: 'Єдиний план для кількох заліків', description: 'Додайте кілька власних іспитів, їхні дати та обсяг підготовки; розподіляйте заняття між предметами на одному тижні.', category: 'planning', status: 'local', minimumPlan: 'max' },
  { id: 'workload_calendar', title: 'Календар навантаження та пріоритетів', description: 'Бачте наближення іспитів і заплановані хвилини підготовки, знаходьте перевантажені дні та змінюйте власний план.', category: 'planning', status: 'local', minimumPlan: 'max' },
  { id: 'grade_goal', title: 'Сценарії балів за кількома предметами', description: 'Задайте компоненти оцінювання, власні бали й бажані результати, порівняйте сценарії та побачте, де потрібно зосередитися. Це розрахунок лише за введеними вами правилами; він не змінює оцінок у журналі.', category: 'progress', status: 'local', minimumPlan: 'max' },
  { id: 'research_reader', title: 'Особиста PDF-студія', description: 'Читайте завантажені вами PDF, переходьте між сторінками, шукайте текст і ставте закладки. Позиція читання та власні позначки зберігаються на цьому пристрої; захищені оригінали викладача не підтягуються.', category: 'research', status: 'local', minimumPlan: 'max' },
  { id: 'source_capture', title: 'Цитата з джерела → фрагмент великої роботи', description: 'Збережіть уривок із назвою джерела, сторінкою та своєю приміткою, а потім прикріпіть його до курсової чи проєкту. Зв’язок із джерелом залишається, щоб повернутися до контексту.', category: 'research', status: 'local', minimumPlan: 'max' },
  { id: 'coursework_projects', title: 'Майстерня курсових і навчальних проєктів', description: 'Створюйте окремі роботи зі структурою розділів, власним текстом, етапами, дедлайнами та контрольним списком. Слідкуйте за обсягом написаного й рухом роботи від плану до готового матеріалу.', category: 'projects', status: 'local', minimumPlan: 'max' },
  { id: 'source_citations', title: 'Джерела, посилання та список літератури', description: 'Запишіть автора, назву, рік і адресу власного джерела, вставляйте посилання [n] у текст роботи та збирайте список використаного. Це ручне оформлення без обіцянки автоматичної відповідності певному академічному стандарту.', category: 'research', status: 'local', minimumPlan: 'max' },
  { id: 'project_versions', title: 'Версії великих робіт із відновленням', description: 'Збережіть стан тексту й структури перед змінами та поверніться до попереднього варіанта, якщо редагування не підійшло. Історія стосується власних локальних проєктів і не змінює зданих викладачу робіт.', category: 'projects', status: 'local', minimumPlan: 'max' },
  { id: 'project_export', title: 'Експорт власної роботи разом із джерелами', description: 'Завантажуйте текст, структуру та список джерел своїх великих робіт у підтримуваних форматах для подальшого редагування або резервної копії. Читання й експорт збереженого залишаються доступними після зміни тарифу.', category: 'projects', status: 'local', minimumPlan: 'max' },
  { id: 'ai_chat', title: 'Розмова з ШІ', description: 'Спілкуйся без обов’язкового файлу. За бажанням додай свій текст або дозволений матеріал власної групи.', category: 'study', status: 'existing', minimumPlan: 'plus' },
  { id: 'ai_cloud_practice', title: 'Тести, картки й збережені відповіді', description: 'Створюй практику за темою чи конспектом. Розмови, картки та відповіді в помічнику зберігаються в акаунті й доступні після оновлення сторінки.', category: 'practice', status: 'existing', minimumPlan: 'plus' },
  { id: 'ai_mistake_notebook', title: 'Тетрадь помилок', description: 'У «Моїй активності» переглядай помилки з останніх занять і повертайся до потрібного тесту для повторення.', category: 'progress', status: 'existing', minimumPlan: 'plus' },
  { id: 'ai_extended_study', title: 'Плани й інтерактивні заняття', description: 'Макс додає плани з тестами на кожному кроці, інтерактивні уроки, письмові вправи й бокові підказки.', category: 'planning', status: 'existing', minimumPlan: 'max' },
].map(feature => Object.freeze(feature)) as StudentPlanFeature[])

/** Future formats are separate from the available chat and practice features. */
export const STUDENT_AI_ROADMAP: readonly StudentPlanFeature[] = Object.freeze([
  { id: 'ai_handwriting', title: 'Розпізнавання рукописного конспекту', description: 'Робота з рукописним текстом і сканами ще не входить до активних можливостей помічника.', category: 'study', status: 'paused', minimumPlan: 'max' },
  { id: 'ai_voice_tutor', title: 'Жива голосова розмова', description: 'Двостороння голосова розмова з моделлю залишена для наступного етапу. Озвучення браузером її не замінює.', category: 'practice', status: 'paused', minimumPlan: 'max' },
  { id: 'ai_deep_learning', title: 'Поглиблена підготовка, голос та інтерактивні моделі', description: 'Репетиція усних відповідей і генерація навчальних моделей залишаються окремим майбутнім етапом.', category: 'practice', status: 'paused', minimumPlan: 'max' },
].map(feature => Object.freeze(feature)) as StudentPlanFeature[])

const STUDENT_PLAN_ORDER: readonly StudentPlanId[] = Object.freeze(['start', 'plus', 'max'])
export function getStudentPlanFeatures(planId: StudentPlanId): readonly StudentPlanFeature[] {
  const rank = STUDENT_PLAN_ORDER.indexOf(planId)
  if (rank < 0) throw new Error('Невідомий студентський тариф.')
  return Object.freeze(STUDENT_PLAN_FEATURES.filter(feature => STUDENT_PLAN_ORDER.indexOf(feature.minimumPlan) <= rank))
}

export const STUDENT_PLANS: readonly StudentPlan[] = Object.freeze([
  Object.freeze({
    id: 'start' as const, name: 'Старт', eyebrow: 'Справи, нотатки й чати',
    description: 'Щоденні справи, навчальні нотатки, спілкування та власний стиль.',
    monthlyPriceUah: 149, monthlyAiBudgetUsd: 0, accent: '#8a1234',
    features: Object.freeze(['Бейдж, текстовий статус до 48 символів і до 3 емодзі', 'Пошук у чатах і відкладені особисті повідомлення', 'Особистий органайзер, повтори та push-нагадування', 'Спільний органайзер до 35 людей', 'Обкладинки профілю, теми й фони чатів', 'Створення опитувань і статей', 'Нотатки, шаблони, закладки та список справ', 'Фокус-таймер, історія сесій і план підготовки']),
  }),
  Object.freeze({
    id: 'plus' as const, name: 'Плюс', eyebrow: 'Тренування й повторення',
    description: 'Створюй свої тренування, повторюй складне та бач прогрес.',
    monthlyPriceUah: 399, monthlyAiBudgetUsd: 3, accent: '#a66120',
    features: Object.freeze(['Органайзери, нотатки, фокус і оформлення зі «Старт»', 'Власні картки з інтервалами повторення', 'Ручний конструктор особистих тренувань', 'Імпорт та експорт запитань у JSON і CSV', 'Практика за темою та перемішування питань', 'Повтор лише помилкових запитань із поясненнями', 'Історія спроб і прогрес за темами']),
  }),
  Object.freeze({
    id: 'max' as const, name: 'Макс', eyebrow: 'Особиста навчальна студія',
    description: 'Працюй із ШІ, читай PDF, збирай джерела й готуйся до іспитів.',
    monthlyPriceUah: 999, monthlyAiBudgetUsd: 10, accent: '#6b326d',
    features: Object.freeze(['PDF-студія: читання, пошук, закладки й власні примітки', 'Цитати зі сторінками, пов’язані з курсовою чи проєктом', 'Великі роботи: структура, текст, етапи та дедлайни', 'Посилання в тексті та список використаних джерел', 'Збережені версії роботи з можливістю відновлення', 'Сценарії підсумкових балів за кількома предметами', 'Єдиний план сесії та репетиції іспитів із таймером', 'Експорт власних проєктів і джерел']),
  }),
])

export function getStudentPlan(id: StudentPlanId): StudentPlan {
  const plan = STUDENT_PLANS.find(item => item.id === id)
  if (!plan) throw new Error('Невідомий студентський тариф.')
  return plan
}

/** Must be supplied by an authenticated server response, never profile form metadata. */
export interface InitialBillingAudienceRecord {
  userId: string
  initialAudience: BillingAudience
  assignedAt: string
}

/** A display resolver, not an authorization boundary. The server must enforce billing audience. */
export function resolveBillingAudience(
  record: InitialBillingAudienceRecord | null | undefined,
  authenticatedUserId: string,
  now = Date.now(),
): BillingAudience | 'unresolved' {
  if (!authenticatedUserId || !record || record.userId !== authenticatedUserId
    || !['student', 'teacher'].includes(record.initialAudience)
    || !Number.isFinite(now) || typeof record.assignedAt !== 'string' || !Number.isFinite(Date.parse(record.assignedAt))
    || Date.parse(record.assignedAt) > now) return 'unresolved'
  return record.initialAudience
}

export interface StudentPlanGrant {
  userId: string
  planId: StudentPlanId
  startsAt: string
  expiresAt: string
}

export interface LegacyParticipantGrant {
  userId: string
  kind: 'payment' | 'gift' | 'lifetime'
  isPremium: boolean
  isLifetime: boolean
  expiresAt: string | null
}

export interface StudentEntitlements {
  audience: BillingAudience | 'unresolved'
  planId: StudentPlanId | 'free'
  source: 'student_plan' | 'legacy_payment' | 'legacy_gift' | 'legacy_lifetime' | 'free'
  expiresAt: string | null
  isLifetime: boolean
  legacyBenefits: boolean
  aiAllowance: 'available' | 'pending_legacy_policy' | 'not_included'
  monthlyAiBudgetUsd: number
  /** Own saved content stays readable/exportable when a subscription or AI allowance ends. */
  ownSavedContentAccess: true
}

export interface StudentEntitlementInput {
  authenticatedUserId: string
  billingAudience?: InitialBillingAudienceRecord | null
  planGrant?: StudentPlanGrant | null
  legacyGrant?: LegacyParticipantGrant | null
  now?: number
}

export function resolveStudentEntitlements(input: StudentEntitlementInput): StudentEntitlements {
  const now = input.now ?? Date.now()
  const audience = resolveBillingAudience(input.billingAudience, input.authenticatedUserId, now)
  const base: StudentEntitlements = {
    audience, planId: 'free', source: 'free', expiresAt: null, isLifetime: false,
    legacyBenefits: false, aiAllowance: 'not_included', monthlyAiBudgetUsd: 0,
    ownSavedContentAccess: true,
  }
  if (!input.authenticatedUserId || !Number.isFinite(now)) return base
  const old = input.legacyGrant
  const oldIsLifetime = Boolean(old?.kind === 'lifetime' && old.isLifetime === true && old.expiresAt === null)
  const oldIsTimed = Boolean(old && ['payment', 'gift'].includes(old.kind) && old.isLifetime === false
    && typeof old.expiresAt === 'string' && Number.isFinite(Date.parse(old.expiresAt)) && Date.parse(old.expiresAt) > now)
  const legacyActive = Boolean(old?.userId === input.authenticatedUserId && old.isPremium === true && (oldIsLifetime || oldIsTimed))
  const grant = input.planGrant
  const grantActive = Boolean(audience === 'student' && grant?.userId === input.authenticatedUserId
    && STUDENT_PLANS.some(plan => plan.id === grant.planId)
    && typeof grant.startsAt === 'string' && Number.isFinite(Date.parse(grant.startsAt)) && Date.parse(grant.startsAt) <= now
    && typeof grant.expiresAt === 'string' && Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > now)
  if (grantActive && grant) {
    return { ...base, planId: grant.planId, source: 'student_plan', expiresAt: grant.expiresAt,
      legacyBenefits: true, aiAllowance: grant.planId === 'start' ? 'not_included' : 'available', monthlyAiBudgetUsd: getStudentPlan(grant.planId).monthlyAiBudgetUsd }
  }
  if (!legacyActive || !old) return base
  const student = audience === 'student'
  const paidAi = student && old.kind === 'payment' && getStudentPlan('start').monthlyAiBudgetUsd > 0
  return { ...base, planId: student ? 'start' : 'free', source: `legacy_${old.kind}`,
    expiresAt: old.expiresAt, isLifetime: oldIsLifetime, legacyBenefits: true,
    aiAllowance: paidAi ? 'available' : student ? 'pending_legacy_policy' : 'not_included',
    monthlyAiBudgetUsd: paidAi ? getStudentPlan('start').monthlyAiBudgetUsd : 0 }
}

export interface StudentEconomicsAssumptions {
  /** Planning assumption; it is not a fetched exchange rate. */
  uahPerUsd?: number
  paymentFeeRate?: number
  otherVariableUah?: number
}

export function calculateStudentPlanEconomics(planId: StudentPlanId, assumptions: StudentEconomicsAssumptions = {}) {
  const plan = getStudentPlan(planId)
  const fx = assumptions.uahPerUsd ?? 50
  const fee = assumptions.paymentFeeRate ?? 0.02
  const reserve = assumptions.otherVariableUah ?? ({ start: 15, plus: 35, max: 75 }[planId])
  if (!Number.isFinite(fx) || fx <= 0 || !Number.isFinite(fee) || fee < 0 || fee > 1
    || !Number.isFinite(reserve) || reserve < 0) throw new Error('Некоректні припущення для розрахунку.')
  const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
  const aiUah = round(plan.monthlyAiBudgetUsd * fx)
  const feeUah = round(plan.monthlyPriceUah * fee)
  const contributionUah = round(plan.monthlyPriceUah - aiUah - feeUah - reserve)
  if (![aiUah, feeUah, contributionUah].every(Number.isFinite)) throw new Error('Розрахунок перевищує допустимі значення.')
  return { priceUah: plan.monthlyPriceUah, aiUah, paymentFeeUah: feeUah, otherVariableUah: reserve,
    contributionUah, uahPerUsd: fx, paymentFeeRate: fee,
    excludes: ['Податки', 'Постійні витрати', 'Робота команди'] as const }
}
