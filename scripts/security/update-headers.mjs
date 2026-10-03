// Run after deliberately editing the inline structured-data block in index.html.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const path = new URL('../../vercel.json', import.meta.url)
const config = JSON.parse(await readFile(path, 'utf8'))
const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8')
const hashes = [...new Set([...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].flatMap((m) => {
  const lf = m[1].replaceAll('\r\n','\n')
  return [lf,lf.replaceAll('\n','\r\n')].map((content) => `'sha256-${createHash('sha256').update(content).digest('base64')}'`)
}))]
const headers = config.headers.find((entry) => entry.source === '/(.*)').headers
const security = {
  'Content-Security-Policy': `default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-src https://secure.wayforpay.com; form-action 'self' https://secure.wayforpay.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; upgrade-insecure-requests`,
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(self "https://secure.wayforpay.com")',
}
for (const [key,value] of Object.entries(security)) {
  const previous = headers.find((header) => header.key === key)
  if (previous) previous.value = value
  else headers.push({key,value})
}
if (!config.headers.some((entry) => entry.source === '/api/(.*)')) config.headers.push({ source: '/api/(.*)', headers: [{ key: 'Cache-Control', value: 'no-store' }] })
await writeFile(path, JSON.stringify(config,null,2) + '\n')
