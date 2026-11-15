import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.knu-email-preview.local')
const argument = process.argv.indexOf('--port')
const port = argument < 0 ? 3083 : Number(process.argv[argument + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Пошта КНУ</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>\n')
await writeFile(path.join(directory, 'main.tsx'), "import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'\nimport '../src/index.css'\nimport { ToastProvider } from '../src/context/ToastContext'\nimport { LocalKnuEmailPreview } from '../src/components/profile/LocalKnuEmailPreview'\nconst rootRoute=createRootRoute({component:()=> <ToastProvider><LocalKnuEmailPreview /></ToastProvider>})\nconst router=createRouter({routeTree:rootRoute.addChildren([createRoute({getParentRoute:()=>rootRoute,path:'$',component:()=>null})])})\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router}/></React.StrictMode>)\n")
console.log(`Local preview: http://127.0.0.1:${port}/.knu-email-preview.local/index.html`)
if (!process.argv.includes('--prepare-only')) {
  const fixture = path.join(root, 'scripts/knu-email-preview-fixture.ts').replaceAll('\\', '/')
  const blocked = '\0xelay-knu-local-backend', auth = '\0xelay-knu-local-auth'
  const server = await createServer({ root, configFile: false, envDir: path.join(directory, 'no-env'), envPrefix: 'XELAY_UNUSED_PREVIEW_', optimizeDeps: { entries: ['.knu-email-preview.local/index.html'] }, plugins: [react(), {
    name: 'xelay-knu-preview-no-production', enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/')
      if (['src/lib/supabase', 'src/lib/supabase.ts'].some(file => candidate === path.join(root, file).replaceAll('\\', '/'))) return blocked
      if (['src/context/AuthContext', 'src/context/AuthContext.tsx'].some(file => candidate === path.join(root, file).replaceAll('\\', '/'))) return auth
      return null
    },
    load(id) { return id === blocked ? `export {supabase,emailLinkVerifier} from ${JSON.stringify(fixture)}` : id === auth ? `export {useAuth} from ${JSON.stringify(fixture)}` : null },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api/')) return next()
        response.statusCode = 503; response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store')
        response.end(JSON.stringify({ code: 'LOCAL_PREVIEW_LIVE_BACKEND_FORBIDDEN' }))
      })
    },
  }], server: { host: '127.0.0.1', port, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'] } })
  await server.listen()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close().finally(() => process.exit(0)) })
}
