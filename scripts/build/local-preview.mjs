import { createServer } from 'node:http'
import { copyFile, readFile, readdir, realpath, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as esbuild from 'esbuild'
import { createBrowserBundle } from './browser-bundle.mjs'

const synthetic = { VITE_SUPABASE_URL: 'http://127.0.0.1:9', VITE_SUPABASE_ANON_KEY: 'local-preview-only' }
const loopback = ['127.0.0.1', 'localhost']
export function isLocalRequest(req, port) {
  const hosts = loopback.map((host) => host + ':' + port)
  return (
    hosts.includes(req.headers.host) &&
    (req.headers.origin === undefined || hosts.some((host) => req.headers.origin === 'http://' + host))
  )
}

function fixtureModules(root, fixture) {
  return {
    name: 'xelay-local-fixture',
    setup(build) {
      if (fixture.resolveId)
        build.onResolve({ filter: /.*/ }, (args) => {
          const replacement = fixture.resolveId(args.path, args.importer)
          if (!replacement) return
          return replacement.startsWith('\0')
            ? { path: replacement.slice(1), namespace: 'fixture' }
            : { path: path.resolve(root, replacement) }
        })
      if (!fixture.load) return
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => {
        const contents = fixture.load('\0' + args.path)
        if (typeof contents !== 'string') throw Error('Local fixture module not found')
        return { contents, loader: 'tsx', resolveDir: root }
      })
      build.onLoad({ filter: /\.[mc]?[jt]sx?$/, namespace: 'file' }, (args) => {
        const contents = fixture.load(args.path)
        if (typeof contents === 'string')
          return { contents, loader: 'tsx', resolveDir: path.dirname(args.path) }
      })
    }
  }
}

function bundleOptions({ root, htmlPath, environment = synthetic, fixture }, outdir) {
  return {
    root,
    htmlPath,
    outdir,
    development: true,
    environment,
    plugins: fixture ? [fixtureModules(root, fixture)] : []
  }
}

export async function buildPreview(options) {
  const { root, htmlPath, outdir } = options
  const built = await createBrowserBundle(bundleOptions(options, path.join(outdir, 'assets')))
  const outputHtml = path.join(outdir, path.relative(root, htmlPath))
  for (const [url, source] of await indexPublicTree(path.join(root, 'public'))) {
    const destination = path.join(outdir, url)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }
  await mkdir(path.dirname(outputHtml), { recursive: true })
  await mkdir(path.join(outdir, 'assets'), { recursive: true })
  for (const [url, bytes] of built.assets) await writeFile(path.join(outdir, url), bytes)
  await writeFile(outputHtml, built.html)
}

const fileTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4'
}
const mimeFor = (url) => fileTypes[path.extname(url).toLowerCase()] || 'application/octet-stream'

async function indexPublicTree(directory, current = directory, result = new Map()) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
    const file = path.join(current, entry.name)
    if (entry.isDirectory()) await indexPublicTree(directory, file, result)
    if (entry.isFile()) result.set('/' + path.relative(directory, file).split(path.sep).join('/'), file)
  }
  return result
}
async function loadTutorServer(root) {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['server/student-learning/maxTutorLocalServer.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false
  })
  return import(
    'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64')
  )
}

export async function createPreviewServer(options) {
  const { root, htmlPath, port, watch = false, fixture, staticDir, spa = false } = options
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid loopback port')
  const portUrl = 'http://127.0.0.1:' + port
  const publicDir = await realpath(staticDir || path.join(root, 'public'))
  const files = await indexPublicTree(publicDir)
  const pagePath = htmlPath ? '/' + path.relative(root, htmlPath).split(path.sep).join('/') : '/index.html'
  const handlers = [],
    streams = new Set()
  let bundle, stopWatch
  const httpServer = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    const end = (status, body = '', type = 'text/plain; charset=utf-8') => {
      res.statusCode = status
      res.setHeader('Content-Type', type)
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    if (!isLocalRequest(req, port)) return end(403, 'Forbidden')
    async function serve() {
      if (req.method !== 'GET' && req.method !== 'HEAD') return end(405)
      let url
      try {
        url = decodeURIComponent(new URL(req.url, portUrl).pathname)
      } catch {
        return end(400)
      }
      if (url.includes('\\') || url.includes('\0')) return end(400)
      if (watch && url === '/__xelay_dev_update.js')
        return end(
          200,
          "new EventSource('/__xelay_dev_events').onmessage=()=>location.reload()",
          mimeFor(url)
        )
      if (watch && url === '/__xelay_dev_events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
        res.write(': connected\n\n')
        streams.add(res)
        res.on('close', () => streams.delete(res))
        return
      }
      if (bundle?.assets.has(url)) return end(200, bundle.assets.get(url), mimeFor(url))
      if (files.has(url)) return end(200, await readFile(files.get(url)), mimeFor(url))
      const indexUrl = url.endsWith('/') ? url + 'index.html' : ''
      if (files.has(indexUrl)) return end(200, await readFile(files.get(indexUrl)), mimeFor(indexUrl))
      const appNavigation =
        spa &&
        (req.headers.accept || '').includes('text/html') &&
        !path.extname(url) &&
        !url.split('/').some((x) => x.startsWith('.')) &&
        !/^\/(?:api|server|node_modules|src|scripts)(?:\/|$)/.test(url)
      if (bundle && (url === '/' || url === '/index.html' || url === pagePath || appNavigation)) {
        const html = watch
          ? bundle.html.replace('</body>', '<script src="/__xelay_dev_update.js"></script></body>')
          : bundle.html
        return end(200, html, mimeFor('index.html'))
      }
      if (staticDir && appNavigation && files.has('/index.html'))
        return end(200, await readFile(files.get('/index.html')), mimeFor('index.html'))
      return end(404)
    }
    function dispatch(index) {
      Promise.resolve()
        .then(() =>
          index === handlers.length ? serve() : handlers[index](req, res, () => dispatch(index + 1))
        )
        .catch(() => {
          if (!res.headersSent) end(500, 'Local preview unavailable')
          else res.destroy()
        })
    }
    dispatch(0)
  })
  const server = {
    httpServer,
    middlewares: {
      use(handler) {
        handlers.push(handler)
      }
    },
    loadTutorServer: () => loadTutorServer(root),
    async listen() {
      if (!staticDir) {
        const optionsForBundle = bundleOptions(options, path.join(root, '.preview-output.local', 'assets'))
        if (watch) {
          const ctx = await createBrowserBundle({
            ...optionsForBundle,
            watch: true,
            onBuild(built) {
              bundle = built
              for (const res of streams) res.write('data: reload\n\n')
            }
          })
          stopWatch = ctx.close
        } else bundle = await createBrowserBundle(optionsForBundle)
      }
      try {
        await new Promise((ok, fail) => {
          httpServer.once('error', fail)
          httpServer.listen({ host: '127.0.0.1', port }, ok)
        })
      } catch (error) {
        await stopWatch?.()
        throw error
      }
    },
    async close() {
      for (const res of streams) res.end()
      await stopWatch?.()
      if (httpServer.listening) await new Promise((done) => httpServer.close(done))
    }
  }
  fixture?.configureServer?.(server)
  return server
}
