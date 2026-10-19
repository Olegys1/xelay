import {
  privateTimetableRecognitionResponse, recognizeTimetable, timetableRecognitionError, timetableRecognitionStatus,
} from '../../server/timetableRecognition.js'
import {
  createSeminarAiDraft, privateSeminarAiDraftResponse, seminarAiDraftError, seminarAiDraftStatus,
} from '../../server/seminarAiDraft.js'

export const config = { maxDuration: 120 }

export default async function handler(req: any, res: any) {
  // A dedicated public URL rewrites here to retain the existing function count.
  // Keep seminar auth, quota and errors inside their separate server module.
  const aiRoute = req.query?.xelay_ai_route
  if (aiRoute !== undefined) {
    privateSeminarAiDraftResponse(res)
    if (aiRoute !== 'seminar') return res.status(400).json({ error: 'Некоректний маршрут запиту.' })
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST')
      return res.status(405).json({ error: 'Метод не підтримується.' })
    }
    try {
      const result = req.method === 'GET' ? await seminarAiDraftStatus(req) : await createSeminarAiDraft(req)
      if (req.aborted || res.destroyed || res.writableEnded) return
      return res.status(200).json(result)
    } catch (error) { return seminarAiDraftError(res, error) }
  }
  privateTimetableRecognitionResponse(res)
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Метод не підтримується.' })
  }
  try {
    const result = req.method === 'GET' ? await timetableRecognitionStatus(req) : await recognizeTimetable(req)
    if (req.aborted || res.destroyed || res.writableEnded) return
    return res.status(200).json(result)
  } catch (error) { return timetableRecognitionError(res, error) }
}
