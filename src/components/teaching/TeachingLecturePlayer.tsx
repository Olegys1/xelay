import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, LockKeyhole, Play, RotateCcw } from 'lucide-react'
import type { TeachingFile } from '../../lib/teaching'
import { lectureTime, type CourseLecture } from '../../lib/teachingCourseModules'
import { TeachingButton } from './TeachingUI'

type Props = {
  lecture: CourseLecture
  lockedReason?: string
  resolveVideo?: (file: TeachingFile) => Promise<string>
  recordProgress: (positionSeconds: number) => Promise<void>
}

export function TeachingLecturePlayer({ lecture, lockedReason, resolveVideo, recordProgress }: Props) {
  const [opened, setOpened] = useState(false)
  const [loading, setLoading] = useState(false)
  const [source, setSource] = useState('')
  const [playbackError, setPlaybackError] = useState('')
  const [progressError, setProgressError] = useState(false)
  const [seekNotice, setSeekNotice] = useState(false)
  const [ended, setEnded] = useState(false)
  const request = useRef(0)
  const mounted = useRef(false)
  const videoNode = useRef<HTMLVideoElement>(null)
  const reporting = useRef(false)
  const finalReportPending = useRef(false)
  const latest = useRef({ lecture, recordProgress })
  latest.current = { lecture, recordProgress }
  const prefix = useRef(lecture.watched_seconds || 0)
  const lastMediaTime = useRef<number | null>(null)
  const retryAt = useRef(0)
  const observed = Math.max(0, lecture.watched_seconds || 0)
  const required = lecture.required_seconds || Math.ceil(lecture.duration_seconds * .9)
  const percent = Math.min(100, Math.round(observed / Math.max(1, lecture.duration_seconds) * 100))
  prefix.current = Math.max(prefix.current, observed)

  useEffect(() => {
    mounted.current = true
    function changeVisibility() {
      if (!document.hidden) return
      lastMediaTime.current = null
      if (!videoNode.current || videoNode.current.paused || latest.current.lecture.completed) return
      videoNode.current.pause()
      void send(true)
    }
    document.addEventListener('visibilitychange', changeVisibility)
    return () => { mounted.current = false; request.current++; document.removeEventListener('visibilitychange', changeVisibility) }
    // The callback reads the current lecture and progress handler through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function load() {
    if (!lecture.file || lecture.locked || !resolveVideo || loading) return
    const version = ++request.current
    setOpened(true)
    setSource('')
    setPlaybackError('')
    setLoading(true)
    try {
      const url = await resolveVideo(lecture.file)
      if (version === request.current) setSource(url)
    } catch {
      if (version === request.current) setPlaybackError('Не вдалося відкрити відео. Перевірте з’єднання та спробуйте ще раз.')
    } finally {
      if (version === request.current) setLoading(false)
    }
  }

  async function send(force = false) {
    const current = latest.current.lecture
    if (!mounted.current || current.completed || current.locked || !force && Date.now() < retryAt.current) return
    if (reporting.current) {
      if (force) finalReportPending.current = true
      return
    }
    const position = Math.min(current.duration_seconds, (current.watched_seconds || 0) + 20, Math.floor(prefix.current + .04))
    if (!force && position - (current.watched_seconds || 0) < 8) return
    reporting.current = true
    retryAt.current = Date.now() + 4500
    const version = request.current
    try {
      await latest.current.recordProgress(position)
      if (version === request.current) setProgressError(false)
    } catch {
      retryAt.current = Date.now() + 5000
      if (version === request.current) setProgressError(true)
    } finally {
      reporting.current = false
      if (finalReportPending.current) {
        finalReportPending.current = false
        void send(true)
      }
    }
  }

  function update(video: HTMLVideoElement, force = false) {
    const time = video.currentTime
    const lastTime = lastMediaTime.current
    if (document.hidden || video.seeking) { lastMediaTime.current = null; return }
    if (lastTime !== null && time > lastTime && time - lastTime < 3 && lastTime <= prefix.current + .4) {
      prefix.current = Math.max(time, prefix.current)
    }
    lastMediaTime.current = video.paused ? null : time
    if (!video.paused || force) void send(force)
  }

  return <section className="tcm-lecture-player" data-teaching-guide="course-lecture-player">
    {lecture.locked ? <div className="tcm-video-placeholder"><LockKeyhole size={26} aria-hidden="true" /><strong>Лекція ще закрита</strong><p>{lockedReason || 'Завершіть попередній крок, щоб відкрити відео.'}</p></div> : !opened ? <div className="tcm-video-placeholder"><span className="tcm-lecture-play-icon"><Play size={22} aria-hidden="true" /></span><strong>Відеолекція · {lectureTime(lecture.duration_seconds)}</strong><p>{observed > 0 ? 'Можете продовжити зі збереженого місця.' : 'Прогрес зберігається під час перегляду.'}</p><TeachingButton primary disabled={!lecture.file || !resolveVideo} onClick={() => void load()}><Play size={15} />{observed > 0 ? 'Продовжити перегляд' : 'Дивитися лекцію'}</TeachingButton></div> : <div className="tcm-video-stage">
      {loading && <p role="status">Завантажуємо відео…</p>}
      {playbackError && <div role="alert"><p>{playbackError}</p><TeachingButton onClick={() => void load()}><RotateCcw size={14} />Завантажити знову</TeachingButton></div>}
      {source && !playbackError && <video
        ref={videoNode}
        src={source}
        aria-label="Відеолекція"
        controls playsInline preload="metadata"
        onLoadedMetadata={event => {
          const video = event.currentTarget
          if (!lecture.completed && observed > 0 && observed < video.duration) video.currentTime = observed
        }}
        onPlay={event => {
          setEnded(false)
          lastMediaTime.current = event.currentTarget.currentTime
          if (!document.hidden) void send(true)
        }}
        onTimeUpdate={event => update(event.currentTarget)}
        onSeeking={event => {
          const video = event.currentTarget
          lastMediaTime.current = null
          if (!lecture.completed && video.currentTime > prefix.current + .4) {
            video.currentTime = prefix.current
            setSeekNotice(true)
          }
        }}
        onSeeked={event => { if (!event.currentTarget.paused) lastMediaTime.current = event.currentTarget.currentTime }}
        onPause={event => update(event.currentTarget, true)}
        onEnded={event => { setEnded(true); update(event.currentTarget, true) }}
        onError={() => setPlaybackError('Не вдалося відтворити відео. Спробуйте завантажити його знову.')}
      />}
    </div>}
    {!lecture.locked && <div className="tcm-lecture-meter">
      <div><span>Переглянуто {lectureTime(observed)} із {lectureTime(lecture.duration_seconds)}</span><strong>{lecture.completed ? <><CheckCircle2 size={15} aria-hidden="true" />Лекцію зараховано</> : `${percent}%`}</strong></div>
      <progress className="tcm-progress-bar" value={percent} max={100} aria-label="Прогрес перегляду лекції" />
      {!lecture.completed && <p>Тест відкриється після {lectureTime(required)} перегляду.</p>}
      {seekNotice && !lecture.completed && <p role="status">Можна повторити переглянуту частину. Щоб відкрити тест, перегляньте решту лекції послідовно.</p>}
      {progressError && !lecture.completed && <div role="status"><p>Прогрес ще не збережено. Перевірте з’єднання.</p><TeachingButton onClick={() => void send(true)}><RotateCcw size={14} />Зберегти прогрес</TeachingButton></div>}
      {ended && !lecture.completed && !progressError && <div role="status"><p>Відео закінчилося. Якщо тест ще закритий, оновіть прогрес перегляду.</p><TeachingButton onClick={() => void send(true)}><RotateCcw size={14} />Оновити прогрес перегляду</TeachingButton></div>}
    </div>}
  </section>
}
