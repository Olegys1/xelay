/** Pure accounting helpers. Production callers must reserve/settle atomically and idempotently on the server. */
export const AI_USD_MICROS = 1_000_000

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export function aiUsdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('Некоректна вартість ШІ.')
  const micros = Math.ceil(usd * AI_USD_MICROS)
  if (!nonNegativeInteger(micros)) throw new Error('Вартість ШІ перевищує допустимі значення.')
  return micros
}

export interface AiTokenRates {
  inputUsdPerMillion: number
  cachedInputUsdPerMillion: number
  outputUsdPerMillion: number
}

export interface AiBillableUsage {
  inputTokens: number
  cachedInputTokens: number
  /** Total billed output, INCLUDING reasoning tokens; do not add reasoning a second time. */
  outputTokens: number
  reasoningTokens?: number
  /** Combined billed tools, storage and other explicitly charged services for this operation. */
  toolCostUsd?: number
}

export function calculateAiCostMicros(usage: AiBillableUsage, rates: AiTokenRates): number {
  const tokens = [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.reasoningTokens ?? 0]
  const prices = [rates.inputUsdPerMillion, rates.cachedInputUsdPerMillion, rates.outputUsdPerMillion]
  if (!tokens.every(nonNegativeInteger) || !prices.every(rate => Number.isFinite(rate) && rate >= 0)
    || usage.cachedInputTokens > usage.inputTokens || (usage.reasoningTokens ?? 0) > usage.outputTokens) {
    throw new Error('Некоректний облік використання ШІ.')
  }
  const tokenMicros = Math.ceil((usage.inputTokens - usage.cachedInputTokens) * rates.inputUsdPerMillion
    + usage.cachedInputTokens * rates.cachedInputUsdPerMillion + usage.outputTokens * rates.outputUsdPerMillion)
  const cost = tokenMicros + aiUsdToMicros(usage.toolCostUsd ?? 0)
  if (!nonNegativeInteger(cost)) throw new Error('Вартість ШІ перевищує допустимі значення.')
  return cost
}

export interface AiBudgetSnapshot {
  limitMicros: number
  spentMicros: number
  reservedMicros: number
}

export function evaluateAiReservation(budget: AiBudgetSnapshot, requestMicros: number) {
  const values = [budget.limitMicros, budget.spentMicros, budget.reservedMicros, requestMicros]
  if (!values.every(nonNegativeInteger) || requestMicros === 0) {
    return { allowed: false as const, reason: 'invalid_budget' as const, remainingMicros: 0 }
  }
  const used = budget.spentMicros + budget.reservedMicros
  if (!Number.isSafeInteger(used)) return { allowed: false as const, reason: 'invalid_budget' as const, remainingMicros: 0 }
  const remainingMicros = Math.max(0, budget.limitMicros - used)
  return requestMicros <= remainingMicros
    ? { allowed: true as const, reason: 'available' as const, remainingMicros: remainingMicros - requestMicros }
    : { allowed: false as const, reason: 'allowance_exhausted' as const, remainingMicros }
}

/** Unknown provider usage charges the full reservation conservatively; it is not a free retry. */
export function settleAiReservation(
  budget: AiBudgetSnapshot,
  reservationMicros: number,
  actualCostMicros: number | null,
): AiBudgetSnapshot {
  if (![budget.limitMicros, budget.spentMicros, budget.reservedMicros, reservationMicros].every(nonNegativeInteger)
    || reservationMicros === 0 || reservationMicros > budget.reservedMicros
    || !Number.isSafeInteger(budget.spentMicros + budget.reservedMicros)
    || (actualCostMicros !== null && !nonNegativeInteger(actualCostMicros))) throw new Error('Некоректне завершення операції ШІ.')
  const cost = actualCostMicros ?? reservationMicros
  const spentMicros = budget.spentMicros + cost
  if (!Number.isSafeInteger(spentMicros)) throw new Error('Облік ШІ перевищує допустимі значення.')
  // Actual overspend is kept in the ledger; future reservations will be denied instead of hiding it.
  return { limitMicros: budget.limitMicros, spentMicros, reservedMicros: budget.reservedMicros - reservationMicros }
}
