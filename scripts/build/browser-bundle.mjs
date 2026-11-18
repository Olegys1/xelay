import * as esbuild from 'esbuild'
import postcss from 'postcss'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parseEnv } from 'node:util'

const require = createRequire(import.meta.url)
const browserKeys = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_GOOGLE_AUTH_ENABLED']
const slash = name => name.split(path.sep).join('/')

export async function appEnvironment(root, mode) {
  const env = {}
  for (const name of ['.env', '.env.local', '.env.' + mode, '.env.' + mode + '.local']) {
    try { Object.assign(env, parseEnv(await readFile(path.join(root, name), 'utf8'))) }
    catch (err) { if (err.code !== 'ENOENT') throw err }
  }
  return Object.fromEntries(browserKeys.map(key => [key, process.env[key] ?? env[key]]))
}

// This is also used by synthetic fixtures. Only their explicit public values enter a bundle.
export function browserDefines(environment, development) {
  const env = Object.fromEntries(browserKeys.filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]]))
  return {
    'import.meta.env': JSON.stringify({...env, DEV: development, PROD: !development, MODE: development ? 'development' : 'production', BASE_URL: '/'}),
    'import.meta.env.DEV': String(development),
    'process.env.NODE_ENV': JSON.stringify(development ? 'development' : 'production'),
  }
}

function assetPlugin() {
  return {name: 'xelay-browser-assets', setup(build) {
    build.onResolve({filter: /\?worker-url$/}, args => {
      const source = path.resolve(args.resolveDir,args.path.slice(0,-11))
      return {path:source+'.js',namespace:'bundled-worker',pluginData:{source}}
    })
    build.onLoad({filter: /.*/, namespace:'bundled-worker'}, async args => {
      const worker = await esbuild.build({entryPoints:[args.pluginData.source],bundle:true,format:'esm',
        platform:'browser',target:'es2022',minify:true,write:false,metafile:true})
      return {contents:worker.outputFiles[0].contents,loader:'file',watchFiles:Object.keys(worker.metafile.inputs).map(name=>path.resolve(name))}
    })
    build.onResolve({filter: /^\//}, args => {
      if (args.kind === 'url-token') return {path: args.path, external: true}
    })
    build.onResolve({filter: /\?url$/}, async args => {
      const result = await build.resolve(args.path.slice(0,-4), {resolveDir: args.resolveDir, kind: 'import-statement'})
      if (result.errors.length) return {errors: result.errors}
      return {path: result.path, namespace: 'asset-url'}
    })
    build.onLoad({filter: /.*/,namespace:'asset-url'}, async args => ({contents: await readFile(args.path), loader:'file', watchFiles:[args.path]}))
    build.onLoad({filter:/\.css$/}, async args => {
      const from = args.path
      const processor = postcss(require('../../postcss.config.cjs').plugins)
      const css = await processor.process(await readFile(from,'utf8'), {from, map:false})
      return {contents:css.css, loader:'css', resolveDir:path.dirname(from),
        watchFiles:[from,...css.messages.filter(m=>m.type==='dependency' && typeof m.file==='string').map(m=>m.file)]}
    })
  }}
}

export async function createBrowserBundle({root, htmlPath, outdir, development=false, environment={}, plugins=[], watch=false, onBuild}) {
  const template = await readFile(htmlPath,'utf8')
  const entryScript = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/i
  const entry = template.match(entryScript)
  if (!entry) throw Error('A module script is required in ' + path.relative(root,htmlPath))
  const entryPath = entry[1].startsWith('/') ? path.join(root,entry[1]) : path.resolve(path.dirname(htmlPath),entry[1])
  const options = {absWorkingDir:root, bundle:true, platform:'browser', format:'esm', splitting:true,
    target:'es2022', jsx:'automatic', entryPoints:{index:entryPath}, outdir,
    publicPath:'/assets', entryNames:'[name]-[hash]', chunkNames:'chunk-[name]-[hash]', assetNames:'[name]-[hash]',
    loader:{'.svg':'file','.png':'file','.jpg':'file','.gif':'file','.webp':'file','.mp4':'file','.woff':'file','.woff2':'file','.ttf':'file'},
    define:browserDefines(environment,development), plugins:[...plugins,assetPlugin()], minify:!development,
    legalComments:'eof', metafile:true, write:false, logLevel:'warning'}
  function render(result) {
    const urlFor = output => '/assets/' + slash(path.relative(outdir,path.resolve(root,output)))
    const outputs = result.metafile.outputs
    const entryOut = Object.keys(outputs).find(key=>outputs[key].entryPoint && path.resolve(root, outputs[key].entryPoint)===entryPath && key.endsWith('.js'))
    if (!entryOut) throw Error('Missing browser entry in build outputs')
    const entryMeta = outputs[entryOut]
    const cssLink = entryMeta.cssBundle ? '<link rel="stylesheet" crossorigin href="'+urlFor(entryMeta.cssBundle)+'">' : ''
    const shellUrls = new Set()
    function includeStatic(output) {
      const meta = outputs[output], url = urlFor(output)
      if (!meta) throw Error('Missing static browser output ' + output)
      if (shellUrls.has(url)) return
      shellUrls.add(url)
      for (const ref of meta.imports) if (ref.kind==='import-statement' && !ref.external) includeStatic(ref.path)
    }
    includeStatic(entryOut)
    for (const key of Object.keys(outputs)) if (/\.(?:woff2?|css)$/i.test(key)) shellUrls.add(urlFor(key))
    const html = template.replace(entryScript,'<script type="module" crossorigin src="'+urlFor(entryOut)+'"></script>').replace('</head>',cssLink+'</head>')
    const assets = new Map(result.outputFiles.map(f=>['/assets/'+slash(path.relative(outdir,f.path)),f.contents]))
    return {html, assets, shellUrls}
  }
  if (!watch) return render(await esbuild.build(options))
  let current
  options.plugins.push({name:'xelay-local-update',setup(build){build.onEnd(result=>{
    if (!result.errors.length) { current=render(result); onBuild?.(current) }
  })}})
  const context = await esbuild.context(options)
  try { await context.rebuild(); await context.watch() }
  catch(err) { await context.dispose(); throw err }
  return {current, close:()=>context.dispose()}
}

