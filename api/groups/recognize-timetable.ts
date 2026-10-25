import {
  privateTimetableRecognitionResponse, recognizeTimetable, timetableRecognitionError, timetableRecognitionStatus,
} from '../../server/timetableRecognition.js'
import {
  createSeminarAiDraft, privateSeminarAiDraftResponse, seminarAiDraftError, seminarAiDraftStatus,
} from '../../server/seminarAiDraft.js'
import { downloadTimetableGoogleSheet } from '../../server/timetableGoogleSheet.js'
import {
  createHomeworkAiDraft, privateHomeworkAiDraftResponse, homeworkAiDraftError, homeworkAiDraftStatus,
} from '../../server/homeworkAiDraft.js'

export const config = { maxDuration: 120 }

export default async function handler(req: any, res: any) {
  const timetableRoute = req.query?.xelay_timetable_route
  if (timetableRoute !== undefined) {
    privateTimetableRecognitionResponse(res)
    if (timetableRoute !== 'google-sheet' || req.query?.xelay_ai_route !== undefined) return res.status(400).json({ error: 'Некоректний маршрут запиту.' })
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return res.status(405).json({ error: 'Метод не підтримується.' })
    }
    const origin = req.headers?.origin
    const host = req.headers?.host
    if (origin !== undefined && (typeof origin !== 'string' || typeof host !== 'string'
      || ![`https://${host}`, ...(process.env.VERCEL_ENV !== 'production' ? [`http://${host}`] : [])].includes(origin))) {
      return res.status(403).json({ error: 'Завантажуйте таблицю зі сторінки своєї групи в Xelay.' })
    }
    try {
      const { bytes } = await downloadTimetableGoogleSheet(req)
      if (req.aborted || res.destroyed || res.writableEnded) return
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', 'attachment; filename="google-rozklad.xlsx"')
      res.setHeader('Content-Length', String(bytes.length))
      return res.status(200).send(bytes)
    } catch (error) { return timetableRecognitionError(res, error) }
  }
  // A dedicated public URL rewrites here to retain the existing function count.
  // Keep seminar auth, quota and errors inside their separate server module.
  const aiRoute = req.query?.xelay_ai_route
  if (aiRoute === 'homework') {
    privateHomeworkAiDraftResponse(res)
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST')
      return res.status(405).json({ error: 'Метод не підтримується.' })
    }
    const origin = req.headers?.origin
    const host = req.headers?.host
    if (origin !== undefined && (typeof origin !== 'string' || typeof host !== 'string'
      || ![`https://${host}`, ...(process.env.VERCEL_ENV !== 'production' ? [`http://${host}`] : [])].includes(origin))) {
      return res.status(403).json({ error: 'Готуйте чернетку зі сторінки своєї групи в Xelay.' })
    }
    try {
      const result = req.method === 'GET' ? await homeworkAiDraftStatus(req) : await createHomeworkAiDraft(req)
      if (req.aborted || res.destroyed || res.writableEnded) return
      return res.status(200).json(result)
    } catch (error) { return homeworkAiDraftError(res, error) }
  }
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
