import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixtureRoot = path.join(root, 'scripts/performance/fixtures')
const normalize = value => value.replaceAll('\\', '/')
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 3003
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), {
    name: 'xelay-isolated-performance-fixtures',
    enforce: 'pre',
    load(id) {
      if (normalize(id) === normalize(path.join(root, 'src/lib/supabase.ts'))) {
        return `export { supabase, emailLinkVerifier } from ${JSON.stringify(normalize(path.join(fixtureRoot, 'mockSupabase.ts')))};`
      }
      if (normalize(id) === normalize(path.join(root, 'src/main.tsx'))) {
        return `import ${JSON.stringify(normalize(path.join(fixtureRoot, 'main.tsx')))};`
      }
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
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
  }],
  // Keep browser checks stable while production/baseline builds write files.
  // Restart this fixture server after changing source; avoid duplicate React roots.
  server: { host: '127.0.0.1', port, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'], hmr: false, watch: null },
})
await server.listen()
console.log(`Isolated real-component performance preview: http://127.0.0.1:${port}/`)
console.log('Supabase is replaced by an in-memory fixture; no production reads or writes.')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close() })
