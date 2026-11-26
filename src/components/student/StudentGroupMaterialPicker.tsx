import {useEffect,useRef,useState} from 'react'
import {BookOpen,Check,FileText,Loader2,LockKeyhole,Search} from 'lucide-react'
import type {StudentGroupMaterial,StudentGroupMaterialsClient,StudentMaterialGroup,StudentMaterialPreview} from '../../lib/studentGroupMaterials'
import './studentGroupMaterialPicker.css'

export function StudentGroupMaterialPicker({client,disabled,selectedIds,onAttach}:{client:StudentGroupMaterialsClient;disabled:boolean;selectedIds:readonly string[];onAttach:(preview:StudentMaterialPreview)=>void}){
 const [groups,setGroups]=useState<StudentMaterialGroup[]>([]),[groupId,setGroupId]=useState(''),[items,setItems]=useState<StudentGroupMaterial[]>([]),[query,setQuery]=useState('')
 const [loading,setLoading]=useState(true),[reading,setReading]=useState(''),[error,setError]=useState(''),[truncated,setTruncated]=useState(false),[retry,setRetry]=useState(0)
 const previewRequest=useRef<AbortController|null>(null)
 useEffect(()=>{
  const abort=new AbortController();setLoading(true);setError('')
  void client.groups(abort.signal).then(value=>{if(!abort.signal.aborted){setGroups(value);setGroupId(current=>value.some(g=>g.id===current)?current:value[0]?.id||'')}}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Не вдалося відкрити групи.')}).finally(()=>{if(!abort.signal.aborted)setLoading(false)})
  return()=>abort.abort()
 },[client,retry])
 useEffect(()=>{
  previewRequest.current?.abort();previewRequest.current=null;setReading('');setItems([]);setTruncated(false);setQuery('')
  if(!groupId)return
  const abort=new AbortController();setLoading(true);setError('')
  void client.list(groupId,abort.signal).then(value=>{if(!abort.signal.aborted){setItems(value.items);setTruncated(value.truncated)}}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Не вдалося відкрити матеріали.')}).finally(()=>{if(!abort.signal.aborted)setLoading(false)})
  return()=>{abort.abort();previewRequest.current?.abort()}
 },[client,groupId,retry])
 useEffect(()=>{if(disabled){previewRequest.current?.abort();previewRequest.current=null;setReading('')}return()=>previewRequest.current?.abort()},[disabled])
 async function attach(id:string){
  if(disabled||previewRequest.current||selectedIds.includes(id))return
  const abort=new AbortController();previewRequest.current=abort;setReading(id);setError('')
  try{const result=await client.preview(id,abort.signal);if(!abort.signal.aborted)onAttach(result)}
  catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Не вдалося прочитати матеріал.')}
  finally{if(previewRequest.current===abort){previewRequest.current=null;setReading('')}}
 }
 const normalized=query.trim().toLocaleLowerCase('uk-UA'),visible=items.filter(item=>[item.title,item.subject].join(' ').toLocaleLowerCase('uk-UA').includes(normalized))
 return <section className="sgmp-root" aria-label="Матеріали навчальної групи">
  <header><BookOpen size={20}/><div><strong>З твоєї навчальної групи</strong><p>Обери матеріал. Текст можна переглянути перед надсиланням помічнику.</p></div></header>
  {groups.length>0&&<><label className="sgmp-group">Навчальна група<select value={groupId} disabled={disabled||!!reading} onChange={event=>setGroupId(event.target.value)}>{groups.map(group=><option key={group.id} value={group.id}>{group.name}</option>)}</select></label><label className="sgmp-search"><Search size={16}/><input type="search" aria-label="Пошук матеріалів групи" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Назва або предмет" disabled={disabled}/></label></>}
  {loading&&<p className="sgmp-status" role="status"><Loader2 size={16}/>Завантажуємо матеріали…</p>}
  {error&&<div className="sgmp-error" role="alert"><p>{error}</p><button type="button" disabled={disabled||!!reading} onClick={()=>setRetry(n=>n+1)}>Оновити список</button></div>}
  {!loading&&!error&&!groups.length&&<p className="sgmp-empty">Поки немає навчальної групи. Приєднайся до неї, щоб вибирати спільні матеріали.</p>}
  {!loading&&!error&&groups.length>0&&!visible.length&&<p className="sgmp-empty">{query?'За цим запитом нічого не знайдено.':'У цій групі ще немає доступних матеріалів.'}</p>}
  <div className="sgmp-list">{visible.map(item=>{
   const selected=selectedIds.includes(item.id),busy=reading===item.id
   return <button key={item.id} type="button" disabled={disabled||!!reading||selected||!item.allowAi} onClick={()=>void attach(item.id)} className={selected?'is-selected':''}>
    {busy?<Loader2 size={18}/>:selected?<Check size={18}/>:!item.allowAi?<LockKeyhole size={18}/>:<FileText size={18}/>}
    <span><strong>{item.title}</strong>{item.subject&&<small>{item.subject}</small>}<small>{busy?'Читаємо вибраний матеріал…':selected?'Додано до розмови':item.allowAi?'Переглянути й додати':'Автор ще не дозволив використання з ШІ'}</small></span>
   </button>
  })}</div>
  {truncated&&<p className="sgmp-empty">Показано перші 100 доступних матеріалів. Пошук працює в цьому списку.</p>}
  <p className="sgmp-privacy">Помічник отримає лише вибраний текст після твоєї згоди. Тести викладача та чужі відповіді сюди не потрапляють.</p>
 </section>
}
