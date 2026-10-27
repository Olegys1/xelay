import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const directory = path.join(root, '.teaching-performance-preview.local')
const argument = process.argv.indexOf('--port')
const port = argument < 0 ? 3057 : Number(process.argv[argument + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Оптимізація кабінету</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>\n')
await writeFile(path.join(directory, 'main.tsx'), "import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport '../src/index.css'\nimport { ToastProvider } from '../src/context/ToastContext'\nimport { TeachingPerformancePreview } from '../scripts/performance/teaching-preview'\ncreateRoot(document.getElementById('root')!).render(<ToastProvider><TeachingPerformancePreview /></ToastProvider>)\n")
console.log(`Local teaching preview: http://127.0.0.1:${port}/.teaching-performance-preview.local/index.html`)
if (!process.argv.includes('--prepare-only')) {
  const blocked = '\0xelay-teaching-performance-no-live-backend'
  const server = await createServer({ root, configFile: false, envDir: path.join(directory, 'no-env'), envPrefix: 'XELAY_UNUSED_PREVIEW_', optimizeDeps: { entries: ['.teaching-performance-preview.local/index.html'] }, plugins: [react(), {
    name: 'xelay-teaching-performance-block-live-backend', enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/')
      return ['src/lib/supabase', 'src/lib/supabase.ts'].some(file => candidate === path.join(root, file).replaceAll('\\', '/')) ? blocked : null
    },
    load(id) { return id === blocked ? "const deny=()=>{throw new Error('LOCAL_PREVIEW_LIVE_BACKEND_FORBIDDEN')};export const supabase={rpc:deny,from:deny,channel:deny,auth:new Proxy({},{get:()=>deny})};export const emailLinkVerifier=deny;" : null },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api/')) return next()
        response.statusCode = 503
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ error: 'LOCAL_PREVIEW_LIVE_BACKEND_FORBIDDEN' }))
      })
    },
  }], server: { host: '127.0.0.1', port, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'] } })
  await server.listen()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close().finally(() => process.exit(0)) })
}
