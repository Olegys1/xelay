import { authorizeParticipantWorker, dispatchParticipantPush, participantError, participantService, privateParticipantResponse, ParticipantRuntimeError } from '../../server/participantRuntime.js'

export const config = { maxDuration: 60 }
export default async function handler(req: any, res: any) {
  privateParticipantResponse(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    authorizeParticipantWorker(req)
    if (process.env.PARTICIPANT_BACKGROUND_ENABLED !== 'true') throw new ParticipantRuntimeError(503, 'Фонова обробка вимкнена.')
    const deadline = Date.now() + 52000
    const service = participantService(deadline)
    const scheduled = await service.rpc('xelay_dispatch_scheduled_direct_messages', { p_limit: 20 })
    if (scheduled.error) throw scheduled.error
    const reminders = await service.rpc('xelay_dispatch_organizer_reminders', { p_limit: 20 })
    if (reminders.error) throw reminders.error
    const push = await dispatchParticipantPush(service, deadline - 8000)
    const heartbeat = await service.rpc('xelay_participant_worker_heartbeat')
    if (heartbeat.error) throw heartbeat.error
    return res.status(200).json({ ok: true, scheduled: scheduled.data, reminders: reminders.data, push })
  } catch (error) { return participantError(res, error) }
}
