import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.teaching-lesson-roles-preview.local')
const index = process.argv.indexOf('--port')
const port = index < 0 ? 3089 : Number(process.argv[index + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid preview port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Лекції та семінари</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>')
await writeFile(path.join(directory, 'main.tsx'), `import React,{useMemo,useState}from'react'
import{createRoot}from'react-dom/client'
import'../src/index.css'
import{SeasonalThemePreviewProvider,useTheme}from'../src/context/ThemeContext'
import{ToastProvider}from'../src/context/ToastContext'
import{createLocalTeachingRepository,LOCAL_TEACHING_IDENTITIES,type LocalTeachingRole}from'../src/lib/localTeachingRepository'
import{TeachingWorkspace}from'../src/components/teaching/TeachingWorkspace'
function Preview(){const[role,setRole]=useState<LocalTeachingRole>('teacher');const{theme,toggleTheme}=useTheme();const repository=useMemo(()=>createLocalTeachingRepository(role),[role]),identity=LOCAL_TEACHING_IDENTITIES[role];return <div className="min-h-screen bg-background text-foreground"><header className="border-b border-border bg-card"><div className="mx-auto max-w-[1180px] px-5 py-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-widest text-primary">Xelay · Локальний перегляд</p><p className="mt-2 text-sm text-muted-foreground">Лекції та семінари. Дані вигадані, робоча платформа не змінюється.</p></div><button className="teaching-button" onClick={toggleTheme}>{theme==='light'?'Темна тема':'Світла тема'}</button></div><nav aria-label="Обліковий запис прикладу" className="mt-4 flex flex-wrap gap-2"><button className="teaching-button" aria-pressed={role==='teacher'} onClick={()=>setRole('teacher')}>Олена, викладачка</button><button className="teaching-button" aria-pressed={role==='colleague'} onClick={()=>setRole('colleague')}>Тарас, колега</button></nav></div></header><TeachingWorkspace key={role} repository={repository} userId={identity.userId} fullName={identity.fullName} initialView="calendar" initialHome="calendar" initialDate="2026-11-05"/></div>}
const previewRoot=import.meta.hot?.data.xelayPreviewRoot||createRoot(document.getElementById('root')!);if(import.meta.hot)import.meta.hot.data.xelayPreviewRoot=previewRoot;
previewRoot.render(<React.StrictMode><SeasonalThemePreviewProvider initialTheme="light"><ToastProvider><Preview/></ToastProvider></SeasonalThemePreviewProvider></React.StrictMode>)
`)
if (process.argv.includes('--prepare-only')) process.exit(0)
const blocked = '\0xelay-lesson-roles-no-cloud'
const stub = "const deny=()=>{throw Error('LOCAL_PREVIEW_ONLY')};export const supabase={rpc:deny,from:deny,channel:deny,auth:new Proxy({},{get:()=>deny}),storage:new Proxy({},{get:()=>deny})}"
const server = await createServer({ root, configFile: false, envDir: path.join(directory, 'no-env'), envPrefix: 'XELAY_UNUSED_PREVIEW_',
  cacheDir: path.join(root, 'node_modules/.vite-teaching-lesson-roles'), optimizeDeps: { entries: [path.relative(root, path.join(directory, 'index.html'))] },
  plugins: [react(), { name: 'lesson-roles-isolated', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return null
    const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/')
    return ['src/lib/supabase', 'src/lib/supabase.ts'].some(file => candidate === path.join(root, file).replaceAll('\\', '/')) ? blocked : null
  }, load(id) { return id === blocked ? stub : null } }], server: { port, host: '127.0.0.1', strictPort: true } })
await server.listen()
console.log('Local lesson roles: http://127.0.0.1:' + port + '/.teaching-lesson-roles-preview.local/index.html')
