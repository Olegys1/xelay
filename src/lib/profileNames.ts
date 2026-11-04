export const PROFILE_NAME_PART_MAX_LENGTH = 60
export const PROFILE_NAME_MAX_LENGTH = 120

/** Name components are explicit user input. Never infer their order from a legacy display name. */
export function normalizeNamePart(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFC').trim().replace(/[ \u00a0]+/gu, ' ') : ''
}

export function isValidProfileNamePart(value: unknown): boolean {
  const part = normalizeNamePart(value)
  return part.length > 0 && [...part].length <= PROFILE_NAME_PART_MAX_LENGTH
    && /\p{L}/u.test(part) && !/[\p{Cc}\p{Cf}<>]/u.test(part)
    && /^[\p{L}\p{M} '’ʼ.\-]+$/u.test(part)
}

/** The display order throughout Xelay is surname followed by given name. */
export function composeProfileName(lastName: unknown, firstName: unknown): string {
  return [normalizeNamePart(lastName), normalizeNamePart(firstName)].filter(Boolean).join(' ')
}

type NameSource = { first_name?: unknown; last_name?: unknown; firstName?: unknown; lastName?: unknown } | null | undefined
export function profileNameParts(source: NameSource): { firstName: string; lastName: string; hasStructuredName: boolean } {
  const firstName = normalizeNamePart(source?.first_name ?? source?.firstName)
  const lastName = normalizeNamePart(source?.last_name ?? source?.lastName)
  const hasStructuredName = isValidProfileNamePart(firstName) && isValidProfileNamePart(lastName)
    && [...composeProfileName(lastName, firstName)].length <= PROFILE_NAME_MAX_LENGTH
  return hasStructuredName ? { firstName, lastName, hasStructuredName } : { firstName: '', lastName: '', hasStructuredName: false }
}
