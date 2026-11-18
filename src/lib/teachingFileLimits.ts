/** Display/preflight limits. Storage and content verification independently
 * enforce the current immutable teacher entitlement; this is not an ACL. */
export const TEACHING_LIBRARY_MAX_FILE_BYTES = 200 * 1024 * 1024
export const TEACHING_FREE_FILE_BYTES = 50 * 1024 * 1024
export function teachingPlanFileBytes(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return TEACHING_FREE_FILE_BYTES
  const state = value as { audience?: unknown; planId?: unknown }
  if (state.audience !== 'teacher') return TEACHING_FREE_FILE_BYTES
  return ({ teacher_start: 100, teacher_plus: 150, teacher_max: 200 } as Record<string, number>)[String(state.planId)] * 1024 * 1024 || TEACHING_FREE_FILE_BYTES
}
export function teachingFileMaximum(file: Pick<File, 'name' | 'type'>, planBytes: number): number {
  const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase()
  const expected = extension === 'pdf' ? 'application/pdf' : extension === 'txt' ? 'text/plain' : ''
  const provided = typeof file.type === 'string' ? file.type.trim().toLowerCase().split(';', 1)[0] : ''
  return expected && (!provided || provided === expected || provided === 'application/octet-stream')
    && Number.isSafeInteger(planBytes) && planBytes >= TEACHING_FREE_FILE_BYTES && planBytes <= TEACHING_LIBRARY_MAX_FILE_BYTES ? planBytes : TEACHING_FREE_FILE_BYTES
}
export function validateTeachingProtectedFileSizes(files: readonly Pick<File, 'name' | 'size'>[]): void {
  if (files.some(file => /\.(?:txt|csv)$/i.test(file.name) && file.size > 2 * 1024 * 1024)) {
    throw new Error('Для захищеного перегляду TXT і CSV мають бути до 2 МБ. Великий текст збережіть як PDF або дозвольте завантаження оригіналу.')
  }
}
