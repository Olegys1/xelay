import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { XelayUser } from '../../types'
import { useTheme } from '../../context/ThemeContext'
import { useHomeDashboard } from '../../hooks/useHomeDashboard'
import { readGroupQuickAccess } from '../../lib/groupQuickAccess'
import type { HomeDashboardSelection } from '../../lib/homeDashboardModel'
import { HomeDashboard } from './HomeDashboard'
import { HomeIcon } from './HomeIcons'
import { SecretBadgeAnnouncement } from '../SecretBadgeAnnouncement'
import { RectorateFeedbackAnnouncement } from '../RectorateFeedbackAnnouncement'
import { OfflineStudyAnnouncement } from '../OfflineStudyAnnouncement'
import { HalloweenPumpkin } from '../halloween/HalloweenPumpkin'
import './HomeDashboard.css'

export function LiveHomeDashboard({ profile, userId }: { profile: XelayUser; userId: string }) {
  const { theme } = useTheme()
  const navigate = useNavigate()
  const { data, refresh, refreshing } = useHomeDashboard(profile, userId)
  const [selection, setSelection] = useState<HomeDashboardSelection>(() => ({
    context: profile.isTeacher ? 'teaching' : 'learning', date: 'today', groupId: readGroupQuickAccess(userId, 'schedule') || 'all',
  }))
  const [meetingId, setMeetingId] = useState<string | null>(null)
  const meetingLesson = data.status === 'ready' ? data.lessons.find(item => item.id === meetingId) : undefined
  const meeting = meetingLesson?.conference?.meetingId ? { title: meetingLesson.subject, id: meetingLesson.conference.meetingId, passcode: meetingLesson.conference.passcode } : null
  useEffect(() => { if (meetingId && !meeting) setMeetingId(null) }, [meetingId, Boolean(meeting)])
  const meetingClose = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (data.status !== 'ready') return
    const context = selection.context && data.contexts.includes(selection.context) ? selection.context : data.contexts[0]
    const available = data.groups.filter(group => group.status === 'accepted' && (context === 'teaching' ? group.teachingSubjectIds.length > 0 : group.learning))
    const groupId = selection.groupId === 'all' || available.some(group => group.id === selection.groupId) ? selection.groupId : 'all'
    if (context !== selection.context || groupId !== selection.groupId) setSelection(previous => ({ ...previous, context, groupId }))
  }, [data.status, data.contexts, data.groups, selection.context, selection.groupId])
  useEffect(() => {
    if (!meeting) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    meetingClose.current?.focus()
    return () => { document.body.style.overflow = overflow; previous?.focus() }
  }, [Boolean(meeting)])
  const open = (href: string, label: string, resourceId?: string) => {
    if (label === 'Приєднатися до пари') {
      const lesson = data.lessons.find(item => item.id === resourceId)
      if (lesson?.conference?.meetingId && !lesson.conference.href) {
        setMeetingId(lesson.id)
        return
      }
    }
    void navigate({ href })
  }
  // The real Header, BurgerMenu and site footer remain in RootLayout.
  return <div className="hd-dashboard hd-live" data-theme={theme}>
    <div className="hd-live-announcements">
      <OfflineStudyAnnouncement blocked={Boolean(meeting)} />
      <RectorateFeedbackAnnouncement blocked={Boolean(meeting)} />
      <SecretBadgeAnnouncement blocked={Boolean(meeting)} />
      <HalloweenPumpkin pumpkinId="home" perch="right" />
    </div>
    <div className="hd-live-tools"><span role="status">{refreshing && data.status === 'ready' ? 'Оновлюємо ваш навчальний день' : data.partialMessage || ''}</span><button type="button" disabled={refreshing} onClick={() => void refresh()}><HomeIcon name="refresh" size={14} />Оновити</button></div>
    <HomeDashboard opportunityActionLabel="Про майбутній розділ" data={data} selection={selection} onSelectionChange={setSelection} onNavigate={open} onRetry={() => void refresh()} onOpportunityInterest={() => void navigate({ href: '/opportunities' })} />
    {meeting && <div className="hd-demo-backdrop" onClick={() => setMeetingId(null)}><div className="hd-demo-dialog" role="dialog" aria-modal="true" aria-labelledby="home-meeting-title" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setMeetingId(null); if (event.key === 'Tab') { event.preventDefault(); meetingClose.current?.focus() } }}>
      <button ref={meetingClose} type="button" className="hd-demo-close" aria-label="Закрити дані конференції" onClick={() => setMeetingId(null)}><HomeIcon name="close" size={18} /></button>
      <h2 id="home-meeting-title">{meeting.title}</h2><p>Введіть ці дані в застосунку для відеозустрічі.</p><dl className="hd-demo-details"><dt>Ідентифікатор конференції</dt><dd>{meeting.id}</dd>{meeting.passcode && <><dt>Код доступу</dt><dd>{meeting.passcode}</dd></>}</dl>
    </div></div>}
  </div>
}
