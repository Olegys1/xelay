import { createClient } from '@supabase/supabase-js'

export default async function handler(req: any, res: any) {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE!
  )

  const { data: questions, error } = await supabase
    .from('questions')
    .select('id, title, created_at')
    .order('created_at', { ascending: false })

  if (error) {
    return res.status(500).send('Sitemap error')
  }

  const staticPages = [
    'https://xelay.ink/',
    'https://xelay.ink/categories',
    'https://xelay.ink/faq',
  ]

  const urls = [
    ...staticPages.map(
      (url) => `
      <url>
        <loc>${url}</loc>
      </url>`
    ),

    ...(questions || []).map((q) => `
      <url>
        <loc>https://xelay.ink/question/${q.id}</loc>
        <lastmod>${new Date(q.created_at).toISOString()}</lastmod>
      </url>
    `),
  ]

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('')}
</urlset>`

  res.setHeader('Content-Type', 'application/xml')
  res.status(200).send(xml)
}