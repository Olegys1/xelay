import { readFile } from 'node:fs/promises'
import type { AssistantAuthorizedReadRecord, AssistantCallerReadQuery, AssistantExtendedReadRecord } from './authenticatedRead.ts'
import type { AssistantCallerClient } from './supabaseReadRepository.ts'

export const EXTENDED_STUDY_TOPICS = ['seminars','organizer','community','news','opportunities','help'] as const
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const fail=():never=>{throw Object.assign(new Error('assistant_read_repository_scope_violation'),{code:'assistant_read_repository_scope_violation',status:403})}
const text=(v:unknown,n=4000)=>typeof v==='string'?v.slice(0,n):''
const list=(v:unknown,n=1000):any[]=>Array.isArray(v)&&v.length<=n&&v.every(x=>x&&typeof x==='object'&&!Array.isArray(x))?v:fail()
const id=(v:unknown):string=>typeof v==='string'&&UUID.test(v)?v.toLowerCase():fail()
const count=(v:unknown,max=10000)=>Number.isInteger(v)&&Number(v)>=0&&Number(v)<=max?Number(v):fail()
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)
export function assistantSearchTerms(input:unknown):string[]{const stop=new Set(['знайди','найди','знайти','найти','покажи','показати','пошук','поиск','мені','мне','будь','ласка','питання','вопрос','вопросы','питаннями','новини','новости','можливості','возможности','допомога','помощь','про','для','как','як','щодо','сообщество','спільноті','спільнота','серед','платформі','розкажи','расскажи','підкажи','подскажи','хочу','можна','можно','нужно','потрібно','можу','Xelay'.toLowerCase()]);return text(input,6000).toLocaleLowerCase().split(/\s+/u).map(t=>t.replace(/[^\p{L}\p{N}'’\-]/gu,'')).filter(t=>t.length>=3&&!stop.has(t)).slice(0,8)}
export function assistantSourcePath(v:unknown):string {
  if(typeof v!=='string'||!v.startsWith('/')||v.length>600||/[\\\u0000-\u0020]/.test(v)||v.startsWith('//'))return fail()
  const parsed=new URL(v,'https://www.xelay.ink')
  if(parsed.origin!=='https://www.xelay.ink'||!/^\/(?:groups\/[a-f\d-]{36}|question\/[a-f\d-]{36}|news(?:\/[a-f\d-]{36})?|community|opportunities|organizer|teaching|guides\/)$/i.test(parsed.pathname))return fail()
  const seen=new Set<string>()
  for(const [key,value]of parsed.searchParams){if(seen.has(key))return fail();seen.add(key);if(['group','course','teaching','lesson','assignment','material','workspace','item'].includes(key)){if(!UUID.test(value))return fail()}else if(key==='date'){if(!/^20\d\d-\d\d-\d\d$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)return fail()}else if(key==='tab'){if(!['materials','schedule','seminars','timetable','guides'].includes(value))return fail()}else if(key==='home'){if(!['calendar','journal','assignments','materials','requests','scheduled'].includes(value))return fail()}else if(key==='kind'){if(!['homework','seminar'].includes(value))return fail()}else if(key==='view'){if(!['shared','personal'].includes(value))return fail()}else return fail()}
  if(parsed.hash&&!/^#(?:headman|teacher)\/[a-z\d-]{1,100}$/.test(parsed.hash))return fail()
  return v
}
export function projectExtendedStudyRecord(raw:any,q:AssistantCallerReadQuery):AssistantExtendedReadRecord {
  if(!object(raw)||!['seminar','task','question','news','opportunity','help'].includes(raw.kind))return fail()
  const topicFor:Record<string,string>={seminar:'seminars',task:'organizer',question:'community',news:'news',opportunity:'opportunities',help:'help'}
  if(topicFor[raw.kind]!==q.topic||typeof raw.title!=='string'||!raw.title.trim()||typeof raw.body!=='string')return fail()
  const base:any={id:raw.kind==='help'&&/^guide:(?:teacher|headman):[a-z\d-]{1,100}$/.test(raw.id)?raw.id:id(raw.id),kind:raw.kind,title:text(raw.title,300),body:text(raw.body),sourcePath:assistantSourcePath(raw.sourcePath),groupId:'',subjectId:'',archived:raw.archived===true}
  if(raw.kind==='seminar') {
    if(q.audience!=='student'||!q.selections.some(s=>s.groupId===raw.groupId&&(!s.subjectId||s.subjectId===raw.subjectId)&&(!s.allowedSubjectIds||s.allowedSubjectIds.includes(raw.subjectId)))||!['questions','teams','booking'].includes(raw.format)||!/^20\d\d-\d\d-\d\d$/.test(raw.date))return fail()
    base.groupId=id(raw.groupId);base.subjectId=id(raw.subjectId);base.date=raw.date;base.startsAt=text(raw.startsAt,5);base.endsAt=text(raw.endsAt,5);base.format=raw.format;base.selectionVersion=count(raw.selectionVersion||0,1000000);base.selectionDeadlineAt=raw.selectionDeadlineAt===null?null:text(raw.selectionDeadlineAt,40)
    base.canReopen=q.groupPermissions?.includes('seminars')===true
    base.questions=list(raw.questions,100).map(x=>({id:id(x.id),body:text(x.body,2000),position:count(x.position),primaryCapacity:count(x.primaryCapacity,100),supplementCapacity:count(x.supplementCapacity,100),occupiedPrimary:count(x.occupiedPrimary),occupiedSupplement:count(x.occupiedSupplement)}))
    base.teams=list(raw.teams,100).map(x=>({id:id(x.id),name:text(x.name,100),capacity:count(x.capacity,100),occupied:count(x.occupied)}))
    if(raw.myReservation){const r=raw.myReservation;if(!['primary','supplement','booking','team'].includes(r.role))return fail();base.myReservation={id:id(r.id),role:r.role,...(r.questionId?{questionId:id(r.questionId)}:{}),...(r.teamId?{teamId:id(r.teamId)}:{})}}
  } else {
    if(raw.groupId!==''||raw.subjectId!=='')return fail()
    if(raw.kind==='task') {
      if(!['personal','shared'].includes(raw.space)||typeof raw.completed!=='boolean'||typeof raw.canEdit!=='boolean'||raw.space==='shared'&&!UUID.test(raw.workspaceId))return fail()
      base.space=raw.space;base.completed=raw.completed;base.canEdit=raw.canEdit;base.dueAt=raw.dueAt===null?null:text(raw.dueAt,40)
      if(raw.workspaceId)base.workspaceId=id(raw.workspaceId)
    }
  }
  return base
}

/** Every query uses the injected caller JWT client. Output is a deliberate
 * projection: no profile/contact/resume or other people's booking identifiers. */
export async function readExtendedStudyPage(o:{client:AssistantCallerClient;userId:string;query:AssistantCallerReadQuery;now:()=>number}) {
  const {client,userId,query:q}=o,result:AssistantAuthorizedReadRecord[]=[]
  const terms=assistantSearchTerms(q.query)
  const search=(call:any,columns:string[])=>terms.length&&typeof call.or==='function'?call.or(columns.flatMap(column=>terms.slice(0,4).map(term=>`${column}.ilike.%${term}%`)).join(',')):call
  const check=()=>{if(q.signal?.aborted)throw Object.assign(new Error('request_cancelled'),{code:'request_cancelled',status:499})}
  const value=async(p:any)=>{check();const r=await(q.signal&&typeof p.abortSignal==='function'?p.abortSignal(q.signal):p);check();if(!r||r.error||Buffer.byteLength(JSON.stringify(r.data??null))>4000000)return fail();return r.data}
  const table=async(name:string,columns:string,filter:(call:any)=>any,max=1000)=>list(await value(filter(client.from(name).select(columns)).order('id',{ascending:true}).limit(max)),max)
  const rpc=(name:string,args?:Record<string,unknown>)=>value(client.rpc(name,args))
  let hasMore=false
  const scores=new Map<string,number>()
  const push=(row:any)=>{const haystack=`${row.title} ${row.body}`.toLocaleLowerCase(),score=terms.reduce((n,t)=>n+(haystack.includes(t)?1:0),0);if(terms.length&&!score)return;scores.set(row.id,score);result.push(projectExtendedStudyRecord(row,q))}
  if(q.topic==='seminars') {
    if(q.audience!=='student'||!q.selections.length)return fail()
    for(const s of q.selections) {
      const seminars=await table('study_group_seminars','id,group_id,subject_id,lesson_date,starts_at,ends_at,title,instructions,format,selection_deadline_at,selection_version',c=>c.eq('group_id',s.groupId).gte('lesson_date',q.from).lte('lesson_date',q.to),101)
      if(seminars.some(x=>x.group_id!==s.groupId))return fail()
      const selected=seminars.filter(x=>!s.subjectId||s.subjectId===x.subject_id),ids=selected.map(x=>id(x.id))
      if(!ids.length)continue
      const [questions,teams,reservations]=await Promise.all([
        table('study_group_seminar_questions','id,seminar_id,position,body,primary_capacity,supplement_capacity',c=>c.in('seminar_id',ids)),
        table('study_group_seminar_teams','id,seminar_id,name,capacity',c=>c.in('seminar_id',ids)),
        table('study_group_seminar_reservations','id,seminar_id,user_id,role,question_id,team_id',c=>c.in('seminar_id',ids)),
      ])
      if([...questions,...teams,...reservations].some(x=>!ids.includes(x.seminar_id)))return fail()
      for(const sem of selected) {
        const booked=reservations.filter(x=>x.seminar_id===sem.id),mine=booked.filter(x=>x.user_id===userId)
        if(mine.length>1)return fail()
        push({kind:'seminar',id:sem.id,groupId:s.groupId,subjectId:sem.subject_id,title:sem.title||'Семінар',body:sem.instructions||'',sourcePath:`/groups/${s.groupId}?tab=seminars&date=${sem.lesson_date}&assignment=${id(sem.id)}&kind=seminar`,date:sem.lesson_date,startsAt:sem.starts_at,endsAt:sem.ends_at,format:sem.format,selectionVersion:sem.selection_version||0,selectionDeadlineAt:sem.selection_deadline_at||null,
          questions:questions.filter(x=>x.seminar_id===sem.id).map(x=>({id:x.id,body:x.body,position:x.position,primaryCapacity:x.primary_capacity,supplementCapacity:x.supplement_capacity??0,occupiedPrimary:booked.filter(b=>b.question_id===x.id&&['primary','booking'].includes(b.role)).length,occupiedSupplement:booked.filter(b=>b.question_id===x.id&&b.role==='supplement').length})),
          teams:teams.filter(x=>x.seminar_id===sem.id).map(x=>({id:x.id,name:x.name,capacity:x.capacity,occupied:booked.filter(b=>b.team_id===x.id).length})),
          ...(mine[0]?{myReservation:{id:mine[0].id,role:mine[0].role,...(mine[0].question_id?{questionId:mine[0].question_id}:{}),...(mine[0].team_id?{teamId:mine[0].team_id}:{})}}:{})})
      }
    }
  } else if(q.topic==='organizer') {
    const space=q.space||'personal'
    if(space!=='shared') {
      const tasks=await table('organizer_tasks','id,user_id,title,notes,due_at,due_date,completed',c=>c.eq('user_id',userId),101)
      if(tasks.some(x=>x.user_id!==userId))return fail()
      for(const x of tasks)push({kind:'task',id:x.id,groupId:'',subjectId:'',title:x.title,body:x.notes||'',sourcePath:'/organizer',space:'personal',dueAt:x.due_at||x.due_date||null,completed:x.completed,canEdit:true})
    }
    if(space!=='personal') {
      const overview=await rpc('xelay_shared_organizer_overview'),workspaces=list(overview.workspaces,35)
      const selected=q.workspaceId?workspaces.filter(x=>x.id===q.workspaceId):workspaces
      if(q.workspaceId&&!selected.length)return fail()
      for(const w of selected) {
        const snap=await rpc('xelay_shared_organizer_workspace',{p_workspace_id:id(w.id),p_offset:0,p_limit:100})
        if(snap.workspace?.id!==w.id||!list(snap.members,35).some(x=>x.user_id===userId&&x.workspace_id===w.id))return fail()
        const tasks=list(snap.tasks,100);if(tasks.some(x=>x.workspace_id!==w.id))return fail()
        hasMore ||= Number(snap.total)>tasks.length
        for(const x of tasks)push({kind:'task',id:x.id,groupId:'',subjectId:'',title:x.title,body:x.notes||'',sourcePath:`/organizer?view=shared&workspace=${id(w.id)}`,space:'shared',workspaceId:w.id,dueAt:x.due_at||x.due_date||null,completed:x.completed,canEdit:true})
      }
    }
  } else if(q.topic==='community') {
    for(const x of await table('questions','id,title,content,created_at',c=>search(c,['title','content']),201))push({kind:'question',id:x.id,groupId:'',subjectId:'',title:x.title||text(x.content,100)||'Запитання спільноти',body:x.content||'',sourcePath:`/question/${id(x.id)}`})
  } else if(q.topic==='news') {
    const source=await table('news_posts','id,title,body,status,published_at',c=>search(c.eq('status','published').lte('published_at',new Date(o.now()).toISOString()),['title','body']),201)
    if(source.some(x=>x.status!=='published'||!Number.isFinite(Date.parse(x.published_at))||Date.parse(x.published_at)>o.now()))return fail()
    for(const x of source)push({kind:'news',id:x.id,groupId:'',subjectId:'',title:x.title,body:x.body||'',sourcePath:`/news/${id(x.id)}`})
  } else if(q.topic==='opportunities') {
    const source=await table('opportunities_items','id,company_id,status,published_at,deadline,data',c=>search(c.eq('status','approved').lte('published_at',new Date(o.now()).toISOString()),['data->>title','data->>summary','data->>description']),201)
    if(source.some(x=>x.status!=='approved'||!Number.isFinite(Date.parse(x.published_at))||Date.parse(x.published_at)>o.now()))return fail()
    for(const x of source) {if(x.deadline&&x.deadline<new Date(o.now()).toISOString().slice(0,10))continue;push({kind:'opportunity',id:x.id,groupId:'',subjectId:'',title:x.data?.title||'Можливість',body:[x.data?.summary,x.data?.description,x.data?.requirements].filter(v=>typeof v==='string').join('\n'),sourcePath:`/opportunities?item=${id(x.id)}`})}
  } else if(q.topic==='help') {
    for(const audience of ['headman','teacher']) {
      const file=audience==='headman'?new URL('../../public/guides/data/headman.json',import.meta.url):new URL('../../public/guides/data/teacher.json',import.meta.url)
      const bytes=await readFile(file);if(bytes.length>300000)return fail()
      const guide=JSON.parse(bytes.toString('utf8'))
      for(const x of list(guide.sections,100)) {if(!/^[a-z\d-]{1,100}$/.test(x.id))return fail();push({kind:'help',id:`guide:${audience}:${x.id}`,groupId:'',subjectId:'',title:x.title,body:[x.goal,...(Array.isArray(x.steps)?x.steps:[])].filter(v=>typeof v==='string').join('\n'),sourcePath:`/guides/#${audience}/${x.id}`})}
    }
  } else return fail()
  check()
  const filtered=result.sort((a,b)=>(scores.get(b.id)||0)-(scores.get(a.id)||0))
  return {rows:filtered.slice(0,q.limit),hasMore:hasMore||filtered.length>q.limit||result.length>=201}
}
