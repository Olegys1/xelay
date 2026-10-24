import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.shared-organizer-preview.local')
const portIndex = process.argv.indexOf('--port')
const port = portIndex < 0 ? 3047 : Number(process.argv[portIndex + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Оберіть порт від 1024 до 65535.')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Новий спільний органайзер</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>\n')
await writeFile(path.join(directory, 'main.tsx'), "import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport '../src/index.css'\nimport { LocalSharedOrganizerPreview } from '../src/components/organizer/LocalSharedOrganizerPreview'\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><LocalSharedOrganizerPreview /></React.StrictMode>)\n")
await writeFile(path.join(directory, 'vite.config.mjs'), `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ root: ${JSON.stringify(root)}, plugins: [react()], resolve: { alias: [{ find: /^(?:\\.\\.\\/)+lib\\/sharedOrganizer(?:\\.ts)?$/, replacement: ${JSON.stringify(path.join(root, 'src/lib/sharedOrganizerPreview.ts'))} }] }, server: { host: '127.0.0.1', port: ${port}, strictPort: true, allowedHosts: ['localhost','127.0.0.1'] } })\n`)
console.log(`Локальний перегляд: http://127.0.0.1:${port}/.shared-organizer-preview.local/index.html`)
if (!process.argv.includes('--prepare-only')) {
  const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(directory, 'vite.config.mjs')], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:9', VITE_SUPABASE_ANON_KEY: 'local-preview-only' },
  })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 0 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
}
