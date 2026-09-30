// Only a missing RPC permits the compatibility path. Permission errors and
// other failures must keep their original meaning rather than bypass guards.
export function isMissingDatabaseFunction(error: { code?: string } | null | undefined) {
  return error?.code === 'PGRST202' || error?.code === '42883'
}

export function isMissingDatabaseTable(error: { code?: string } | null | undefined) {
  return error?.code === 'PGRST205' || error?.code === '42P01'
}

export function isMissingDatabaseColumn(error: { code?: string } | null | undefined) {
  return error?.code === 'PGRST204' || error?.code === '42703'
}
