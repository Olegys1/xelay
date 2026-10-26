import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.schedule-copy-custom-preview.local')
const argument = process.argv.indexOf('--port')
const port = argument < 0 ? 3053 : Number(process.argv[argument + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Оберіть локальний порт від 1024 до 65535.')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Час суботніх пар — локальний приклад</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>\n')
await writeFile(path.join(directory, 'main.tsx'), "import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport '../src/index.css'\nimport { ToastProvider } from '../src/context/ToastContext'\nimport { LocalScheduleCopyCustomPreview } from '../src/components/schedule/LocalScheduleCopyCustomPreview'\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><ToastProvider><LocalScheduleCopyCustomPreview /></ToastProvider></React.StrictMode>)\n")
console.log(`Локальний перегляд: http://127.0.0.1:${port}/.schedule-copy-custom-preview.local/index.html`)

if (!process.argv.includes('--prepare-only')) {
  const blocked = '\0xelay-local-preview-no-backend'
  const server = await createServer({
    root, configFile: false, envDir: path.join(directory, 'no-env'), envPrefix: 'XELAY_UNUSED_PREVIEW_',
    plugins: [react(), {
      name: 'xelay-preview-block-live-backend',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer || !source.startsWith('.')) return null
        const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/')
        if (candidate === path.join(root, 'src/lib/supabase').replaceAll('\\', '/') || candidate === path.join(root, 'src/lib/supabase.ts').replaceAll('\\', '/')) return blocked
        return null
      },
      load(id) {
        if (id === blocked) return "const deny=()=>{throw new Error('LOCAL_PREVIEW_LIVE_BACKEND_FORBIDDEN')};export const supabase={rpc:deny,from:deny,channel:deny,auth:new Proxy({},{get:()=>deny})};"
        return null
      },
    }],
    server: { host: '127.0.0.1', port, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'] },
  })
  await server.listen()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close().finally(() => process.exit(0)) })
}
