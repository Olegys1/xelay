import { supabase } from './supabase'

export async function reservePrivateMedia(bucketId: string, storagePath: string) {
  const { error } = await supabase.rpc('xelay_private_reserve_media', { p_bucket_id: bucketId, p_storage_path: storagePath })
  if (error) throw error
}

/** A successful response with no removed rows is still pending cleanup. */
export async function discardPrivateMedia(bucketId: string, paths: string[]): Promise<boolean> {
  let remaining = [...new Set(paths)]
  for (let attempt = 0; attempt < 2 && remaining.length; attempt += 1) {
    try {
      const { data, error } = await supabase.storage.from(bucketId).remove(remaining)
      if (error) { console.error('Private file cleanup pending:', error); continue }
      const removed = new Set((data || []).map((object) => object.name))
      remaining = remaining.filter((path) => !removed.has(path))
    } catch (error) { console.error('Private file cleanup pending:', error) }
  }
  if (remaining.length) console.warn('Private file cleanup will need another attempt.')
  return remaining.length === 0
}
