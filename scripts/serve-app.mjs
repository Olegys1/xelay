import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appEnvironment } from './build/browser-bundle.mjs'
import { createPreviewServer } from './build/local-preview.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
function value(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error('Missing ' + name + ' value')
  return args[index + 1]
}
if (value('--host') && value('--host') !== '127.0.0.1') throw Error('Only the loopback address is supported')
const preview = args.includes('--preview'),
  fixture = value('--fixture')
const port = Number(value('--port') ?? (preview ? 4173 : 3000))
const htmlPath = fixture ? path.resolve(root, fixture) : path.join(root, 'index.html')
if (
  fixture &&
  !/^\.[\w-]+\.local\/index\.html$/.test(path.relative(root, htmlPath).split(path.sep).join('/'))
)
  throw Error('Invalid fixture entry')
const server = await createPreviewServer({
  root,
  htmlPath,
  port,
  staticDir: preview ? path.join(root, 'dist') : undefined,
  spa: !fixture,
  watch: !fixture && !preview,
  environment: fixture || preview ? undefined : await appEnvironment(root, 'development')
})
await server.listen()
console.log(
  'Xelay local ' + (preview ? 'preview' : 'development server') + ' at http://127.0.0.1:' + port + '/'
)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close())
