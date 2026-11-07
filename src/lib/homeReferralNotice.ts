import type { HomeDashboardContext, HomeDashboardRole, HomeDashboardStatus } from './homeDashboardModel'

/** Approved public campaign copy only. No personal participation data is loaded. */
export const HOME_REFERRAL_NOTICE = Object.freeze({
  href: '/referrals',
  startsAt: '2026-11-08T00:00:00+02:00',
  endsAt: '2026-11-21T23:59:00+02:00',
  eyebrow: 'Триває акція · до 21 листопада, 23:59',
  title: 'Запроси нову групу — додай собі шанс.',
  description: 'За кожну підтверджену групу — квиток у розіграші ChatGPT Plus і Telegram Premium. Три призи, три різні переможці.',
  action: 'Умови та участь',
})

const startsAt = Date.parse(HOME_REFERRAL_NOTICE.startsAt)
const endsAt = Date.parse(HOME_REFERRAL_NOTICE.endsAt)

export function showHomeReferralNotice({ role, context, status, clockIso }: {
  role: HomeDashboardRole; context: HomeDashboardContext; status: HomeDashboardStatus; clockIso: string
}): boolean {
  const now = Date.parse(clockIso)
  return status === 'ready' && context === 'learning' && (role === 'student' || role === 'headman')
    && Number.isFinite(now) && now >= startsAt && now <= endsAt
}
