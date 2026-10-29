import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { XelayUser } from '../../types'
import { useTheme } from '../../context/ThemeContext'
import { useOnboarding } from '../../context/OnboardingContext'
import { useHomeDashboard } from '../../hooks/useHomeDashboard'
import { readGroupQuickAccess } from '../../lib/groupQuickAccess'
import type { HomeDashboardSelection } from '../../lib/homeDashboardModel'
import { visibleHomeLessonConference } from '../../lib/homeLessonConference'
import { HomeDashboard } from './HomeDashboard'
import { HomeIcon } from './HomeIcons'
import { SecretBadgeAnnouncement } from '../SecretBadgeAnnouncement'
import { RectorateFeedbackAnnouncement } from '../RectorateFeedbackAnnouncement'
import { OfflineStudyAnnouncement } from '../OfflineStudyAnnouncement'
import { HalloweenPumpkin } from '../halloween/HalloweenPumpkin'
import './HomeDashboard.css'

export function LiveHomeDashboard({ profile, userId }: { profile: XelayUser; userId: string }) {
  const { theme } = useTheme()
  const { homeGuide } = useOnboarding()
  const navigate = useNavigate()
  const { data, refresh, refreshing } = useHomeDashboard(profile, userId)
  const [selection, setSelection] = useState<HomeDashboardSelection>(() => ({
    context: profile.isTeacher ? 'teaching' : 'learning', date: 'today', groupId: readGroupQuickAccess(userId, 'schedule') || 'all',
  }))
  const [meetingId, setMeetingId] = useState<string | null>(null)
  const [copied, setCopied] = useState<'id' | 'passcode' | 'failed' | null>(null)
  const meetingAccess = meetingId ? visibleHomeLessonConference(data, selection, meetingId) : null
  const meeting = meetingAccess && !meetingAccess.conference.href ? { title: meetingAccess.lesson.subject, id: meetingAccess.conference.meetingId, passcode: meetingAccess.conference.passcode } : null
  useEffect(() => { if (meetingId && !meeting) setMeetingId(null) }, [meetingId, Boolean(meeting)])
  const meetingClose = useRef<HTMLButtonElement>(null)
  const meetingDialog = useRef<HTMLDivElement>(null)
  const closeMeeting = () => { setMeetingId(null); setCopied(null) }
  useEffect(() => { setMeetingId(null); setCopied(null) }, [userId])
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
  const open = (href: string) => { void navigate({ href }) }
  const join = (lessonId: string) => {
    const access = visibleHomeLessonConference(data, selection, lessonId)
    // URL joins are native anchors in HomeDashboard. A stale credential-only
    // button must not silently navigate to the group or guess a meeting URL.
    if (!access || access.conference.href) return
    setCopied(null)
    setMeetingId(access.lesson.id)
  }
  const copy = async (kind: 'id' | 'passcode') => {
    const value = kind === 'id' ? meeting?.id : meeting?.passcode
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
    } catch { setCopied('failed') }
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
    <HomeDashboard opportunityActionLabel="Про майбутній розділ" data={data} selection={selection} onSelectionChange={setSelection} onNavigate={open} onJoinLesson={join} homeGuide={homeGuide} onRetry={() => void refresh()} onOpportunityInterest={() => void navigate({ href: '/opportunities' })} />
    {meeting && <div className="hd-demo-backdrop" onClick={closeMeeting}><div ref={meetingDialog} className="hd-demo-dialog" role="dialog" aria-modal="true" aria-labelledby="home-meeting-title" onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Escape') closeMeeting()
      if (event.key === 'Tab') {
        const buttons = Array.from(meetingDialog.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || [])
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <button ref={meetingClose} type="button" className="hd-demo-close" aria-label="Закрити дані конференції" onClick={closeMeeting}><HomeIcon name="close" size={18} /></button>
      <h2 id="home-meeting-title">{meeting.title}</h2><p>Посилання на зустріч не додано. Скопіюйте дані й введіть їх у застосунку для відеозустрічі.</p>
      <dl className="hd-demo-details">{meeting.id && <><dt>Ідентифікатор конференції</dt><dd>{meeting.id}</dd><dd><button type="button" className="hd-button hd-button-soft" onClick={() => void copy('id')}>{copied === 'id' ? 'Скопійовано' : 'Скопіювати ідентифікатор'}</button></dd></>}{meeting.passcode && <><dt>Код доступу</dt><dd>{meeting.passcode}</dd><dd><button type="button" className="hd-button hd-button-soft" onClick={() => void copy('passcode')}>{copied === 'passcode' ? 'Скопійовано' : 'Скопіювати код'}</button></dd></>}</dl>
      <p role="status" aria-live="polite">{copied === 'failed' ? 'Не вдалося скопіювати. Виділіть потрібні дані та скопіюйте вручну.' : copied ? 'Готово, дані скопійовано.' : ''}</p>
    </div></div>}
  </div>
}
