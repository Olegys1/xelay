import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createPreviewServer } from './build/local-preview.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.group-referral-preview.local')
const portIndex = process.argv.indexOf('--port')
const port = portIndex < 0 ? 3094 : Number(process.argv[portIndex + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local preview port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Запроси групу — локальний перегляд</title></head><body><div id="root"></div><script type="module" src="/.group-referral-preview.local/main.tsx"></script></body></html>')
await writeFile(path.join(directory, 'main.tsx'), "import React from 'react'\nimport {createRoot} from 'react-dom/client'\nimport '../src/index.css'\nimport {LocalGroupReferralPreview} from '../src/components/referrals/LocalGroupReferralPreview'\ncreateRoot(document.getElementById('root')!).render(<LocalGroupReferralPreview/>)\n")
const server = await createPreviewServer({
  root, port, htmlPath: path.join(directory, 'index.html'),
  fixture: {
    configureServer(server) { server.middlewares.use((req, _res, next) => { if (req.url === '/' || req.url?.startsWith('/referrals?') || req.url === '/referrals') req.url = '/.group-referral-preview.local/index.html'; next() }) },
  },
})
await server.listen()
console.log(`Локальний перегляд: http://127.0.0.1:${port}/`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0) })
