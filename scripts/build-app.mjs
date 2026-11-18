import {cp, lstat, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {appEnvironment, createBrowserBundle} from './build/browser-bundle.mjs'
import {legalPageKinds, renderLegalHtml} from './legalHtml.ts'
import {publicPageBody, renderSeoHtml, seoStaticDocuments} from './publicSeoHtml.ts'
import {metadataForPath} from '../src/lib/seo.ts'

const root = await realpath(fileURLToPath(new URL('../',import.meta.url)))
const dist = path.join(root,'dist')
const publicDir = path.join(root,'public')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const result = await createBrowserBundle({root,htmlPath:path.join(root,'index.html'),outdir:path.join(dist,'assets'),
  environment:await appEnvironment(root,'production')})

const html = renderSeoHtml(result.html,metadataForPath('/'),publicPageBody('/'))
const worker = await readFile(path.join(publicDir,'push-sw.js'),'utf8')
const shell = new Map([['/index.html',html]])
for (const url of result.shellUrls) {
  if (!result.assets.has(url)) throw Error('Missing offline asset: ' + url)
  shell.set(url,result.assets.get(url))
}
for (const url of ['/theme-init.js','/icons/xelay-app-20261008-192.png']) shell.set(url,await readFile(path.join(publicDir,url)))
const hash = createHash('sha256').update(worker)
for (const url of [...shell.keys()].sort()) hash.update(url).update(shell.get(url))
const version = hash.digest('hex').slice(0,24)
const finalHtml = html.replace('</head>','<meta name="xelay-shell-version" content="' + version + '" /></head>')
shell.set('/index.html',finalHtml)
const integrity = Object.fromEntries([...shell].map(([url,bytes])=>[url,digest(bytes)]))
const documents = seoStaticDocuments(finalHtml)
for (const kind of legalPageKinds) documents.set('legal/'+kind+'.html',renderLegalHtml(kind))
const manifest = {version,shell:'/index.html',urls:[...shell.keys()],integrity}

try {
  const target = await lstat(dist)
  if (target.isSymbolicLink() || !target.isDirectory() || await realpath(dist)!==dist) throw Error('Invalid dist directory')
  await rm(dist,{recursive:true})
} catch (err) { if (err.code!=='ENOENT') throw err }
await cp(publicDir,dist,{recursive:true})
await mkdir(path.join(dist,'assets'),{recursive:true})
async function emit(name,bytes) {
  const dest = path.join(dist,name)
  await mkdir(path.dirname(dest),{recursive:true})
  await writeFile(dest,bytes)
}
for (const [url,bytes] of result.assets) await emit(url,bytes)
for (const [name,body] of documents) await emit(name,body)
await emit('assets/offline-shell-manifest-'+version+'.json',JSON.stringify(manifest))
await emit('push-sw.js',worker.replace('__XELAY_OFFLINE_SHELL_BUILD_ID__',version))
await emit('index.html',finalHtml)
console.log('Built Xelay with '+result.assets.size+' browser assets, '+documents.size+' public documents and '+shell.size+' verified offline files.')

