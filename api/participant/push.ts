import {
  participantActor, participantError, participantPushConfiguration, participantService,
  privateParticipantResponse, requestObject, validPushEndpoint, ParticipantRuntimeError,
} from '../../server/participantRuntime.js'

export const config = { maxDuration: 30 }
export default async function handler(req: any, res: any) {
  privateParticipantResponse(res)
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) { res.setHeader('Allow', 'GET, POST, DELETE'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    const service = participantService()
    if (req.method === 'GET') return res.status(200).json(await participantPushConfiguration(service))
    const actor = await participantActor(req, service)
    const body = requestObject(req)
    const endpoint = body.subscription?.endpoint || body.endpoint
    if (!validPushEndpoint(endpoint)) throw new ParticipantRuntimeError(400, 'Некоректна push-підписка.')
    if (req.method === 'DELETE') {
      // Opt-out remains available after paid access expires.
      const { error } = await service.from('participant_push_subscriptions').delete().eq('user_id', actor).eq('endpoint', endpoint)
      if (error) throw error
      return res.status(200).json({ subscribed: false })
    }
    if (body.operation === 'status') {
      const { data, error } = await service.from('participant_push_subscriptions').select('enabled').eq('user_id', actor).eq('endpoint', endpoint).maybeSingle()
      if (error) throw error
      return res.status(200).json({ subscribed: data?.enabled === true })
    }
    const configuration = await participantPushConfiguration(service)
    if (!configuration.available) throw new ParticipantRuntimeError(503, 'Фонові нагадування ще не підключені.')
    const keys = body.subscription?.keys
    if (!keys || !/^[A-Za-z0-9_-]{87}=?$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{22}(==)?$/.test(keys.auth)) {
      throw new ParticipantRuntimeError(400, 'Некоректна push-підписка.')
    }
    const { error } = await service.rpc('xelay_register_participant_push', {
      p_user_id: actor, p_endpoint: endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth,
      p_label: typeof body.label === 'string' ? body.label.slice(0, 120) : '',
    })
    if (error) {
      if (error.message.includes('PARTICIPANT_REQUIRED')) throw new ParticipantRuntimeError(403, 'Потрібна активна підписка «Учасник».')
      if (error.message.includes('PUSH_DEVICE_OTHER_ACCOUNT')) throw new ParticipantRuntimeError(409, 'Вимкніть push попереднього акаунта в цьому браузері та повторіть спробу.')
      if (error.message.includes('PUSH_DEVICE_LIMIT')) throw new ParticipantRuntimeError(409, 'Досягнуто ліміт 8 пристроїв для нагадувань.')
      throw error
    }
    return res.status(200).json({ subscribed: true })
  } catch (error) { return participantError(res, error) }
}
