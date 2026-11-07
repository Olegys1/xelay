import type { Plugin } from 'vite'
import { metadataForPath } from '../src/lib/seo.ts'
import { publicPageBody, renderSeoHtml, seoStaticDocuments } from './publicSeoHtml.ts'

export function publicSeoPlugin(): Plugin {
  return {
    name: 'xelay-public-seo', enforce: 'post',
    transformIndexHtml: { order: 'post', handler: html => renderSeoHtml(html,metadataForPath('/'),publicPageBody('/')) },
    generateBundle: { order: 'post', handler(_options,bundle) {
      const entry=bundle['index.html']
      if (!entry || entry.type!=='asset' || typeof entry.source!=='string') this.error('The SEO pages require the built app shell.')
      for (const [fileName,source] of seoStaticDocuments(entry.source)) this.emitFile({type:'asset',fileName,source})
    } },
  }
}
