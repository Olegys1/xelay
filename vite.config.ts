import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
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
  }],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    port: 3000,
    strictPort: true,
    host: true,
    allowedHosts: true,
  },
})
