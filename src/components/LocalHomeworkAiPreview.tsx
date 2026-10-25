import { useRef, useState } from 'react'
import { ArrowLeft, Check, FileText, Plus, X } from 'lucide-react'
import { HomeworkAiDraft, type HomeworkAiApply, type HomeworkAiCarry, type HomeworkAiService, type HomeworkAiTarget } from './HomeworkAiDraft'
import { homeworkAiBody, normalizeHomeworkAiDraft, type HomeworkAiDraftResult, type HomeworkAiInput } from '../lib/homeworkAiDraft'
import { normalizeHomeworkLinks } from '../lib/homeworkResources'
import { LESSON_TYPES, scheduleOccursOnDate, type TimetableLesson } from '../lib/studyGroupTimetable'

const GROUP = '00000000-0000-4000-9000-000000000001'
const USER = '00000000-0000-4000-9000-000000000002'
const REFERENCE = '2026-10-25'
const uid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12,'0')}`
const lesson = (n: number, subject: string, weekday: number, lesson_type: TimetableLesson['lesson_type'], starts_at: string): TimetableLesson => ({ id:uid(n),group_id:GROUP,subject,weekday,lesson_type,starts_at,ends_at:starts_at==='08:00'?'09:20':starts_at==='09:40'?'11:00':'12:40',location:'',online_url:null,valid_from:'2026-09-01',valid_until:'2027-01-31',created_by:USER,week_pattern:'every',excluded_dates:[] })
const SCHEDULE = [lesson(11,'Вища математика',2,'practical','09:40'),lesson(12,'Економічна теорія',4,'seminar','08:00'),lesson(13,'Вища математика',2,'lecture','11:20')]
type Sample = { id:string; label:string; source:string; draft:HomeworkAiDraftResult }
const first = 'Вища математика. На вівторок, практичне заняття. Похідні. Розв’язати задачі 1–5 і виписати правила диференціювання. Матеріали: https://example.org/mathematics.pdf'
const second = 'Економічна теорія. На четвер, семінар. Ринкова рівновага. Прочитати розділ 3 та підготувати приклад зміни попиту.'
const ambiguous = 'Вища математика. На наступному тижні підготувати відповіді на питання 1–3. Точну дату заняття уточнимо.'
const duplicateOne = 'Вища математика. На вівторок, практичне заняття. Повторення. Розв’язати задачі 6–8.'
const duplicateTwo = 'Вища математика. На вівторок, практичне заняття. Додаткові вправи. Підготувати задачу 9.'
const draft = (items: HomeworkAiDraftResult['items'],warnings:string[]=[]):HomeworkAiDraftResult => ({version:1,complete:true,general_instructions:'',items,warnings})
const SAMPLES: Sample[] = [
  { id:'several',label:'Кілька предметів',source:first+'\n\n'+second,draft:draft([
    {subject:'Вища математика',lesson_type:'practical',date_text:'На вівторок',lesson_topic:'Похідні',source_fragment:first,links:[{url:'https://example.org/mathematics.pdf',title:'Матеріали'}]},
    {subject:'Економічна теорія',lesson_type:'seminar',date_text:'На четвер',lesson_topic:'Ринкова рівновага',source_fragment:second,links:[]},
  ]) },
  { id:'ambiguous',label:'Потрібне уточнення дати',source:ambiguous,draft:draft([{subject:'Вища математика',lesson_type:null,date_text:'На наступному тижні',lesson_topic:'',source_fragment:ambiguous,links:[]}],['Повідомлення не містить точної дати й типу заняття. Оберіть їх самостійно.']) },
  { id:'duplicate',label:'Два ДЗ до однієї пари',source:duplicateOne+'\n\n'+duplicateTwo,draft:draft([
    {subject:'Вища математика',lesson_type:'practical',date_text:'На вівторок',lesson_topic:'Повторення',source_fragment:duplicateOne,links:[]},
    {subject:'Вища математика',lesson_type:'practical',date_text:'На вівторок',lesson_topic:'Додаткові вправи',source_fragment:duplicateTwo,links:[]},
  ],['Обидва завдання стосуються однієї пари. Перед збереженням об’єднайте їх вручну або перевірте, яке має залишитися.']) },
]
const previewService:HomeworkAiService = {
  availability: async () => ({available:true}),
  request: async (_group,_user,input,signal) => {
    if(signal?.aborted) throw new DOMException('Скасовано','AbortError')
    const sample = SAMPLES.find(item=>item.source.trim()===input.source_text.trim())
    if(!sample) throw new Error('Це локальний приклад із готовими відповідями. Оберіть один зі сценаріїв угорі. Справжній ШІ тут не викликається.')
    return normalizeHomeworkAiDraft(sample.draft,input)
  },
}
type RecordValue = { topic:string;body:string;links:string[];titles:string[];files:string[] }
type Editor = RecordValue & {target:HomeworkAiTarget;carry:HomeworkAiCarry|null}
const keyFor=(value:HomeworkAiTarget)=>`${value.lesson.id}:${value.date}`
const inputClass='w-full rounded-xl border border-border bg-background px-3 py-2.5 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 sm:text-sm'
const action='inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-50'
export function LocalHomeworkAiPreview(){
  const [sampleId,setSampleId]=useState('several'),[dark,setDark]=useState(false),[editor,setEditor]=useState<Editor|null>(null),[status,setStatus]=useState('')
  const [records,setRecords]=useState<Record<string,RecordValue>>({[`${SCHEDULE[0].id}:2026-10-27`]:{topic:'Попереднє ДЗ',body:'Повторити основні формули. Цей текст уже був у групі.',links:['https://example.org/existing-notes'],titles:['Попередні нотатки'],files:['Збережений конспект.pdf']}})
  const current=useRef(editor);current.current=editor
  const sample=SAMPLES.find(item=>item.id===sampleId)!
  const baseVersion=JSON.stringify(editor)
  function openManual(target:HomeworkAiTarget,carry:HomeworkAiCarry|null=null){
    const existing=records[keyFor(target)]
    setEditor({...existing||{topic:'',body:'',links:[],titles:[],files:[]},target,carry})
  }
  const openAi=(value:HomeworkAiApply)=>{
    const existing=records[keyFor(value.target)]
    const item=value.draft.items[value.itemIndex]
    if(existing)openManual(value.target,{input:value.input,draft:value.draft,itemIndex:value.itemIndex})
    else setEditor({target:value.target,carry:null,topic:item.lesson_topic,body:homeworkAiBody(value.draft,item),links:item.links.map(link=>link.url),titles:item.links.map(link=>link.title),files:[]})
    return true
  }
  const applyInline=(value:HomeworkAiApply)=>{
    const valueNow=current.current
    if(!valueNow||JSON.stringify(valueNow)!==value.expected.baseDraftVersion||value.target.lesson.id!==valueNow.target.lesson.id||value.target.date!==valueNow.target.date)throw new Error('Форма змінилася. Підготуйте чернетку знову.')
    const item=value.draft.items[value.itemIndex]
    const links=normalizeHomeworkLinks([...valueNow.links,...item.links.map(link=>link.url)])
    const titles=new Map(valueNow.links.map((link,index)=>[new URL(link).href,valueNow.titles[index]||'']))
    item.links.forEach(link=>{if(!titles.has(new URL(link.url).href))titles.set(new URL(link.url).href,link.title)})
    setEditor({...valueNow,topic:item.lesson_topic,body:homeworkAiBody(value.draft,item),links,titles:links.map(url=>titles.get(url)||'')})
    return true
  }
  return <div className={`theme-linear ${dark?'dark':''} min-h-screen bg-background text-foreground`}>
    <header className="border-b border-border bg-card"><div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6"><div className="flex flex-wrap items-center gap-3"><span className="font-serif text-3xl">Xelay</span><span className="rounded-full bg-amber-500/10 px-3 py-1.5 text-xs">Локальний приклад · вигадані дані</span></div><button type="button" className={action} aria-pressed={dark} onClick={()=>setDark(value=>!value)}>{dark?'Темна':'Світла'} тема</button></div></header>
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-7 sm:px-6 sm:py-10"><div><p className="text-xs font-semibold uppercase tracking-wider text-primary">Розклад · домашні завдання</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">ДЗ із повідомлення викладача</h1><p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">Спробуйте обидва шляхи: розібрати повідомлення з кількома ДЗ або відкрити конкретну пару й заповнити її форму. У цьому прикладі використовуються готові тестові відповіді; звернень до OpenAI та робочої бази немає.</p></div>
      <section className="space-y-3 rounded-2xl border border-border bg-card p-4"><h2 className="text-sm font-semibold">Сценарій для перевірки</h2><div className="flex flex-wrap gap-2">{SAMPLES.map(item=><button key={item.id} type="button" className={`${action} ${sampleId===item.id?'border-primary/40 bg-primary/10 text-primary':''}`} aria-pressed={sampleId===item.id} onClick={()=>{setSampleId(item.id);setStatus('')}}>{item.label}</button>)}</div><p className="text-xs text-muted-foreground">Дата вихідного повідомлення: 25 жовтня 2026. У математиці вже є ДЗ, посилання й файл — під час заміни вони не зникнуть без вашого рішення.</p></section>
      <HomeworkAiDraft key={sample.id} mode="bulk" groupId={GROUP} currentUserId={USER} editorKey={`${GROUP}:${USER}:bulk:${sample.id}`} baseDraftVersion="fictional-schedule-v1" canEdit disabled={Boolean(editor)} schedule={SCHEDULE} selectedDate="2026-10-27" initialSource={sample.source} initialReferenceDate={REFERENCE} service={previewService} onApply={openAi}/>
      {status&&<p role="status" className="rounded-xl bg-primary/10 p-3 text-sm text-primary">{status}</p>}
      <section className="space-y-3"><h2 className="text-lg font-semibold">Приклад розкладу</h2>{SCHEDULE.map(item=>{const date=item.weekday===2?'2026-10-27':'2026-10-29',record=records[`${item.id}:${date}`];return <article key={item.id} className="rounded-2xl border border-border bg-card p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-muted-foreground">{date} · {item.starts_at} · {LESSON_TYPES[item.lesson_type]}</p><h3 className="mt-1 font-semibold">{item.subject}</h3></div><button type="button" className={action} onClick={()=>openManual({lesson:item,date})}><Plus size={15}/>Тема / ДЗ</button></div>{record?<div className="mt-3 space-y-2 border-t border-border pt-3 text-sm"><strong>{record.topic||'Домашнє завдання'}</strong><p className="whitespace-pre-wrap break-words text-muted-foreground">{record.body}</p>{record.files.map(file=><p className="flex items-center gap-2 text-xs" key={file}><FileText size={14}/>{file}</p>)}{record.links.map((link,index)=><p className="break-all text-xs text-primary" key={link}>{record.titles[index]||link}</p>)}</div>:<p className="mt-3 text-xs text-muted-foreground">ДЗ ще не додане.</p>}</article>})}</section>
    </main>
    {editor&&<div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-sm sm:items-center sm:p-4"><form className="max-h-[94dvh] w-full max-w-xl space-y-4 overflow-y-auto rounded-t-3xl border border-border bg-background p-5 sm:rounded-3xl sm:p-6" onSubmit={event=>{event.preventDefault();const {target,carry,...record}=editor;setRecords(previous=>({...previous,[keyFor(target)]:record}));setEditor(null);setStatus('ДЗ збережено тільки в пам’яті локального прикладу. Робоча платформа не змінювалася.')}}><header className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Тема заняття та домашнє завдання</h2><p className="mt-1 text-sm text-muted-foreground">{editor.target.lesson.subject} · {editor.target.date} · {editor.target.lesson.starts_at}</p></div><button type="button" className="rounded-full p-2 hover:bg-muted" aria-label="Закрити форму ДЗ" onClick={()=>setEditor(null)}><X size={18}/></button></header>
      <HomeworkAiDraft key={keyFor(editor.target)} mode="inline" groupId={GROUP} currentUserId={USER} editorKey={keyFor(editor.target)} baseDraftVersion={baseVersion} canEdit disabled={false} schedule={SCHEDULE} selectedDate={editor.target.date} target={editor.target} initialExtraction={editor.carry} initialSource={sample.source} initialReferenceDate={REFERENCE} hasExistingContent={Boolean(editor.topic||editor.body||editor.links.length||editor.files.length)} service={previewService} onApply={applyInline}/>
      <label className="block space-y-1.5"><span className="text-sm font-medium">Тема заняття / примітка</span><input value={editor.topic} maxLength={240} className={inputClass} onChange={event=>setEditor(previous=>previous&&({...previous,topic:event.target.value}))}/></label><label className="block space-y-1.5"><span className="text-sm font-medium">Домашнє завдання</span><textarea value={editor.body} maxLength={10000} rows={6} className={inputClass} onChange={event=>setEditor(previous=>previous&&({...previous,body:event.target.value}))}/></label>
      <div className="space-y-2"><h3 className="text-sm font-medium">Посилання</h3>{editor.links.length?editor.links.map((url,index)=><div key={index} className="space-y-1 rounded-xl border border-border p-3"><input aria-label={`Посилання ${index+1}`} className={inputClass} value={url} onChange={event=>setEditor(previous=>previous&&({...previous,links:previous.links.map((link,i)=>i===index?event.target.value:link)}))}/><p className="text-xs text-muted-foreground">{editor.titles[index]||'Без підпису'}</p></div>):<p className="text-xs text-muted-foreground">Посилань немає.</p>}</div>
      {editor.files.length>0&&<div className="rounded-xl bg-muted/50 p-3"><p className="mb-2 text-sm font-medium">Наявні файли збережено</p>{editor.files.map(file=><p className="flex items-center gap-2 text-xs" key={file}><FileText size={14}/>{file}</p>)}</div>}
      <div className="flex gap-2"><button className={`${action} flex-1 border-primary bg-primary text-primary-foreground hover:bg-primary/90`}><Check size={15}/>Зберегти в прикладі</button><button type="button" className={action} onClick={()=>setEditor(null)}>Скасувати</button></div><p className="text-xs leading-relaxed text-muted-foreground">Локальна демонстрація. Оновлення сторінки повертає початкові вигадані дані.</p>
    </form></div>}
  </div>
}
