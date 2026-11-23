import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createPreviewServer } from './build/local-preview.mjs'

const root = fileURLToPath(new URL('../', import.meta.url)), directory = path.join(root, '.dean-preview.local')
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 3171
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local preview port')
const sourceIndex = process.argv.indexOf('--source')
const original = sourceIndex < 0 ? null : JSON.parse(await readFile(path.resolve(process.argv[sourceIndex + 1]), 'utf8'))
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Локальний кабінет деканату</title></head><body><div id="root"></div><script type="module" src="/scripts/preview-dean-workspace.tsx"></script></body></html>')
const blocked = '\0dean-preview-no-cloud'
const deny = "const deny=()=>{throw Error('LOCAL_SYNTHETIC_PREVIEW_ONLY')};export const emailLinkVerifier={auth:{verifyOtp:deny}};export const supabase={rpc:deny,from:deny,channel:deny,auth:new Proxy({},{get:()=>deny}),storage:new Proxy({},{get:()=>deny})}"
const server = await createPreviewServer({
  root, port, htmlPath: path.join(directory, 'index.html'),
  fixture: {
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/')
      return ['src/lib/supabase', 'src/lib/supabase.ts'].some(file => candidate === path.join(root, file).replaceAll('\\', '/')) ? blocked : null
    },
    load(id) { return id === blocked ? deny : null },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; frame-src 'none'; form-action 'none'; object-src 'none'")
        if (req.url === '/__dean-original.json') {
          if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(original ? { title: '3 курс · початковий розклад', source: original } : null)); return
        }
        if (req.url?.startsWith('/api/')) { res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"LOCAL_SYNTHETIC_PREVIEW_ONLY"}'); return }
        next()
      })
    },
  },
})
await server.listen()
console.log(`Dean local ${original ? 'original read-only' : 'synthetic'} preview: http://127.0.0.1:${port}/.dean-preview.local/index.html`)
