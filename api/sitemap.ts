import { createClient } from '@supabase/supabase-js'
import { CATEGORY_META } from '../src/lib/categoryMeta.js'
import { buildPublicSitemap, publicSupabaseConfiguration } from '../server/publicQuestionSeo.js'

export default async function handler(req: any, res: any) {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    res.setHeader('Allow', 'GET, HEAD')
    return res.status(405).end()
  }
  const unavailable = () => { res.setHeader('Cache-Control', 'private, no-store'); return res.status(503).send(req.method === 'HEAD' ? '' : 'Sitemap unavailable') }
  const configuration = publicSupabaseConfiguration(process.env)
  if (!configuration) return unavailable()
  try {
    // Public questions need no service-role bypass. Bound the DB read and cache it.
    const client = createClient(configuration.url, configuration.key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
    })
    const { data: questions, error } = await client.from('questions').select('id, created_at')
      .order('created_at', { ascending: false }).limit(1000)
    if (error) return unavailable()
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600')
    res.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600')
    return res.status(200).send(req.method === 'HEAD' ? '' : buildPublicSitemap(questions || [], Object.keys(CATEGORY_META)))
  } catch { return unavailable() }
}
