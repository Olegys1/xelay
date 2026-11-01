import { createHash, randomBytes } from 'node:crypto'
import type { VerifiedAssistantSession } from './authenticatedRead.ts'

export const ASSISTANT_MODEL_RESERVATION_MICROUSD = 50_000
// These are actual provider-usage bounds, including vision input and reasoning
// output. They are not a byte-to-token estimate or a provider invoice limit.
// At the pinned Standard price, 40k input + 4k output costs $0.048.
export const ASSISTANT_MODEL_BUDGET_LIMITS = Object.freeze({ inputTokens: 40_000, outputTokens: 4000, telemetryTokens: 2_000_000 })
export interface AssistantModelBudgetRemaining { dayMicrousd: number; monthMicrousd: number; userDayRequests: number }
export interface AssistantModelBudgetRequest { requestId: string; contextHash: string }
export interface AssistantModelBudgetUsage { inputTokens: number; outputTokens: number }
export interface AssistantModelBudgetRpcClient { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }
export interface AssistantModelBudgetLedger {
  readonly mode: 'private-model-budget'
  reserve(userId: string, request: AssistantModelBudgetRequest, claimHash: string): Promise<unknown>
  finish(userId: string, request: AssistantModelBudgetRequest, claimHash: string, outcome: 'succeeded' | 'unknown', usage?: AssistantModelBudgetUsage): Promise<unknown>
}
export class AssistantModelBudgetError extends Error {
  constructor(readonly code: 'assistant_model_budget_unavailable' | 'assistant_model_budget_disabled' | 'assistant_model_budget_exhausted' | 'assistant_model_budget_replay' | 'assistant_model_budget_halted' | 'assistant_model_request_failed' | 'assistant_model_usage_invalid' | 'invalid_request' | 'session_invalid' | 'session_changed', readonly status = 503) {
    super(code); this.name = 'AssistantModelBudgetError'
  }
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const counter = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000_000
const validRemaining = (value: unknown): value is AssistantModelBudgetRemaining => object(value) && counter(value.dayMicrousd) && counter(value.monthMicrousd) && counter(value.userDayRequests)
const id = (value: unknown) => typeof value === 'string' && UUID.test(value) && value !== '00000000-0000-0000-0000-000000000000' ? value.toLowerCase() : fail('invalid_request', 400)
function fail(code: AssistantModelBudgetError['code'], status = 503): never { throw new AssistantModelBudgetError(code, status) }
function requestOf(value: unknown): AssistantModelBudgetRequest {
  if (!object(value) || Object.keys(value).some(key => !['requestId','contextHash'].includes(key)) || typeof value.contextHash !== 'string' || !HASH.test(value.contextHash)) return fail('invalid_request',400)
  return { requestId: id(value.requestId), contextHash: value.contextHash }
}
function usageOf(value: unknown): value is AssistantModelBudgetUsage {
  return object(value) && Number.isSafeInteger(value.inputTokens) && value.inputTokens >= 0 && value.inputTokens <= ASSISTANT_MODEL_BUDGET_LIMITS.telemetryTokens
    && Number.isSafeInteger(value.outputTokens) && value.outputTokens >= 0 && value.outputTokens <= ASSISTANT_MODEL_BUDGET_LIMITS.telemetryTokens
}
export function assistantModelCostMicrousd(usage: AssistantModelBudgetUsage) {
  if (!usageOf(usage)) return fail('assistant_model_usage_invalid')
  return Math.ceil((3*usage.inputTokens+18*usage.outputTokens)/4)
}

/** Only the server's existing private client may implement this port. It has
 * no table access, model fallback, settings mutation or credential discovery. */
export function createSupabaseModelBudgetLedger(options: { client: AssistantModelBudgetRpcClient }): AssistantModelBudgetLedger {
  if (!options?.client || typeof options.client.rpc !== 'function') throw new TypeError('private_model_budget_client_required')
  async function rpc(name: string, args: Record<string, unknown>) {
    try {
      const result = await options.client.rpc(name,args)
      if (!result || result.error) {
        const code = object(result?.error) ? result.error.code : ''
        if (code === '42501') return fail('session_invalid',401)
        if (code === 'PT409') return fail('assistant_model_budget_replay',409)
        return fail('assistant_model_budget_unavailable')
      }
      return result.data
    } catch (error) { if (error instanceof AssistantModelBudgetError) throw error; return fail('assistant_model_budget_unavailable') }
  }
  return {
    mode: 'private-model-budget',
    reserve(user, request, claimHash) { return rpc('xelay_assistant_model_reserve',{p_user_id:user,p_request_id:request.requestId,p_context_hash:request.contextHash,p_claim_hash:claimHash}) },
    finish(user, request, claimHash, outcome, usage) { return rpc('xelay_assistant_model_finish',{p_user_id:user,p_request_id:request.requestId,p_context_hash:request.contextHash,p_claim_hash:claimHash,p_outcome:outcome,p_input_tokens:usage?.inputTokens??null,p_output_tokens:usage?.outputTokens??null}) },
  }
}

/** A verified server-only reservation precedes exactly one provider operation.
 * Provider failures, malformed usage and unknown completion retain the full
 * reservation. A new process cannot claim an existing request a second time. */
export function createAssistantModelBudget(dependencies: {
  ledger: AssistantModelBudgetLedger
  verifySession(credential: string): Promise<VerifiedAssistantSession | null>
  now?: () => number
}) {
  if (!dependencies?.ledger || dependencies.ledger.mode !== 'private-model-budget' || typeof dependencies.ledger.reserve !== 'function' || typeof dependencies.ledger.finish !== 'function' || typeof dependencies.verifySession !== 'function') throw new TypeError('private_model_budget_dependencies_required')
  const now = dependencies.now || Date.now
  const clock = () => { let value:number;try { value=now() } catch { return fail('assistant_model_budget_unavailable') };return Number.isFinite(value)?value:fail('assistant_model_budget_unavailable') }
  async function sessionOf(credential: string) {
    if (typeof credential !== 'string' || credential.length < 16 || credential.length > 8192 || /\s/.test(credential)) return fail('session_invalid',401)
    let session: VerifiedAssistantSession | null
    try { session = await dependencies.verifySession(credential) } catch { return fail('session_invalid',401) }
    if (!session || !UUID.test(session.userId) || session.userId === '00000000-0000-0000-0000-000000000000' || session.accountActive !== true || session.emailConfirmed !== true
      || typeof session.expiresAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(session.expiresAt) || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= clock()) return fail('session_invalid',401)
    return { ...session, userId: session.userId.toLowerCase() }
  }
  return {
    async run<T>(credential: string, value: AssistantModelBudgetRequest, operation: () => Promise<{ value: T; usage: AssistantModelBudgetUsage }>): Promise<{value:T;requestId:string;remaining:AssistantModelBudgetRemaining;finalized:boolean}> {
      const request = requestOf(value), session = await sessionOf(credential)
      const nonce = randomBytes(24), claimHash = createHash('sha256').update(nonce).digest('hex'); nonce.fill(0)
      let reservation: unknown
      try { reservation = await dependencies.ledger.reserve(session.userId,request,claimHash) } catch (error) { if (error instanceof AssistantModelBudgetError) throw error; return fail('assistant_model_budget_unavailable') }
      if (!object(reservation) || typeof reservation.allowed !== 'boolean' || typeof reservation.reused !== 'boolean') return fail('assistant_model_budget_unavailable')
      if (!reservation.allowed) {
        if (reservation.reused && reservation.requestId === request.requestId && reservation.reason === 'replay') return fail('assistant_model_budget_replay',409)
        if (reservation.reused) return fail('assistant_model_budget_unavailable')
        if (reservation.reason === 'disabled') return fail('assistant_model_budget_disabled')
        if (reservation.reason === 'halted') return fail('assistant_model_budget_halted')
        if (['user_day_limit','day_limit','month_limit'].includes(reservation.reason)) return fail('assistant_model_budget_exhausted',429)
        return fail('assistant_model_budget_unavailable')
      }
      if (reservation.reused || reservation.requestId !== request.requestId || reservation.userId !== session.userId || reservation.state !== 'reserved'
        || reservation.reservedMicrousd !== ASSISTANT_MODEL_RESERVATION_MICROUSD || !validRemaining(reservation.remaining)
        || typeof reservation.expiresAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(reservation.expiresAt) || !Number.isFinite(Date.parse(reservation.expiresAt)) || Date.parse(reservation.expiresAt) <= clock()) return fail('assistant_model_budget_unavailable')
      let result: { value: T; usage: AssistantModelBudgetUsage } | undefined, usage: AssistantModelBudgetUsage | undefined
      let operationError: AssistantModelBudgetError | undefined, finalized = false, remaining = reservation.remaining, halted = false
      try {
        const latest = await sessionOf(credential)
        if (latest.userId !== session.userId || latest.sessionId !== session.sessionId) return fail('session_changed',401)
        const output = await operation()
        if (!object(output) || !Object.prototype.hasOwnProperty.call(output,'value') || !usageOf(output.usage)) return fail('assistant_model_usage_invalid')
        result = output; usage = output.usage
      } catch (error) {
        operationError = error instanceof AssistantModelBudgetError ? error : new AssistantModelBudgetError('assistant_model_request_failed')
      } finally {
        try {
          const finish = await dependencies.ledger.finish(session.userId,request,claimHash,result?'succeeded':'unknown',usage)
          if (object(finish) && finish.finished === true && finish.requestId === request.requestId && typeof finish.reused === 'boolean'
            && ['succeeded','unknown','over_limit'].includes(finish.state) && typeof finish.halted === 'boolean' && counter(finish.chargedMicrousd) && validRemaining(finish.remaining)
            && (!result ? finish.state === 'unknown' && !finish.halted && finish.chargedMicrousd === ASSISTANT_MODEL_RESERVATION_MICROUSD
              : finish.state === 'over_limit' && finish.halted && finish.chargedMicrousd >= ASSISTANT_MODEL_RESERVATION_MICROUSD
                || finish.state === 'succeeded' && !finish.halted && finish.chargedMicrousd === assistantModelCostMicrousd(usage!))) {
            finalized = true; remaining = finish.remaining; halted = finish.halted
          }
        } catch { /* The full reservation stays charged; never rerun or refund. */ }
      }
      if (operationError) throw operationError
      if (halted || usage && (usage.inputTokens>ASSISTANT_MODEL_BUDGET_LIMITS.inputTokens || usage.outputTokens>ASSISTANT_MODEL_BUDGET_LIMITS.outputTokens || assistantModelCostMicrousd(usage)>ASSISTANT_MODEL_RESERVATION_MICROUSD)) return fail('assistant_model_budget_halted')
      const latest = await sessionOf(credential)
      if (latest.userId !== session.userId || latest.sessionId !== session.sessionId) return fail('session_changed',401)
      return { value: result!.value, requestId: request.requestId, remaining, finalized }
    },
  }
}
