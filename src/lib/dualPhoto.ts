export type DualPhotoFacing = 'environment' | 'user'
export type DualPhotoCameraIdentity = { facing: DualPhotoFacing; deviceId: string; reportedFacing: boolean }
export type DualPhotoCamera = { stream: MediaStream; identity: DualPhotoCameraIdentity }
export type DualPhotoFrame = { canvas: HTMLCanvasElement; facing: DualPhotoFacing }
type CameraDevices = Pick<MediaDevices, 'getUserMedia'> & Partial<Pick<MediaDevices, 'getSupportedConstraints'>>

export const DUAL_PHOTO_WIDTH = 1200
export const DUAL_PHOTO_HEIGHT = 1600
export const DUAL_PHOTO_MAX_BYTES = 5 * 1024 * 1024

function abortCheck(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Зйомку скасовано', 'AbortError')
}
function photoError(code: string) { return new Error(code) }

export function stopDualPhotoStream(stream?: MediaStream | null): void {
  stream?.getTracks().forEach(track => { try { track.stop() } catch { /* Already released. */ } })
}

function labelledFacing(label: string): DualPhotoFacing | null {
  const front = /\b(front|user|selfie|facetime)\b|передн|фронталь/i.test(label)
  const rear = /\b(back|rear|environment)\b|задн|тилов/i.test(label)
  return front === rear ? null : front ? 'user' : 'environment'
}

// A successful ideal constraint alone proves nothing: some devices return the
// same webcam for both requests. Verify actual facing and distinct device IDs.
export function dualPhotoCameraIdentity(track: MediaStreamTrack, facing: DualPhotoFacing,
  previous?: DualPhotoCameraIdentity, exactFacingAccepted = false): DualPhotoCameraIdentity {
  const settings = track.getSettings()
  const reported = settings.facingMode === 'environment' || settings.facingMode === 'user'
    ? settings.facingMode : labelledFacing(track.label || '')
  if (track.readyState === 'ended' || reported && reported !== facing) throw photoError('DUAL_PHOTO_OPPOSITE_CAMERA_REQUIRED')
  if (!reported && !exactFacingAccepted) throw photoError('DUAL_PHOTO_CAMERA_UNVERIFIED')
  const identity = { facing, deviceId: settings.deviceId || '', reportedFacing: Boolean(reported) }
  if (previous) {
    if (previous.facing === facing || identity.deviceId && previous.deviceId === identity.deviceId) {
      throw photoError('DUAL_PHOTO_OPPOSITE_CAMERA_REQUIRED')
    }
    if ((!identity.deviceId || !previous.deviceId) && (!identity.reportedFacing || !previous.reportedFacing)) {
      throw photoError('DUAL_PHOTO_CAMERA_UNVERIFIED')
    }
  }
  return identity
}

export async function openDualPhotoCamera(facing: DualPhotoFacing, previous?: DualPhotoCameraIdentity,
  signal?: AbortSignal, media?: CameraDevices): Promise<DualPhotoCamera> {
  abortCheck(signal)
  const devices = media || (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined)
  if (!devices?.getUserMedia) throw photoError('DUAL_PHOTO_UNSUPPORTED')
  let stream: MediaStream | null = null
  let exact = true
  try {
    try {
      stream = await devices.getUserMedia({ audio: false, video: {
        facingMode: { exact: facing }, width: { ideal: 1200 }, height: { ideal: 1600 },
      } })
    } catch (error) {
      abortCheck(signal)
      // Retry unsupported exact constraints, never denied permission or a busy
      // device. The fallback still has to prove its actual camera orientation.
      const name = (error as { name?: string })?.name
      if (name !== 'OverconstrainedError' && name !== 'ConstraintNotSatisfiedError') throw error
      exact = false
      stream = await devices.getUserMedia({ audio: false, video: {
        facingMode: { ideal: facing }, width: { ideal: 1200 }, height: { ideal: 1600 },
      } })
    }
    abortCheck(signal)
    const tracks = stream.getVideoTracks()
    if (tracks.length !== 1) throw photoError('DUAL_PHOTO_CAMERA_UNAVAILABLE')
    // Do not retain an unexpected microphone track even if a browser returns it.
    stream.getAudioTracks().forEach(track => track.stop())
    const identity = dualPhotoCameraIdentity(tracks[0], facing, previous,
      exact && devices.getSupportedConstraints?.().facingMode === true)
    return { stream, identity }
  } catch (error) {
    // getUserMedia itself cannot be aborted. A late result after close/retake
    // arrives here and is released before the caller can attach it to a video.
    stopDualPhotoStream(stream)
    throw error
  }
}

export function dualPhotoDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('Зйомку скасовано', 'AbortError')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export function waitForDualPhotoVideo(video: HTMLVideoElement, stream: MediaStream, signal?: AbortSignal,
  timeoutMs = 12_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false, playing = false, frameRequest: number | null = null
    const track = stream.getVideoTracks()[0]
    const cleanup = () => {
      clearTimeout(timeout); clearInterval(poll)
      signal?.removeEventListener('abort', abort)
      video.removeEventListener('loadeddata', ready); video.removeEventListener('canplay', ready)
      video.removeEventListener('resize', ready); video.removeEventListener('error', failed)
      track?.removeEventListener('ended', failed)
      if (frameRequest !== null) video.cancelVideoFrameCallback?.(frameRequest)
    }
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true; cleanup()
      if (error) reject(error); else resolve()
    }
    const abort = () => finish(new DOMException('Зйомку скасовано', 'AbortError'))
    const failed = () => finish(photoError('DUAL_PHOTO_CAMERA_UNAVAILABLE'))
    const hasFrame = () => video.srcObject === stream && track?.readyState !== 'ended'
      && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0
    const ready = () => {
      if (settled || !playing || !hasFrame() || frameRequest !== null) return
      if (typeof video.requestVideoFrameCallback === 'function') {
        frameRequest = video.requestVideoFrameCallback(() => {
          frameRequest = null
          if (hasFrame()) finish(); else ready()
        })
      } else finish()
    }
    const timeout = setTimeout(() => finish(photoError('DUAL_PHOTO_VIDEO_TIMEOUT')), timeoutMs)
    const poll = setInterval(ready, 100)
    video.addEventListener('loadeddata', ready); video.addEventListener('canplay', ready)
    video.addEventListener('resize', ready); video.addEventListener('error', failed)
    track?.addEventListener('ended', failed, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    video.muted = true; video.playsInline = true; video.autoplay = true
    video.srcObject = stream
    try {
      Promise.resolve(video.play()).then(() => { playing = true; ready() }, () => finish(photoError('DUAL_PHOTO_PLAY_FAILED')))
    } catch { finish(photoError('DUAL_PHOTO_PLAY_FAILED')) }
  })
}

export function captureDualPhotoFrame(video: HTMLVideoElement, facing: DualPhotoFacing): DualPhotoFrame {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw photoError('DUAL_PHOTO_VIDEO_TIMEOUT')
  const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw photoError('DUAL_PHOTO_CANVAS_UNAVAILABLE')
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return { canvas, facing }
}

export function dualPhotoCrop(sourceWidth: number, sourceHeight: number, width: number, height: number) {
  if (![sourceWidth, sourceHeight, width, height].every(value => Number.isFinite(value) && value > 0)) {
    throw photoError('DUAL_PHOTO_CANVAS_UNAVAILABLE')
  }
  const scale = Math.max(width / sourceWidth, height / sourceHeight)
  const sw = width / scale, sh = height / scale
  return { sx: (sourceWidth - sw) / 2, sy: (sourceHeight - sh) / 2, sw, sh }
}

function drawPhoto(context: CanvasRenderingContext2D, frame: DualPhotoFrame, x: number, y: number, width: number, height: number) {
  const crop = dualPhotoCrop(frame.canvas.width, frame.canvas.height, width, height)
  context.save()
  if (frame.facing === 'user') { context.translate(x + width, y); context.scale(-1, 1) }
  else context.translate(x, y)
  context.drawImage(frame.canvas, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height)
  context.restore()
}

function roundedBox(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath(); context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius); context.arcTo(x, y, x + width, y, radius)
  context.closePath()
}

function jpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob?.type === 'image/jpeg'
    ? resolve(blob) : reject(photoError('DUAL_PHOTO_ENCODE_FAILED')), 'image/jpeg', quality))
}

export async function composeDualPhoto(rear: DualPhotoFrame, selfie: DualPhotoFrame,
  selfieMain = false, signal?: AbortSignal): Promise<File> {
  abortCheck(signal)
  if (rear.facing !== 'environment' || selfie.facing !== 'user') throw photoError('DUAL_PHOTO_OPPOSITE_CAMERA_REQUIRED')
  const canvas = document.createElement('canvas')
  canvas.width = DUAL_PHOTO_WIDTH; canvas.height = DUAL_PHOTO_HEIGHT
  const context = canvas.getContext('2d')
  if (!context) throw photoError('DUAL_PHOTO_CANVAS_UNAVAILABLE')
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
  drawPhoto(context, selfieMain ? selfie : rear, 0, 0, canvas.width, canvas.height)
  const width = Math.round(canvas.width * 0.3), height = Math.round(width * 4 / 3)
  const margin = Math.round(canvas.width * 0.035), radius = Math.round(width * 0.13)
  context.save(); roundedBox(context, margin, margin, width, height, radius); context.clip()
  drawPhoto(context, selfieMain ? rear : selfie, margin, margin, width, height)
  context.restore()
  roundedBox(context, margin, margin, width, height, radius)
  context.strokeStyle = '#ffffff'; context.lineWidth = 8; context.stroke()
  for (const quality of [0.9, 0.8, 0.68, 0.54, 0.4]) {
    abortCheck(signal)
    const blob = await jpeg(canvas, quality)
    abortCheck(signal)
    if (blob.size > 0 && blob.size <= DUAL_PHOTO_MAX_BYTES) {
      return new File([blob], `xelay-dual-photo-${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
    }
  }
  throw photoError('DUAL_PHOTO_TOO_LARGE')
}

export function dualPhotoError(error: unknown): string {
  const value = error as { name?: string; message?: string } | null
  if (value?.name === 'NotAllowedError' || value?.name === 'PermissionDeniedError' || value?.name === 'SecurityError') {
    return 'Дозвольте доступ до камери в налаштуваннях браузера й спробуйте ще раз.'
  }
  if (value?.name === 'NotFoundError' || value?.message === 'DUAL_PHOTO_OPPOSITE_CAMERA_REQUIRED'
    || value?.message === 'DUAL_PHOTO_CAMERA_UNVERIFIED') {
    return 'Потрібні дві різні камери: основна та фронтальна. Відкрийте Xelay у браузері телефона з обома камерами.'
  }
  if (value?.message === 'DUAL_PHOTO_UNSUPPORTED') return 'Цей браузер не підтримує зйомку. Відкрийте Xelay через HTTPS у Safari або Chrome на телефоні.'
  if (value?.name === 'NotReadableError' || value?.message === 'DUAL_PHOTO_CAMERA_UNAVAILABLE') return 'Камера недоступна. Закрийте інші застосунки з камерою та повторіть спробу.'
  if (value?.message === 'DUAL_PHOTO_VIDEO_TIMEOUT' || value?.message === 'DUAL_PHOTO_PLAY_FAILED') return 'Не вдалося отримати зображення з камери. Спробуйте зйомку ще раз.'
  if (value?.message === 'DUAL_PHOTO_TOO_LARGE') return 'Не вдалося зменшити фото до 5 МБ. Спробуйте зробити нові кадри.'
  return 'Не вдалося підготувати подвійне фото. Спробуйте ще раз.'
}
