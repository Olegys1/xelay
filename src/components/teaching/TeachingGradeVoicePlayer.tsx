import { useEffect, useRef, useState } from 'react'
import { Headphones, RefreshCw } from 'lucide-react'
import { teachingError, type TeachingRepository } from '../../lib/teaching'
import type { TeachingGradeVoice } from '../../lib/teachingGradeVoice'
import { TeachingButton } from './TeachingUI'

export function TeachingGradeVoicePlayer({ repository, requestId, voice, userId }: {
  repository: TeachingRepository; requestId: string; voice: TeachingGradeVoice; userId: string
}) {
  const [playback, setPlayback] = useState<{ repository: TeachingRepository; scope: string; url: string } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0), mounted = useRef(true)
  const audio = useRef<HTMLAudioElement>(null)
  const scope = `${userId}:${requestId}:${voice.storage_path}`
  const url = playback?.repository === repository && playback.scope === scope ? playback.url : ''
  const current = useRef({ repository, scope })
  current.current = { repository, scope }
  useEffect(() => {
    mounted.current = true
    setPlayback(null); setError(''); setBusy(false)
    return () => { mounted.current = false; generation.current++ }
  }, [repository, scope])
  useEffect(() => {
    const element = audio.current
    return () => {
      if (!element) return
      element.pause(); element.removeAttribute('src'); element.load()
    }
  }, [repository, scope, url])
  async function open() {
    if (busy || !repository.gradeVoiceUrl) return
    const version = ++generation.current
    setBusy(true); setError('')
    const isCurrent = () => mounted.current && version === generation.current && current.current.repository === repository && current.current.scope === scope
    try {
      const next = await repository.gradeVoiceUrl(requestId, voice)
      if (isCurrent()) setPlayback({ repository, scope, url: next })
    } catch (failure) { if (isCurrent()) { setPlayback(null); setError(teachingError(failure)) } }
    finally { if (isCurrent()) setBusy(false) }
  }
  const seconds = Math.max(0, Math.ceil(voice.duration_seconds))
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return <div className="mt-4 rounded-2xl border border-sky-500/20 bg-sky-500/[0.06] p-4">
    <div className="flex items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-300"><Headphones size={19} aria-hidden="true" /></span><div><p className="text-sm font-semibold">Голосова відповідь викладача</p><p className="mt-0.5 text-xs text-muted-foreground">{duration} · приватна відповідь щодо балів</p></div></div>
    {url ? <><audio ref={audio} key={url} controls preload="none" src={url} aria-label="Голосова відповідь викладача" className="mt-4 w-full" onError={() => { if (mounted.current && current.current.scope === scope && current.current.repository === repository) setError('Не вдалося відтворити запис. Оновіть доступ і спробуйте ще раз.') }} /><div className="mt-3"><TeachingButton busy={busy} onClick={() => void open()}><RefreshCw size={14} />Оновити доступ до запису</TeachingButton></div></> : <div className="mt-4"><TeachingButton busy={busy} disabled={!repository.gradeVoiceUrl} onClick={() => void open()}><Headphones size={15} />Прослухати відповідь</TeachingButton></div>}
    {error && <p role="alert" className="teaching-error mt-3">{error}</p>}
  </div>
}
