/** Public activity stages only. Never include prompts, reasoning, credentials or private IDs. */
export const MAX_TUTOR_PROGRESS_PHASES = ['sending', 'preparing', 'generating', 'validating', 'saving'] as const
export type MaxTutorProgressPhase = typeof MAX_TUTOR_PROGRESS_PHASES[number]
export type MaxTutorProgressListener = (phase: MaxTutorProgressPhase) => void

export function isMaxTutorProgressPhase(value: unknown): value is MaxTutorProgressPhase {
  return typeof value === 'string' && MAX_TUTOR_PROGRESS_PHASES.some(phase => phase === value)
}

/** A bounded response parser; an interrupted stream is never a successful answer. */
export async function readTutorProgressResponse(response: Response, onProgress: MaxTutorProgressListener, maximum = 2_000_000): Promise<unknown> {
  if (response.redirected || !/^application\/x-ndjson(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body) throw Error('Invalid tutor progress response')
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', {fatal: true})
  let bytes = 0, buffer = '', result: unknown, complete = false, lastPhase = -1, events = 0
  function line(text: string) {
    if (!text.trim() || complete || ++events > 8) throw Error('Invalid tutor progress frame')
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid tutor progress frame')
    const frame = value as Record<string, unknown>
    if (frame.type === 'progress' && Object.keys(frame).length === 2 && isMaxTutorProgressPhase(frame.phase)) {
      const index = MAX_TUTOR_PROGRESS_PHASES.indexOf(frame.phase)
      if (index <= lastPhase) throw Error('Invalid tutor progress order')
      lastPhase = index
      try { onProgress(frame.phase) } catch { /* UI observers cannot change request settlement. */ }
    } else if (frame.type === 'result' && Object.keys(frame).length === 3 && Number.isSafeInteger(frame.status) && Number(frame.status) >= 200 && Number(frame.status) <= 599 && Object.prototype.hasOwnProperty.call(frame, 'value')) {
      result = frame.value; complete = true
    } else throw Error('Invalid tutor progress frame')
  }
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maximum) throw Error('Tutor progress response too large')
      buffer += decoder.decode(part.value, {stream: true})
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1) }
    }
    buffer += decoder.decode()
    if (buffer.length) line(buffer)
    if (!complete) throw Error('Incomplete tutor progress response')
    return result
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}
