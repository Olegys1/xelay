import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.group-year-archive-preview.local')
const argument = process.argv.indexOf('--port')
const port = argument < 0 ? 3059 : Number(process.argv[argument + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk" class="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Архів навчальних років</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>\n')
await writeFile(path.join(directory, 'main.tsx'), `import React from 'react'
import { createRoot } from 'react-dom/client'
import { createRootRoute,createRoute,createRouter,createMemoryHistory,RouterProvider } from '@tanstack/react-router'
import '../src/index.css'
import {ToastProvider} from '../src/context/ToastContext'
import {LocalGroupYearArchivePreview} from '../src/components/LocalGroupYearArchivePreview'
import {StudyGroupDetailPage,StudyGroupsPage} from '../src/pages/StudyGroupsPage'
import {PREVIEW_GROUP_ID,PREVIEW_DATE,archivePreviewFixture} from '../scripts/group-year-archive-preview-fixture'
const originalFetch=window.fetch.bind(window)
window.fetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.origin);if(url.origin!==location.origin){archivePreviewFixture.blockedExternal(url.href);return Promise.reject(new Error('LOCAL_PREVIEW_EXTERNAL_REQUEST_DENIED'))}return originalFetch(input,options)}
const rootRoute=createRootRoute({component:()=> <ToastProvider><LocalGroupYearArchivePreview /></ToastProvider>})
const detail=createRoute({getParentRoute:()=>rootRoute,path:'/groups/$id',validateSearch:(value:Record<string,unknown>)=>({date:typeof value.date==='string'?value.date:undefined,tab:typeof value.tab==='string'?value.tab:undefined,assignment:typeof value.assignment==='string'?value.assignment:undefined,kind:typeof value.kind==='string'?value.kind:undefined,teaching:undefined}),component:StudyGroupDetailPage})
const groups=createRoute({getParentRoute:()=>rootRoute,path:'/groups',component:StudyGroupsPage})
const fallback=createRoute({getParentRoute:()=>rootRoute,path:'$',component:()=> <p className="p-6">Це локальний приклад архіву групи.</p>})
const router=createRouter({routeTree:rootRoute.addChildren([detail,groups,fallback]),history:createMemoryHistory({initialEntries:['/groups/'+PREVIEW_GROUP_ID+'?date='+PREVIEW_DATE]})})
createRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router}/></React.StrictMode>)
`)
const pdf = await readFile(path.join(root, 'artifacts/academic-usability-20261027/test-presentation.pdf'))
console.log(`Local preview: http://127.0.0.1:${port}/.group-year-archive-preview.local/index.html`)
if (!process.argv.includes('--prepare-only')) {
  const fixture = path.join(root, 'scripts/group-year-archive-preview-fixture.ts').replaceAll('\\', '/')
  const aliases = new Map([
    ['src/lib/supabase', { id: '\0xelay-group-year-supabase', exports: 'supabase,emailLinkVerifier' }],
    ['src/context/AuthContext', { id: '\0xelay-group-year-auth', exports: 'useAuth' }],
    ['src/lib/offlineStudy', { id: '\0xelay-group-year-offline', exports: 'getOfflineOwner,loadOfflineGroup,saveOfflineGroupSnapshot,removeOfflineGroupSnapshot,establishOfflineOwner,clearOfflineStudy,listOfflineGroups,offlineStudyError,OFFLINE_STUDY_DAYS,OFFLINE_STUDY_TTL_MS,OFFLINE_STUDY_CHANGED' }],
  ])
  const server = await createServer({ root, configFile: false, envDir: path.join(directory, 'no-env'), envPrefix: 'XELAY_UNUSED_PREVIEW_',
    optimizeDeps: { entries: ['.group-year-archive-preview.local/index.html'] }, plugins: [react(), {
      name: 'xelay-group-year-isolated-fixture', enforce: 'pre',
      resolveId(source, importer) {
        if (!importer || !source.startsWith('.')) return null
        const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/').replace(/\.(tsx?|jsx?)$/, '')
        for (const [suffix, value] of aliases) if (candidate === path.join(root, suffix).replaceAll('\\', '/')) return value.id
        return null
      },
      load(id) { for (const value of aliases.values()) if (value.id === id) return `export {${value.exports}} from ${JSON.stringify(fixture)}`; return null },
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; form-action 'none'; base-uri 'self'")
          if (request.url?.startsWith('/__xelay-group-archive/presentation.pdf') && request.method === 'GET') {
            response.setHeader('Content-Type', 'application/pdf'); response.setHeader('Content-Length', pdf.length)
            response.setHeader('Cache-Control', 'no-store')
            if (request.url.includes('download=1')) response.setHeader('Content-Disposition', 'attachment; filename="group-presentation.pdf"')
            response.end(pdf); return
          }
          if (!request.url?.startsWith('/api/')) return next()
          response.statusCode = 503; response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({ error: 'LOCAL_PREVIEW_LIVE_BACKEND_FORBIDDEN' }))
        })
      },
    }], server: { host: '127.0.0.1', port, strictPort: true, hmr: false, allowedHosts: ['127.0.0.1', 'localhost'] } })
  await server.listen()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close().finally(() => process.exit(0)) })
}
