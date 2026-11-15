import type { MouseEvent } from 'react'
import { HOME_REFERRAL_NOTICE, showHomeReferralNotice } from '../../lib/homeReferralNotice'
import type { HomeDashboardContext, HomeDashboardData } from '../../lib/homeDashboardModel'
import { HomeIcon } from './HomeIcons'
import './HomeReferralNotice.css'

export function HomeReferralNotice({ data, context, onNavigate }: {
  data: Pick<HomeDashboardData, 'role' | 'status' | 'clockIso'>
  context: HomeDashboardContext
  onNavigate?: (href: string, label: string) => void
}) {
  if (!showHomeReferralNotice({ ...data, context })) return null
  const notice = HOME_REFERRAL_NOTICE
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (onNavigate && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
      event.preventDefault()
      onNavigate(notice.href, notice.action)
    }
  }
  return <section className="hd-referral-notice" aria-labelledby="hd-referral-notice-title">
    <span className="hd-referral-notice-icon"><HomeIcon name="users" size={25} /><HomeIcon name="spark" size={14} /></span>
    <div className="hd-referral-notice-copy"><p className="hd-referral-notice-eyebrow">{notice.eyebrow}</p><h2 id="hd-referral-notice-title">{notice.title}</h2><p>{notice.description}</p></div>
    <a href={notice.href} onClick={open} className="hd-button hd-button-primary hd-referral-notice-action">{notice.action}<HomeIcon name="arrow" size={17} /></a>
  </section>
}
