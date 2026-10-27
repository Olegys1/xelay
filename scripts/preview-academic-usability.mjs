import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.academic-usability-preview.local')
const argument = process.argv.indexOf('--port')
const port = argument < 0 ? 3058 : Number(process.argv[argument + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Зручніше навчання</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>\n')
await writeFile(path.join(directory, 'main.tsx'), "import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'\nimport '../src/index.css'\nimport { ToastProvider } from '../src/context/ToastContext'\nimport { LocalAcademicUsabilityPreview } from '../src/components/teaching/LocalAcademicUsabilityPreview'\nconst rootRoute=createRootRoute({component:()=> <ToastProvider><LocalAcademicUsabilityPreview /></ToastProvider>})\nconst routeTree=rootRoute.addChildren([createRoute({getParentRoute:()=>rootRoute,path:'$',component:()=>null})])\nconst router=createRouter({routeTree})\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router}/></React.StrictMode>)\n")
console.log(`Local preview: http://127.0.0.1:${port}/.academic-usability-preview.local/index.html`)
if (!process.argv.includes('--prepare-only')) {
  const fixture = path.join(root, 'scripts/academic-usability-preview-fixture.ts').replaceAll('\\', '/')
  const blocked = '\0xelay-academic-local-catalog'
  const auth = '\0xelay-academic-local-auth'
  const server = await createServer({ root, configFile: false, envDir: path.join(directory, 'no-env'), envPrefix: 'XELAY_UNUSED_PREVIEW_', optimizeDeps: { entries: ['.academic-usability-preview.local/index.html'] }, plugins: [react(), {
    name: 'xelay-academic-preview-no-production', enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/')
      if (['src/lib/supabase', 'src/lib/supabase.ts'].some(file => candidate === path.join(root, file).replaceAll('\\', '/'))) return blocked
      if (['src/context/AuthContext', 'src/context/AuthContext.tsx'].some(file => candidate === path.join(root, file).replaceAll('\\', '/'))) return auth
      return null
    },
    load(id) { return id === blocked ? `export {supabase,emailLinkVerifier} from ${JSON.stringify(fixture)}` : id === auth ? `export {useAuth} from ${JSON.stringify(fixture)}` : null },
    configureServer(vite) {
      // Emulate private HTTP attachment delivery; browser blob downloads differ
      // between desktop webviews. Bytes never leave this loopback server's RAM.
      const downloads = new Map()
      vite.middlewares.use(async (request, response, next) => {
        const now = Date.now()
        for (const [token, item] of downloads) if (item.expires <= now) downloads.delete(token)
        if (request.url === '/__xelay-preview-download' && request.method === 'POST') {
          if (request.headers.origin !== `http://127.0.0.1:${port}`) { response.statusCode = 403; response.end(); return }
          const chunks = []; let size = 0
          for await (const chunk of request) {
            size += chunk.length
            if (size > 50 * 1024 * 1024) { response.statusCode = 413; response.end(); return }
            chunks.push(chunk)
          }
          if (!size || [...downloads.values()].reduce((sum, item) => sum + item.bytes.length, size) > 200 * 1024 * 1024) { response.statusCode = 413; response.end(); return }
          let name = 'presentation'
          try { name = decodeURIComponent(String(request.headers['x-xelay-file-name'] || name)).replace(/[\r\n\u0000/\\]/g, '').slice(0, 180) || name } catch { /* Keep safe fallback name. */ }
          const token = randomUUID()
          downloads.set(token, { bytes: Buffer.concat(chunks), name, expires: now + 60000 })
          response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store')
          response.end(JSON.stringify({ url: `/__xelay-preview-download/${token}` })); return
        }
        if (request.url?.startsWith('/__xelay-preview-download/') && request.method === 'GET') {
          const item = downloads.get(request.url.slice('/__xelay-preview-download/'.length))
          if (!item) { response.statusCode = 404; response.end(); return }
          response.setHeader('Content-Type', 'application/octet-stream')
          response.setHeader('Content-Disposition', `attachment; filename="presentation"; filename*=UTF-8''${encodeURIComponent(item.name)}`)
          response.setHeader('Content-Length', item.bytes.length)
          response.setHeader('Cache-Control', 'no-store')
          response.end(item.bytes); return
        }
        if (!request.url?.startsWith('/api/')) return next()
        response.statusCode = 503; response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ error: 'LOCAL_PREVIEW_LIVE_BACKEND_FORBIDDEN' }))
      })
    },
  }], server: { host: '127.0.0.1', port, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'] } })
  await server.listen()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close().finally(() => process.exit(0)) })
}
