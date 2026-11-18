import { createPreviewServer } from '../build/local-preview.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixtureRoot = path.join(root, 'scripts/performance/fixtures')
const normalize = value => value.replaceAll('\\', '/')
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 3003
const server = await createPreviewServer({
  root, port, htmlPath: path.join(root, 'index.html'),
  spa: true, watch: false,
  fixture: {
    load(id) {
      if (normalize(id) === normalize(path.join(root, 'src/lib/supabase.ts'))) {
        return `export { supabase, emailLinkVerifier } from ${JSON.stringify(normalize(path.join(fixtureRoot, 'mockSupabase.ts')))};`
      }
      if (normalize(id) === normalize(path.join(root, 'src/main.tsx'))) {
        return `import ${JSON.stringify(normalize(path.join(fixtureRoot, 'main.tsx')))};`
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        if (req.url.startsWith('/api/notifications/email')) {
          return res.end(JSON.stringify({ state: 'ready', available: true }))
        }
        res.statusCode = 503
        res.end(JSON.stringify({ error: 'Isolated local fixture: no production API access.' }))
      })
    },
  },
})
await server.listen()
console.log(`Isolated real-component performance preview: http://127.0.0.1:${port}/`)
console.log('Supabase is replaced by an in-memory fixture; no production reads or writes.')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close() })
