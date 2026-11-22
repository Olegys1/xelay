import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { DEAN_ACTIVITY_LABELS, DEAN_TIMES, type DeanSource } from '../lib/deanWorkspace'

export const DEAN_DEFAULTS={days:[1,2,3,4,5],firstPeriod:1,lastPeriod:6,minDaily:2,maxDaily:4,zeroGaps:true,fiveDays:true,lowLoadException:true,teacherCompact:true,avoidLate:false,blocked:[] as {teacher:string;day:number;period:number}[]}
const days=['','Понеділок','Вівторок','Середа','Четвер','П’ятниця']
export async function deanOnline(action:string,payload:Record<string,unknown>={}){
 const {data,error}=await supabase.rpc('xelay_dean_online',{p_action:action,p_payload:payload})
 if(error)throw Error(({DEAN_STALE_VERSION:'Чернетка змінилася. Відкрийте її знову.',DEAN_CALC_BUSY:'Дочекайтеся завершення поточного розрахунку.',DEAN_JOB_DENIED:'Немає доступу до результату.'} as Record<string,string>)[error.message]||'Дію відхилено. Перевірте доступ і другий фактор.')
 return data
}
export async function deanServer(body:Record<string,unknown>){
 const {data:{session}}=await supabase.auth.getSession()
 if(!session)throw Error('Увійдіть до кабінету.')
 const response=await fetch('/api/dean',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify(body),cache:'no-store'})
 const result=await response.json()
 if(!response.ok)throw Error(result.error||'Не вдалося виконати дію. Чернетку збережено.')
 return result
}
export function DeanOnlinePlanner({draft,source,dirty,onApply}:{draft:any;source:DeanSource;dirty:boolean;onApply:(draft:any)=>void}){
 const [cfg,setCfg]=useState({...DEAN_DEFAULTS,...draft.document.settings}),[mode,setMode]=useState('student'),[person,setPerson]=useState(''),[week,setWeek]=useState(1)
 const [selected,setSelected]=useState(''),[day,setDay]=useState(1),[period,setPeriod]=useState(1),[blockedTeacher,setBlockedTeacher]=useState('')
 const [jobs,setJobs]=useState<any[]>([]),[result,setResult]=useState<any>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
 const alive=useRef(true),locked=useRef(false)
 const teachers=useMemo(()=>Array.from(new Map(source.events.flatMap(e=>e.teacherIds.map(id=>[id,{id,name:e.teacher||id}] as const))).values()),[source])
 const people=mode==='student'?source.students:teachers
 const current=people.some(p=>p.id===person)?person:people[0]?.id
 const events=source.events.filter(e=>e.weeks.includes(week)&&(mode==='student'?e.studentIds:e.teacherIds).includes(current))
 const running=jobs.some(j=>j.state==='running')
 const refresh=async()=>{const value=await deanOnline('jobs');if(alive.current)setJobs(value)}
 useEffect(()=>{alive.current=true;void refresh().catch(()=>{});return()=>{alive.current=false}},[])
 useEffect(()=>{if(!busy&&!running)return;const id=setInterval(()=>void refresh().catch(()=>{}),5000);return()=>clearInterval(id)},[busy,running])
 const act=async(fn:()=>Promise<void>)=>{if(locked.current)return;locked.current=true;setBusy(true);setMessage('');try{await fn()}catch(e){if(alive.current)setMessage(e instanceof Error?e.message:'Не вдалося виконати дію.')}finally{locked.current=false;if(alive.current){setBusy(false);void refresh().catch(()=>{})}}}
 const calculate=(move:boolean)=>act(async()=>{
  setResult(null);setMessage(move?'Шукаємо перенесення з найменшою кількістю пов’язаних змін…':'Рахуємо інші варіанти за обраними умовами…')
  const response=await deanServer({action:'calculate',draftId:draft.id,revision:draft.revision,settings:cfg,...(move?{target:{event:selected,day,period}}:{})})
  const saved=await deanOnline('result',{id:response.job});if(alive.current){setResult(saved);setMessage(saved.result?.note||'Розрахунок завершено.')}
 })
 return <section className="dean-panel dean-planner"><div className="dean-planner-heading"><div><span className="dean-eyebrow">ОНЛАЙН-ПЛАНУВАННЯ</span><h2>Один розклад. Більше вдалих рішень.</h2></div><span className="dean-status">Початкова версія збережена</span></div>
 <details className="dean-settings" open><summary>Умови та побажання</summary><div className="dean-controls">
 {(['firstPeriod','lastPeriod','minDaily','maxDaily'] as const).map((key,i)=><label key={key}>{['Перша доступна пара','Остання доступна пара','Мінімум пар на день','Максимум пар на день'][i]}<select value={cfg[key]} onChange={e=>setCfg({...cfg,[key]:Number(e.target.value)})}>{[1,2,3,4,5,6].map(n=><option key={n}>{n}</option>)}</select></label>)}
 </div><div className="dean-toggles">{days.slice(1).map((name,i)=><label key={name}><input type="checkbox" checked={cfg.days.includes(i+1)} onChange={e=>setCfg({...cfg,days:e.target.checked?[...cfg.days,i+1].sort():cfg.days.filter(d=>d!==i+1)})}/>{name}</label>)}</div>
 <div className="dean-toggles">{(['zeroGaps','fiveDays','lowLoadException','teacherCompact','avoidLate'] as const).map((key,i)=><label key={key}><input type="checkbox" checked={cfg[key]} onChange={e=>setCfg({...cfg,[key]:e.target.checked})}/>{['Без вікон у студентів','Зайняті всі обрані дні','3–4 дні для навантаження менше 10 пар','Менше вікон викладачів','Надавати перевагу раннім парам'][i]}</label>)}</div>
 <details><summary>Недоступність викладачів</summary><div className="dean-controls"><label>Викладач<select value={blockedTeacher} onChange={e=>setBlockedTeacher(e.target.value)}><option value="">Оберіть</option>{teachers.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label>День<select value={day} onChange={e=>setDay(+e.target.value)}>{days.slice(1).map((d,i)=><option key={d} value={i+1}>{d}</option>)}</select></label><label>Пара<select value={period} onChange={e=>setPeriod(+e.target.value)}>{[1,2,3,4,5,6].map(n=><option key={n}>{n}</option>)}</select></label><button disabled={!blockedTeacher||cfg.blocked.length>=200} onClick={()=>setCfg({...cfg,blocked:[...cfg.blocked,{teacher:blockedTeacher,day,period}]})}>Додати обмеження</button></div>{cfg.blocked.map((b,i)=><p key={i}>{teachers.find(t=>t.id===b.teacher)?.name} · {days[b.day]}, {b.period} пара <button onClick={()=>setCfg({...cfg,blocked:cfg.blocked.filter((_,j)=>i!==j)})}>Прибрати</button></p>)}</details>
 </details>
 <button disabled={busy||running||dirty||!cfg.days.length} onClick={()=>void calculate(false)}>{busy||running?'Розрахунок триває…':'Запропонувати інші варіанти'}</button>{dirty&&<p>Спочатку збережіть зміни чернетки.</p>}<p>Години, студенти, викладачі та кількість потоків залишаються тими самими. Змінюються тільки дні й час.</p>
 <div className="dean-controls"><label>Перегляд<select value={mode} onChange={e=>{setMode(e.target.value);setPerson('')}}><option value="student">Студенти</option><option value="teacher">Викладачі</option></select></label><label>Студент або викладач<select value={current} onChange={e=>setPerson(e.target.value)}>{people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Тиждень<select value={week} onChange={e=>setWeek(+e.target.value)}>{Array.from({length:Math.max(...source.events.flatMap(e=>e.weeks))},(_,i)=><option key={i} value={i+1}>{i+1}</option>)}</select></label></div>
 <div className="dean-week">{days.slice(1).map((name,d)=><section key={name}><h3>{name}</h3>{[1,2,3,4,5,6].map(p=><div className="dean-slot" key={p}><small>{p} · {DEAN_TIMES[p-1][0]}</small>{events.filter(e=>e.day===d+1&&e.period===p).map(e=><button key={e.id} aria-pressed={selected===e.id} onClick={()=>{setSelected(e.id);setDay(e.day);setPeriod(e.period)}}><small>{DEAN_ACTIVITY_LABELS[e.activity]}</small><strong>{e.course}</strong><small>{e.teacher||'Не призначено'}</small></button>)}</div>)}</section>)}</div>
 {selected&&<div className="dean-move"><h3>Перенести: {source.events.find(e=>e.id===selected)?.course}</h3><div className="dean-controls"><label>Новий день<select value={day} onChange={e=>setDay(+e.target.value)}>{days.slice(1).map((name,i)=><option key={name} value={i+1}>{name}</option>)}</select></label><label>Нова пара<select value={period} onChange={e=>setPeriod(+e.target.value)}>{[1,2,3,4,5,6].map(n=><option key={n}>{n}</option>)}</select></label><button disabled={busy||running||dirty} onClick={()=>void calculate(true)}>Підібрати пов’язані перенесення</button><button onClick={()=>setSelected('')}>Скасувати вибір</button></div></div>}
 {message&&<p role="status" className="dean-notice">{message}</p>}
 {result?.result?.options?.map((o:any,i:number)=><article className="dean-option" key={i}><h3>Варіант {i+1}</h3><p>{o.changes.length} змін · вікон у студентів: {o.report.metrics.studentGaps} · накладок: {o.report.metrics.conflicts} · вікон викладачів: {o.report.metrics.teacherGaps}</p><details><summary>Що саме зміниться</summary>{o.changes.map((c:any)=><p key={c.id}>{c.course} · {c.teacher}: {days[c.from[0]]}, {c.from[1]} → {days[c.to[0]]}, {c.to[1]} пара</p>)}</details><button disabled={busy} onClick={()=>void act(async()=>{const d=await deanOnline('apply',{id:result.id,option:i});if(alive.current)onApply(d)})}>Відкрити як нову чернетку</button><small>Це не публікація студентам.</small></article>)}
 <details><summary>Останні розрахунки — збережені онлайн</summary>{jobs.map(j=><div key={j.id}><span>{new Date(j.created_at).toLocaleString('uk-UA')} · {({running:'Розрахунок триває',done:'Готово',failed:'Рішення не знайдено',interrupted:'Перервано — можна запустити знову'} as any)[j.state]}</span><button disabled={busy||j.state==='running'||j.state==='interrupted'} onClick={()=>void act(async()=>{const r=await deanOnline('result',{id:j.id});if(alive.current)setResult(r)})}>Переглянути</button></div>)}</details>
 </section>
}

export function DeanStaffAccounts({draftId}:{draftId?:string}){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[credentials,setCredentials]=useState<any[]>([]),[staff,setStaff]=useState<any[]>([])
 const lock=useRef(false)
 useEffect(()=>{let active=true;void deanOnline('staff_list').then(r=>{if(active)setStaff(r)}).catch(()=>{});return()=>{active=false}},[])
 async function create(){if(lock.current)return;lock.current=true;setBusy(true);setMessage('');try{const r=await deanServer({action:'create_staff',count:5,draftId});setCredentials(r.credentials);setMessage(r.complete?'Створено 5 окремих входів. Збережіть паролі зараз: повторно вони не відображатимуться.':'Створено частину акаунтів. Збережіть показані паролі.');setStaff(await deanOnline('staff_list'))}catch(e){setMessage(e instanceof Error?e.message:'Не вдалося створити акаунти.')}finally{lock.current=false;setBusy(false)}}
 return <details className="dean-panel"><summary>Службові входи деканату</summary><p>Окремі логіни у форматі email, без поштової скриньки. Пароль показується один раз. Перший вхід потребує налаштування другого фактора. Відкрита чернетка надається для читання; розрахунок створює особисту копію.</p><button disabled={busy||credentials.length>0} onClick={()=>void create()}>Створити 5 службових входів</button>{message&&<p role="status">{message}</p>}{credentials.length>0&&<div className="dean-credentials"><button onClick={()=>{const text=credentials.map(c=>`${c.label}\nЛогін: ${c.login}\nПароль: ${c.password}`).join('\n\n');const url=URL.createObjectURL(new Blob(['Xelay · https://www.xelay.ink/dean\n\n'+text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='xelay-dean-access.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>Завантажити логіни та паролі</button>{credentials.map(c=><div key={c.login}><strong>{c.label}</strong><p>{c.login}</p><code>{c.password}</code></div>)}<button onClick={()=>setCredentials([])}>Приховати паролі</button></div>}{staff.map(s=><p key={s.user_id}>{s.label} · {s.login} · {s.enabled?'Активний':'Вимкнений'}{s.enabled&&<button disabled={busy} onClick={()=>{setBusy(true);void deanOnline('staff_disable',{userId:s.user_id}).then(()=>deanOnline('staff_list')).then(setStaff).catch(()=>setMessage('Не вдалося відкликати доступ.')).finally(()=>setBusy(false))}}>Відкликати доступ</button>}</p>)}</details>
}
