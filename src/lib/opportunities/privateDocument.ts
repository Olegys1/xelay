import { supabase } from '../supabase'
import type { CareerFile } from './types'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_BYTES = 10 * 1024 * 1024
const unavailable = () => new Error('Документ недоступний для цього акаунта. Увійдіть як власник або адміністратор із двоетапною перевіркою.')

export function privateDocumentPath(id: string): string {
  if (!UUID.test(id)) throw new Error('Некоректний документ.')
  return `/business/document/${id}`
}

/** Neither the route nor its metadata grants access. Storage checks this session
 * again; cacheNonce and no-store force a fresh request on every opening. */
export async function loadPrivateDocument(id: string, signal: AbortSignal): Promise<{ file: CareerFile; blob: Blob }> {
  privateDocumentPath(id)
  const { data, error } = await supabase.rpc('xelay_opportunities_document_access', { p_id: id }).abortSignal(signal)
  signal.throwIfAborted()
  if (error || !data || data.id !== id || data.kind !== 'company' || !UUID.test(data.ownerId)
    || data.path !== `${data.ownerId}/company/${id}.pdf` || data.mime !== 'application/pdf'
    || !Number.isSafeInteger(data.size) || data.size < 5 || data.size > MAX_BYTES
    || typeof data.name !== 'string' || !data.name || data.name.length > 180) throw unavailable()
  const result = await supabase.storage.from('opportunities-private').download(data.path,
    { cacheNonce: crypto.randomUUID() }, { signal, cache: 'no-store' })
  signal.throwIfAborted()
  if (result.error || !result.data || result.data.type.split(';')[0] !== 'application/pdf'
    || result.data.size !== data.size) throw unavailable()
  const signature = new Uint8Array(await result.data.slice(0, 5).arrayBuffer())
  signal.throwIfAborted()
  if (String.fromCharCode(...signature) !== '%PDF-') throw new Error('Не вдалося перевірити документ PDF.')
  return { file: data as CareerFile, blob: result.data }
}
