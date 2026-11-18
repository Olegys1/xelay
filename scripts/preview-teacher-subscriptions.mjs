import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('../', import.meta.url)), directory = path.join(root, '.teacher-plans-preview.local')
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 3136
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local preview port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Локальні тарифи викладача</title></head><body><div id="root"></div><script type="module" src="/scripts/preview-teacher-subscriptions/main.tsx"></script></body></html>')
const blocked = '\0teacher-plans-preview-no-cloud'
const deny = "const deny=()=>{throw Error('LOCAL_SYNTHETIC_PREVIEW_ONLY')};export const supabase={rpc:deny,from:deny,channel:deny,auth:new Proxy({},{get:()=>deny}),storage:new Proxy({},{get:()=>deny})}"
const server = await createServer({ root, configFile: false, envDir: path.join(directory, 'empty-env'), envPrefix: 'XELAY_UNUSED_PREVIEW_',
  cacheDir: path.join(root, 'node_modules/.vite-teacher-plans'),
  plugins: [react(), { name: 'teacher-plans-local-boundary', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return null
    const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/')
    return ['src/lib/supabase', 'src/lib/supabase.ts'].some(file => candidate === path.join(root, file).replaceAll('\\', '/')) ? blocked : null
  }, load(id) { return id === blocked ? deny : null }, configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; frame-src 'none'; form-action 'none'; object-src 'none'")
      if (req.url?.startsWith('/api/')) { res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"LOCAL_SYNTHETIC_PREVIEW_ONLY"}'); return }
      next()
    })
  } }], server: { host: '127.0.0.1', port, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'],
    watch: { ignored: ['**/.security-ci.local/**', '**/.teacher-dependencies.local/**', '**/output/**', '**/dist/**', '**/node_modules/**'] },
  } })
await server.listen()
console.log(`Teacher plans local synthetic preview: http://127.0.0.1:${port}/.teacher-plans-preview.local/index.html`)
