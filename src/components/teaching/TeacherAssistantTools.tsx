import { useEffect, useRef, useState } from 'react'
import { Bell, Check, Clock3, RefreshCw, X } from 'lucide-react'
import type { TeacherLearningClient, TeacherLearningDraft } from '../../lib/teacherLearningClient'
import type { TeacherInsights, TeacherInsightsScope, TeacherReminder, TeacherTestConditions } from '../../lib/teacherAssistantTools'
import { kyivDeadline, localDeadline } from '../../lib/teaching'

const date = (value: string) => new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
export function TeacherInsightsPanel({ client, scope, onRemind }: { client: TeacherLearningClient; scope: TeacherInsightsScope; onRemind(title: string): void }) {
 const [data,setData]=useState<TeacherInsights|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0)
 useEffect(()=>{const controller=new AbortController();setLoading(true);setData(null);setError('')
  client.insights?.(scope,controller.signal).then(result=>{if(!controller.signal.aborted)setData(result)}).catch(e=>{if(!controller.signal.aborted)setError(e.message)}).finally(()=>{if(!controller.signal.aborted)setLoading(false)})
  return()=>controller.abort()
 },[client,scope.courseId,scope.groupIds.join(','),scope.testId,refresh])
 return <section className="tla-insights" aria-label="Актуальна статистика">
  <div className="tla-tool-section-heading"><h4>Що відбувається у групах</h4><button type="button" disabled={loading} onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={14}/>Оновити дані</button></div>
  {loading&&<p role="status">Звіряю актуальні дані…</p>}{error&&<p role="alert">{error}</p>}
  {data&&<><small>Перевірено {date(data.checkedAt)} · час Києва</small><div className="tla-insight-cards">{data.groups.map(g=><article key={g.id}><strong>{g.name}</strong><dl><div><dt>У журналі</dt><dd>{g.students} студентів</dd></div><div><dt>Опублікованих оцінок</dt><dd>{g.publishedGrades}</dd></div><div><dt>Середній результат</dt><dd>{g.averagePercent===null?'Ще немає':g.averagePercent+'%'}</dd></div><div><dt>Чекають перевірки</dt><dd>{g.pendingReviews}</dd></div></dl>
   {g.pendingReviews>0&&<button type="button" onClick={()=>onRemind('Перевірити роботи · '+g.name)}><Bell size={13}/>Нагадати перевірити</button>}
   {g.upcoming.length>0&&<details><summary>Дедлайни наступних 7 днів · {g.upcoming.length}</summary>{g.upcoming.map((x,i)=><p key={i}>{x.title} · {date(x.dueAt)} <button type="button" onClick={()=>onRemind(x.title)}>Нагадати</button></p>)}</details>}
  </article>)}</div>
  {data.test&&!data.test.ready&&<p className="tla-notice">Тест ще триває або є активні спроби. Детальний розбір відкриється після завершення.</p>}
  {data.test?.ready&&<><h4>{data.test.title} · здано {data.test.submitted}</h4><div className="tla-table-scroll"><table><thead><tr><th>Запитання</th><th>Втратили бали</th><th>Ще перевірити</th></tr></thead><tbody>{data.questions.map((q,i)=><tr key={q.key}><td><small>{q.key}</small><br/>{i+1}. {q.text}</td><td>{q.mistakes} / {q.responses}</td><td>{q.pendingReview}</td></tr>)}</tbody></table></div>
  <details><summary>Кому й що пояснити · {data.learners.length} студентів</summary><div className="tla-table-scroll"><table><thead><tr><th>Студент</th><th>Запитання для повторення</th><th>Очікують перевірки</th></tr></thead><tbody>{data.learners.map(s=><tr key={s.code+s.groupId}><td>{s.name}<br/><small>{s.code}</small></td><td>{s.weak.length?s.weak.map(key=>{const i=data.questions.findIndex(q=>q.key===key);return i>=0?'№'+(i+1):key}).join(', '):'Без втрати балів у перевірених відповідях'}</td><td>{s.pendingReview}</td></tr>)}</tbody></table></div></details></>}
  <p className="tla-privacy">{data.notice} Аналіз ШІ — рекомендація. Імена не передаються моделі; для великих тестів вона бачить до 100 студентів із найбільшою кількістю помилок, таблиця — до 500. Перелік запитань показує до 80 найскладніших; для ШІ обсяг додатково обмежено, про це вказано в аналізі.</p></>}
 </section>
}
export function TeacherRemindersPanel({ client, initialTitle='', onClose }: { client: TeacherLearningClient; initialTitle?: string; onClose(): void }) {
 const [items,setItems]=useState<TeacherReminder[]>([]),[title,setTitle]=useState(initialTitle),[due,setDue]=useState(localDeadline(new Date(Date.now()+3600000).toISOString())),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const nonce=useRef(crypto.randomUUID()),alive=useRef(true)
 useEffect(()=>{const c=new AbortController();alive.current=true;client.reminders?.('list',{},c.signal).then(rows=>{if(!c.signal.aborted)setItems(rows)}).catch(e=>{if(!c.signal.aborted)setError(e.message)});return()=>{alive.current=false;c.abort()}},[client])
 async function save(event:React.FormEvent){event.preventDefault();if(busy||!client.reminders)return;setError('');setNotice('');const at=kyivDeadline(due)
  if(!at||Date.parse(at)<=Date.now()+15000){setError('Оберіть майбутній час за Києвом.');return}setBusy(true)
  try{const rows=await client.reminders('create',{id:nonce.current,title:title.trim(),dueAt:at});if(alive.current){setItems(rows);setTitle('');nonce.current=crypto.randomUUID();setNotice('Нагадування заплановано. Можна закрити вкладку.')}}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Не вдалося зберегти.')}finally{if(alive.current)setBusy(false)}
 }
 async function cancel(id:string){if(busy||!client.reminders)return;setBusy(true);try{const rows=await client.reminders('cancel',{id});if(alive.current)setItems(rows)}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Не вдалося скасувати.')}finally{if(alive.current)setBusy(false)}}
 return <section className="tla-reminders" aria-label="Особисті нагадування"><div className="tla-tool-section-heading"><h3><Bell size={19}/>Нагадування</h3><button type="button" onClick={onClose} aria-label="Закрити нагадування"><X size={18}/></button></div>
  <p>Ваші важливі справи — у сповіщеннях Xelay. Лист надійде, якщо його дозволено у ваших налаштуваннях. Час — за Києвом; сповіщення зазвичай з’являється впродовж хвилини після обраного часу.</p>
  <form onSubmit={save}><label>Про що нагадати<input type="text" value={title} required maxLength={180} disabled={busy} onChange={e=>{setTitle(e.target.value);nonce.current=crypto.randomUUID()}}/></label><label>Коли · Київ<input type="datetime-local" value={due} required disabled={busy} onChange={e=>{setDue(e.target.value);nonce.current=crypto.randomUUID()}}/></label><button className="tla-primary" disabled={busy||!title.trim()}><Bell size={15}/>Зберегти нагадування</button></form>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<ul>{items.map(x=><li key={x.id}><span>{x.state==='sent'?<Check size={15}/>:<Clock3 size={15}/>}<strong>{x.title}</strong><small>{date(x.dueAt)} · {x.state==='sent'?'Надіслано':'Заплановано'}</small></span>{x.state==='pending'&&<button disabled={busy} type="button" onClick={()=>void cancel(x.id)}>Скасувати</button>}</li>)}</ul>
 </section>
}
export function TeacherTestSavePanel({client,draft,onSaved}:{client:TeacherLearningClient;draft:TeacherLearningDraft;onSaved():void}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false)
 const proposed=draft.bundle.testConditions
 const [opens,setOpens]=useState(localDeadline(proposed?.opensAt || new Date(Date.now()+3600000).toISOString())),[closes,setCloses]=useState(localDeadline(proposed?.closesAt || new Date(Date.now()+86400000).toISOString())),[duration,setDuration]=useState((proposed?.durationSeconds ?? 1200)/60)
 const [rules,setRules]=useState({allowSkip:proposed?.allowSkip??true,allowReturn:proposed?.allowReturn??true,restrictTabSwitch:proposed?.restrictTabSwitch??true,requireAccessCode:proposed?.requireAccessCode??false,shuffleQuestions:proposed?.shuffleQuestions??false,shuffleAnswers:proposed?.shuffleAnswers??false})
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 async function create(event:React.FormEvent){event.preventDefault();if(busy||!client.createTest)return
  const a=kyivDeadline(opens),b=kyivDeadline(closes);if(!a||!b||Date.parse(b)<=Date.parse(a)){setError('Завершення має бути пізніше початку.');return}
  setBusy(true);setError('');try{const conditions:TeacherTestConditions={...rules,opensAt:a,closesAt:b,durationSeconds:Math.round(duration*60)};await client.createTest(draft.id,conditions);if(alive.current)setSaved(true)}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Не вдалося створити тест.')}finally{if(alive.current)setBusy(false)}
 }
 return <div className="tla-test-save">{!open?<button type="button" className="tla-primary" onClick={()=>setOpen(true)}>Створити тест у кабінеті</button>:saved?<p role="status">Тест збережено як чернетку. <button type="button" onClick={onSaved}>Відкрити «Тести»</button></p>:<form onSubmit={create}><h4>Умови тесту</h4>{proposed&&<p>Помічник підставив узгоджені в розмові умови. Решта — початкові значення форми. Перевірте всі поля перед підтвердженням.</p>}<p>Обрано груп: {draft.request.groupIds.length}. Вони залишаються тими, які ви вибрали для цієї чернетки. Студенти побачать тест після окремої публікації в кабінеті.</p><div className="tla-conditions"><label>Початок · Київ<input type="datetime-local" required value={opens} disabled={busy} onChange={e=>setOpens(e.target.value)}/></label><label>Завершення · Київ<input type="datetime-local" required value={closes} disabled={busy} onChange={e=>setCloses(e.target.value)}/></label><label>Хвилин на спробу<input type="number" min={1} max={1440} required value={duration} disabled={busy} onChange={e=>setDuration(Number(e.target.value))}/></label></div>
 {Object.entries({allowSkip:'Дозволити пропуск запитання',allowReturn:'Дозволити повернення',restrictTabSwitch:'Автоздача після виходу з вкладки',requireAccessCode:'Код доступу',shuffleQuestions:'Перемішати запитання',shuffleAnswers:'Перемішати відповіді'}).map(([k,label])=><label className="tla-rule" key={k}><input type="checkbox" checked={rules[k as keyof typeof rules]} disabled={busy} onChange={e=>setRules(v=>({...v,[k]:e.target.checked}))}/>{label}</label>)}
 <button className="tla-primary" disabled={busy}>{busy?'Зберігаю…':'Підтвердити умови та створити чернетку'}</button>{error&&<p role="alert">{error}</p>}</form>}</div>
}
