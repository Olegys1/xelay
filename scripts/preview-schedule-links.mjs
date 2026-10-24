import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.schedule-links-preview.local')
const portIndex = process.argv.indexOf('--port')
const port = portIndex < 0 ? 3046 : Number(process.argv[portIndex + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Оберіть порт від 1024 до 65535.')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Посилання суботніх пар — локальний приклад</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>\n')
await writeFile(path.join(directory, 'main.tsx'), "import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport '../src/index.css'\nimport { LocalScheduleCopyLinksPreview } from '../src/components/schedule/LocalScheduleCopyLinksPreview'\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><LocalScheduleCopyLinksPreview /></React.StrictMode>)\n")
console.log(`Локальний перегляд: http://127.0.0.1:${port}/.schedule-links-preview.local/index.html`)
if (!process.argv.includes('--prepare-only')) {
  const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:9', VITE_SUPABASE_ANON_KEY: 'local-preview-only' },
  })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 0 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
}
