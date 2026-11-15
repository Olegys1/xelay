import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { publicationRevisionsFixture } from './security/teaching-test-publication-revisions-fixture.mjs'

// All identities, questions, attempts and RPCs in this preview are local and synthetic.
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.exam-reliability-preview.local')
const port = 3115
await mkdir(directory, { recursive: true })
const fx = await publicationRevisionsFixture()
await fx.db.exec(await readFile(path.join(root, 'supabase/migrations/202611140120_teaching_first_exit_submission.sql'), 'utf8'))
const { ids, groups, db } = fx
for (const [id, name] of [[ids.owner, 'Олена Прикладенко'], [ids.studentA, 'Марія Прикладенко'], [ids.studentB, 'Данило Зразковий'], [ids.headA, 'Андрій Навчальний']]) {
  await db.query('update profiles set full_name=$1 where id=$2', [name, id])
  await db.query('update teaching_entries set full_name=$1 where user_id=$2', [name, id])
}
await db.query("update teaching_courses set title='Основи менеджменту' where id=$1", [ids.course])
await db.query("update study_groups set group_name='Група А · навчальний приклад' where id=$1", [groups[0]])
await db.query("update study_groups set group_name='Група Б · навчальний приклад' where id=$1", [groups[1]])
const now = Date.now()
const common = { title: 'Контрольна · оновлення часу', variants: [], targets: groups.map(group_id => ({ group_id, audience_mode: 'all', subgroup_ids: [] })), closes_at: new Date(now + 3600000).toISOString() }
const published = await fx.createTest(common)
const publicationId = published.definition.id
const early = await fx.complete(ids.studentA, publicationId)
const later = await fx.complete(ids.studentB, publicationId, { group: groups[1] })
const active = await fx.testMutate(ids.headA, 'start', { id: publicationId, group_id: groups[0] })
await db.query("update teaching_test_attempts set started_at=(clock_timestamp() at time zone 'Europe/Kyiv')::date+time '13:10' at time zone 'Europe/Kyiv' where id=$1", [early.attempt.id])
await db.query("update teaching_test_attempts set started_at=(clock_timestamp() at time zone 'Europe/Kyiv')::date+time '13:26' at time zone 'Europe/Kyiv' where id=$1", [later.attempt.id])
await fx.stage(publicationId, { duration_seconds: 1800, closes_at: new Date(now + 7200000).toISOString() })
const strict = await fx.createTest({ title: 'Самостійна · здача після виходу', variants: [], restrict_tab_switch: true, discourage_capture: true, duration_seconds: 1200 })
const strictId = strict.definition.id
const signatures = {
  xelay_teaching_test: ['p_test_id'], xelay_teaching_test_mutate: ['p_action', 'p_payload'],
  xelay_teaching_tests: ['p_course_id', 'p_group_id'], xelay_teaching_course: ['p_course_id'],
  xelay_teaching_audience: ['p_course_id'], xelay_teaching_question_bank: ['p_course_id'],
}
const reply = (res, status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(data)) }
let queue = Promise.resolve()
function serialized(fn) { const next = queue.then(fn); queue = next.catch(() => {}); return next }
const virtual = '\0xelay-exam-preview-transport'
const transport = `const deny=()=>{throw Error('LOCAL_PREVIEW_ONLY')}; export const supabase={rpc:async(name,args={})=>{try{const response=await fetch('/__exam-preview/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:sessionStorage.getItem('xelay-exam-preview-role')||'teacher',name,args})});return await response.json()}catch(error){return {data:null,error:{message:error.message}}}},from:deny,channel:deny,storage:new Proxy({},{get:()=>deny}),auth:new Proxy({},{get:()=>deny})};`
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Перевірка тестування</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>')
await writeFile(path.join(directory, 'main.tsx'), `
import React,{useEffect,useMemo,useState}from'react';import{createRoot}from'react-dom/client';
import'../src/index.css';import'../src/components/teaching/teaching.css';import'../src/components/teaching/teaching-workflow.css';import'../src/components/teaching/teaching-tests.css';
import{ToastProvider}from'../src/context/ToastContext';import{SeasonalThemePreviewProvider}from'../src/context/ThemeContext';
import{TeachingPublishedTestEditor}from'../src/components/teaching/TeachingPublishedTestEditor';import{TeachingTestRunner}from'../src/components/teaching/TeachingTestRunner';
import{TeachingButton}from'../src/components/teaching/TeachingUI';import{supabaseTeachingRepository}from'../src/lib/teaching';import{createSupabaseTeachingTestRepository}from'../src/lib/teachingTests';
function Preview(){const[config,setConfig]=useState<any>(null),[panel,setPanel]=useState(''),[notice,setNotice]=useState(''),[error,setError]=useState(''),[revision,setRevision]=useState(0);const repository=useMemo(()=>createSupabaseTeachingTestRepository(),[]);const teaching=useMemo(()=>({...supabaseTeachingRepository,mode:'local' as const}),[]);
useEffect(()=>{sessionStorage.setItem('xelay-exam-preview-role','teacher');fetch('/__exam-preview/config').then(r=>r.json()).then(setConfig).catch(e=>setError(e.message))},[revision]);
function open(next:string){sessionStorage.setItem('xelay-exam-preview-role',next==='student'?'student':'teacher');setPanel(next);setNotice('')}
return <main className="min-h-screen bg-background text-foreground"><div className="mx-auto max-w-5xl px-5 py-12"><p className="text-xs font-semibold uppercase tracking-widest text-primary">Xelay · локальна перевірка</p><h1 className="mt-3 text-3xl font-semibold">Тестування без втрати робіт</h1><p className="mt-4 max-w-3xl text-muted-foreground">Вигадані студенти та окрема локальна база. Опубліковані роботи й робочий Xelay тут не змінюються.</p><div className="mt-8 grid gap-5 md:grid-cols-2"><section className="teaching-card"><h2 className="text-xl font-semibold">Викладач</h2><p className="my-4 text-sm text-muted-foreground">Зміни часу збережені окремою чернеткою. Оберіть, чи потрібні повторні спроби, та перевірте отримувачів до публікації.</p><TeachingButton primary disabled={!config} onClick={()=>open('teacher')}>Переглянути зміни тесту</TeachingButton></section><section className="teaching-card"><h2 className="text-xl font-semibold">Студент</h2><p className="my-4 text-sm text-muted-foreground">Прочитайте правило виходу, почніть тест і спробуйте закрити його. Фактичний вихід завершує спробу з першого разу.</p><TeachingButton primary disabled={!config} onClick={()=>open('student')}>Відкрити тест студента</TeachingButton></section></div>{notice&&<p role="status" className="teaching-note mt-6">{notice}</p>}{error&&<p role="alert">{error}</p>}<p className="mt-8 text-xs text-muted-foreground">Олена Прикладенко · викладачка. Марія Прикладенко · студентка. Дані прикладу зберігаються до вимкнення локального перегляду.</p></div>{panel==='teacher'&&config&&<TeachingPublishedTestEditor key={revision} test={config.detail.test} snapshot={config.snapshot} repository={repository} teachingRepository={teaching} userId={config.teacherId} onClose={()=>setPanel('')} onSaved={detail=>{setPanel('');setNotice('Зміни опубліковано в локальній базі. Нових особистих спроб: '+detail.republish_result.created_retakes+'. Подовжено активних: '+detail.republish_result.extended_active_attempts+'. Попередні відповіді збережені.');setRevision(n=>n+1)}}/>}{panel==='student'&&config&&<TeachingTestRunner repository={repository} testId={config.strictId} groupId={config.groupId} userId={config.studentId} onClose={()=>setPanel('')}/>}</main>}
createRoot(document.getElementById('root')!).render(<SeasonalThemePreviewProvider initialTheme="light"><ToastProvider><Preview/></ToastProvider></SeasonalThemePreviewProvider>);
`)
const server = await createServer({ root, configFile: false, envDir: false, envPrefix: 'XELAY_UNUSED_PREVIEW_', cacheDir: path.join(directory, '.vite'), optimizeDeps: { entries: [path.relative(root,path.join(directory,'index.html'))] }, plugins: [react(), {
  name: 'xelay-exam-preview-isolation', enforce: 'pre',
  resolveId(source, importer) { if (!importer || !source.startsWith('.')) return null; const file = path.resolve(path.dirname(importer.split('?')[0]),source).replaceAll('\\','/'); return ['src/lib/supabase','src/lib/supabase.ts'].some(item=>file===path.join(root,item).replaceAll('\\','/')) ? virtual : null },
  load(id) { return id===virtual ? transport : null },
  configureServer(vite) { vite.middlewares.use(async(req,res,next)=>{
    res.setHeader('Content-Security-Policy', "connect-src 'self'; object-src 'none'; frame-src 'none'")
    const route=req.url?.split('?')[0];if(!route?.startsWith('/__exam-preview/'))return next()
    if(req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${port}`)return reply(res,403,{error:{message:'PREVIEW_ORIGIN_DENIED'}})
    try{
      if(route==='/__exam-preview/config'&&req.method==='GET')return reply(res,200,await serialized(async()=>({detail:await fx.testDetail(ids.owner,publicationId),snapshot:await fx.rpc(ids.owner,'xelay_teaching_course',[ids.course]),teacherId:ids.owner,studentId:ids.studentA,groupId:groups[0],strictId})))
      if(route!=='/__exam-preview/rpc'||req.method!=='POST')return reply(res,404,{error:{message:'PREVIEW_ROUTE_UNKNOWN'}})
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2*1024*1024)throw Error('PREVIEW_TOO_LARGE')}
      const request=JSON.parse(raw),actor=request.role==='teacher'?ids.owner:request.role==='student'?ids.studentA:null,keys=signatures[request.name]
      if(!actor||!keys||Object.keys(request.args||{}).some(key=>!keys.includes(key)))throw Error('PREVIEW_RPC_DENIED')
      const values=keys.map(key=>{let value=request.args[key]??null;if(key==='p_payload')value={...value,expected_user_id:actor};return value&&typeof value==='object'?JSON.stringify(value):value})
      return reply(res,200,{data:await serialized(()=>fx.rpc(actor,request.name,values)),error:null})
    }catch(error){return reply(res,200,{data:null,error:{code:error.code||'',message:error.message}})}
  })},
}],server:{host:'127.0.0.1',port,strictPort:true,hmr:false,allowedHosts:['127.0.0.1'],watch:{ignored:['**/.security-ci.local/**']}}})
await server.listen()
console.log(`http://127.0.0.1:${port}/.exam-reliability-preview.local/index.html`)
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void server.close().then(()=>fx.close()).finally(()=>process.exit(0))})
