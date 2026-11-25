import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, CheckCheck, Copy, Save } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { AuthModal } from '../components/AuthModal'
import { AdminSecurityGate } from '../components/AdminSecurityGate'
import { PrivacyConsentNotice } from '../components/PrivacyConsentNotice'
import { DeanOnlinePlanner, DeanStaffAccounts, type DeanPlannerApi } from '../components/DeanOnlinePlanner'
import { DeanInputs } from '../components/DeanInputs'
import { DeanShell, DeanGuide, type DeanSection } from '../components/DeanShell'
import { supabase } from '../lib/supabase'
import { deanPublicationRows, parseDeanSource, type DeanMapping, type DeanRosterGroup, type DeanSource } from '../lib/deanWorkspace'
import './deanWorkspace.css'

type Document = { source: DeanSource; planningSource?:DeanSource; mapping: DeanMapping; teacherMapping?:Record<string,string>; monday: string; rows: ReturnType<typeof deanPublicationRows>; settings?: Record<string,unknown> }
type Draft = { id:string;title:string;revision:number;document:Document;approved_revision:number|null;published_revision:number|null;teacher_published_revision?:number|null }
const errors: Record<string,string> = {
 DEAN_TEACHER_MAPPING_REQUIRED:'Прив’яжіть усіх викладачів до їхніх акаунтів Xelay.',DEAN_DATE_INVALID:'Вкажіть перший понеділок семестру.',DEAN_MAIN_IMMUTABLE:'Основний розклад захищено. Створіть робочу копію.',DEAN_MAIN_REQUIRED:'Спочатку оберіть цю версію основною в деканаті.',DEAN_INPUTS_NOT_CALCULATED:'Вхідні дані змінились. Розрахуйте й підтвердіть новий варіант.',DEAN_ROOM_INELIGIBLE:'Аудиторія не відповідає заняттю або недоступна.',DEAN_ROOM_CONFLICT:'В аудиторії дві пари одночасно.',DEAN_PROJECTION_MISMATCH:'Отримувачі не відповідають основному розкладу. Підготуйте відправку знову.',DEAN_MFA_REQUIRED:'Підтвердіть другий фактор і оновіть сторінку.',DEAN_ACCESS_DENIED:'Доступ ще не надано. Адміністратор має призначити вам навчальні групи.',DEAN_SCOPE_DENIED:'Немає доступу до однієї з обраних груп.',DEAN_STALE_VERSION:'Чернетка змінилась в іншій вкладці. Відкрийте її знову.',DEAN_APPROVAL_REQUIRED:'Потрібне підтвердження адміністратором саме цієї версії.',DEAN_ROSTER_CHANGED:'Склад груп змінився. Перевірте прив’язку студентів.',DEAN_EXISTING_GROUP_CONFLICT:'Є накладка з чинним розкладом групи. Чинний розклад не змінено.',DEAN_PUBLISHED_CONFLICT:'Є накладка з уже опублікованим розкладом.',DEAN_STUDENT_CONFLICT:'У студента дві пари одночасно.',DEAN_TEACHER_CONFLICT:'У викладача дві пари одночасно.',DEAN_DAY_GAPS_OR_LOAD:'У студента є вікно або день не відповідає умовам 2–4 пари.',DEAN_ROWS_REQUIRED:'Спочатку заповніть дату і прив’язку студентів.',DEAN_LAB_CAPACITY:'Лабораторна група перевищує 18 осіб.'
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
 const [teacherAccounts,setTeacherAccounts]=useState<{id:string;name:string}[]>([]),[teacherMapping,setTeacherMapping]=useState<Record<string,string>>({}),[teacherConfirmation,setTeacherConfirmation]=useState('')
 const [mapping,setMapping]=useState<DeanMapping>({}),[monday,setMonday]=useState(''),[title,setTitle]=useState('Новий розклад')
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[query,setQuery]=useState(''),[review,setReview]=useState<{lessons:number;attendances:number}|null>(null)
 const [confirmation,setConfirmation]=useState(''),[accessUser,setAccessUser]=useState(''),[accessGroup,setAccessGroup]=useState('')
 const [planningSource,setPlanningSource]=useState<DeanSource|undefined>(),[settings,setSettings]=useState<Record<string,unknown>|undefined>(),[mainState,setMainState]=useState<any>(null),[mainConfirmation,setMainConfirmation]=useState('')
 const [accessOpened,setAccessOpened]=useState(false)
 const alive=useRef(true),lock=useRef(false)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const run=async(fn:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setMessage('');try{await fn()}catch(e){if(alive.current)setMessage(e instanceof Error?e.message:'Не вдалося виконати дію.')}finally{lock.current=false;if(alive.current)setBusy(false)}}
 useEffect(()=>{void run(async()=>{const initial=await call<{admin:boolean;drafts:Draft[];draft:Draft|null}>('bootstrap');if(alive.current){setAdmin(initial.admin);setAllowed(true);setDrafts(initial.drafts);if(initial.draft)load(initial.draft)}})},[])
 const load=(d:Draft)=>{setDraft(d);setPlanningSource(d.document.planningSource?parseDeanSource(d.document.planningSource,false):undefined);setSettings(d.document.settings);setMainConfirmation('');setSource(parseDeanSource(d.document.source));setMapping(d.document.mapping??{});setMonday(d.document.monday??'');setTitle(d.title);setTeacherMapping(d.document.teacherMapping??{});setTeacherConfirmation('');setDirty(false);setReview(null);setConfirmation('')}
 useEffect(()=>{let active=true;setMainState(null);if(draft)void call<any>(section==='main'?'main':'main_summary',{id:draft.id}).then(value=>{if(active)setMainState(value)}).catch(()=>{if(active)setMessage('Не вдалося прочитати основний розклад. Оновіть сторінку.')});return()=>{active=false}},[draft?.id,draft?.revision,section==='main'])
 useEffect(()=>{let active=true;if(allowed&&(section==='people'||section==='access'))void call<{groups:DeanRosterGroup[]}>('catalog').then(value=>{if(active)setGroups(value.groups)}).catch(()=>{if(active)setMessage('Не вдалося завантажити список груп.')});return()=>{active=false}},[allowed,section])
 useEffect(()=>{if(section==='access')setAccessOpened(true)},[section])
 useEffect(()=>{let active=true;if(admin&&section==='people')void call<{id:string;name:string}[]>('teacher_catalog').then(rows=>{if(active)setTeacherAccounts(rows)}).catch(()=>{if(active)setMessage('Не вдалося завантажити акаунти викладачів.')});return()=>{active=false}},[admin,section])
 const changed=()=>{setDirty(true);setReview(null);setConfirmation('');setTeacherConfirmation('')}
 const save=()=>run(async()=>{
  if(!source)throw Error('Завантажте розрахунок.')
  let rows:Document['rows']=[];try{rows=deanPublicationRows(source,mapping,monday)}catch{/* Incomplete work may be saved, never published. */}
 const document={source:parseDeanSource(source),mapping,teacherMapping,monday,rows,...(settings?{settings}:{}),...(planningSource?{planningSource:parseDeanSource(planningSource,false)}:{})}
  const d=await call<Draft>(draft?'save':'create',draft?{id:draft.id,revision:draft.revision,document}:{title,document})
  if(alive.current){load(d);setMessage('Чернетку збережено. Студентам нічого не надіслано.');setDrafts(await call<Draft[]>('list'))}
 })
 const students=useMemo(()=>{const ids=new Set(source?.events.flatMap(e=>e.studentIds)??[]);return source?.students.filter(s=>ids.has(s.id))??[]},[source])
 const visible=students.filter(s=>`${s.name} ${s.group}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0,40)
 const mapped=students.filter(s=>mapping[s.id]?.userId).length
 const immutable=!!draft?.published_revision
 const teacherPublished=!!draft?.teacher_published_revision
 const teachers=useMemo(()=>Array.from(new Map((source?.events??[]).flatMap(e=>e.teacherIds.map(id=>[id,e.teacher||id] as const))).entries()),[source])
 const mainSource=useMemo(()=>mainState?.main?.document?parseDeanSource(mainState.main.document.source):null,[mainState])
 const isMain=!!draft&&mainState?.main?.draft_id===draft.id
 const fork=()=>run(async()=>{if(!draft)return;const d=await call<Draft>('fork',{id:draft.id,revision:draft.revision});if(alive.current){load(d);setDrafts(await call<Draft[]>('list'));setSection('inputs');setMessage('Робочу копію збережено. Основний розклад не змінено.')}})
 return <DeanShell section={section} onSection={setSection} admin={admin} dirty={dirty} onSignOut={onSignOut}><main className="dean-workspace" aria-busy={busy}>

  {message&&<p role="status" className="dean-notice">{message}</p>}
  {!allowed?<p>Перевіряємо призначені групи. Якщо доступ не надано, зверніться до адміністратора Xelay.</p>:<>

  <section className="dean-draftbar" aria-label="Версія розкладу"><div className="dean-controls">
   <label>Версія розкладу<select value={draft?.id??''} disabled={busy} onChange={e=>{const id=e.target.value;if(id)void run(async()=>{const d=await call<Draft>('load',{id});if(alive.current)load(d)})}}><option value="">Оберіть збережену версію</option>{drafts.map(d=><option key={d.id} value={d.id}>{d.title} (версія {d.revision}){d.published_revision?' Опубліковано':''}</option>)}</select></label>

   {draft&&<button disabled={busy} onClick={()=>void fork()}><Copy size={16}/> Створити копію</button>}
   <button className="dean-primary" disabled={busy||immutable||!source||!dirty} onClick={()=>void save()}><Save size={16}/> Зберегти</button>
  </div></section>
  <nav className="dean-workflow" aria-label="Етапи роботи">{[['inputs','Вхідні дані'],['schedule','Чернетка'],['main','Основний розклад'],['publication','Відправка']].map(([id,label],i)=><button key={id} aria-current={section===id?'step':undefined} onClick={()=>setSection(id as DeanSection)}><span>{i+1}</span>{label}</button>)}</nav>
  {planningSource&&<p className="dean-notice">Вхідні дані змінені. Збережіть їх і запустіть розрахунок. Календар поки показує останній підтверджений варіант.</p>}
  {section==='help'&&<DeanGuide/>}
  {section==='inputs'&&source&&<DeanInputs source={planningSource??source} disabled={isMain||immutable||busy} onChange={s=>{setPlanningSource(s);changed()}}/>}
  {section==='inputs'&&source&&<button className="dean-primary" onClick={()=>setSection('conditions')}>Далі: умови та розрахунок</button>}
  {section==='main'&&<section className="dean-panel dean-view-enter"><h2>Основний розклад деканату</h2>{mainState?.main?<><p>{mainState.main.title} · версія {mainState.main.revision}. Збережено {new Date(mainState.main.selected_at).toLocaleString('uk-UA')}.</p><p>Це внутрішній розклад деканату. Статус відправки студентам перевіряється окремо.</p>{mainSource&&<DeanOnlinePlanner key={`main-${mainState.main.draft_id}-${mainState.main.revision}`} api={plannerApi} draft={{id:mainState.main.draft_id,revision:mainState.main.revision,document:mainState.main.document}} source={mainSource} dirty={false} onApply={()=>{}} readOnly/>}</>:<p>Основний розклад ще не обрано. Збережені чернетки залишаються доступними.</p>}
   {draft&&mainState?.canSelect&&!isMain&&<><h3>Зробити відкриту чернетку основною</h3><p>{draft.title} · версія {draft.revision}. Це замінить лише внутрішній основний варіант; попередні чернетки збережуться.</p><label>Введіть «ОСНОВНИЙ {draft.revision}»<input value={mainConfirmation} onChange={e=>setMainConfirmation(e.target.value)}/></label><button className="dean-primary" disabled={busy||dirty||!!planningSource||mainConfirmation!==`ОСНОВНИЙ ${draft.revision}`} onClick={()=>void run(async()=>{await call('make_main',{id:draft.id,revision:draft.revision,mainVersion:mainState?.main?.version??0,confirmation:mainConfirmation});if(alive.current){setMainState(await call('main',{id:draft.id}));setMainConfirmation('');setMessage('Основний розклад збережено в деканаті. На платформу нічого не відправлено.')}})}>Підтвердити основний розклад</button></>}
  </section>}
  {section==='inputs'&&<details className="dean-panel"><summary>Імпортувати інший розрахунок</summary><label>Файл розрахунку<input type="file" accept=".json,application/json" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)void run(async()=>{if(file.size>8_000_000)throw Error('Максимум 8 МБ.');const s=parseDeanSource(JSON.parse(await file.text()));if(alive.current){setSource(s);setPlanningSource(undefined);setSettings(undefined);setDraft(null);setMapping({});setTeacherMapping({});setMonday('');changed()}});e.target.value=''}}/></label></details>}
  {!draft&&source&&<section className="dean-panel"><label>Назва копії<input value={title} onChange={e=>{setTitle(e.target.value);changed()}}/></label><p>Збережіть копію кнопкою вгорі. Початкова версія залишиться на місці.</p></section>}
  {source&&<>
  <div hidden={!['schedule','conditions','variants'].includes(section)}>{draft&&<DeanOnlinePlanner api={plannerApi} view={section==='conditions'?'conditions':section==='variants'?'variants':'schedule'} onViewChange={setSection} onSettings={isMain||immutable?undefined:value=>{setSettings(value);changed()}} key={`${draft.id}:${draft.revision}`} draft={draft} source={source} dirty={dirty} onApply={d=>{load(d);setDrafts(prev=>[d,...prev]);setSection('schedule');setMessage('Новий варіант збережено окремою чернеткою.')}}/>}</div>
  {section==='people'&&<section className="dean-panel dean-view-enter"><h2><CalendarDays/> Студенти та навчальний період</h2><div className="dean-controls"><label>Назва<input value={title} maxLength={160} disabled={!!draft||busy} onChange={e=>{setTitle(e.target.value);changed()}}/></label><label>Перший понеділок семестру<input type="date" value={monday} disabled={immutable||teacherPublished||busy} onInput={e=>{setMonday(e.currentTarget.value);changed()}} onChange={e=>{setMonday(e.target.value);changed()}}/></label></div>
  <p>Підключено {mapped} із {students.length} акаунтів. Оберіть акаунт кожного студента перед публікацією в групи.</p>
  {!!source.blockers.length&&<p className="dean-notice">Вихідні таблиці містять {source.blockers.length} зауважень. Перед публікацією потрібно перевірити повноту годин і календар.</p>}
  <label>Знайти студента<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Прізвище або група"/></label>
  <div className="dean-mappings">{visible.map(s=><div key={s.id}><span><strong>{s.name}</strong><small>{s.group}</small></span><select aria-label={`Акаунт ${s.name}`} value={mapping[s.id]?`${mapping[s.id].groupId}:${mapping[s.id].userId}`:''} disabled={busy||immutable} onChange={e=>{const [groupId,userId]=e.target.value.split(':');setMapping(prev=>({...prev,[s.id]:{groupId,userId}}));changed()}}><option value="">Не прив’язано</option>{groups.map(g=><optgroup key={g.id} label={g.name}>{g.members.map(m=><option key={m.id} value={`${g.id}:${m.id}`}>{m.name} (@{m.username})</option>)}</optgroup>)}</select></div>)}</div><small>Показано до 40 рядків. Пошук працює по всьому списку.</small>
  {admin&&<><h3>Акаунти викладачів</h3><p>Прив’язка потрібна тільки для окремої відправки викладачам. Їхні заняття з’являться в розділі «Викладання».</p><div className="dean-mappings">{teachers.map(([id,name])=><div key={id}><strong>{name}</strong><select aria-label={`Акаунт викладача ${name}`} value={teacherMapping[id]??''} disabled={busy||immutable||teacherPublished} onChange={e=>{setTeacherMapping(prev=>({...prev,[id]:e.target.value}));changed()}}><option value="">Не прив’язано</option>{teacherAccounts.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></div>)}</div></>}
  </section>}
  {section==='publication'&&<section className="dean-panel dean-view-enter"><h2><CheckCheck/> Відправити основний розклад на платформу</h2>{!isMain&&<p className="dean-notice">Спочатку оберіть цю чернетку основною в розділі «Основний розклад».</p>}<div className="dean-controls"><button disabled={busy||immutable} onClick={()=>void save()}><Save size={16}/> Зберегти чернетку</button><button disabled={busy||dirty||!draft||!isMain} onClick={()=>void run(async()=>{if(!source) return;deanPublicationRows(source,mapping,monday);const r=await call<{lessons:number;attendances:number}>('review',{id:draft!.id,revision:draft!.revision});if(alive.current)setReview(r)})}>Перевірити публікацію</button></div>
   {review&&<p>{review.lessons} занять перевірено. Версія {draft?.revision}. Студентам ще нічого не опубліковано.</p>}
   {admin&&review&&!immutable&&<><p>Підтвердіть повноту навчальних годин, календар та отримувачів. Введіть «ПІДТВЕРДЖУЮ {draft?.revision}» для погодження саме цієї версії.</p><input aria-label="Підтвердження версії" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/><button disabled={busy||dirty||confirmation!==`ПІДТВЕРДЖУЮ ${draft?.revision}`} onClick={()=>void run(async()=>{const d=await call<Draft>('approve',{id:draft!.id,revision:draft!.revision,confirmation});if(alive.current){setDraft(d);setMessage('Версію погоджено. Тепер можна окремо опублікувати розклад.')}})}>Погодити версію</button></>}
   <button disabled={busy||dirty||!isMain||!review||immutable||draft?.approved_revision!==draft?.revision} onClick={()=>void run(async()=>{const d=await call<Draft>('publish',{id:draft!.id,revision:draft!.revision});if(alive.current){load(d);setMessage('Розклад опубліковано. Попередні записи розкладу збережені.')}})}>Опублікувати погоджену версію в групи</button>
   {admin&&draft&&<div className="dean-panel"><h3>Окрема відправка викладачам</h3>{teacherPublished?<p>Викладачам уже відправлено версію {draft.teacher_published_revision}.</p>:<><p>Спочатку збережіть дату семестру та акаунти викладачів у «Отримувачі». Перевірте повноту годин. Це відкриє викладачам лише їхні заняття.</p><label>Введіть «ВИКЛАДАЧАМ {draft.revision}»<input value={teacherConfirmation} onChange={e=>setTeacherConfirmation(e.target.value)}/></label><button disabled={busy||dirty||!isMain||!!planningSource||teacherConfirmation!==`ВИКЛАДАЧАМ ${draft.revision}`} onClick={()=>void run(async()=>{const result=await call<{lessons:number}>('teacher_publish',{id:draft.id,revision:draft.revision,confirmation:teacherConfirmation});if(alive.current){load(await call<Draft>('load',{id:draft.id}));setMessage(`Викладачам надіслано ${result.lessons} занять. Відправка студентам виконується окремо.`)}})}>Підтвердити відправку викладачам</button></>}</div>}
   <p>Без погодження адміністратора сервер відхиляє публікацію. Кожен студент бачить тільки свої заняття. Опубліковані версії незмінні.</p>
  </section>}</>}
  <div hidden={section!=='access'}>{admin&&accessOpened&&<><DeanStaffAccounts draftId={draft?.id} api={plannerApi}/><details className="dean-panel"><summary>Доступ до навчальних груп</summary><p>Службові входи створюються вище. Тут адміністратор окремо визначає групи, в які співробітник зможе готувати публікацію.</p><div className="dean-controls"><label>ID акаунта<input value={accessUser} onChange={e=>setAccessUser(e.target.value)}/></label><label>Група<select value={accessGroup} onChange={e=>setAccessGroup(e.target.value)}><option value="">Оберіть групу</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>{[true,false].map(enabled=><button key={String(enabled)} disabled={busy||!accessGroup||!/^[a-f0-9-]{36}$/i.test(accessUser)} onClick={()=>void run(async()=>{await call('grant',{userId:accessUser,groupId:accessGroup,enabled});if(alive.current)setMessage(enabled?'Доступ до групи надано.':'Доступ до групи відкликано.')})}>{enabled?'Надати доступ':'Відкликати'}</button>)}</div></details></>}
  </div></>}
 </main></DeanShell>
}
