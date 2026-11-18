import { mkdir, writeFile } from 'node:fs/promises'
import { createPreviewServer } from './build/local-preview.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root=fileURLToPath(new URL('../',import.meta.url)),directory=path.join(root,'.teaching-grade-voice-preview.local')
const flag=process.argv.indexOf('--port'),port=flag<0?3060:Number(process.argv[flag+1])
if(!Number.isInteger(port)||port<1024||port>65535) throw Error('Invalid local port')
await mkdir(directory,{recursive:true})
await writeFile(path.join(directory,'index.html'),'<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Голосові відповіді</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>')
await writeFile(path.join(directory,'main.tsx'),"import React from 'react'\nimport{createRoot}from'react-dom/client'\nimport'../src/index.css'\nimport{LocalTeachingGradeVoicePreview}from'../src/components/teaching/LocalTeachingGradeVoicePreview'\ncreateRoot(document.getElementById('root')!).render(<LocalTeachingGradeVoicePreview/>);\n")
const block='\0grade-voice-no-live-backend',recorder='\0grade-voice-demo-recorder'
const normalize=value=>value.replaceAll('\\','/')
const server=await createPreviewServer({
  root, port, htmlPath: path.join(directory, 'index.html'),
  fixture: {
    resolveId(source,importer){
      if(!importer||!source.startsWith('.'))return null
      const candidate=normalize(path.resolve(path.dirname(importer.split('?')[0]),source))
      if(candidate===normalize(path.join(root,'src/lib/supabase'))||candidate===normalize(path.join(root,'src/lib/supabase.ts')))return block
      if(normalize(importer).endsWith('/src/components/teaching/TeachingGradeRequests.tsx')&&source==='./TeachingVoiceRecorder')return recorder
      return null
    },
    load(id){
      if(id===block)return "const denied=()=>{throw Error('LOCAL_PREVIEW_LIVE_BACKEND_FORBIDDEN')};export const supabase=new Proxy({},{get:()=>denied});"
      if(id===recorder)return `export {LocalTeachingVoiceRecorder as TeachingVoiceRecorder} from ${JSON.stringify(normalize(path.join(root,'src/components/teaching/LocalTeachingGradeVoicePreview.tsx')))}`
    },
    configureServer(server){server.middlewares.use((request,response,next)=>{
      response.setHeader('Content-Security-Policy',"connect-src 'self' ws://127.0.0.1:"+port+"; media-src 'self' blob:; img-src 'self' data: blob:")
      if(!request.url?.startsWith('/api/'))return next()
      response.statusCode=503;response.end('LOCAL_PREVIEW_LIVE_BACKEND_FORBIDDEN')
    })},
  },
})
await server.listen()
console.log(`Local preview: http://127.0.0.1:${port}/.teaching-grade-voice-preview.local/index.html`)
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void server.close().finally(()=>process.exit(0))})
