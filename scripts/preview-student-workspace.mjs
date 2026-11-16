import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, build } from 'vite'
import react from '@vitejs/plugin-react'
import { studentPreviewBlockedPath } from './student-preview-boundary.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const port = Number(process.env.XELAY_STUDENT_PREVIEW_PORT || 3116)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port')
const directory = path.join(root, '.student-workspace-preview.local')
async function writeGenerated(file, content) {
  let previous
  try { previous = await readFile(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (previous !== content) await writeFile(file, content)
}
await mkdir(directory, { recursive: true })
await writeGenerated(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Твій навчальний простір</title></head><body style="margin:0"><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>\n')
await writeGenerated(path.join(directory, 'main.tsx'), "import React from 'react'\nimport {createRoot} from 'react-dom/client'\nimport {StudentWorkspacePreview} from '../src/components/student/StudentWorkspacePreview'\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><StudentWorkspacePreview /></React.StrictMode>)\n")
const envDirectory = path.join(directory, 'empty-env')
await mkdir(envDirectory, { recursive: true })
let localTutorApi
let localTutorApiPromise
const getLocalTutorApi = server => {
  if (!localTutorApiPromise) localTutorApiPromise = server.ssrLoadModule('/server/student-learning/maxTutorLocalServer.ts')
    .then(module => module.createMaxTutorLocalServer({
      origin: `http://127.0.0.1:${port}`,
      privateDirectory: path.resolve(root, '../output/student-workspace-20261116/local-tutor-private'),
      environmentApiKey: process.env.OPENAI_API_KEY || '',
    })).then(api => (localTutorApi = api)).catch(() => { localTutorApiPromise = undefined; throw new Error('Local tutor unavailable') })
  return localTutorApiPromise
}
const config = {
  configFile: false, root, envDir: envDirectory, envPrefix: 'XELAY_LOCAL_UNUSED_',
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('http://127.0.0.1:9'), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('isolated-student-preview-only') },
  plugins: [react(), { name: 'xelay-isolated-student-preview', configureServer(server) {
    server.httpServer?.on('close', () => { void localTutorApi?.close() })
    server.middlewares.use(async (req, res, next) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port}; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`)
      if (req.headers.host !== `127.0.0.1:${port}` || studentPreviewBlockedPath(req.url)) { res.statusCode = 403; res.setHeader('Cache-Control', 'no-store'); res.end('Forbidden'); return }
      if (req.url?.split('?')[0].startsWith('/api/local-max/')) {
        try { const api = await getLocalTutorApi(server); if (await api.handle(req, res)) return }
        catch { if (!res.writableEnded && !res.destroyed) { res.statusCode = 503; res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'unavailable', error: 'Локальний помічник тимчасово недоступний. Спробуйте ще раз.' })) }; return }
        res.statusCode = 404; res.end(); return
      }
      if (req.url?.startsWith('/api/')) { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Local preview has no live APIs or payments.' })); return }
      next()
    })
  } }],
  server: { host: '127.0.0.1', port, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'], fs: { strict: true, allow: [root, await realpath(path.join(root, 'node_modules'))] } },
}
if (process.argv.includes('--build')) {
  await build({ ...config, build: { outDir: path.join(directory, 'dist'), emptyOutDir: true, rollupOptions: { input: path.join(directory, 'index.html') } } })
  console.log('Local student preview build passed without dotenv or production services.')
  process.exit(0)
}
const server = await createServer(config)
await server.listen()
console.log(`Локальний перегляд: http://127.0.0.1:${port}/.student-workspace-preview.local/index.html`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0) })
