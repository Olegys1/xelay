import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic, RotateCcw, Square, Trash2, X } from 'lucide-react'
import { createTeachingVoiceCapture, teachingVoiceTime, type TeachingVoiceCapture, type TeachingVoiceCaptureState, type TeachingVoiceRecording } from '../../lib/teachingVoiceRecording'
import { TeachingButton } from './TeachingUI'

type Props = {
  value: TeachingVoiceRecording | null
  onChange: (value: TeachingVoiceRecording | null) => void
  disabled?: boolean
  onRecordingChange?: (busy: boolean) => void
}

export function TeachingVoiceRecorder({ value, onChange, disabled = false, onRecordingChange }: Props) {
  const [state, setState] = useState<TeachingVoiceCaptureState>('idle')
  const [seconds, setSeconds] = useState(0), [error, setError] = useState(''), [preview, setPreview] = useState('')
  const capture = useRef<TeachingVoiceCapture | null>(null), audio = useRef<HTMLAudioElement | null>(null)
  const callbacks = useRef({ onChange, onRecordingChange })
  callbacks.current = { onChange, onRecordingChange }
  const busy = state !== 'idle'

  useEffect(() => {
    capture.current = createTeachingVoiceCapture({
      onState(next) { setState(next); callbacks.current.onRecordingChange?.(next !== 'idle') },
      onTime: setSeconds,
      onComplete(recording) { setError(''); callbacks.current.onChange(recording) },
      onError: setError,
    })
    return () => { capture.current?.dispose(); capture.current = null; callbacks.current.onRecordingChange?.(false) }
  }, [])
  useEffect(() => {
    if (!value) { setPreview(''); return }
    const url = URL.createObjectURL(value.file)
    setPreview(url)
    return () => { audio.current?.pause(); URL.revokeObjectURL(url) }
  }, [value?.file])
  useEffect(() => { if (disabled) capture.current?.cancel() }, [disabled])

  return <section aria-label="Голосова відповідь" className="mt-4 rounded-2xl border border-sky-500/20 bg-sky-500/[0.04] p-4">
    <div className="flex items-start gap-3">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${state === 'recording' ? 'bg-red-500/10 text-red-500' : 'bg-sky-500/10 text-sky-600 dark:text-sky-300'}`}><Mic size={19} aria-hidden="true" /></span>
      <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">Голосова відповідь</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">До 5 хвилин. Прослухайте запис перед надсиланням. Він буде доступний студенту, який надіслав цей запит.</p></div>
    </div>
    {error && <p role="alert" className="teaching-error mt-3">{error}</p>}
    {busy ? <div className="mt-4 space-y-3">
      <div className="flex items-center gap-3 rounded-xl bg-background/70 px-3 py-3">
        {state === 'recording' ? <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-500 motion-safe:animate-pulse" aria-hidden="true" /> : <Loader2 size={16} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        <p role="status" className="min-w-0 flex-1 text-sm">{state === 'requesting' ? 'Дозвольте доступ до мікрофона в браузері…' : state === 'processing' ? 'Готуємо запис до прослуховування…' : 'Записуємо відповідь'}</p>
        {state === 'recording' && <span className="shrink-0 font-mono text-sm tabular-nums" aria-label={`Тривалість запису ${teachingVoiceTime(seconds)}`}>{teachingVoiceTime(seconds)} / 5:00</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {state === 'recording' && <TeachingButton primary onClick={() => capture.current?.stop()}><Square size={14} fill="currentColor" aria-hidden="true" />Зупинити запис</TeachingButton>}
        <TeachingButton onClick={() => capture.current?.cancel()}><X size={15} aria-hidden="true" />Скасувати запис</TeachingButton>
      </div>
    </div> : <>
      {value && preview && <div className="mt-4 rounded-xl border border-border bg-background/70 p-3">
        <div className="mb-2 flex items-center justify-between gap-3"><span className="text-xs font-medium">Запис готовий · {teachingVoiceTime(value.durationSeconds)}</span><span className="text-xs text-muted-foreground">Ще не надіслано</span></div>
        <audio ref={audio} className="w-full" controls preload="metadata" src={preview} aria-label="Прослухати свою голосову відповідь" />
      </div>}
      <div className="mt-4 flex flex-wrap gap-2">
        <TeachingButton disabled={disabled} onClick={() => { audio.current?.pause(); setError(''); void capture.current?.start() }}>{value ? <RotateCcw size={15} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}{value ? 'Перезаписати' : 'Записати голосове'}</TeachingButton>
        {value && <TeachingButton disabled={disabled} onClick={() => { audio.current?.pause(); setError(''); onChange(null) }}><Trash2 size={15} aria-hidden="true" />Прибрати запис</TeachingButton>}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Мікрофон вмикається лише після натискання кнопки. Можна додати текст або відповісти тільки голосом.</p>
    </>}
  </section>
}
