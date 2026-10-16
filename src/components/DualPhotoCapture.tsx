import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, Camera, Check, Loader2, RotateCcw, ShieldCheck } from 'lucide-react'
import { ChatDialog, chatButton, chatPrimary } from './CommunityChatPrimitives'
import {
  captureDualPhotoFrame, composeDualPhoto, dualPhotoDelay, dualPhotoError, openDualPhotoCamera,
  stopDualPhotoStream, waitForDualPhotoVideo,
  type DualPhotoCameraIdentity, type DualPhotoFacing, type DualPhotoFrame,
} from '../lib/dualPhoto'

type Phase = 'openingRear' | 'rear' | 'openingFront' | 'countdown' | 'composing' | 'review' | 'paused' | 'error'
type Props = { onCapture: (file: File) => boolean | void; onClose: () => void }

export function DualPhotoCapture({ onCapture, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('openingRear')
  const [error, setError] = useState('')
  const [countdown, setCountdown] = useState(3)
  const [selfieMain, setSelfieMain] = useState(false)
  const [preview, setPreview] = useState('')
  const [adding, setAdding] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const progress = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const removeEnded = useRef<(() => void) | null>(null)
  const rearCamera = useRef<DualPhotoCameraIdentity | null>(null)
  const frames = useRef<{ rear: DualPhotoFrame; selfie?: DualPhotoFrame } | null>(null)
  const file = useRef<File | null>(null)
  const previewUrl = useRef('')
  const phaseRef = useRef<Phase>(phase)
  const shutterBusy = useRef(false)
  const addBusy = useRef(false)
  const callbacks = useRef({ onCapture, onClose }); callbacks.current = { onCapture, onClose }

  const changePhase = useCallback((next: Phase) => {
    phaseRef.current = next
    if (mounted.current) setPhase(next)
  }, [])
  const releaseCamera = useCallback(() => {
    removeEnded.current?.(); removeEnded.current = null
    stopDualPhotoStream(stream.current); stream.current = null
    const element = video.current
    if (element) {
      try { element.pause() } catch { /* The source may already be detached. */ }
      element.srcObject = null
    }
  }, [])
  const invalidate = useCallback(() => {
    ++generation.current; controller.current?.abort(); controller.current = null
    releaseCamera(); shutterBusy.current = false
  }, [releaseCamera])
  const clearReview = useCallback(() => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = ''; file.current = null
    if (mounted.current) setPreview('')
  }, [])
  const current = useCallback((ticket: number, signal: AbortSignal) => mounted.current
    && ticket === generation.current && !signal.aborted && document.visibilityState !== 'hidden', [])
  const fail = useCallback((reason: unknown, ticket: number, signal: AbortSignal) => {
    if (!current(ticket, signal)) return
    invalidate(); frames.current = null; rearCamera.current = null
    setError(dualPhotoError(reason)); changePhase('error')
  }, [changePhase, current, invalidate])
  const attach = useCallback(async (facing: DualPhotoFacing, ticket: number, signal: AbortSignal,
    previous?: DualPhotoCameraIdentity) => {
    const result = await openDualPhotoCamera(facing, previous, signal)
    if (!current(ticket, signal)) { stopDualPhotoStream(result.stream); throw new DOMException('Зйомку скасовано', 'AbortError') }
    stream.current = result.stream
    const track = result.stream.getVideoTracks()[0]
    const ended = () => fail(new Error('DUAL_PHOTO_CAMERA_UNAVAILABLE'), ticket, signal)
    track.addEventListener('ended', ended, { once: true })
    removeEnded.current = () => track.removeEventListener('ended', ended)
    if (!video.current) throw new Error('DUAL_PHOTO_UNSUPPORTED')
    await waitForDualPhotoVideo(video.current, result.stream, signal)
    if (!current(ticket, signal)) throw new DOMException('Зйомку скасовано', 'AbortError')
    return result.identity
  }, [current, fail])

  const start = useCallback(async () => {
    invalidate(); clearReview(); frames.current = null; rearCamera.current = null
    if (!mounted.current) return
    setError(''); setSelfieMain(false); setCountdown(3); setAdding(false); addBusy.current = false
    if (document.visibilityState === 'hidden') { changePhase('paused'); return }
    const ticket = generation.current, next = new AbortController()
    controller.current = next
    changePhase('openingRear')
    try {
      const identity = await attach('environment', ticket, next.signal)
      if (!current(ticket, next.signal)) return
      rearCamera.current = identity; changePhase('rear')
    } catch (reason) { fail(reason, ticket, next.signal) }
  }, [attach, changePhase, clearReview, current, fail, invalidate])

  const renderReview = useCallback(async (mainSelfie: boolean, ticket: number, signal: AbortSignal) => {
    const captured = frames.current
    if (!captured?.selfie) throw new Error('DUAL_PHOTO_CAMERA_UNAVAILABLE')
    changePhase('composing')
    const result = await composeDualPhoto(captured.rear, captured.selfie, mainSelfie, signal)
    if (!current(ticket, signal)) return
    const nextUrl = URL.createObjectURL(result)
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = nextUrl; file.current = result
    setPreview(nextUrl); setSelfieMain(mainSelfie); changePhase('review')
  }, [changePhase, current])

  const capture = async () => {
    if (shutterBusy.current || phaseRef.current !== 'rear' || !video.current || !controller.current || !rearCamera.current) return
    shutterBusy.current = true
    const ticket = generation.current, signal = controller.current.signal
    try {
      if (!current(ticket, signal)) return
      frames.current = { rear: captureDualPhotoFrame(video.current, 'environment') }
      releaseCamera(); changePhase('openingFront')
      // Give mobile hardware a short release interval before requesting the
      // opposite lens. Both shots are sequential, never simultaneous.
      await dualPhotoDelay(200, signal)
      await attach('user', ticket, signal, rearCamera.current)
      if (!current(ticket, signal)) return
      changePhase('countdown')
      for (let seconds = 3; seconds > 0; seconds -= 1) {
        if (!current(ticket, signal)) return
        setCountdown(seconds); await dualPhotoDelay(1000, signal)
      }
      if (!current(ticket, signal) || !video.current || !frames.current) return
      frames.current.selfie = captureDualPhotoFrame(video.current, 'user')
      releaseCamera()
      await renderReview(false, ticket, signal)
    } catch (reason) { fail(reason, ticket, signal) }
    finally { if (ticket === generation.current) shutterBusy.current = false }
  }
  const swap = async () => {
    if (phaseRef.current !== 'review' || !controller.current || addBusy.current) return
    const ticket = generation.current, signal = controller.current.signal
    setError('')
    try { await renderReview(!selfieMain, ticket, signal) }
    catch (reason) { fail(reason, ticket, signal) }
  }
  const add = () => {
    if (!mounted.current || phaseRef.current !== 'review' || !file.current || addBusy.current) return
    addBusy.current = true; setAdding(true); setError('')
    try {
      const accepted = callbacks.current.onCapture(file.current)
      if (accepted === false && mounted.current) {
        addBusy.current = false; setAdding(false)
        setError('Не вдалося додати фото. Перевірте кількість і розмір вкладень у повідомленні.')
      }
    } catch {
      addBusy.current = false
      if (mounted.current) { setAdding(false); setError('Не вдалося додати фото. Спробуйте ще раз.') }
    }
    // The parent validates its target/attachment queue and closes only after
    // acceptance. Never auto-send or close a rejected attachment here.
  }
  const close = () => {
    mounted.current = false; invalidate(); frames.current = null; rearCamera.current = null
    clearReview(); callbacks.current.onClose()
  }

  useEffect(() => {
    mounted.current = true
    void start()
    const pause = () => {
      if (!mounted.current) return
      if (phaseRef.current === 'review') { releaseCamera(); return }
      invalidate(); frames.current = null; rearCamera.current = null; clearReview()
      setError(''); changePhase('paused')
    }
    const visibility = () => { if (document.visibilityState === 'hidden') pause() }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', pause)
    return () => {
      mounted.current = false; invalidate(); frames.current = null; rearCamera.current = null
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
      previewUrl.current = ''; file.current = null
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pause)
    }
  }, [changePhase, clearReview, invalidate, releaseCamera, start])

  useEffect(() => {
    // A retake/swap replaces the focused review button. Keep keyboard focus in
    // the dialog while that control is absent instead of dropping to the page.
    const dialog = progress.current?.closest('[role="dialog"]')
    if (dialog && !dialog.contains(document.activeElement)) {
      // Use a control recognized by ChatDialog's existing Tab loop.
      const target = dialog.querySelector<HTMLButtonElement>('button:not(:disabled)') || progress.current
      target?.focus()
    }
  }, [phase])

  // Visible video keeps requestVideoFrameCallback progressing on mobile Safari
  // while the loading overlay covers it. visibility:hidden can suspend frames.
  const cameraVisible = phase === 'openingRear' || phase === 'rear' || phase === 'openingFront' || phase === 'countdown'
  const waiting = phase === 'openingRear' || phase === 'openingFront' || phase === 'composing'
  const selfieVisible = phase === 'openingFront' || phase === 'countdown'
  const status = phase === 'openingRear' ? 'Відкриваємо основну камеру…'
    : phase === 'rear' ? '1 / 2 · Зніміть те, що перед вами'
      : phase === 'openingFront' ? 'Перемикаємо на фронтальну камеру…'
        : phase === 'countdown' ? `2 / 2 · Селфі автоматично через ${countdown} с`
          : phase === 'composing' ? 'Готуємо подвійне фото…'
            : phase === 'review' ? 'Перевірте обидва кадри'
              : phase === 'paused' ? 'Зйомку призупинено' : 'Не вдалося відкрити камеру'

  return <ChatDialog title="Подвійне фото" onClose={close}>
    <p className="text-sm leading-relaxed text-muted-foreground">Один натиск: спочатку основна камера, потім селфі через 3 секунди. Кадри знімаються по черзі.</p>
    <div ref={progress} tabIndex={-1} className="mt-3 flex min-h-8 items-center gap-2 text-sm font-medium outline-none" role="status" aria-live="polite" aria-atomic="true">
      {waiting && <Loader2 size={16} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />}
      {status}
    </div>
    <div className="relative mx-auto mt-3 aspect-[3/4] w-full max-w-[min(330px,32dvh)] overflow-hidden rounded-2xl bg-black shadow-sm">
      <video ref={video} muted playsInline autoPlay aria-label={selfieVisible ? 'Фронтальна камера' : 'Основна камера'}
        className={`h-full w-full object-cover ${cameraVisible ? '' : 'invisible'} ${selfieVisible ? '-scale-x-100' : ''}`} />
      {preview && <img src={preview} alt="Попередній перегляд двох кадрів: основна камера та селфі" className="absolute inset-0 h-full w-full object-cover" />}
      {waiting && <div className="absolute inset-0 flex items-center justify-center bg-black/25 text-white"><Loader2 size={34} aria-label="Підготовка камери та фото" className="animate-spin motion-reduce:animate-none" /></div>}
      {phase === 'countdown' && <div className="absolute bottom-5 left-1/2 flex h-16 w-16 -translate-x-1/2 items-center justify-center rounded-full bg-black/55 text-3xl font-semibold text-white" aria-hidden="true">{countdown}</div>}
      {(phase === 'error' || phase === 'paused') && <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm leading-relaxed text-white/85">{phase === 'paused' ? 'Камери вимкнено. Поверніться до зйомки, коли будете готові.' : 'Перевірте доступ до обох камер і повторіть спробу.'}</div>}
    </div>
    {error && <p role="alert" className="mt-3 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm leading-relaxed text-destructive">{error}</p>}
    {phase === 'rear' && <button type="button" onClick={() => void capture()} className={`${chatPrimary} mt-4 w-full`}><Camera size={18} aria-hidden="true" />Зняти подвійне фото</button>}
    {phase === 'review' && <>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => void swap()} disabled={adding} className={chatButton}><ArrowLeftRight size={16} aria-hidden="true" />Поміняти кадри</button>
        <button type="button" onClick={() => void start()} disabled={adding} className={chatButton}><RotateCcw size={16} aria-hidden="true" />Перезняти</button>
      </div>
      <button type="button" onClick={add} disabled={adding} className={`${chatPrimary} mt-3 w-full`}><Check size={17} aria-hidden="true" />Додати до повідомлення</button>
      <p className="mt-2 text-center text-xs text-muted-foreground">Селфі віддзеркалено, як у попередньому перегляді камери.</p>
    </>}
    {(phase === 'error' || phase === 'paused') && <button type="button" onClick={() => void start()} className={`${chatPrimary} mt-4 w-full`}><RotateCcw size={17} aria-hidden="true" />{phase === 'paused' ? 'Почати зйомку знову' : 'Спробувати ще раз'}</button>}
    <p className="mt-4 flex gap-2 text-xs leading-relaxed text-muted-foreground"><ShieldCheck size={15} aria-hidden="true" className="mt-0.5 shrink-0" />Фото готується на вашому пристрої. Додайте його до повідомлення й надішліть, коли будете готові.</p>
  </ChatDialog>
}

export default DualPhotoCapture
