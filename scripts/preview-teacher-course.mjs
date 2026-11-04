import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.teacher-course-preview.local')
const argument = process.argv.indexOf('--port')
const port = argument < 0 ? 3088 : Number(process.argv[argument + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid preview port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Відеоуроки та імпорт тестів</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>')
await writeFile(path.join(directory, 'main.tsx'), `import React,{useMemo,useState}from'react'
import{createRoot}from'react-dom/client'
import'../src/index.css'
import{SeasonalThemePreviewProvider,useTheme}from'../src/context/ThemeContext'
import{ToastProvider}from'../src/context/ToastContext'
import{createLocalTeachingRepository,LOCAL_TEACHING_IDENTITIES}from'../src/lib/localTeachingRepository'
import{TeachingWorkspace}from'../src/components/teaching/TeachingWorkspace'
import{TeachingQuestionImportPanel}from'../src/components/teaching/TeachingQuestionImportPanel'
function Preview(){const[view,setView]=useState('guides'),[questions,setQuestions]=useState([]),[importOpen,setImportOpen]=useState(true);const{theme,toggleTheme}=useTheme();const repository=useMemo(()=>createLocalTeachingRepository('teacher'),[]),identity=LOCAL_TEACHING_IDENTITIES.teacher;return <div className="min-h-screen bg-background text-foreground"><header className="border-b border-border bg-card"><div className="mx-auto max-w-[1180px] px-5 py-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-widest text-primary">Xelay · Локальний перегляд</p><p className="mt-2 text-sm text-muted-foreground">Справжні відео. Навчальні дані вигадані. Нічого не опубліковано.</p></div><button className="teaching-button" onClick={toggleTheme}>{theme==='light'?'Темна тема':'Світла тема'}</button></div><nav aria-label="Перегляд оновлення" className="mt-4 flex flex-wrap gap-2"><button className="teaching-button" aria-pressed={view==='guides'} onClick={()=>setView('guides')}>Відеокурс у кабінеті</button><button className="teaching-button" aria-pressed={view==='import'} onClick={()=>setView('import')}>Імпорт тестів</button></nav></div></header>{view==='guides'?<TeachingWorkspace repository={repository} userId={identity.userId} fullName={identity.fullName} initialView="guides"/>:<main className="teaching-page"><h1 className="mb-3 text-2xl font-bold">Легкий імпорт готових тестів</h1><p className="mb-6 text-sm text-muted-foreground">Файли обробляються у цьому браузері. Після підтвердження запитання залишаться лише в локальному прикладі.</p>{questions.length>0&&<div role="status" className="teaching-note mb-5">До локального банку додано запитань: {questions.length}. Публікації на платформі немає.</div>}{importOpen?<TeachingQuestionImportPanel onCancel={()=>setImportOpen(false)} onConfirm={(items)=>{setQuestions(previous=>[...previous,...items]);setImportOpen(false)}}/>:<button className="teaching-button teaching-button-primary" onClick={()=>setImportOpen(true)}>Імпортувати ще</button>}</main>}</div>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><SeasonalThemePreviewProvider initialTheme="light"><ToastProvider><Preview/></ToastProvider></SeasonalThemePreviewProvider></React.StrictMode>)
`)
if (process.argv.includes('--prepare-only')) process.exit(0)
const blocked = '\0xelay-teacher-course-no-cloud'
const stub = "const deny=()=>{throw Error('LOCAL_PREVIEW_ONLY')};export const supabase={rpc:deny,from:deny,channel:deny,auth:new Proxy({},{get:()=>deny}),storage:new Proxy({},{get:()=>deny})}"
const server = await createServer({ root, configFile: false, envDir: path.join(directory, 'no-env'), envPrefix: 'XELAY_UNUSED_PREVIEW_',
  cacheDir: path.join(root, 'node_modules/.vite-teacher-course'), optimizeDeps: { entries: [path.relative(root, path.join(directory, 'index.html'))] },
  plugins: [react(), { name: 'teacher-course-isolated', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return null
    const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/')
    return ['src/lib/supabase', 'src/lib/supabase.ts'].some(file => candidate === path.join(root, file).replaceAll('\\', '/')) ? blocked : null
  }, load(id) { return id === blocked ? stub : null }, configureServer(vite) {
    vite.middlewares.use((req, _res, next) => {
      if (req.url?.split('?')[0] === '/guides/' || req.url?.split('?')[0] === '/guides') req.url = '/guides/index.html'
      next()
    })
  } }], server: { port, host: '127.0.0.1', strictPort: true } })
await server.listen()
console.log(`Local teacher course: http://127.0.0.1:${port}/.teacher-course-preview.local/index.html`)
