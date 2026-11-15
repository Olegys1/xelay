import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { personalRetakesFixture } from './security/teaching-test-personal-retakes-fixture.mjs'
import { readCourseModuleMigration } from './security/teaching-course-modules-fixture.mjs'

// Loopback-only fictional actors. No production credentials, provider client,
// .env files or external services are used; every successful RPC is actual SQL.
const root=fileURLToPath(new URL('../',import.meta.url)),port=3116,origin='http://127.0.0.1:'+port
const directory=path.join(root,'.optimization-phase1-preview.local')
await mkdir(directory,{recursive:true})
const fx=await personalRetakesFixture()
for(const name of ['202611140110_teaching_publication_revisions.sql','202611140120_teaching_first_exit_submission.sql','202611150010_teaching_qa_atomic_exit.sql'])await fx.db.exec(await readCourseModuleMigration(name))
const{db,ids,groups}=fx,qaSeed=await fx.createQaTest()
const actors={qa:qaSeed.owner,teacher:ids.owner,student:ids.studentA}
for(const[id,first,last]of[[ids.owner,'Олена','Прикладенко'],[ids.studentA,'Марія','Тестова'],[ids.studentB,'Данило','Зразковий'],[qaSeed.owner,'Олег','Навчальний']]){
 await db.query('update profiles set full_name=$1,first_name=$2,last_name=$3 where id=$4',[last+' '+first,first,last,id])
 await db.query('update teaching_entries set full_name=$1 where user_id=$2',[last+' '+first,id])
}
await db.query("update study_groups set group_name='Група А · навчальний приклад' where id=$1",[groups[0]])
await db.query("update teaching_courses set title='Менеджмент · локальна перевірка' where id=$1",[ids.course])
await db.query("update study_groups set group_name='ооо 1 · вигаданий приклад' where id=$1",[qaSeed.group])
await db.query("update teaching_courses set title='Службова перевірка · лише автор' where id=$1",[qaSeed.course])
const now=Date.now(),timing={opens_at:new Date(now-60000).toISOString(),closes_at:new Date(now+3600000).toISOString(),duration_seconds:600}
const old=await fx.createTest({title:'Збережений попередній результат · 10 балів',variants:[],...timing})
await fx.complete(ids.studentA,old.definition.id)
await fx.publishOriginal(old.definition.id)
const oldGrades=(await db.query('select id from teaching_grades order by id')).rows.map(r=>r.id)
const gradeHash=async()=>(await db.query("select md5(coalesce(string_agg(md5(to_jsonb(g)::text),'' order by id),'')) hash from teaching_grades g where id=any($1::uuid[])",[oldGrades])).rows[0].hash
const oldGradeHash=await gradeHash()
const attemptHash=async()=>(await db.query("select md5(coalesce(string_agg(md5(to_jsonb(a)::text),'' order by id),'')) hash from teaching_test_attempts a where test_id=$1",[old.definition.id])).rows[0].hash
const oldAttemptHash=await attemptHash()
const normal=await fx.createTest({title:'Пакет 1 · контрольна для студента',variants:[],...timing,max_points:5,
 questions:fx.definition().questions.map((q,i)=>({...q,text:i?'Який результат додавання 1 + 1?':'Оберіть число два.'}))})
const qaInput={...qaSeed.definition,...timing,status:'published',qa_own_attempt:true,version:qaSeed.detail.test.version,
 title:'Пакет 1 · службовий вихід та остання відповідь',description:'Вигаданий приклад. Окремий тестовий бал не змінює журнал.',
 max_points:5,restrict_tab_switch:true,discourage_capture:true,variants:[],
 questions:[{...qaSeed.definition.questions[0],text:'Оберіть число два.'},{id:'essay',kind:'essay',text:'Напишіть коротке пояснення: що допомагає не втрачати відповіді?',
 points:1,time_limit_seconds:null,partial_credit:false,options:[],buckets:[]}]}
await fx.testMutate(qaSeed.owner,'save_test',qaInput)
const signatures={
 xelay_teaching_test:['p_test_id'],xelay_teaching_test_mutate:['p_action','p_payload'],xelay_teaching_test_qa:['p_action','p_payload'],
 xelay_teaching_tests:['p_course_id','p_group_id'],xelay_teaching_course:['p_course_id'],xelay_teaching_audience:['p_course_id'],
 xelay_teaching_question_bank:['p_course_id'],xelay_teaching_mutate:['p_action','p_payload'],
 xelay_teaching_journal_preferences:['p_course_id','p_group_id'],
 xelay_teaching_save_journal_preferences:['p_course_id','p_group_id','p_activity_ids','p_version','p_expected_user_id'],
 xelay_teaching_save_journal_view:['p_course_id','p_group_id','p_settings','p_version','p_expected_user_id'],
 xelay_teaching_sync_journal_schedule:['p_course_id','p_group_id','p_from','p_to','p_expected_user_id'],
}
let queue=Promise.resolve()
function serialized(fn){const task=queue.then(fn);queue=task.catch(()=>{});return task}
const counts={}
async function state(){return{old_grade_count:oldGrades.length,old_grade_rows_unchanged:await gradeHash()===oldGradeHash,
 old_attempts_unchanged:await attemptHash()===oldAttemptHash,total_grade_rows:(await db.query('select count(*)::int n from teaching_grades')).rows[0].n,
 qa_results:(await db.query('select count(*)::int n from teaching_test_qa_results')).rows[0].n,requests:counts}}
function reply(res,status,data){res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data))}
const virtual='\0xelay-optimization-preview-transport'
const transport="const deny=()=>{throw Error('LOCAL_PREVIEW_ONLY')};export const supabase={rpc:async(name,args={})=>{try{const r=await fetch('/__optimization-preview/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:sessionStorage.getItem('xelay-optimization-preview-role')||'qa',name,args})});return await r.json()}catch(e){return{data:null,error:{message:e.message}}}},from:deny,channel:deny,storage:new Proxy({},{get:()=>deny}),auth:new Proxy({},{get:()=>deny})};"
await writeFile(path.join(directory,'index.html'),'<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Перший пакет оптимізації</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>')
await writeFile(path.join(directory,'main.tsx'),"import React,{useEffect,useMemo,useRef,useState}from'react';import{createRoot}from'react-dom/client';\nimport'../src/index.css';import'../src/components/teaching/teaching.css';import'../src/components/teaching/teaching-workflow.css';\nimport{ToastProvider}from'../src/context/ToastContext';import{SeasonalThemePreviewProvider}from'../src/context/ThemeContext';\nimport{TeachingTests}from'../src/components/teaching/TeachingTests';import{TeachingGradebook}from'../src/components/teaching/TeachingGradebook';import{TeachingGroupTests}from'../src/components/teaching/TeachingTestRunner';\nimport{TeachingButton}from'../src/components/teaching/TeachingUI';import{supabaseTeachingRepository}from'../src/lib/teaching';import{createSupabaseTeachingTestRepository}from'../src/lib/teachingTests';\nconst labels={qa:'Службовий тест',teacher:'Викладач',student:'Студент'};\nfunction Preview(){\n const[role,setRole]=useState<'qa'|'teacher'|'student'>('qa'),[config,setConfig]=useState<any>(null),[snapshot,setSnapshot]=useState<any>(null),[stats,setStats]=useState<any>(null),[error,setError]=useState(''),[view,setView]=useState('tests'),[target,setTarget]=useState<any>(),[revision,setRevision]=useState(0);\n const currentRole=useRef(role);currentRole.current=role;\n const tests=useMemo(()=>createSupabaseTeachingTestRepository(),[]),teaching=useMemo(()=>({...supabaseTeachingRepository,mode:'local' as const}),[]);\n useEffect(()=>{sessionStorage.setItem('xelay-optimization-preview-role',role);setSnapshot(null);setError('');setView('tests');setTarget(undefined);let active=true;\n fetch('/__optimization-preview/config?role='+role).then(r=>r.json()).then(v=>{if(active){if(v.error)throw Error(v.error.message);setConfig(v);setSnapshot(v.snapshot);setStats(v.state)}}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[role]);\n async function refresh(){if(!config)return;const requested=role;try{const next=requested==='student'?{}:await teaching.course(config.courseId);const nextStats=await fetch('/__optimization-preview/state').then(r=>r.json());if(currentRole.current!==requested)return;setSnapshot(next);setStats(nextStats);if(requested==='student')setRevision(value=>value+1)}catch(e:any){if(currentRole.current===requested)setError(e.message)}}\n function change(next:'qa'|'teacher'|'student'){if(next===role)return;setSnapshot(null);setConfig(null);sessionStorage.setItem('xelay-optimization-preview-role',next);setRole(next)}\n return <main className=\"min-h-screen bg-background text-foreground\"><div className=\"mx-auto max-w-6xl px-5 py-9\"><p className=\"text-xs font-semibold uppercase tracking-widest text-primary\">Xelay · локальна перевірка</p><h1 className=\"mt-3 text-3xl font-semibold\">Збереження відповідей та оцінок</h1><p className=\"mt-3 text-muted-foreground\">Вигадані учасники й окрема локальна база. Пройдіть тест, перевірте роботу, опублікуйте бал і подивіться на результат очима студента.</p>\n <div role=\"tablist\" aria-label=\"Режим локальної перевірки\" className=\"teaching-test-actions my-6\">{Object.entries(labels).map(([id,label])=><TeachingButton key={id} primary={role===id} onClick={()=>change(id as any)}>{label}</TeachingButton>)}</div>\n {stats&&<aside className=\"teaching-note mb-6\" role=\"status\">Попередні оцінки: {stats.old_grade_count}. {stats.old_grade_rows_unchanged&&stats.old_attempts_unchanged?'Збережені без змін.':'ПОТРІБНА ПЕРЕВІРКА ДАНИХ.'} Тестових результатів: {stats.qa_results}.</aside>}{error&&<p role=\"alert\" className=\"teaching-error\">{error}</p>}\n {!snapshot||!config?<p role=\"status\">Завантажуємо локальний приклад…</p>:<section key={role} className=\"teaching-card\"><div className=\"teaching-test-heading\"><div><p className=\"text-sm text-muted-foreground\">{config.actorName} · {config.groupName}</p><h2 className=\"text-xl font-semibold\">{labels[role]}</h2></div><TeachingButton onClick={()=>void refresh()}>Оновити локальні дані</TeachingButton></div>\n {role==='student'?<TeachingGroupTests key={role+':'+revision} repository={tests} courseId={config.courseId} groupId={config.groupId} userId={config.actorId}/>:<><div className=\"teaching-test-actions my-5\"><TeachingButton primary={view==='tests'} onClick={()=>setView('tests')}>Тести та перевірка</TeachingButton>{role==='teacher'&&<TeachingButton primary={view==='journal'} onClick={()=>setView('journal')}>Журнал оцінок</TeachingButton>}</div>\n {view==='journal'?<TeachingGradebook snapshot={snapshot} repository={teaching} userId={config.actorId} onRefresh={refresh} testJournalTarget={target} onDismissTestTarget={()=>setTarget(undefined)}/>:<TeachingTests snapshot={snapshot} repository={tests} teachingRepository={teaching} userId={config.actorId} groupId={config.groupId} onRefresh={refresh} onOpenJournal={value=>{setTarget(value);setView('journal');void refresh()}}/>}</>}</section>}</div></main>\n}\ncreateRoot(document.getElementById('root')!).render(<SeasonalThemePreviewProvider initialTheme=\"light\"><ToastProvider><Preview/></ToastProvider></SeasonalThemePreviewProvider>);")
const server=await createServer({root,configFile:false,envDir:false,envPrefix:'XELAY_UNUSED_PREVIEW_',cacheDir:path.join(directory,'.vite'),
 optimizeDeps:{entries:[path.relative(root,path.join(directory,'index.html'))]},plugins:[react(),{
 name:'xelay-optimization-preview-isolation',enforce:'pre',
 resolveId(source,importer){if(!importer||!source.startsWith('.'))return null;const file=path.resolve(path.dirname(importer.split('?')[0]),source).replaceAll('\\','/');
 return['src/lib/supabase','src/lib/supabase.ts'].some(p=>file===path.join(root,p).replaceAll('\\','/'))?virtual:null},
 load(id){return id===virtual?transport:null},
 configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
 res.setHeader('Content-Security-Policy',"connect-src 'self'; object-src 'none'; frame-src 'none'")
 const url=new URL(req.url||'/',origin);if(!url.pathname.startsWith('/__optimization-preview/'))return next()
 if(req.headers.origin&&req.headers.origin!==origin)return reply(res,403,{error:{message:'PREVIEW_ORIGIN_DENIED'}})
 try{
 if(url.pathname==='/__optimization-preview/state'&&req.method==='GET')return reply(res,200,await serialized(state))
 if(url.pathname==='/__optimization-preview/config'&&req.method==='GET'){
 const role=url.searchParams.get('role'),actor=actors[role];if(!actor)return reply(res,400,{error:{message:'PREVIEW_ROLE_DENIED'}})
 const qa=role==='qa',courseId=qa?qaSeed.course:ids.course,groupId=qa?qaSeed.group:groups[0]
 return reply(res,200,await serialized(async()=>({actorId:actor,actorName:qa?'Навчальний Олег':role==='teacher'?'Прикладенко Олена':'Тестова Марія',
 courseId,groupId,groupName:qa?'ооо 1 · вигаданий приклад':'Група А · навчальний приклад',normalId:normal.definition.id,qaId:qaInput.id,oldId:old.definition.id,
 snapshot:role==='student'?{}:await fx.rpc(actor,'xelay_teaching_course',[courseId]),state:await state()})))}
 if(url.pathname!=='/__optimization-preview/rpc'||req.method!=='POST')return reply(res,404,{error:{message:'PREVIEW_ROUTE_UNKNOWN'}})
 if(!req.headers['content-type']?.startsWith('application/json'))return reply(res,415,{error:{message:'PREVIEW_JSON_REQUIRED'}})
 let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>2*1024*1024)throw Error('PREVIEW_TOO_LARGE')}
 const request=JSON.parse(raw),actor=actors[request.role],keys=signatures[request.name]
 if(!request||Object.keys(request).some(k=>!['role','name','args'].includes(k))||!actor||!keys||!request.args||typeof request.args!=='object'||Array.isArray(request.args)||Object.keys(request.args).some(k=>!keys.includes(k)))throw Error('PREVIEW_RPC_DENIED')
 const values=keys.map(k=>{const v=request.args[k]??null;if(k==='p_activity_ids'){if(!Array.isArray(v)||v.some(id=>typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id)))throw Error('PREVIEW_RPC_DENIED');return'{'+v.join(',')+'}'}
 return v&&typeof v==='object'?JSON.stringify(v):v})
 const metric=request.role+':'+request.name+':'+(request.args.p_action||'');counts[metric]=(counts[metric]||0)+1
 return reply(res,200,{data:await serialized(()=>fx.rpc(actor,request.name,values)),error:null})
 }catch(e){return reply(res,200,{data:null,error:{code:e.code||'',message:e.message}})}
 })},
 }],server:{host:'127.0.0.1',port,strictPort:true,hmr:false,allowedHosts:['127.0.0.1'],watch:{ignored:['**/.security-ci.local/**','**/.git/**']}}})
await server.listen()
console.log(origin+'/.optimization-phase1-preview.local/index.html')
for(const signal of['SIGINT','SIGTERM'])process.on(signal,()=>{void server.close().then(()=>fx.close()).finally(()=>process.exit(0))})
