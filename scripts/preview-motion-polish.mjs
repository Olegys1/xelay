import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('../', import.meta.url))
const port = Number(process.env.XELAY_MOTION_PREVIEW_PORT || 3114)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port')
const directory = path.join(root, '.motion-preview.local')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Деталі та анімації</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>\n')
await writeFile(path.join(directory, 'main.tsx'), "import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport '../src/index.css'\nimport { LocalMotionPreview } from '../src/components/motion/LocalMotionPreview'\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><LocalMotionPreview /></React.StrictMode>)\n")

// This preview imports real UI components with fictional props. It has no live
// checkout, application session, production backend URL or writable API.
process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:9'
process.env.VITE_SUPABASE_ANON_KEY = 'isolated-motion-preview-only'
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), {
    name: 'xelay-isolated-motion-preview',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow')
        res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port}; frame-src 'none'; object-src 'none'; base-uri 'self'`)
        if (req.url?.startsWith('/api/')) {
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Local visual preview: no live APIs or payments.' }))
          return
        }
        next()
      })
    },
  }],
  server: { host: '127.0.0.1', port, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'], fs: { strict: true, allow: [root, await realpath(path.join(root, 'node_modules'))] } },
})
await server.listen()
console.log(`Локальний перегляд: http://127.0.0.1:${port}/.motion-preview.local/index.html`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0) })
