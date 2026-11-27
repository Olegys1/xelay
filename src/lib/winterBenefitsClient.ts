import { supabase } from './supabase'
import { parseWinterBenefitAction, parseWinterBenefitsState, type WinterBenefitAction, type WinterBenefitsState } from './winterBenefits'

/** Every mutation uses the account for which its button was rendered. */
export async function requestWinterBenefits(expectedUserId: string, action?: WinterBenefitAction, signal?: AbortSignal): Promise<WinterBenefitsState> {
  const payload = action ? parseWinterBenefitAction(action) : undefined
  const { data: { session } } = await supabase.auth.getSession()
  if (!session || session.user.id !== expectedUserId) throw new Error('Акаунт змінився. Оновіть сторінку подарунків.')
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const response = await fetch('/api/winter/benefits', {
    method: payload ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin', signal,
    headers: { Accept: 'application/json', Authorization: `Bearer ${session.access_token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  })
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Подарунки тимчасово недоступні. Спробуйте ще раз.')
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Не вдалося використати подарунок. Спробуйте ще раз.')
  return parseWinterBenefitsState(data)
}
