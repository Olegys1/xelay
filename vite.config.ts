import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { legalPageKinds, renderLegalHtml } from './scripts/legalHtml'

export default defineConfig({
  plugins: [react(), {
    name: 'xelay-public-legal-pages',
    apply: 'build',
    generateBundle() {
      for (const kind of legalPageKinds) {
        this.emitFile({ type: 'asset', fileName: `legal/${kind}.html`, source: renderLegalHtml(kind) })
      }
    },
  }, {
    name: 'xelay-offline-shell',
    apply: 'build',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        // Only the initial application's static module closure is needed by the
        // standalone reader. Lazy teaching/admin pages and file workers stay online-only.
        const shellChunks = new Set<string>()
        const includeStaticChunk = (fileName: string) => {
          if (shellChunks.has(fileName)) return
          const chunk = bundle[fileName]
          if (!chunk || chunk.type !== 'chunk') this.error(`The offline entry imports a missing static chunk: ${fileName}`)
          shellChunks.add(fileName)
          // OutputChunk.imports contains static imports; dynamicImports is deliberately excluded.
          for (const imported of chunk.imports) includeStaticChunk(imported)
        }
        for (const entry of Object.values(bundle)) if (entry.type === 'chunk' && entry.isEntry) includeStaticChunk(entry.fileName)
        if (!shellChunks.size) this.error('The offline shell requires a static application entry chunk.')
        const entries = Object.values(bundle).filter((entry) => entry.fileName === 'index.html'
          || (entry.type === 'chunk' && shellChunks.has(entry.fileName))
          || (entry.fileName.startsWith('assets/') && /\.(?:css|woff2?)$/i.test(entry.fileName)))
        const publicFiles = ['theme-init.js', 'icons/xelay-app-20261008-192.png']
        const worker = readFileSync(path.resolve(__dirname, 'public/push-sw.js'), 'utf8')
        const hash = createHash('sha256').update(worker)
        for (const entry of entries.sort((a, b) => a.fileName.localeCompare(b.fileName))) {
          hash.update(entry.fileName).update(entry.type === 'chunk' ? entry.code : entry.source)
        }
        for (const file of publicFiles) hash.update(file).update(readFileSync(path.resolve(__dirname, 'public', file)))
        const version = hash.digest('hex').slice(0, 24)
        const html = entries.find((entry) => entry.fileName === 'index.html')
        if (!html || html.type !== 'asset' || typeof html.source !== 'string') this.error('The offline shell requires the final public index.html.')
        html.source = html.source.replace('</head>', `<meta name="xelay-shell-version" content="${version}" /></head>`)
        const integrity: Record<string, string> = {}
        for (const entry of entries) integrity[`/${entry.fileName}`] = createHash('sha256').update(entry.type === 'chunk' ? entry.code : entry.source).digest('hex')
        for (const file of publicFiles) integrity[`/${file}`] = createHash('sha256').update(readFileSync(path.resolve(__dirname, 'public', file))).digest('hex')
        this.emitFile({ type: 'asset', fileName: `assets/offline-shell-manifest-${version}.json`, source: JSON.stringify({
          version, shell: '/index.html', urls: [...entries.map((entry) => `/${entry.fileName}`), ...publicFiles.map((file) => `/${file}`)], integrity,
        }) })
        this.emitFile({ type: 'asset', fileName: 'push-sw.js', source: worker.replace('__XELAY_OFFLINE_SHELL_BUILD_ID__', version) })
      },
    },
  }],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    port: 3000,
    strictPort: true,
    host: '127.0.0.1',
    allowedHosts: ['localhost', '127.0.0.1'],
  },
})
