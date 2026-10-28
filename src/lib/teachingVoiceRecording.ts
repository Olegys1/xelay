export const TEACHING_VOICE_MAX_SECONDS = 300
export const TEACHING_VOICE_MAX_BYTES = 10 * 1024 * 1024
export const TEACHING_VOICE_MIME_PREFERENCES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'] as const

export type TeachingVoiceRecording = { file: File; durationSeconds: number }
export type TeachingVoiceCaptureState = 'idle' | 'requesting' | 'recording' | 'processing'
type CaptureCallbacks = {
  onState: (state: TeachingVoiceCaptureState) => void
  onTime: (seconds: number) => void
  onComplete: (recording: TeachingVoiceRecording) => void
  onError: (message: string) => void
}

export function teachingVoiceMime(value: string): 'audio/webm' | 'audio/ogg' | 'audio/mp4' | null {
  const mime = value.split(';', 1)[0].trim().toLowerCase()
  return mime === 'audio/webm' || mime === 'audio/ogg' || mime === 'audio/mp4' ? mime : null
}

export function teachingVoiceTime(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

export function teachingVoiceError(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Дозвольте доступ до мікрофона в браузері та спробуйте ще раз. Текстову відповідь можна надіслати без мікрофона.'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'Мікрофон не знайдено. Підключіть його або напишіть текстову відповідь.'
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'Не вдалося ввімкнути мікрофон. Перевірте, чи не використовує його інший застосунок.'
  if (name === 'SecurityError') return 'Браузер заблокував мікрофон. Перевірте дозвіл для Xelay або напишіть текстову відповідь.'
  return 'Не вдалося записати голосове. Спробуйте ще раз або напишіть текстову відповідь.'
}

/** Local capture only. Permission is requested exclusively by start(), never on mount. */
export function createTeachingVoiceCapture(callbacks: CaptureCallbacks) {
  let disposed = false, generation = 0, active = false, stopping = false
  let stream: MediaStream | null = null, recorder: MediaRecorder | null = null
  let timer: ReturnType<typeof setInterval> | null = null, limitTimer: ReturnType<typeof setTimeout> | null = null
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let startedAt = 0, stoppedAt = 0, bytes = 0, chunks: Blob[] = [], failure = ''
  let endedListeners: Array<{ track: MediaStreamTrack; listener: () => void }> = []
  const clock = () => typeof performance !== 'undefined' ? performance.now() : Date.now()
  const stopTracks = () => {
    for (const { track, listener } of endedListeners) track.removeEventListener('ended', listener)
    endedListeners = []
    stream?.getTracks().forEach(track => track.stop())
    stream = null
  }
  const clearTimers = () => {
    if (timer !== null) clearInterval(timer)
    if (limitTimer !== null) clearTimeout(limitTimer)
    if (settleTimer !== null) clearTimeout(settleTimer)
    timer = null; limitTimer = null; settleTimer = null
  }
  const release = () => { clearTimers(); stopTracks() }
  const resetHandlers = () => {
    if (recorder) { recorder.ondataavailable = null; recorder.onerror = null; recorder.onstop = null }
    recorder = null
  }
  const stop = () => {
    if (!active || stopping || !recorder) return
    stopping = true; stoppedAt = clock()
    callbacks.onState('processing')
    clearTimers()
    // A browser/driver failure must not leave the reply form waiting forever
    // for a final dataavailable/stop event after the microphone is released.
    settleTimer = setTimeout(() => { failure = 'Не вдалося завершити запис. Запишіть голосове ще раз.'; finish() }, 5000)
    try { if (recorder.state !== 'inactive') recorder.stop() }
    catch { failure = 'Не вдалося завершити запис. Запишіть голосове ще раз.'; finish() }
    finally { stopTracks() }
  }
  const finish = () => {
    if (!active || disposed) { release(); resetHandlers(); return }
    const elapsed = Math.max(1, (stoppedAt || clock()) - startedAt)
    const mime = teachingVoiceMime(recorder?.mimeType || '') || teachingVoiceMime(chunks.find(chunk => chunk.type)?.type || '')
    const result = mime && bytes > 0 && bytes <= TEACHING_VOICE_MAX_BYTES ? new Blob(chunks, { type: mime }) : null
    if (elapsed > (TEACHING_VOICE_MAX_SECONDS + 1) * 1000) failure = 'Запис тривав довше 5 хвилин. Запишіть коротшу відповідь.'
    const problem = failure || (!result ? 'Запис порожній або його формат не підтримується. Спробуйте записати ще раз.' : '')
    active = false; stopping = false; chunks = []; bytes = 0
    release(); resetHandlers()
    if (problem) callbacks.onError(problem)
    else if (result && mime) {
      const extension = mime === 'audio/mp4' ? 'm4a' : mime === 'audio/ogg' ? 'ogg' : 'webm'
      callbacks.onComplete({ file: new File([result], `voice-reply.${extension}`, { type: mime }), durationSeconds: Math.min(TEACHING_VOICE_MAX_SECONDS, Math.ceil(elapsed / 1000)) })
    }
    callbacks.onState('idle')
  }
  const cancel = (notify = true) => {
    generation += 1; active = false; stopping = false
    const previous = recorder
    resetHandlers(); release(); chunks = []; bytes = 0; failure = ''
    try { if (previous && previous.state !== 'inactive') previous.stop() } catch { /* Tracks have already been stopped. */ }
    if (!disposed && notify) { callbacks.onTime(0); callbacks.onState('idle') }
  }
  return {
    async start() {
      if (disposed || active) return
      if (typeof window !== 'undefined' && !window.isSecureContext) { callbacks.onError('Для голосового запису відкрийте Xelay через захищене з’єднання HTTPS.'); return }
      if (typeof MediaRecorder === 'undefined' || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) { callbacks.onError('Цей браузер не підтримує запис голосу. Оновіть його або напишіть текстову відповідь.'); return }
      const attempt = ++generation
      active = true; stopping = false; failure = ''; chunks = []; bytes = 0; startedAt = 0; stoppedAt = 0
      callbacks.onTime(0); callbacks.onState('requesting')
      try {
        const captured = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        if (disposed || attempt !== generation || !active) { captured.getTracks().forEach(track => track.stop()); return }
        stream = captured
        if (!captured.getAudioTracks().some(track => track.readyState === 'live')) throw new Error('No live microphone')
        const mime = typeof MediaRecorder.isTypeSupported === 'function' ? TEACHING_VOICE_MIME_PREFERENCES.find(type => MediaRecorder.isTypeSupported(type)) : undefined
        recorder = new MediaRecorder(captured, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 64000 })
        recorder.ondataavailable = event => {
          if (disposed || attempt !== generation || !active || !event.data.size) return
          if (bytes + event.data.size > TEACHING_VOICE_MAX_BYTES) { failure = 'Голосове перевищує 10 МБ. Запишіть коротшу відповідь.'; chunks = []; bytes = 0; stop(); return }
          chunks.push(event.data); bytes += event.data.size
        }
        recorder.onerror = () => { if (attempt === generation && active) { failure = 'Запис перервався. Спробуйте записати голосове ще раз.'; stop() } }
        recorder.onstop = () => { if (attempt === generation) finish() }
        endedListeners = captured.getAudioTracks().map(track => {
          const listener = () => stop()
          track.addEventListener('ended', listener)
          return { track, listener }
        })
        recorder.start(1000); startedAt = clock()
        callbacks.onState('recording')
        timer = setInterval(() => { if (active && !stopping) callbacks.onTime(Math.min(TEACHING_VOICE_MAX_SECONDS, Math.floor((clock() - startedAt) / 1000))) }, 250)
        limitTimer = setTimeout(stop, TEACHING_VOICE_MAX_SECONDS * 1000)
      } catch (error) {
        if (disposed || attempt !== generation) return
        cancel(false); callbacks.onError(teachingVoiceError(error)); callbacks.onState('idle')
      }
    },
    stop,
    cancel() { cancel() },
    dispose() { disposed = true; cancel(false) },
  }
}

export type TeachingVoiceCapture = ReturnType<typeof createTeachingVoiceCapture>
