import {MAX_TUTOR_PROGRESS_PHASES, type MaxTutorProgressPhase} from '../../src/lib/maxTutorProgress.js'

/** Opt-in streaming keeps the JSON endpoint compatible with existing clients. */
export function createTutorProgressResponse(req: {headers?: Record<string, unknown>}, res: any) {
  const accept = req.headers?.accept
  const streaming = typeof accept === 'string' && accept.split(',').some(value => value.trim() === 'application/x-ndjson') && typeof res.write === 'function'
  let started = false, lastPhase = -1
  function start() {
    if (started) return
    started = true; res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson;charset=utf-8')
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
  }
  return {
    progress(phase: MaxTutorProgressPhase) {
      if (!streaming || res.writableEnded || res.destroyed) return
      const index = MAX_TUTOR_PROGRESS_PHASES.indexOf(phase)
      if (index <= lastPhase || index < 0) return
      lastPhase = index; start()
      res.write(JSON.stringify({type: 'progress', phase}) + '\n')
    },
    send(status: number, value: unknown) {
      if (res.writableEnded || res.destroyed) return
      if (!started) { res.setHeader('Cache-Control', 'no-store, private'); res.setHeader('X-Content-Type-Options', 'nosniff') }
      if (streaming && started) res.end(JSON.stringify({type: 'result', status, value}) + '\n')
      else { res.statusCode = status; res.setHeader('Content-Type', 'application/json;charset=utf-8'); res.end(JSON.stringify(value)) }
    },
  }
}
