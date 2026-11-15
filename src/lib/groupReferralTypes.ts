export type ReferralCampaignState = 'draft' | 'open' | 'frozen' | 'drawn' | 'published' | 'cancelled'
export type ReferralGroupState = 'collecting' | 'pending' | 'approved' | 'rejected'
export interface ReferralPrize { rank: 1 | 2 | 3; label: string; months: number | null }
export interface ReferralCampaign {
  id: string; slug: string; title: string; state: ReferralCampaignState; version: number
  startsAt: string | null; joinsUntil: string | null; qualifiesUntil: string | null; drawAt: string | null
  minimumStudents: 10; prizes: ReferralPrize[]; rulesVersion: string
  frozenAt?: string | null; snapshotHash?: string | null; drawnAt?: string | null; publishedAt?: string | null
}
export interface ReferralActor { id: string; verified: boolean; alias: string; canAdmin: boolean }
export interface ReferralGroupProgress {
  id: string; groupId: string; groupName: string; organizerId: string; organizerAlias: string
  createdAt: string; registeredAt: string; state: ReferralGroupState; version: number
  verifiedStudents: number; returningStudents: number; hasSchedule: boolean; hasResource: boolean
  eligible: boolean; issues: string[]; reviewReason?: string | null; reviewedAt?: string | null
  ownMemberDays?: number; ownMemberCounts?: boolean
  viewerRole?: 'organizer' | 'representative' | 'member'; canSubmit?: boolean
}
export interface ReferralCandidateGroup { id: string; name: string; createdAt: string; canRegister: boolean; reason?: string }
export interface ReferralWinner {
  id: string; rank: 1 | 2 | 3; alias: string; organizerId?: string; prize: ReferralPrize
  prizeStatus?: 'pending' | 'issued'; interviewStatus?: 'pending' | 'invited' | 'declined' | 'completed'
  version: number; isOwn: boolean
}
export interface ReferralAudit { id: string; at: string; action: string; actorAlias: string; reason?: string; target?: string }
export interface GroupReferralWorkspace {
  campaign: ReferralCampaign | null; actor: ReferralActor | null
  ownLink: { code: string; path: string } | null; ownGroups: ReferralGroupProgress[]
  candidateGroups: ReferralCandidateGroup[]; ownTickets: number; nextCursor?: string | null; candidateNextCursor?: string | null
  winners: ReferralWinner[]; notification?: string | null
  admin?: { groups: ReferralGroupProgress[]; audit: ReferralAudit[]; approvedTickets: number; eligibleOrganizers: number; nextCursor?: string | null }
}
export type GroupReferralAction = 'create_link' | 'register_group' | 'submit_group' | 'save_campaign' | 'activate_campaign' | 'review_group' | 'freeze_entries' | 'draw_winners' | 'publish_results' | 'set_prize_status' | 'set_interview_status'
export interface GroupReferralRepository {
  load(options?: { after?: string; adminAfter?: string; candidateAfter?: string }): Promise<GroupReferralWorkspace>
  action(action: GroupReferralAction, payload: Record<string, unknown>): Promise<GroupReferralWorkspace>
}
export interface ReferralObserveInput { groupId: string; kind: 'schedule' | 'homework' | 'material'; resourceId: string }
export const GROUP_REFERRAL_MINIMUM = 10 as const
export const GROUP_REFERRAL_DEFAULT_PRIZES: ReferralPrize[] = [
  { rank: 1, label: 'ChatGPT Plus', months: 1 },
  { rank: 2, label: 'Telegram Premium', months: 6 },
  { rank: 3, label: 'Telegram Premium', months: 3 },
]
export function groupReferralError(error: unknown): string {
  const text = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error || '')
  const messages: Record<string, string> = {
    REFERRAL_AUTH_REQUIRED: 'Увійдіть у Xelay, щоб долучитися до акції.',
    REFERRAL_VERIFICATION_REQUIRED: 'Підтвердьте електронну пошту свого акаунта.',
    REFERRAL_ADMIN_REQUIRED: 'Ця дія доступна лише адміністрації.',
    REFERRAL_MFA_REQUIRED: 'Підтвердьте захищений адміністративний вхід.',
    REFERRAL_NOT_OPEN: 'Прийом запрошень зараз закритий.',
    REFERRAL_INVALID_CODE: 'Код запрошення не знайдено або він належить іншій акції.',
    REFERRAL_GROUP_ALREADY_REGISTERED: 'Ця група вже має організатора в акції.',
    REFERRAL_REGISTRATION_EXPIRED: 'Дата створення групи ще не настала. Оновіть дані групи та спробуйте ще раз.',
    REFERRAL_GROUP_FORBIDDEN: 'Заявку може подати лише староста цієї групи.',
    REFERRAL_GROUP_INELIGIBLE: 'Група ще не виконала всі умови. Перевірте прогрес нижче.',
    REFERRAL_CAMPAIGN_INCOMPLETE: 'Заповніть дати, точні призи та строки підписок перед запуском.',
    REFERRAL_VERSION_CONFLICT: 'Дані змінилися. Оновіть сторінку й перевірте свій вибір.',
    REFERRAL_TOO_EARLY: 'Час для цієї дії ще не настав.',
    REFERRAL_NEED_THREE_ORGANIZERS: 'Для трьох різних переможців потрібні щонайменше три організатори з підтвердженими групами.',
    REFERRAL_INVALID_STATE: 'Ця дія недоступна на поточному етапі акції.',
    REFERRAL_ALREADY_DRAWN: 'Розіграш уже проведено. Збережені результати не змінюються.',
    REFERRAL_REASON_REQUIRED: 'Додайте зрозумілу причину цього рішення.',
    REFERRAL_SOURCE_UNAVAILABLE: 'Дані акції ще не підключені. Спробуйте пізніше.',
    REFERRAL_INVALID_PAYLOAD: 'Перевірте введені дані.',
  }
  return Object.entries(messages).find(([code]) => text.includes(code))?.[1] || 'Не вдалося виконати дію. Оновіть дані та спробуйте ще раз.'
}
