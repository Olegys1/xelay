import {
  privateTimetableRecognitionResponse, recognizeTimetable, timetableRecognitionError, timetableRecognitionStatus,
} from '../../server/timetableRecognition.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
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
