import { supabase } from './supabase'
import { uploadTeachingStorageFile } from './teachingFileUpload'

export const TEACHING_GRADE_VOICE_BUCKET = 'teaching-grade-voices'
export const TEACHING_GRADE_VOICE_MAX_BYTES = 10 * 1024 * 1024
export const TEACHING_GRADE_VOICE_MAX_SECONDS = 300
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MIME_EXTENSIONS: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4' }

export type TeachingGradeVoice = { storage_path: string; mime_type: string; size: number; duration_seconds: number }
export type TeachingGradeVoiceRecording = { file: File; durationSeconds: number }

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Завантаження голосової відповіді скасовано.', 'AbortError')
}

/** Accept only the private request/uploader/voice layout, never an arbitrary URL. */
export function validateTeachingGradeVoice(requestId: string, value: unknown, userId?: string): TeachingGradeVoice {
  if (!UUID.test(requestId) || userId !== undefined && !UUID.test(userId) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TEACHING_GRADE_VOICE_INVALID')
  const voice = value as TeachingGradeVoice
  const extension = Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, voice.mime_type) ? MIME_EXTENSIONS[voice.mime_type] : undefined
  const parts = typeof voice.storage_path === 'string' ? voice.storage_path.split('/') : []
  if (!extension || parts.length !== 3 || parts[0] !== requestId || !UUID.test(parts[1])
    || userId !== undefined && parts[1] !== userId || !parts[2].endsWith(`.${extension}`)
    || !UUID.test(parts[2].slice(0, -(extension.length + 1)))
    || !Number.isSafeInteger(voice.size) || voice.size <= 0 || voice.size > TEACHING_GRADE_VOICE_MAX_BYTES
    || !Number.isFinite(voice.duration_seconds) || voice.duration_seconds <= 0 || voice.duration_seconds > TEACHING_GRADE_VOICE_MAX_SECONDS) throw new Error('TEACHING_GRADE_VOICE_INVALID')
  return { storage_path: voice.storage_path, mime_type: voice.mime_type, size: voice.size, duration_seconds: voice.duration_seconds }
}

async function currentSession(userId?: string, signal?: AbortSignal) {
  aborted(signal)
  const { data, error } = await supabase.auth.getSession()
  aborted(signal)
  if (error || !data.session?.access_token || !UUID.test(data.session.user.id) || userId !== undefined && data.session.user.id !== userId) throw new Error('TEACHING_ACTOR_CHANGED')
  return data.session
}

function recordingMetadata(requestId: string, userId: string, recording: TeachingGradeVoiceRecording, uploadId: string): TeachingGradeVoice {
  const file = recording?.file
  const mimeType = typeof file?.type === 'string' ? file.type.toLowerCase().split(';')[0].trim() : ''
  const extension = Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, mimeType) ? MIME_EXTENSIONS[mimeType] : undefined
  if (!extension || !file || typeof file.arrayBuffer !== 'function') throw new Error('TEACHING_GRADE_VOICE_INVALID')
  return validateTeachingGradeVoice(requestId, { storage_path: `${requestId}/${userId}/${uploadId}.${extension}`,
    mime_type: mimeType, size: file.size, duration_seconds: recording.durationSeconds }, userId)
}

/** A server reservation checks the actor and request before any bytes are sent. */
export async function uploadGradeVoice(requestId: string, userId: string, recording: TeachingGradeVoiceRecording,
  onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<TeachingGradeVoice> {
  aborted(signal)
  const uploadId = crypto.randomUUID()
  const expected = recordingMetadata(requestId, userId, recording, uploadId)
  await currentSession(userId, signal)
  const { data, error } = await supabase.rpc('xelay_teaching_prepare_grade_voice', {
    p_request_id: requestId, p_upload_id: uploadId, p_mime_type: expected.mime_type,
    p_size: expected.size, p_duration_seconds: expected.duration_seconds,
  })
  aborted(signal)
  if (error) throw error
  const prepared = validateTeachingGradeVoice(requestId, data, userId)
  if (prepared.storage_path !== expected.storage_path || prepared.mime_type !== expected.mime_type
    || prepared.size !== expected.size || prepared.duration_seconds !== expected.duration_seconds) throw new Error('TEACHING_GRADE_VOICE_INVALID')
  const session = await currentSession(userId, signal)
  try {
    await uploadTeachingStorageFile({ bucket: TEACHING_GRADE_VOICE_BUCKET, storagePath: prepared.storage_path,
      file: recording.file, mimeType: prepared.mime_type, accessToken: session.access_token, onProgress, signal })
    await currentSession(userId, signal)
    return prepared
  } catch (failure) {
    // A failed/uncertain upload is not a reply. DELETE independently refuses a
    // voice already attached to a resolved request; never delete on client trust.
    await discardGradeVoice(requestId, prepared).catch(() => {})
    throw failure
  }
}

/** Only the uploader's still-unused attachment is deletable under Storage RLS. */
export async function discardGradeVoice(requestId: string, voice: TeachingGradeVoice): Promise<void> {
  const file = validateTeachingGradeVoice(requestId, voice)
  const uploader = file.storage_path.split('/')[1]
  await currentSession(uploader)
  const { error } = await supabase.storage.from(TEACHING_GRADE_VOICE_BUCKET).remove([file.storage_path])
  if (error) throw error
}

/** Storage SELECT enforces the current request student's/scoped teacher's access. */
export async function gradeVoiceUrl(requestId: string, voice: TeachingGradeVoice): Promise<string> {
  const file = validateTeachingGradeVoice(requestId, voice)
  const session = await currentSession()
  const { data, error } = await supabase.storage.from(TEACHING_GRADE_VOICE_BUCKET).createSignedUrl(file.storage_path, 120)
  if (error || !data?.signedUrl) throw error || new Error('TEACHING_GRADE_VOICE_UNAVAILABLE')
  await currentSession(session.user.id)
  try {
    const url = new URL(data.signedUrl)
    const configured = new URL(import.meta.env.VITE_SUPABASE_URL as string)
    if (url.origin !== configured.origin || url.username || url.password || url.hash
      || !['https:', 'http:'].includes(url.protocol)
      || decodeURIComponent(url.pathname) !== `/storage/v1/object/sign/${TEACHING_GRADE_VOICE_BUCKET}/${file.storage_path}`) throw new Error()
    return url.href
  } catch { throw new Error('TEACHING_GRADE_VOICE_UNAVAILABLE') }
}
