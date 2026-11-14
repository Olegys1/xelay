import type { AuthReadScope } from './authBootstrap'

export const ACCOUNT_BOOTSTRAP_RPC = 'xelay_my_account_bootstrap'
export type AccountReadResult<T = any> = { data: T | null; error: any; status?: number }
export type AccountBootstrap = {
  profile: AccountReadResult<Record<string, any>>
  roles: AccountReadResult<any[]>
  representative_requests: AccountReadResult<any[]>
  memberships: AccountReadResult<any[]>
  teacher: AccountReadResult<any>
  representative_status: AccountReadResult<any>
}
type BootstrapSource = { rpc(name: string): { abortSignal(signal: AbortSignal): PromiseLike<AccountReadResult> } }
const invalid = () => Object.assign(new Error('Account response unavailable'), { code: 'ACCOUNT_BOOTSTRAP_INVALID' })
const object = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** A missing deployment capability is the ONLY legacy-fallback condition.
 * A denial, overload, timeout or malformed response must not amplify traffic. */
export function createAccountBootstrapReader(source: BootstrapSource) {
  let capability: 'unknown' | 'available' | 'missing' = 'unknown'
  return async (userId: string, reads: AuthReadScope): Promise<AccountBootstrap | null> => {
    if (capability === 'missing') return null
    const result = await reads.read(signal => source.rpc(ACCOUNT_BOOTSTRAP_RPC).abortSignal(signal))
    if (result.error) {
      if (capability === 'unknown' && result.status === 404 && result.error.code === 'PGRST202'
        && typeof result.error.message === 'string' && result.error.message.includes(ACCOUNT_BOOTSTRAP_RPC)) {
        capability = 'missing'
        return null
      }
      throw Object.assign(new Error('Account service unavailable'), result.error, { status: result.status })
    }
    const bundle = result.data
    if (!object(bundle) || !object(bundle.profile) || bundle.profile.error || bundle.profile.status !== 200
      || bundle.profile.data !== null && (!object(bundle.profile.data) || bundle.profile.data.id !== userId)) throw invalid()
    // An absent primary row is an authoritative empty profile; no grants follow.
    if (bundle.profile.data === null) {
      capability = 'available'
      const unavailable = { data: null, error: { code: 'ACCOUNT_PROFILE_MISSING' }, status: 404 }
      return { profile: bundle.profile as AccountBootstrap['profile'], roles: unavailable, representative_requests: unavailable,
        memberships: unavailable, teacher: unavailable, representative_status: unavailable }
    }
    for (const key of ['roles', 'representative_requests', 'memberships', 'teacher', 'representative_status']) {
      const section = bundle[key]
      if (!object(section) || !Number.isInteger(section.status) || section.status < 200 || section.status > 599
        || section.error !== null && !object(section.error) || section.error && section.data !== null) throw invalid()
      if (!section.error && (['roles', 'representative_requests', 'memberships'].includes(key)
        ? !Array.isArray(section.data) || section.data.some((row: unknown) => !object(row)) : !object(section.data))) throw invalid()
    }
    capability = 'available'
    return bundle as AccountBootstrap
  }
}
