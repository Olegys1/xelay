import { createClient } from '@supabase/supabase-js'

const xmlEscape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!)

export default async function handler(req: any, res: any) {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    res.setHeader('Allow', 'GET, HEAD')
    return res.status(405).end()
  }
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) return res.status(503).send('Sitemap unavailable')
  try {
    // Public questions need no service-role bypass. Bound the DB read and cache it.
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: questions, error } = await client.from('questions').select('id, created_at')
      .order('created_at', { ascending: false }).limit(1000)
    if (error) return res.status(503).send('Sitemap unavailable')
    const origin = 'https://www.xelay.ink'
    const entries = ['/', '/categories', '/terms', '/refund-policy', '/contacts'].map((path) => `<url><loc>${origin}${path}</loc></url>`)
    for (const question of questions || []) {
      const date = new Date(question.created_at)
      const stamp = Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1970 && date.getUTCFullYear() <= 9999
        ? `<lastmod>${date.toISOString()}</lastmod>` : ''
      entries.push(`<url><loc>${xmlEscape(`${origin}/question/${encodeURIComponent(String(question.id))}`)}</loc>${stamp}</url>`)
    }
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600')
    return res.status(200).send(req.method === 'HEAD' ? '' : `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>`)
  } catch { return res.status(503).send('Sitemap unavailable') }
}
