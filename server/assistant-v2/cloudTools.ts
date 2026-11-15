import { ingestAssistantAttachments, ingestPublicGoogleSheet } from './attachments.ts'
import type { CloudModelTask } from './cloudTaskModel.ts'
import type { VerifiedAssistantSession } from './authenticatedRead.ts'
import { parseCloudAssistantDate, parseCloudAssistantDeadline } from './cloudDates.ts'
import { cloudSubjectEvidence } from './cloudSkills.ts'
type Row=Record<string,any>
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)
const exact=(v:unknown,keys:string[]):v is Row=>object(v)&&Object.keys(v).every(k=>keys.includes(k))
const text=(v:unknown,n=10000):v is string=>typeof v==='string'&&v.length<=n&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v)&&!/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v)
const day=(v:unknown):v is string=>typeof v==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().startsWith(v)
const clock=(v:string)=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)
function fail(code:string,status=400):never{throw Object.assign(new Error(code),{code,status})}
function scopeOf(v:unknown){if(!exact(v,['groupId','courseId','subjectId','date','period'])||v.groupId!==undefined&&!uuid(v.groupId)||v.courseId!==undefined&&!uuid(v.courseId)||v.subjectId!==undefined&&!uuid(v.subjectId)||v.date!==undefined&&!day(v.date))fail('invalid_scope');return v}
function requestId(v:unknown){if(!uuid(v))fail('invalid_request');return v.toLowerCase()}
const normal=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('uk').replace(/[^\p{L}\p{N}]/gu,'')
const math=(s:string)=>/^(?:вышмат[а-я]*|вишмат[а-яіїє]*|вищмат[а-яіїє]*|вищаматематика|высшаяматематика)$/u.test(normal(s))
export interface CloudToolDependencies {
  verifySession(credential:string,signal?:AbortSignal):Promise<VerifiedAssistantSession|null>
  catalog(session:VerifiedAssistantSession,credential:string,signal?:AbortSignal):Promise<Row>
  read(credential:string,value:unknown,signal?:AbortSignal):Promise<Row>
  prepare(credential:string,value:unknown):Promise<Row>
  model(credential:string,requestId:string,task:CloudModelTask):Promise<Row>
  materialContent?(credential:string,value:unknown,signal?:AbortSignal):Promise<Row>
  assertMaterialRights?(credential:string,value:unknown,signal?:AbortSignal):Promise<Row>
  canImportTestQuestions?(credential: string, courseId: string, signal?: AbortSignal): Promise<boolean>
  now?:()=>number; sheetFetch?:typeof fetch
}
export function createAssistantCloudTools(deps:CloudToolDependencies){
  const now=deps.now||Date.now
  async function owner(credential:string,signal?:AbortSignal){const s=await deps.verifySession(credential,signal);if(!s||!s.accountActive||!s.emailConfirmed||Date.parse(s.expiresAt)<=now())fail('session_invalid',401);return s}
  async function catalog(credential:string,signal?:AbortSignal){const session=await owner(credential,signal),data=await deps.catalog(session,credential,signal);if(data.userId!==session.userId||!Array.isArray(data.groups)||!Array.isArray(data.subjects))fail('repository_invalid_response',503);return{session,data}}
  async function same(credential:string,session:VerifiedAssistantSession,signal?:AbortSignal){const s=await owner(credential,signal);if(s.userId!==session.userId||s.sessionId!==session.sessionId)fail('session_changed',401)}
  function learningGroup(data:Row,scope:Row,permission:string){const groups=data.groups.filter((g:Row)=>g.learning===true),g=scope.groupId?groups.find((g:Row)=>g.id===scope.groupId):groups.length===1?groups[0]:undefined;if(!g)fail('group_required');if(!g.permissions?.includes(permission))fail('permission_required',403);return g}
  return{
    async importTestQuestions(credential: string, value: unknown, signal?: AbortSignal) {
      if (!exact(value, ['requestId', 'courseId', 'consent', 'sourceText', 'image'])
        || !uuid(value.courseId) || value.consent !== true) fail('invalid_request')
      const id = requestId(value.requestId), courseId = value.courseId
      const hasText = value.sourceText !== undefined
      if (hasText === (value.image !== undefined)) fail('invalid_request')
      const source = hasText ? value.sourceText : ''
      if (!text(source, 12000) || hasText && !source.trim() || Buffer.byteLength(source) > 20000) fail('model_context_too_large')
      const image = value.image
      if (!hasText && (typeof image !== 'string' || image.length > 349528 || !image)) fail('invalid_request')
      const session = await owner(credential, signal)
      if (!deps.canImportTestQuestions || !await deps.canImportTestQuestions(credential, courseId, signal)) fail('permission_required', 403)
      const images = hasText ? [] : (await ingestAssistantAttachments([{ name: 'question-source.jpg', mimeType: 'image/jpeg', base64: image }])).inlineData
      if (!hasText && images.length !== 1) fail('invalid_request')
      const result = await deps.model(credential, id, { task: 'test-import', data: { source }, images, signal })
      await same(credential, session, signal)
      if (!await deps.canImportTestQuestions(credential, courseId, signal)) fail('permission_required', 403)
      if (!exact(result, ['draftText', 'notes']) || !text(result.draftText, 16000) || !Array.isArray(result.notes)
        || result.notes.length > 10 || result.notes.some((note: unknown) => !text(note, 360) || !note.trim())) fail('model_invalid_response', 503)
      return { userId: session.userId, draftText: result.draftText, notes: result.notes }
    },
    async importSchedule(credential:string,value:unknown,signal?:AbortSignal){
      if(!exact(value,['requestId','scope','files','googleSheetUrl','groupHint','courseHint','columnHint','weekHint','validFrom','validUntil','weekAnchorDate']))fail('invalid_request')
      const id=requestId(value.requestId),scope=scopeOf(value.scope),{session,data}=await catalog(credential,signal),group=learningGroup(data,scope,'schedule')
      for(const key of ['groupHint','courseHint','columnHint','weekHint'])if(value[key]!==undefined&&!text(value[key],240))fail('invalid_request')
      const from=value.validFrom||scope.date,to=value.validUntil||from
      if(!day(from)||!day(to)||from>to||Date.parse(to)-Date.parse(from)>365*86400000||value.weekAnchorDate!==undefined&&(!day(value.weekAnchorDate)||new Date(value.weekAnchorDate+'T12:00:00Z').getUTCDay()!==1))fail('invalid_date_range')
      const files=value.files||[]
      if(!Array.isArray(files)||files.length>10||files.some((f:unknown)=>!exact(f,['name','mimeType','data'])||!text(f.name,180)||!text(f.mimeType,150)||typeof f.data!=='string'||!/\.(?:png|jpe?g|webp|xlsx|csv|tsv)$/i.test(f.name)))fail('invalid_request')
      if(!files.length&&!value.googleSheetUrl)fail('invalid_request')
      const source=await ingestAssistantAttachments(files.map((f:Row)=>({name:f.name,mimeType:f.mimeType,base64:f.data})))
      if(value.googleSheetUrl){const sheet=await ingestPublicGoogleSheet(value.googleSheetUrl,{fetchImpl:deps.sheetFetch,signal});source.textChunks.push(...sheet.textChunks)}
      const extracted=await deps.model(credential,id,{task:'timetable',data:{sources:source.textChunks,group: value.groupHint||group.name,course:value.courseHint||String(group.course||''),columnHint:value.columnHint||'',weekHint:value.weekHint||'',validFrom:from,validUntil:to,weekAnchorDate:value.weekAnchorDate||''},images:source.inlineData,signal})
      await same(credential,session,signal)
      if(!exact(extracted,['needsClarification','groups','questions','rowsTsv'])||typeof extracted.needsClarification!=='boolean'||!Array.isArray(extracted.groups)||extracted.groups.length>20||extracted.groups.some((g:unknown)=>!text(g,120))||!text(extracted.rowsTsv,18000))fail('model_invalid_response',503)
      if(extracted.needsClarification)return{userId:session.userId,text:'Уточніть потрібний стовпець групи та значення горизонтальних поділів, потім розпізнайте ще раз.',clarifications:['Лівий чи правий стовпець у межах кожного дня?','Горизонтальні частини відповідають верхньому та нижньому тижню?'],groups:extracted.groups,drafts:[]}
      // Trailing TABs are real empty room/teacher cells, not decoration.
      const lines=extracted.rowsTsv.split(/\r?\n/).filter(line=>line.trim().length>0)
      if(!lines.length||lines.length>80)fail('import_row_limit')
      const plans:Row[]=[]
      for(const line of lines){const cells=line.split('\t');if(cells.length!==8)fail('model_invalid_response',503);const [weekday,start,end,name,type,week,room,teacher]=cells
        if(!/^[1-7]$/.test(weekday)||!clock(start)||!clock(end)||start>=end||!text(name,120)||!name.trim()||/^[=+@]/.test(name)||!['lecture','seminar','practical','lab','other'].includes(type)||!['both','upper','lower'].includes(week)||!text(room,160)||!text(teacher,180))fail('model_invalid_response',503)
        if(week!=='both'&&!day(value.weekAnchorDate))return{userId:session.userId,text:'Укажіть дату понеділка верхнього тижня. Чернетки ще не створено.',clarifications:['Дата початку верхнього тижня'],drafts:[]}
        const firstWeekday=new Date(from+'T12:00:00Z').getUTCDay()||7
        let first=new Date(Date.parse(from+'T12:00:00Z')+((Number(weekday)-firstWeekday+7)%7)*86400000).toISOString().slice(0,10)
        if(week!=='both'){const weeks=Math.floor((Date.parse(first+'T12:00:00Z')-Date.parse(value.weekAnchorDate+'T12:00:00Z'))/604800000),actual=((weeks%2)+2)%2===0?'upper':'lower';if(actual!==week)first=new Date(Date.parse(first+'T12:00:00Z')+7*86400000).toISOString().slice(0,10)}
        if(first>to)continue
        plans.push({action:'schedule.create',scope:{groupId:group.id,date:first},payload:{date:first,subject:name.trim(),startsAt:start,endsAt:end,lessonType:type,location:room,teacherName:teacher,recurring:from!==to,validFrom:first,validUntil:to,weekday:Number(weekday),weekPattern:week==='both'?'every':week,...(week!=='both'?{weekAnchorDate:value.weekAnchorDate}:{})}})
      }
      if(!plans.length)fail('invalid_date_range')
      const fingerprints=plans.map(p=>JSON.stringify(p.payload));if(new Set(fingerprints).size!==fingerprints.length)fail('model_invalid_response',503)
      for(let i=0;i<plans.length;i++)for(let j=i+1;j<plans.length;j++){
        const a=plans[i].payload,b=plans[j].payload
        if(a.weekday===b.weekday&&a.startsAt<b.endsAt&&b.startsAt<a.endsAt&&(a.weekPattern==='every'||b.weekPattern==='every'||a.weekPattern===b.weekPattern))
          return{userId:session.userId,text:'Розпізнані заняття перетинаються в межах однієї групи. Уточніть лівий або правий стовпець, верхній і нижній тижні чи завантажте окремий фрагмент. Чернетки ще не створено.',clarifications:['Який стовпець належить вашій групі?','Чи означає горизонтальний поділ чергування тижнів?'],drafts:[]}
      }
      const drafts:Row[]=[]
      for(const plan of plans.slice(0,10)){
        try { const result=await deps.prepare(credential,plan);if(!result.draft)fail('repository_invalid_response',503);drafts.push(result.draft) }
        catch(error) {
          // An expired session must never expose another owner's queue. Other
          // preparation failures retain the successfully created review links.
          await same(credential,session,signal)
          if(!drafts.length)throw error
          return{userId:session.userId,text:'Частину чернеток підготовлено. Перевірте або скасуйте їх; решта пар залишилася в черзі. Нове розпізнавання не потрібне. Збереження відбудеться лише після підтвердження.',drafts,remaining:plans.slice(drafts.length)}
        }
      }
      return{userId:session.userId,text:'Розпізнано. Перевірте кожну пару, групу, тижні й період. Жодної пари ще не збережено. Великі розклади готуються частинами по 10 пар без нового розпізнавання.',drafts,remaining:plans.slice(10)}
    },
    async batchHomework(credential:string,value:unknown,signal?:AbortSignal){
      if(!exact(value,['requestId','scope','source'])||!text(value.source)||!value.source.trim())fail('invalid_request')
      const id=requestId(value.requestId),scope=scopeOf(value.scope),{session,data}=await catalog(credential,signal),group=learningGroup(data,scope,'homework')
      const subjects=data.subjects.filter((s:Row)=>s.kind==='study'&&s.groupId===group.id).map((s:Row,i:number)=>({...s,ref:'subject'+(i+1)}))
      const extracted=await deps.model(credential,id,{task:'homework-batch',data:{source:value.source,subjects:subjects.map((s:Row)=>({ref:s.ref,name:s.name})),now:new Date(now()).toISOString(),timeZone:'Europe/Kyiv'},signal})
      await same(credential,session,signal)
      if(!exact(extracted,['items','needsClarification'])||typeof extracted.needsClarification!=='boolean'||!Array.isArray(extracted.items)||!extracted.items.length||extracted.items.length>10)fail('model_invalid_response',503)
      if(extracted.needsClarification)return{userId:session.userId,text:'Уточніть, які предмети й дати стосуються кожного ДЗ. Чернетки ще не створено.',drafts:[]}
      const plans:Row[]=[]
      for(const item of extracted.items){if(!exact(item,['subject','dateSource','bodyQuote','topic','deadlineSource'])||Object.values(item).some(v=>!text(v,3000))||!value.source.includes(item.dateSource)||!item.dateSource||!value.source.includes(item.bodyQuote)||!item.bodyQuote||item.deadlineSource&&!value.source.includes(item.deadlineSource))fail('model_invalid_response',503)
        const exactMatches=subjects.filter((s:Row)=>s.ref===item.subject||normal(s.name)===normal(item.subject)||math(s.name)&&math(item.subject))
        const matches=exactMatches.length?exactMatches:subjects.filter((s:Row)=>cloudSubjectEvidence(s.name,item.subject,[item.subject],subjects.map((row:Row)=>row.name))&&cloudSubjectEvidence(s.name,item.subject,[value.source],subjects.map((row:Row)=>row.name)))
        const date=parseCloudAssistantDate(item.dateSource,now());if(matches.length!==1||!date) return{userId:session.userId,text:'Для одного із завдань не вдалося однозначно визначити предмет або дату. Допишіть повні назви й дати до повідомлення.',drafts:[]}
        if(matches[0].id!==scope.subjectId&&!cloudSubjectEvidence(matches[0].name,item.subject,[value.source],subjects.map((row:Row)=>row.name)))return{userId:session.userId,text:'Предмет одного із завдань не підтверджується текстом повідомлення. Укажіть повну назву або виберіть предмет і повторіть підготовку.',drafts:[]}
        const available=await deps.read(credential,{topic:'study',scope:{groupId:group.id,from:date,to:date,period:'current'},limit:100},signal)
        if(available.userId!==session.userId||!Array.isArray(available.records)||available.truncated)fail('repository_invalid_response',503)
        const lessons=available.records.filter((r:Row)=>r.kind==='lesson'&&r.subjectId===matches[0].id&&r.date===date&&uuid(r.scheduleId))
        if(lessons.length!==1)return{userId:session.userId,text:`Перевірте пару «${matches[0].name}» на ${date}: її немає або є кілька занять. Уточніть це ДЗ окремим запитом.`,drafts:[]}
        const dueAt=item.deadlineSource?parseCloudAssistantDeadline(item.deadlineSource,now()):null
        if(item.deadlineSource&&dueAt===undefined)return{userId:session.userId,text:'Уточніть явний термін здачі, включно з датою і часом, або напишіть «вільний термін».',drafts:[]}
        plans.push({action:'homework.upsert',scope:{groupId:group.id,date},payload:{lessonId:lessons[0].scheduleId,date,topic:item.topic&&value.source.includes(item.topic)?item.topic:'Домашнє завдання',body:value.source,dueAt:dueAt??null}})
      }
      const keys=plans.map(p=>p.payload.lessonId+':'+p.payload.date);if(new Set(keys).size!==keys.length)fail('model_invalid_response',503)
      const drafts:Row[]=[]
      for(const plan of plans){
        try{const prepared=await deps.prepare(credential,plan);if(!prepared.draft)fail('repository_invalid_response',503);drafts.push(prepared.draft)}
        catch(error){await same(credential,session,signal);if(!drafts.length)throw error;return{userId:session.userId,text:'Частину чернеток підготовлено. Перевірте або скасуйте їх. Решту цього разу не підготовлено; автоматичних повторів немає. Збереження відбудеться лише після вашого підтвердження.',drafts}}
      }
      await same(credential,session,signal)
      return{userId:session.userId,text:'Підготовлено окремі чернетки. Повне повідомлення викладача збережено в кожній; перевірте текст і терміни перед підтвердженням.',drafts}
    },
    async explainMaterial(credential:string,value:unknown,signal?:AbortSignal){
      if(!exact(value,['requestId','scope','materialId','question'])||!uuid(value.materialId)||value.question!==undefined&&!text(value.question,3000))fail('invalid_request')
      const id=requestId(value.requestId),scope=scopeOf(value.scope),session=await owner(credential,signal)
      if(!deps.materialContent)fail('material_requires_platform_editor',409)
      const material=await deps.materialContent(credential,{scope,materialId:value.materialId},signal)
      if(material.userId!==session.userId||material.allowAi!==true||!text(material.text,30000)||!text(material.title,240)||!text(material.rightsVersion,240))fail('permission_required',403)
      const generated=await deps.model(credential,id,{task:'explain',data:{title:material.title,material:material.text,question:value.question||'Поясни основні ідеї простими словами та запропонуй питання для самоперевірки.'},signal})
      if(!exact(generated,['safe','answer','quotes'])||typeof generated.safe!=='boolean'||!text(generated.answer,3500)||!Array.isArray(generated.quotes)||generated.quotes.length>4||generated.quotes.some((q:unknown)=>!text(q,800)||!q||!material.text.includes(q)))fail('model_invalid_response',503)
      if(!generated.safe)fail('model_refused',422)
      const fresh=deps.assertMaterialRights?await deps.assertMaterialRights(credential,{scope,materialId:value.materialId,rightsVersion:material.rightsVersion},signal):await deps.materialContent(credential,{scope,materialId:value.materialId},signal)
      if(fresh.allowAi!==true||fresh.rightsVersion!==material.rightsVersion||!deps.assertMaterialRights&&fresh.text!==material.text||fresh.userId!==session.userId)fail('material_changed',409)
      await same(credential,session,signal)
      return{userId:session.userId,text:(material.truncated?'Опрацьовано лише доступну частину матеріалу. Для решти відкрийте оригінал.\n\n':'')+generated.answer,sources:material.sources||[],quotes:generated.quotes,truncated:material.truncated===true}
    },
  }
}
