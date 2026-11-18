import { mkdir, writeFile } from 'node:fs/promises'
import { createPreviewServer } from './build/local-preview.mjs'
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
console.log(`Локальний перегляд: http://127.0.0.1:${port}/.shared-organizer-preview.local/index.html`)
if (!process.argv.includes('--prepare-only')) {
  const server = await createPreviewServer({
    root, port, htmlPath: path.join(directory, 'index.html'),
    fixture: {
      resolveId(source) {
        if (/^(?:\.\.\/)+lib\/sharedOrganizer(?:\.ts)?$/.test(source)) return path.join(root, 'src/lib/sharedOrganizerPreview.ts')
      },
    },
  })
  await server.listen()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close() })
}
