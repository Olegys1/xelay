import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { DEAN_ACTIVITY_LABELS, DEAN_TIMES, type DeanActivity } from '../lib/deanWorkspace'

type Lesson = { source_id:string; lesson_date:string; period:number; course:string; activity:DeanActivity; room:string }
export function DeanTeacherSchedule(){
 const [lessons,setLessons]=useState<Lesson[]>([]),[error,setError]=useState(false)
 const [day,setDay]=useState(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()))
 useEffect(()=>{let active=true;void supabase.rpc('xelay_dean_teacher_delivery',{p_action:'read',p_payload:{}}).then(({data,error})=>{if(!active)return;if(error)setError(true);else if(Array.isArray(data))setLessons(data as Lesson[])});return()=>{active=false}},[])
 if(error)return <p role="status" className="mx-auto max-w-[1180px] px-5 pt-4 text-sm">Не вдалося перевірити розклад від деканату. Оновіть сторінку.</p>
 if(!lessons.length)return null
 const visible=lessons.filter(l=>l.lesson_date===day)
 return <details className="mx-auto my-5 max-w-[1180px] rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-700 dark:bg-stone-900"><summary className="cursor-pointer font-semibold">Мій розклад від деканату</summary><label className="my-4 flex flex-wrap items-center gap-3">Дата<input type="date" value={day} onChange={e=>setDay(e.target.value)} className="rounded-lg border p-2 text-inherit dark:bg-stone-800"/></label>{visible.length?<ul className="grid gap-3 sm:grid-cols-2">{visible.map(l=><li key={`${l.source_id}:${l.lesson_date}`} className="rounded-xl border border-stone-200 p-4 dark:border-stone-700"><strong>{l.period} пара · {DEAN_TIMES[l.period-1]?.join('–')}</strong><p>{l.course}</p><small>{DEAN_ACTIVITY_LABELS[l.activity]}{l.room?` · ауд. ${l.room}`:''}</small></li>)}</ul>:<p>На цю дату занять від деканату немає.</p>}</details>
}
