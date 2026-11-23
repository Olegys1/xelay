import { useEffect, useRef, useState } from 'react'
import { CalendarDays, CheckCheck, Copy, Save } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { AuthModal } from '../components/AuthModal'
import { AdminSecurityGate } from '../components/AdminSecurityGate'
import { PrivacyConsentNotice } from '../components/PrivacyConsentNotice'
import { DeanOnlinePlanner, DeanStaffAccounts, type DeanPlannerApi } from '../components/DeanOnlinePlanner'
import { DeanShell, DeanGuide, type DeanSection } from '../components/DeanShell'
import { supabase } from '../lib/supabase'
import { deanPublicationRows, parseDeanSource, type DeanMapping, type DeanRosterGroup, type DeanSource } from '../lib/deanWorkspace'
import './deanWorkspace.css'

type Document = { source: DeanSource; mapping: DeanMapping; monday: string; rows: ReturnType<typeof deanPublicationRows>; settings?: Record<string,unknown> }
type Draft = { id:string;title:string;revision:number;document:Document;approved_revision:number|null;published_revision:number|null }
const errors: Record<string,string> = {
 DEAN_MFA_REQUIRED:'Підтвердіть другий фактор і оновіть сторінку.',DEAN_ACCESS_DENIED:'Доступ ще не надано. Адміністратор має призначити вам навчальні групи.',DEAN_SCOPE_DENIED:'Немає доступу до однієї з обраних груп.',DEAN_STALE_VERSION:'Чернетка змінилась в іншій вкладці. Відкрийте її знову.',DEAN_APPROVAL_REQUIRED:'Потрібне підтвердження адміністратором саме цієї версії.',DEAN_ROSTER_CHANGED:'Склад груп змінився. Перевірте прив’язку студентів.',DEAN_EXISTING_GROUP_CONFLICT:'Є накладка з чинним розкладом групи. Чинний розклад не змінено.',DEAN_PUBLISHED_CONFLICT:'Є накладка з уже опублікованим розкладом.',DEAN_STUDENT_CONFLICT:'У студента дві пари одночасно.',DEAN_TEACHER_CONFLICT:'У викладача дві пари одночасно.',DEAN_DAY_GAPS_OR_LOAD:'У студента є вікно або день не відповідає умовам 2–4 пари.',DEAN_ROWS_REQUIRED:'Спочатку заповніть дату і прив’язку студентів.',DEAN_LAB_CAPACITY:'Лабораторна група перевищує 18 осіб.'
}
async function call<T>(action:string,payload:Record<string,unknown>={}):Promise<T>{
 const result=await supabase.rpc('xelay_dean_workspace',{p_action:action,p_payload:payload})
 if(result.error)throw Error(errors[result.error.message]??'Не вдалося виконати дію. Дані не опубліковано; перевірте доступ або повторіть спробу.')
 return result.data as T
}
export function DeanWorkspacePage(){
 const {authUser,isLoading,signOut}=useAuth();const [login,setLogin]=useState(false)
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
 if(isLoading)return <main className="dean-workspace">Перевіряємо вхід…</main>
 if(!authUser)return <main className="dean-workspace dean-login"><a href="/">Xelay</a><h1>Кабінет деканату</h1><p>Увійдіть зі службовим логіном та паролем, виданими адміністратором.</p><form onSubmit={e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');void supabase.auth.signInWithPassword({email:email.trim(),password}).then(r=>{if(r.error)setError('Не вдалося увійти. Перевірте логін і пароль.');setPassword('')}).catch(()=>setError('Не вдалося з’єднатися. Спробуйте ще раз.')).finally(()=>setBusy(false))}}><label>Службовий логін<input type="email" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Пароль<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label><button disabled={busy}>{busy?'Входимо…':'Увійти до деканату'}</button>{error&&<p role="alert">{error}</p>}</form><button onClick={()=>setLogin(true)}>Вхід адміністратора Xelay</button>{login&&<AuthModal onClose={()=>setLogin(false)}/>}</main>
 return <AdminSecurityGate required><PrivacyConsentNotice/><DeanWorkspace key={authUser.id} onSignOut={()=>void signOut()}/></AdminSecurityGate>
}
export function DeanWorkspace({rpc=call,plannerApi,onSignOut}:{rpc?:typeof call;plannerApi?:DeanPlannerApi;onSignOut?:()=>void}){
 const [section,setSection]=useState<DeanSection>('schedule')
 const call=rpc
 const [groups,setGroups]=useState<DeanRosterGroup[]>([]),[admin,setAdmin]=useState(false),[allowed,setAllowed]=useState(false)
 const [drafts,setDrafts]=useState<Draft[]>([]),[draft,setDraft]=useState<Draft|null>(null),[source,setSource]=useState<DeanSource|null>(null)
 const [mapping,setMapping]=useState<DeanMapping>({}),[monday,setMonday]=useState(''),[title,setTitle]=useState('Новий розклад')
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[query,setQuery]=useState(''),[review,setReview]=useState<{lessons:number;attendances:number}|null>(null)
 const [confirmation,setConfirmation]=useState(''),[accessUser,setAccessUser]=useState(''),[accessGroup,setAccessGroup]=useState('')
 const alive=useRef(true),lock=useRef(false)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const run=async(fn:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setMessage('');try{await fn()}catch(e){if(alive.current)setMessage(e instanceof Error?e.message:'Не вдалося виконати дію.')}finally{lock.current=false;if(alive.current)setBusy(false)}}
 useEffect(()=>{void run(async()=>{const [c,list]=await Promise.all([call<{groups:DeanRosterGroup[];admin:boolean}>('catalog'),call<Draft[]>('list')]);if(alive.current){setGroups(c.groups);setAdmin(c.admin);setAllowed(true);setDrafts(list);if(list[0]){const initial=await call<Draft>('load',{id:list[0].id});if(alive.current)load(initial)}}})},[])
 const load=(d:Draft)=>{setDraft(d);setSource(parseDeanSource(d.document.source));setMapping(d.document.mapping??{});setMonday(d.document.monday??'');setTitle(d.title);setDirty(false);setReview(null);setConfirmation('')}
 const changed=()=>{setDirty(true);setReview(null);setConfirmation('')}
 const save=()=>run(async()=>{
  if(!source)throw Error('Завантажте розрахунок.')
  let rows:Document['rows']=[];try{rows=deanPublicationRows(source,mapping,monday)}catch{/* Incomplete work may be saved, never published. */}
 const document={source,mapping,monday,rows,...(draft?.document.settings?{settings:draft.document.settings}:{})}
  const d=await call<Draft>(draft?'save':'create',draft?{id:draft.id,revision:draft.revision,document}:{title,document})
  if(alive.current){load(d);setMessage('Чернетку збережено. Студентам нічого не надіслано.');setDrafts(await call<Draft[]>('list'))}
 })
 const activeIds=new Set(source?.events.flatMap(e=>e.studentIds)??[])
 const students=source?.students.filter(s=>activeIds.has(s.id))??[]
 const visible=students.filter(s=>`${s.name} ${s.group}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0,40)
 const mapped=students.filter(s=>mapping[s.id]?.userId).length
 const immutable=!!draft?.published_revision
 return <DeanShell section={section} onSection={setSection} admin={admin} dirty={dirty} onSignOut={onSignOut}><main className="dean-workspace" aria-busy={busy}>

  {message&&<p role="status" className="dean-notice">{message}</p>}
  {!allowed?<p>Перевіряємо призначені групи. Якщо доступ не надано, зверніться до адміністратора Xelay.</p>:<>

  <section className="dean-draftbar" aria-label="Версія розкладу"><div className="dean-controls">
   <label>Версія розкладу<select value={draft?.id??''} disabled={busy} onChange={e=>{const id=e.target.value;if(id)void run(async()=>{const d=await call<Draft>('load',{id});if(alive.current)load(d)})}}><option value="">Оберіть збережену версію</option>{drafts.map(d=><option key={d.id} value={d.id}>{d.title} (версія {d.revision}){d.published_revision?' Опубліковано':''}</option>)}</select></label>

   {draft&&<button disabled={busy} onClick={()=>{setDraft(null);changed();setMessage('Створено робочу копію. Попередня версія збережена.')}}><Copy size={16}/> Створити копію</button>}
   <button className="dean-primary" disabled={busy||immutable||!source||!dirty} onClick={()=>void save()}><Save size={16}/> Зберегти</button>
  </div></section>
  {section==='help'&&<DeanGuide/>}
  {section==='people'&&<details className="dean-panel"><summary>Імпортувати інший розрахунок</summary><label>Файл розрахунку<input type="file" accept=".json,application/json" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)void run(async()=>{if(file.size>8_000_000)throw Error('Максимум 8 МБ.');const s=parseDeanSource(JSON.parse(await file.text()));if(alive.current){setSource(s);setDraft(null);setMapping({});setMonday('');changed()}});e.target.value=''}}/></label></details>}
  {!draft&&source&&<section className="dean-panel"><label>Назва копії<input value={title} onChange={e=>{setTitle(e.target.value);changed()}}/></label><p>Збережіть копію кнопкою вгорі. Початкова версія залишиться на місці.</p></section>}
  {source&&<>
  <div hidden={!['schedule','conditions','variants'].includes(section)}>{draft&&<DeanOnlinePlanner api={plannerApi} view={section==='conditions'?'conditions':section==='variants'?'variants':'schedule'} onViewChange={setSection} key={`${draft.id}:${draft.revision}`} draft={draft} source={source} dirty={dirty} onApply={d=>{load(d);setDrafts(prev=>[d,...prev]);setSection('schedule');setMessage('Новий варіант збережено окремою чернеткою.')}}/>}</div>
  {section==='people'&&<section className="dean-panel dean-view-enter"><h2><CalendarDays/> Студенти та навчальний період</h2><div className="dean-controls"><label>Назва<input value={title} maxLength={160} disabled={!!draft||busy} onChange={e=>{setTitle(e.target.value);changed()}}/></label><label>Перший понеділок семестру<input type="date" value={monday} disabled={immutable||busy} onInput={e=>{setMonday(e.currentTarget.value);changed()}} onChange={e=>{setMonday(e.target.value);changed()}}/></label></div>
  <p>Підключено {mapped} із {students.length} акаунтів. Оберіть акаунт кожного студента перед публікацією в групи.</p>
  {!!source.blockers.length&&<p className="dean-notice">Вихідні таблиці містять {source.blockers.length} зауважень. Перед публікацією потрібно перевірити повноту годин і календар.</p>}
  <label>Знайти студента<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Прізвище або група"/></label>
  <div className="dean-mappings">{visible.map(s=><div key={s.id}><span><strong>{s.name}</strong><small>{s.group}</small></span><select aria-label={`Акаунт ${s.name}`} value={mapping[s.id]?`${mapping[s.id].groupId}:${mapping[s.id].userId}`:''} disabled={busy||immutable} onChange={e=>{const [groupId,userId]=e.target.value.split(':');setMapping(prev=>({...prev,[s.id]:{groupId,userId}}));changed()}}><option value="">Не прив’язано</option>{groups.map(g=><optgroup key={g.id} label={g.name}>{g.members.map(m=><option key={m.id} value={`${g.id}:${m.id}`}>{m.name} (@{m.username})</option>)}</optgroup>)}</select></div>)}</div><small>Показано до 40 рядків. Пошук працює по всьому списку.</small>
  </section>}
  {section==='publication'&&<section className="dean-panel dean-view-enter"><h2><CheckCheck/> Підготувати розклад для студентів</h2><div className="dean-controls"><button disabled={busy||immutable} onClick={()=>void save()}><Save size={16}/> Зберегти чернетку</button><button disabled={busy||dirty||!draft} onClick={()=>void run(async()=>{if(!source) return;deanPublicationRows(source,mapping,monday);const r=await call<{lessons:number;attendances:number}>('review',{id:draft!.id,revision:draft!.revision});if(alive.current)setReview(r)})}>Перевірити публікацію</button></div>
   {review&&<p>{review.lessons} занять перевірено. Версія {draft?.revision}. Студентам ще нічого не опубліковано.</p>}
   {admin&&review&&!immutable&&<><p>Підтвердіть повноту навчальних годин, календар та отримувачів. Введіть «ПІДТВЕРДЖУЮ {draft?.revision}» для погодження саме цієї версії.</p><input aria-label="Підтвердження версії" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/><button disabled={busy||dirty||confirmation!==`ПІДТВЕРДЖУЮ ${draft?.revision}`} onClick={()=>void run(async()=>{const d=await call<Draft>('approve',{id:draft!.id,revision:draft!.revision,confirmation});if(alive.current){setDraft(d);setMessage('Версію погоджено. Тепер можна окремо опублікувати розклад.')}})}>Погодити версію</button></>}
   <button disabled={busy||dirty||!review||immutable||draft?.approved_revision!==draft?.revision} onClick={()=>void run(async()=>{const d=await call<Draft>('publish',{id:draft!.id,revision:draft!.revision});if(alive.current){load(d);setMessage('Розклад опубліковано. Попередні записи розкладу збережені.')}})}>Опублікувати погоджену версію в групи</button>
   <p>Без погодження адміністратора сервер відхиляє публікацію. Кожен студент бачить тільки свої заняття. Опубліковані версії незмінні.</p>
  </section>}</>}
  <div hidden={section!=='access'}>{admin&&<><DeanStaffAccounts draftId={draft?.id} api={plannerApi}/><details className="dean-panel"><summary>Доступ до навчальних груп</summary><p>Службові входи створюються вище. Тут адміністратор окремо визначає групи, в які співробітник зможе готувати публікацію.</p><div className="dean-controls"><label>ID акаунта<input value={accessUser} onChange={e=>setAccessUser(e.target.value)}/></label><label>Група<select value={accessGroup} onChange={e=>setAccessGroup(e.target.value)}><option value="">Оберіть групу</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>{[true,false].map(enabled=><button key={String(enabled)} disabled={busy||!accessGroup||!/^[a-f0-9-]{36}$/i.test(accessUser)} onClick={()=>void run(async()=>{await call('grant',{userId:accessUser,groupId:accessGroup,enabled});if(alive.current)setMessage(enabled?'Доступ до групи надано.':'Доступ до групи відкликано.')})}>{enabled?'Надати доступ':'Відкликати'}</button>)}</div></details></>}
  </div></>}
 </main></DeanShell>
}
