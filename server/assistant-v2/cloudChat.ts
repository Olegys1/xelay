import { createHmac, timingSafeEqual } from 'node:crypto'
import type { VerifiedAssistantSession } from './authenticatedRead.ts'
import { CLOUD_SKILL_ACTIONS, allowedCloudSkillActions, routeCloudSkill, cloudSubjectEvidence, type CloudSkillAction, type CloudActionForm } from './cloudSkills.ts'
import { parseCloudAssistantDeadline } from './cloudDates.ts'
import { HIDDEN_TEST_STUDY_GROUP_IDS } from '../../src/lib/studyGroupVisibility.ts'

type Row = Record<string, any>
type Topic = 'study' | 'materials' | 'results' | 'teaching' | 'gradebook' | 'seminars' | 'organizer' | 'community' | 'news' | 'opportunities' | 'help'
export type CloudStudyReadView = 'homework' | 'schedule' | 'all'
type Scope = { groupId?: string; subjectId?: string; materialSubjectId?:string; courseId?: string; date?: string; period?: 'current' | 'archive' | 'all'; mode?: 'learning' | 'teaching' }
export type CloudChatIntent =
  | { kind: 'homework'; subject?: string; date?: string; topic?: string }
  | { kind: 'read'; topic: Topic; view?: CloudStudyReadView; subject?: string; courseRef?: string; date?: string }
  | { kind: 'schedule'; date?: string; subject?: string; startsAt?: string; endsAt?: string; lessonType?: string; teacherName?: string; location?: string }
  | { kind: 'organizer'; title?: string; notes?: string }
  | { kind: 'action'; action: CloudSkillAction; courseRef?: string; subject?: string; date?: string }
  | { kind: 'reply'; text: string }
  | { kind: 'clarify'; text: string }
  | { kind: 'unsupported'; text: string }
export interface CloudChatPlannerRequest {
  message: string; teacherMessage?: string; history: { role: 'user' | 'assistant'; content: string }[]; signal?: AbortSignal
  context: { now: string; timeZone: 'Europe/Kyiv'; hasLearningGroup: boolean; materialSubjectName?:string; subjects: { ref: string; name: string }[]; courses: { ref: string; name: string }[];
    scope: { date?: string; subjectRef?: string; courseRef?: string; period: 'current' | 'archive' | 'all' }; previousRead?:{topic:'study'|'teaching';view:CloudStudyReadView;date?:string}; allowedKinds: string[]; allowedTopics: Topic[]; allowedActions?: string[] }
}
export interface CloudChatResult {
  userId: string; kind: 'reply' | 'clarify' | 'draft' | 'read' | 'unsupported'; text: string
  draft?: Row; drafts?: Row[]; read?: Row; continuation?: string; form?: CloudActionForm; tool?: Row; sources?: Row[]
  choices?: { type: 'group' | 'subject' | 'lesson'; items: { id: string; label: string }[] }
}
export interface CloudChatDependencies {
  verifySession(credential: string, signal?: AbortSignal): Promise<VerifiedAssistantSession | null>
  catalog(session: VerifiedAssistantSession, credential: string, signal?: AbortSignal): Promise<Row>
  read(credential: string, request: unknown, signal?: AbortSignal): Promise<Row>
  writes: { prepare(credential: string, request: unknown): Promise<Row>; form?(credential:string,request:unknown):Promise<Row> }
  planner(request: CloudChatPlannerRequest): Promise<unknown>
  continuationSecret: string; now?: () => number
}
type Pending = { v: 1; owner: string; expires: number; stage: 'group' | 'body' | 'subject' | 'lesson' | 'date' | 'course' | 'followup'; message: string; teacherBody?: string; lessonId?: string; resolvedDate?: string; scope: Scope; intent?: CloudChatIntent }
const topics: Topic[] = ['study','materials','results','teaching','gradebook','seminars','organizer','community','news','opportunities','help']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: unknown, allowed: string[]): v is Row => object(v) && Object.keys(v).every(key => allowed.includes(key))
const validText = (v: unknown, maximum: number, required = false): v is string => typeof v === 'string' && v.length <= maximum && (!required || !!v.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v+'T00:00:00Z')) && new Date(v+'T00:00:00Z').toISOString().startsWith(v)
const norm = (v: string) => v.normalize('NFKC').toLocaleLowerCase('uk').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim()
const compact = (v: string) => norm(v).replace(/\s/g,'')
const mathAlias = (v: string) => /^(?:вышмат[а-я]*|вишмат[а-яіїє]*|вищмат[а-яіїє]*|вищаматематика|высшаяматематика)$/u.test(compact(v))
function fail(code: string, status = 400): never { throw Object.assign(new Error(code), { code, status }) }
/** Conversation has no tools or database results. This is a bounded output
 * boundary, not a claim that regexes can establish every sentence as factual. */
export function validateConversationText(value: unknown, maximum = 1200): string {
  if (!validText(value,maximum,true)) fail('model_invalid_response',503)
  const text=value.trim()
  if (/[\u202a-\u202e\u2066-\u2069]/u.test(text)
    || /(?:https?:|ftp:|file:|javascript:|data:|mailto:|tg:|www\.)|<\/?[a-z!]|```|\[[^\]]*\]\s*\(|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu.test(text)
    || /(?:^|[^\p{L}])(?:додано|добавлено|збережено|сохранено|створено|создано|оновлено|обновлено|видалено|удалено|надіслано|отправлено|опубліковано|опубликовано|підтверджено|подтверждено|заброньовано|забронировано|виконано|выполнено)(?=$|[^\p{L}])/iu.test(text)
    || /(?:^|[^\p{L}])(?:я|ми|мы)\s+(?:(?:вже|уже|успішно|успешно|щойно|тільки\s+що)\s+)?(?:додав|добав|зберіг|збереж|сохрани|створ|созда|онов|обнов|видал|удал|надісл|отправ|опублі|опубли|підтверд|подтверд|заброн|викона|выполн|записа|запла|опла|перевіри|провери)[\p{L}]*/iu.test(text)
    || /(?:у|в)\s+вас\s+(?:вже\s+|уже\s+)?\d|ваш[\p{L}]*\s+(?:бал[\p{L}]*|оцінк[\p{L}]*|оценк[\p{L}]*)[^.!?\n]{0,20}\d|(?:sk|sb_secret)_[a-z0-9_-]{12,}|sk-[a-z0-9_-]{12,}/iu.test(text)) fail('model_invalid_response',503)
  return text
}
function standaloneConversation(message:string):'greeting'|'thanks'|'help'|undefined {
  if(message.length>160||message.includes('\n'))return undefined
  const text=norm(message)
  if(/^(?:привіт|привет|вітаю|вітаємо|добрий день|доброго дня|добрий вечір|доброго вечора|доброго ранку|доброе утро|добрый день|добрый вечер|здравствуйте|hello|hi|hey)(?: xelay| друже| друг| усім| всем)?$/u.test(text))return'greeting'
  if(/^(?:(?:дуже|щиро|велике|большое) )?(?:дякую|спасибі|спасибо|thanks|thank you)(?: тобі| вам| тебе| большое| дуже)?$/u.test(text))return'thanks'
  if(/^(?:що ти (?:вмієш|можеш)|що (?:вміє|може) помічник|чим (?:ти )?можеш допомогти|як (?:ти )?можеш (?:мені )?допомогти|які (?:в тебе |у тебе )?можливості|покажи (?:свої )?можливості|что ты (?:умеешь|можешь)|чем (?:ты )?можешь помочь|как (?:ты )?можешь (?:мне )?помочь|твои возможности|what can you do|help|допомога|помощь)$/u.test(text))return'help'
  return undefined
}
function conversationReply(kind:'greeting'|'thanks'|'help') {
  if(kind==='thanks')return'Будь ласка! Якщо ще щось знадобиться, напишіть.'
  if(kind==='greeting')return'Привіт! Я помічник Xelay. Можу показати ваш розклад, ДЗ або матеріали, допомогти з особистими справами чи підготувати зміни для перевірки. Наприклад: «Які завтра пари?» або «Що ти вмієш?»'
  return'Можу показати доступні вам розклад, ДЗ, матеріали й бали, допомогти з семінарами та особистими справами. Старостам і викладачам допомагаю готувати зміни в межах їхніх прав. Спочатку ви переглядаєте чернетку, а збереження потребує вашого підтвердження. Напишіть, що потрібно: наприклад, «Покажи ДЗ на завтра» або «Нагадай повторити тему».'
}
function emptyReadText(topic:Topic,day:string|undefined,now:number) {
  const today=kyivDate(now),tomorrow=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10)
  const when=day===today?'На сьогодні':day===tomorrow?'На завтра':day?`На ${day.split('-').reverse().join('.')}`:'Зараз'
  if(topic==='study')return`${when} у вибраній групі пар немає. Можу перевірити іншу дату.`
  if(topic==='teaching')return`${when} у вашому викладацькому розкладі занять немає. Можу перевірити іншу дату.`
  const labels:Partial<Record<Topic,string>>={materials:'доступних матеріалів',results:'власних результатів оцінювання',gradebook:'записів у журналі',seminars:'доступних семінарів',organizer:'особистих справ',community:'відповідних обговорень',news:'відповідних опублікованих новин',opportunities:'відповідних опублікованих можливостей',help:'відповідних інструкцій'}
  return`За цим запитом ${labels[topic]||'доступних записів'} поки немає. Спробуйте уточнити запит.`
}
function scopeOf(v: unknown): Scope {
  if (v === undefined) return {}
  if (!exact(v,['groupId','subjectId','materialSubjectId','courseId','date','period','mode'])) fail('invalid_scope')
  const out: Scope = {}
  for (const key of ['groupId','subjectId','materialSubjectId','courseId'] as const) if (v[key] !== undefined) { if (typeof v[key] !== 'string' || !UUID.test(v[key])) fail('invalid_scope'); out[key] = v[key].toLowerCase() }
  if (v.date !== undefined) { if (!date(v.date)) fail('invalid_date'); out.date = v.date }
  if (v.period !== undefined) { if (!['current','archive','all'].includes(v.period)) fail('invalid_scope'); out.period = v.period }
  if (v.mode !== undefined) { if (!['learning','teaching'].includes(v.mode)) fail('invalid_scope'); out.mode = v.mode }
  return out
}
function intentOf(v: unknown): CloudChatIntent {
  if (!object(v)) fail('model_invalid_response',503)
  const fields: Record<string,string[]> = { homework:['kind','subject','date','topic'], read:['kind','topic','view','subject','courseRef','date'], schedule:['kind','date','subject','startsAt','endsAt','lessonType','teacherName','location'], organizer:['kind','title','notes'], action:['kind','action','courseRef','subject','date'], reply:['kind','text'], clarify:['kind','text'], unsupported:['kind','text'] }
  if (!Object.prototype.hasOwnProperty.call(fields,v.kind) || !exact(v,fields[v.kind])) fail('model_invalid_response',503)
  for (const [key,value] of Object.entries(v)) if (key !== 'kind' && !validText(value,key==='notes'?10000:key==='text'?(v.kind==='reply'?1200:600):240)) fail('model_invalid_response',503)
  if (v.date !== undefined && !date(v.date) || v.kind==='read' && !topics.includes(v.topic) || ['clarify','unsupported'].includes(v.kind) && !validText(v.text,600,true)) fail('model_invalid_response',503)
  if(v.kind==='action'&&!CLOUD_SKILL_ACTIONS.includes(v.action))fail('model_invalid_response',503)
  if(v.kind==='read'&&v.view!==undefined&&(!['homework','schedule','all'].includes(v.view)||!['study','teaching'].includes(v.topic)&&v.view!=='all'))fail('model_invalid_response',503)
  if(v.kind==='reply'||v.kind==='clarify')return{kind:v.kind,text:validateConversationText(v.text,v.kind==='reply'?1200:600)}
  return v as CloudChatIntent
}
const kyivDate = (now: number) => new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now))
const monthNames=[/^(?:січ|январ)/iu,/^(?:лют|феврал)/iu,/^(?:берез|март)/iu,/^(?:квіт|апрел)/iu,/^(?:трав|ма[йя])/iu,/^(?:черв|июн)/iu,/^(?:лип|июл)/iu,/^(?:серп|август)/iu,/^(?:верес|сентябр)/iu,/^(?:жовт|октябр)/iu,/^(?:листоп|ноябр)/iu,/^(?:груд|декабр)/iu]
const namedDate=/(\d{1,2})\s+([\p{L}]+)(?:\s+(20\d{2}))?/giu
const namedDateMatch=(message:string)=>[...message.matchAll(namedDate)].find(match=>monthNames.some(pattern=>pattern.test(match[2])))
const tomorrowPattern=/(?:^|[^\p{L}\p{N}])(?:завтра|зщавтра|завьра|завтрa|завтр)(?=$|[^\p{L}\p{N}])/iu
const afterTomorrowPattern=/(?:^|[^\p{L}\p{N}])(?:післязавтра|послезавтра)(?=$|[^\p{L}\p{N}])/iu
const todayPattern=/(?:^|[^\p{L}\p{N}])(?:сьогодні|сегодня)(?=$|[^\p{L}\p{N}])/iu
function dateHint(message:string) {
  const dateLike=norm(message).split(' ').some(word=>/^(?:зав[ть]|зщав|післязав|послезав|сьог|сегод|понед|вівтор|вторни|серед|сред[ауы]|четвер|пятниц|субот|суббот|неділ|воскр)/iu.test(word)&&!/^завтрак(?:а|у|ом|е|и|ов|ами|ах)?$/iu.test(word))
  return dateLike||/\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}|наступн[^.?!\n]{0,20}тиж|следующ[^.?!\n]{0,20}недел/iu.test(message)||!!namedDateMatch(message)
}
function statedDate(message: string, now: number) {
  const explicit = message.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]
  if (explicit && date(explicit)) return explicit
  const day = kyivDate(now), start = Date.parse(day+'T00:00:00Z')
  const numeric=/(?:^|[^\d])(\d{1,2})[./](\d{1,2})(?:[./](20\d{2}))?(?!\d)/u.exec(message)
  const named=namedDateMatch(message), month=named?monthNames.findIndex(pattern=>pattern.test(named[2])):-1
  const candidate=numeric?`${numeric[3]||day.slice(0,4)}-${numeric[2].padStart(2,'0')}-${numeric[1].padStart(2,'0')}`:named&&month>=0?`${named[3]||day.slice(0,4)}-${String(month+1).padStart(2,'0')}-${named[1].padStart(2,'0')}`:undefined
  if(candidate) return date(candidate)?candidate:undefined
  const offset = afterTomorrowPattern.test(message)?2:tomorrowPattern.test(message)?1:todayPattern.test(message)?0:undefined
  if (offset !== undefined) return new Date(start+offset*86400000).toISOString().slice(0,10)
  const weekdays = [/понеділ|понедель/iu,/вівтор|вторник/iu,/серед|сред[ауы]/iu,/четвер/iu,/п[’'`]?ятниц|пятниц/iu,/субот|суббот/iu,/неділ|воскресен/iu]
  const weekday = weekdays.findIndex(pattern=>pattern.test(message))
  if (weekday >= 0) {
    const current=(new Date(start).getUTCDay()+6)%7,nextWeek=/наступн[^.?!\n]{0,20}тиж|следующ[^.?!\n]{0,20}недел/iu.test(message)
    let days=nextWeek?7-current+weekday:(weekday-current+7)%7
    if(!nextWeek&&days===0&&/наступн|следующ/iu.test(message))days=7
    return new Date(start+days*86400000).toISOString().slice(0,10)
  }
  return undefined
}
function shortDateFragment(message:string,now:number) {
  if(message.length>160||!statedDate(message,now))return false
  const words=norm(message).replace(/п\s+ят/gu,'пят').split(' ')
  if(words.length>20)return false
  return words.every(word=>/^(?:а|і|и|на|в|у|до|за|по|ще|еще|покажи|пожалуйста|будь|ласка|\d{1,4}|сьогодні|сегодня|завтра|зщавтра|завьра|завтрa|завтр|послезавтра|післязавтра|тоді|тогда)$/iu.test(word)
    ||/^(?:наступн|следующ|тиж|недел|понеділ|понедель|вівтор|вторник|серед|сред[ауы]|четвер|пятниц|субот|суббот|неділ|воскресен)[\p{L}]*$/iu.test(word)
    ||monthNames.some(pattern=>pattern.test(word)))
}
function explicitReadView(message:string):CloudStudyReadView|undefined {
  const text=norm(message),homework=/(?:^|\s)(?:дз|д з|homework|завдання|завдань)(?:$|\s)|домашн|домашк|задал|задано|задава|задав/iu.test(text)
  const schedule=/розклад|расписан|(?:^|\s)(?:пари|пары|пар|заняття|занятия)(?:$|\s)/iu.test(text)
  if(homework&&schedule&&/(?:розклад|расписан|пари|пары)\s+(?:і|та|и|й)\s+(?:дз|домаш)|(?:дз|домаш[\p{L}]*)\s+(?:і|та|и|й)\s+(?:розклад|расписан|пари|пары)/iu.test(text))return'all'
  return homework?'homework':schedule?'schedule':undefined
}
const allSubjectRequest=(message:string)=>/(?:^|\s)(?:все|усе|всі|усі)\s*(?:дз|домаш[\p{L}]*)|(?:по|з|із|за)\s+(?:всіх|усіх|всем|всім|усім)\s+(?:предмет|дисциплін)|all\s+subjects/iu.test(norm(message))
function shortReadRefinement(message:string,now:number) {
  if(message.length>240||explicitWriteCommand('homework',message)||explicitWriteCommand('schedule',message)||explicitWriteCommand('organizer',message))return false
  if(shortDateFragment(message,now))return true
  if(!explicitReadView(message))return false
  return norm(message).split(' ').every(word=>/^(?:я|а|і|и|что|що|на|в|у|за|по|мне|мені|меня|мого|мої|мои|моє|мое|только|лише|тільки|просто|саме|попросил|попросила|просив|просила|просил|прошу|попросив|дай|дати|дать|напиши|покажи|покажіть|будь|ласка|пожалуйста|дз|д|з|домашку|домашнє|домашнее|домашние|домашні|завдання|задания|задание|задали|задано|расписание|розклад|пари|пары|заняття|занятия|сьогодні|сегодня|завтра|зщавтра|завьра|завтрa|завтр|послезавтра|післязавтра)$/iu.test(word))
}
function readHeading(view:CloudStudyReadView,topic:Topic,day:string|undefined,records:Row[],now:number,subject?:string,truncated=false) {
  if(topic!=='study')return records.length?'Ось записи, доступні вашому акаунту.':emptyReadText(topic,day,now)
  const today=kyivDate(now),tomorrow=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10)
  const when=day===today?'на сьогодні':day===tomorrow?'на завтра':day?`на ${day.split('-').reverse().join('.')}`:''
  const selected=subject?` з предмета «${subject}»`:''
  if(view==='homework'&&!records.length&&truncated)return`Поточна вибірка неповна. Уточніть предмет, щоб перевірити ДЗ ${when}.`
  if(view==='homework')return records.length?`ДЗ ${when}${selected}. Показую лише домашні завдання.`:`${when?when[0].toUpperCase()+when.slice(1):'Зараз'}${selected} опублікованого ДЗ немає.`
  if(view==='schedule')return records.length?`Розклад ${when}${selected}. Показую лише заняття.`:emptyReadText(topic,day,now)
  return records.length?`Розклад і ДЗ ${when}${selected}.`:emptyReadText(topic,day,now)
}
const teacherSourceMarker=/(?:повідомлення|сообщение|соо|текст)\s*(?:від|от)?\s*(?:викладач[а-яіїє]*|препод[а-я]*|учител[а-я]*)?\s*[:：]/iu
function inlineHomeworkCopy(message:string) {
  const line=message.split('\n')[0]
  for(const separator of line.matchAll(/[:：][ \t]+(?=\S)/gu)){
    const command=line.slice(0,separator.index),start=separator.index!+separator[0].length
    if(/\d[ \t]*$/u.test(command)&&/^\d/u.test(message.slice(start))||/(?:https?|ftp|mailto|tg)$/iu.test(command))continue
    if(explicitWriteCommand('homework',command))return{command,body:message.slice(start),index:separator.index!}
  }
  return undefined
}
function userCommand(message:string) {
  const line=message.split('\n')[0],marker=teacherSourceMarker.exec(line),inline=inlineHomeworkCopy(message)
  return marker&&(!inline||marker.index<inline.index)?line.slice(0,marker.index):inline?.command||line
}
function teacherCopy(message: string, explicit?: string) {
  if (explicit !== undefined) return explicit.trim() ? explicit : undefined
  const newline = message.indexOf('\n')
  const firstLine=newline<0?message:message.slice(0,newline)
  const firstMarker=teacherSourceMarker.exec(firstLine),inline=inlineHomeworkCopy(message)
  if(firstMarker&&(!inline||firstMarker.index<inline.index))return message.slice(firstMarker.index+firstMarker[0].length).trim()?message.slice(firstMarker.index+firstMarker[0].length).replace(/^ /,''):undefined
  if(inline)return inline.body
  if (newline >= 0 && /додай|добав|запиш|створ|сделай|зроби|постав/iu.test(firstLine) && /(?:^|[^\p{L}])дз[ьъ]?(?:$|[^\p{L}])|д[\/\\]з|домаш|завдан|задан/iu.test(firstLine) && message.slice(newline+1).trim()) return message.slice(newline+1)
  const marker = teacherSourceMarker.exec(message)
  return marker && message.slice(marker.index+marker[0].length).trim() ? message.slice(marker.index+marker[0].length).replace(/^ /,'') : undefined
}
function literalUserFragment(candidate:unknown,sources:string[],maximum:number) {
  if(typeof candidate!=='string'||!candidate.trim()||candidate.trim().length>maximum)return undefined
  const search=candidate.trim().toLocaleLowerCase('uk')
  for(const source of sources){const index=source.toLocaleLowerCase('uk').indexOf(search);if(index<0)continue;const original=source.slice(index,index+candidate.trim().length);if(original.toLocaleLowerCase('uk')===search)return original}
  return undefined
}
function explicitWriteCommand(kind:'homework'|'schedule'|'organizer',command:string) {
  if(/не\s+(?:(?:треба|потрібно|нужно)\s+)?(?:дод|добав|запис|створ|созда|нагад|напом|змін|измен|онов|обнов)/iu.test(command))return false
  if(!/додай|добав|запиш|створ|созда|сделай|зроби|постав|підгот|подгот|внес|вкаж|укаж|змін|измен|онов|обнов|нагад|напом/iu.test(command))return false
  const personal=/особист|личн|органайзер|нагад|напом/iu.test(command)
  const homework=/(?:^|[^\p{L}])дз[ьъ]?(?:$|[^\p{L}])|домашн|домашк|завдан|задан|д[\/\\]з|(?:додай|добав[ьити]*|змін[а-яіїє]*|измен[а-я]*)\s*дз/iu.test(command)
  const wanted=personal?'organizer':homework?'homework':/пар[ауиы]?|занят|розклад|расписан|урок/iu.test(command)?'schedule':/план|справ|дел[оа]|задач/iu.test(command)?'organizer':undefined
  return wanted===kind&&(kind!=='schedule'||/додай|добав|запиш|створ|созда|внес|сделай|зроби/iu.test(command))
}
function userTime(candidate:unknown,sources:string[]) {
  if(typeof candidate!=='string'||!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(candidate))return undefined
  const normalized=candidate.padStart(5,'0')
  return sources.some(source=>[...source.matchAll(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)].some(match=>match[1].padStart(2,'0')+':'+match[2]===normalized))?normalized:undefined
}
function groundedScheduleSubject(candidate:unknown,sources:string[],subjects:Row[]) {
  const literal=literalUserFragment(candidate,sources,120);if(literal)return literal
  if(typeof candidate!=='string')return undefined
  const matches=subjectMatches(candidate,subjects);if(matches.length!==1||matches[0].name.length>120)return undefined
  if(literalUserFragment(matches[0].name,sources,120))return matches[0].name
  if(/вищ[а-яіїє]*\s+математ|высш[а-я]*\s+математ/iu.test(matches[0].name)&&sources.some(source=>/в[иы]ш\s*мат[а-яіїє]*|вищ\s*мат[а-яіїє]*|вищ[а-яіїє]*\s+математ|высш[а-я]*\s+математ/iu.test(source)))return matches[0].name
  return undefined
}
function groundedLessonType(sources:string[]) {
  const source=sources.join('\n'),types=[['lecture',/лекц/iu],['seminar',/семінар|семинар/iu],['practical',/практич/iu],['lab',/лаборатор|(?:^|[^\p{L}])лаб(?:$|[^\p{L}])/iu]] as const
  const matches=types.filter(([,pattern])=>pattern.test(source));return matches.length===1?matches[0][0]:matches.length===0?'other':undefined
}
function matchChoice(message: string, items: {id:string;label:string}[]) {
  const trimmed = message.trim(), number = /^\d{1,2}$/.test(trimmed)?Number(trimmed)-1:-1
  if (number >= 0 && number < items.length) return items[number]
  const matched = items.filter(item=>item.id===trimmed || norm(item.label)===norm(trimmed))
  return matched.length===1?matched[0]:undefined
}
const testGroupIds=new Set<string>(HIDDEN_TEST_STUDY_GROUP_IDS)
function groupNameKey(value:string) {
  const normalized=compact(value.replace(/^(?:група|группа)\s+/iu,''))
  // ЕБ was renamed ЕУБ; accept the usual Latin transliteration as well.
  // Matching is still restricted to the caller's current group pool and unique.
  const program=normalized.replace(/[еe]/gu,'e').replace(/[уuy]/gu,'u').replace(/[бb]/gu,'b')
  const alias=/^e(?:u)?b(\d+)$/u.exec(program)
  return alias?'eub'+alias[1]:normalized
}
function groupLabel(group:Row) {
  return [group.name,...(Number.isInteger(group.studyYear)&&group.studyYear>0?[`${group.studyYear} курс`]:[]),...(typeof group.program==='string'&&group.program?[group.program.slice(0,60)]:[])].join(' · ').slice(0,240)
}
function groupChoice(message:string,pool:Row[]) {
  const exact=matchChoice(message,pool.map(group=>({id:group.id,label:groupLabel(group)})))
  if(exact)return{choice:pool.find(group=>group.id===exact.id),ambiguous:false}
  const key=groupNameKey(message),matches=key?pool.filter(group=>groupNameKey(group.name)===key):[]
  return{choice:matches.length===1?matches[0]:undefined,ambiguous:matches.length>1}
}
function subjectMatches(query: string, subjects: Row[]) {
  const normalized = compact(query)
  const exactMatches = subjects.filter(item=>item.id===query || item.ref===query || compact(item.name)===normalized)
  if (exactMatches.length) return exactMatches
  if (mathAlias(query)) return subjects.filter(item=>/вищ[а-яіїє]*\s+математ|высш[а-я]*\s+математ/iu.test(item.name))
  if (normalized.length < 4) return []
  return subjects.filter(item=>compact(item.name).includes(normalized))
}

/** Authenticated, model-neutral router. The model receives no database records,
 * UUIDs, grades, protected materials or credentials and cannot confirm a write. */
export function createAuthenticatedAssistantChat(deps: CloudChatDependencies) {
  if (!deps || typeof deps.continuationSecret !== 'string' || deps.continuationSecret.length<32) throw new TypeError('chat_private_dependencies_required')
  const now = deps.now || Date.now
  const signature = (payload: string) => createHmac('sha256',deps.continuationSecret).update('xelay:assistant:chat:v1\0'+payload).digest('base64url')
  function pack(pending: Pending) { const payload=Buffer.from(JSON.stringify(pending)).toString('base64url'); const token=payload+'.'+signature(payload); if(token.length>32768) fail('invalid_request');return token }
  function unpack(token: unknown, owner: string): Pending | undefined {
    if (token===undefined) return undefined
    if (typeof token!=='string' || token.length>32768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) fail('chat_context_expired',409)
    const [payload,sig]=token.split('.'), expected=signature(payload)
    if (!timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) fail('chat_context_expired',409)
    let p: Row; try { p=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) } catch { return fail('chat_context_expired',409) }
    if (!exact(p,['v','owner','expires','stage','message','teacherBody','lessonId','resolvedDate','scope','intent']) || p.v!==1 || p.owner!==owner || !Number.isFinite(p.expires) || p.expires<=now() || p.expires>now()+900000 || !['group','body','subject','lesson','date','course','followup'].includes(p.stage) || !validText(p.message,6000,p.stage!=='followup') || p.teacherBody!==undefined&&!validText(p.teacherBody,10000) || p.lessonId!==undefined&&(typeof p.lessonId!=='string'||!UUID.test(p.lessonId)) || p.resolvedDate!==undefined&&!date(p.resolvedDate)) fail('chat_context_expired',409)
    if(p.stage==='followup'&&(!object(p.intent)||p.intent.kind!=='read'||p.teacherBody!==undefined||p.lessonId!==undefined||p.resolvedDate!==undefined||p.message!==''))fail('chat_context_expired',409)
    return {...p,scope:scopeOf(p.scope),...(p.intent?{intent:intentOf(p.intent)}:{})} as Pending
  }
  async function session(credential: string, signal?: AbortSignal) {
    if (signal?.aborted) fail('request_cancelled',499)
    const s=await deps.verifySession(credential,signal)
    if(!s || !s.accountActive || !s.emailConfirmed || !Number.isFinite(Date.parse(s.expiresAt)) || Date.parse(s.expiresAt)<=now()) fail('session_invalid',401)
    return s
  }
  return { async chat(credential: string, value: unknown, signal?: AbortSignal): Promise<CloudChatResult> {
    if (!exact(value,['message','teacherMessage','scope','history','continuation']) || !validText(value.message,6000,true) || value.teacherMessage!==undefined&&!validText(value.teacherMessage,10000)) fail('invalid_request')
    const history=value.history===undefined?[]:value.history
    if (!Array.isArray(history)||history.length>6||history.some(item=>!exact(item,['role','content'])||!['user','assistant'].includes(item.role)||!validText(item.content,6000))||history.reduce((sum,item)=>sum+item.content.length,0)>18000) fail('invalid_request')
    const s=await session(credential,signal),earlyScope=scopeOf(value.scope),earlyPending=unpack(value.continuation,s.userId)
    const earlyRead=earlyPending?.stage==='followup'&&earlyPending.intent?.kind==='read'&&earlyPending.intent.topic==='study'?earlyPending:undefined
    const clearHomework=value.teacherMessage===undefined&&!allSubjectRequest(value.message)&&explicitReadView(value.message)==='homework'&&shortReadRefinement(value.message,now())
    // A narrow read-only route can go straight to the authoritative caller read
    // service. It still verifies fresh membership, RLS, ownership and the final
    // session; it never uses the browser's role or the model to authorize access.
    if(clearHomework&&earlyScope.groupId&&!earlyScope.courseId&&!earlyScope.materialSubjectId&&earlyScope.mode!=='teaching'
      &&(!earlyPending||earlyRead&&earlyRead.scope.groupId===earlyScope.groupId)){
      const targetDate=statedDate(value.message,now())||(!dateHint(value.message)?earlyRead?.scope.date||earlyScope.date||kyivDate(now()):undefined)
      if(targetDate){
        const subjectId=earlyScope.subjectId||earlyRead?.scope.subjectId
        const readScope={groupId:earlyScope.groupId,...(subjectId?{subjectId}:{}),from:targetDate,to:targetDate,period:earlyRead?.scope.period||earlyScope.period||'current'}
        const read=await deps.read(credential,{topic:'study',scope:readScope,limit:100},signal)
        if(read.userId!==s.userId||!Array.isArray(read.records)||read.records.some((record:Row)=>!object(record)||record.groupId!==earlyScope.groupId||record.date!==targetDate||!['lesson','homework'].includes(record.kind)||subjectId&&record.subjectId!==subjectId))fail('repository_invalid_response',503)
        const current=await session(credential,signal);if(current.userId!==s.userId||current.sessionId!==s.sessionId)fail('session_changed',401)
        const selected=read.records.filter((record:Row)=>record.kind==='homework'),{modelContext:_hidden,...publicRead}=read
        publicRead.records=selected.slice(0,30);publicRead.truncated=read.truncated===true||selected.length>30;publicRead.view='homework';publicRead.topic='study';publicRead.scope=readScope
        const continuation=pack({v:1,owner:s.userId,expires:now()+900000,stage:'followup',message:'',intent:{kind:'read',topic:'study',view:'homework'},scope:{groupId:earlyScope.groupId,...(subjectId?{subjectId}:{}),date:targetDate,period:readScope.period}})
        return{userId:s.userId,kind:'read',text:readHeading('homework','study',targetDate,publicRead.records,now(),subjectId?read.records.find((record:Row)=>record.subjectId===subjectId)?.subjectName:undefined,publicRead.truncated),read:publicRead,continuation}
      }
    }
    const catalog=await deps.catalog(s,credential,signal)
    if(catalog.userId!==s.userId || !Array.isArray(catalog.groups)||catalog.groups.length>100||!Array.isArray(catalog.subjects)||catalog.subjects.length>1000||!Array.isArray(catalog.courses)||catalog.courses.length>200) fail('repository_invalid_response',503)
    const latest=async()=>{const current=await session(credential,signal);if(current.userId!==s.userId||current.sessionId!==s.sessionId) fail('session_changed',401)}
    await latest()
    let pending=unpack(value.continuation,s.userId)
    const originalPending=pending,conversation=value.teacherMessage===undefined?standaloneConversation(value.message):undefined
    const incomingScope=scopeOf(value.scope)
    const previousRead=pending?.stage==='followup'&&pending.intent?.kind==='read'&&['study','teaching'].includes(pending.intent.topic)?pending:undefined
    const refinementView=explicitReadView(value.message)
    const readFollowup=!!previousRead&&value.teacherMessage===undefined&&(shortDateFragment(value.message,now())||shortReadRefinement(value.message,now())&&(previousRead.intent!.kind==='read'&&previousRead.intent!.topic==='study'||refinementView==='schedule'))
    if(pending?.stage==='followup'&&!readFollowup)pending=undefined
    let scoped: Scope=readFollowup?{...pending!.scope}:pending?{...pending.scope,...incomingScope}:incomingScope
    let message=pending?.message||value.message, body=pending?.teacherBody??teacherCopy(message,value.teacherMessage), intent=pending?.intent, boundLesson=pending?.lessonId, resolvedDate=readFollowup?statedDate(value.message,now()):pending?.resolvedDate
    if(readFollowup&&intent?.kind==='read'&&refinementView)intent={...intent,view:refinementView}
    const allLearning=catalog.groups.filter((g:Row)=>g.learning===true),learning=allLearning.filter((g:Row)=>!testGroupIds.has(g.id)), teaching=catalog.courses.filter((c:Row)=>c.teaching===true&&Array.isArray(c.teachingGroupIds)&&c.teachingGroupIds.length)
    const allGroups=catalog.groups.filter((g:Row)=>g.learning===true||teaching.some((c:Row)=>c.teachingGroupIds.includes(g.id)))
    if(scoped.mode==='teaching'&&!teaching.length)fail('access_denied',403)
    const teacherHint=teaching.length>0&&(scoped.mode==='teaching'||!learning.length&&!scoped.groupId&&scoped.mode!=='learning'||pending?.intent?.kind==='read'&&['teaching','gradebook'].includes(pending.intent.topic)||!!scoped.courseId||/(?:як|как)\s+(?:викладач|преподавател)|(?:заняття|занятия|розклад|расписание)\s+(?:(?:мо[їи]|мого|свого)\s+)?(?:викладач|преподавател)|викладацьк[^.?!\n]{0,15}розклад|преподавательск[^.?!\n]{0,15}расписание|журнал/iu.test(userCommand(message)))
    if(incomingScope.groupId&&!allGroups.some((g:Row)=>g.id===incomingScope.groupId)||incomingScope.courseId&&!teaching.some((c:Row)=>c.id===incomingScope.courseId))fail('access_denied',403)
    if(incomingScope.subjectId&&!catalog.subjects.some((item:Row)=>item.id===incomingScope.subjectId&&(!incomingScope.groupId||item.groupId===incomingScope.groupId)))fail('invalid_scope')
    if(incomingScope.materialSubjectId&&!catalog.subjects.some((item:Row)=>item.id===incomingScope.materialSubjectId&&item.kind==='materials'&&(!incomingScope.groupId||item.groupId===incomingScope.groupId)))fail('invalid_scope')
    if(scoped.groupId&&!allGroups.some((g:Row)=>g.id===scoped.groupId)) fail('access_denied',403)
    // Even a greeting must not turn an invalid scope or a stale signed target
    // into accepted context. This checks metadata only, never study records.
    if(conversation&&originalPending){const previous=originalPending.scope
      if(previous.groupId&&!allGroups.some((g:Row)=>g.id===previous.groupId)||previous.courseId&&!teaching.some((c:Row)=>c.id===previous.courseId))fail('access_denied',403)
      if(previous.subjectId&&!catalog.subjects.some((item:Row)=>item.id===previous.subjectId&&(!previous.groupId||item.groupId===previous.groupId)))fail('invalid_scope')
      if(previous.materialSubjectId&&!catalog.subjects.some((item:Row)=>item.id===previous.materialSubjectId&&item.kind==='materials'&&(!previous.groupId||item.groupId===previous.groupId)))fail('invalid_scope')
    }
    const globalTeacherCalendar=teacherHint&&/(?:усіх|усі|всіх|всі|всех|все|загальн|общ)/iu.test(userCommand(message))&&/розклад|расписан|занят/iu.test(userCommand(message))
    if(globalTeacherCalendar) delete scoped.groupId
    const result=(kind:CloudChatResult['kind'],text:string,extra:Partial<CloudChatResult>={})=>({userId:s.userId,kind,text,...extra})
    if(conversation){
      const interruptedWrite=originalPending&&originalPending.stage!=='followup'
      return result('reply',conversationReply(conversation)+(interruptedWrite?' Попередню дію не виконую. Коли будете готові, сформулюйте її ще раз.':''),originalPending?.stage==='followup'?{continuation:value.continuation}:{} )
    }
    const clarify=(stage:Pending['stage'],text:string,items?:{id:string;label:string}[],type:'group'|'subject'|'lesson'='subject')=>result('clarify',text,{continuation:pack({v:1,owner:s.userId,expires:pending?.expires||now()+900000,stage,message,teacherBody:body,...(boundLesson?{lessonId:boundLesson}:{}),...(resolvedDate?{resolvedDate}:{}),scope:scoped,...(intent?{intent}:{})}),...(items?{choices:{type,items:items.slice(0,30)}}:{})})
    if(pending?.stage==='group') {
      const teachingChoice=!!scoped.courseId&&(pending.intent?.kind==='read'||pending.intent?.kind==='action'&&pending.intent.action.startsWith('teaching.'))
      const pool=teachingChoice?allGroups.filter((g:Row)=>teaching.some((c:Row)=>c.id===scoped.courseId&&c.teachingGroupIds.includes(g.id))):learning
      const resolved=incomingScope.groupId?{choice:(teachingChoice?pool:allLearning).find((g:Row)=>g.id===incomingScope.groupId),ambiguous:false}:groupChoice(value.message,pool)
      if(resolved.choice)scoped.groupId=resolved.choice.id
      else return clarify('group',resolved.ambiguous?'З такою назвою є кілька ваших груп. Оберіть потрібний курс у списку.':'Не вдалося однозначно знайти таку групу серед доступних. Оберіть її зі списку або напишіть номер варіанта.',pool.map((g:Row)=>({id:g.id,label:groupLabel(g)})),'group')
    }
    if(teacherHint&&scoped.groupId&&!teaching.some((c:Row)=>c.teachingGroupIds.includes(scoped.groupId))) delete scoped.groupId
    if(!scoped.groupId&&!teacherHint&&learning.length===1) scoped.groupId=learning[0].id
    let group=allGroups.find((g:Row)=>g.id===scoped.groupId)
    const subjects: Row[]=catalog.subjects.filter((item:Row)=>item.kind==='study'&&item.groupId===group?.id).map((item:Row,index:number)=>({...item,ref:'subject'+(index+1)}))
    const courses: Row[]=teaching.filter((c:Row)=>!group||c.teachingGroupIds.includes(group.id)).map((c:Row,index:number)=>({...c,ref:'course'+(index+1)}))
    if(scoped.subjectId&&!catalog.subjects.some((item:Row)=>item.id===scoped.subjectId&&item.groupId===group?.id)) fail('invalid_scope')
    if(scoped.courseId&&!courses.some((c:Row)=>c.id===scoped.courseId)) fail('access_denied',403)
    if(pending?.stage==='body') body=value.teacherMessage?.trim()?value.teacherMessage:value.message
    if(pending?.stage==='date') { const resolved=statedDate(value.message,now());if(resolved){scoped.date=resolved;resolvedDate=resolved} }
    if(pending?.stage==='subject') { const matches=subjectMatches(value.message,subjects);if(matches.length===1)scoped.subjectId=matches[0].id }
    if(pending?.stage==='course') { const choice=matchChoice(value.message,courses.map((c:Row)=>({id:c.id,label:c.name})));if(choice)scoped.courseId=choice.id }
    const unselectedLearning=!teacherHint&&!group&&learning.length>1
    const allowedActions=deps.writes.form?[...new Set(unselectedLearning?learning.flatMap((g:Row)=>allowedCloudSkillActions(g,courses,false)):allowedCloudSkillActions(group,courses,teacherHint))]:[]
    const allowedTopics:Topic[]=deps.writes.form
      ? [...(!teacherHint&&(group?.learning||unselectedLearning)?['study','materials','results','seminars'] as Topic[]:['teaching','materials','gradebook'] as Topic[]),'organizer','community','news','opportunities','help']
      : !teacherHint&&(group?.learning||unselectedLearning)?['study','materials','results']:['teaching','materials','gradebook']
    const previousReadCompatible=!!previousRead&&previousRead.intent?.kind==='read'
      &&previousRead.scope.groupId===scoped.groupId
      &&(!incomingScope.courseId||incomingScope.courseId===previousRead.scope.courseId)
      &&(!incomingScope.subjectId||incomingScope.subjectId===previousRead.scope.subjectId)
      &&(!previousRead.scope.courseId||courses.some((c:Row)=>c.id===previousRead.scope.courseId))
      &&(!previousRead.scope.subjectId||catalog.subjects.some((item:Row)=>item.id===previousRead.scope.subjectId&&item.groupId===scoped.groupId))
      &&allowedTopics.includes(previousRead.intent.topic)
    if(!intent&&!body&&value.teacherMessage===undefined&&!teacherHint&&(group?.learning||unselectedLearning)&&refinementView==='homework'&&shortReadRefinement(message,now()))intent={kind:'read',topic:'study',view:'homework'}
    if(!intent) {
      intent=intentOf(await deps.planner({message,...(body?{teacherMessage:body}:{}),history:history.filter(item=>item.role==='user'),signal,context:{now:new Date(now()).toISOString(),timeZone:'Europe/Kyiv',hasLearningGroup:!teacherHint&&!!group?.learning,...(scoped.materialSubjectId?{materialSubjectName:catalog.subjects.find((item:Row)=>item.id===scoped.materialSubjectId&&item.kind==='materials'&&item.groupId===group?.id)?.name}:{}),
        subjects:subjects.map((item:Row)=>({ref:item.ref,name:item.name})),courses:courses.map((c:Row)=>({ref:c.ref,name:c.name})),
        scope:{...(scoped.date?{date:scoped.date}:{}),...(scoped.subjectId?{subjectRef:subjects.find((item:Row)=>item.id===scoped.subjectId)?.ref}:{}),...(scoped.courseId?{courseRef:courses.find((c:Row)=>c.id===scoped.courseId)?.ref}:{}),period:scoped.period||'current'},
        ...(previousReadCompatible&&previousRead?.intent?.kind==='read'?{previousRead:{topic:previousRead.intent.topic as 'study'|'teaching',view:previousRead.intent.view||'all',...(previousRead.scope.date?{date:previousRead.scope.date}:{})}}:{}),
        allowedKinds:['reply','read','organizer',...(!teacherHint&&(group?.learning&&group.permissions.includes('homework')||unselectedLearning&&learning.some((g:Row)=>g.permissions.includes('homework')))?['homework']:[]),...(!teacherHint&&(group?.learning&&group.permissions.includes('schedule')||unselectedLearning&&learning.some((g:Row)=>g.permissions.includes('schedule')))?['schedule']:[]),...(allowedActions.length?['action']:[]),'clarify','unsupported'],allowedTopics,...(allowedActions.length?{allowedActions}:{})}}))
      await latest()
    }
    if(intent.kind==='read'&&!allowedTopics.includes(intent.topic))fail('model_invalid_response',503)
    if(intent.kind==='read'&&['study','teaching'].includes(intent.topic)){
      const inheritedIntent=previousReadCompatible&&previousRead?.intent?.kind==='read'&&previousRead.intent.topic===intent.topic?previousRead.intent:undefined
      const allSubjects=intent.topic==='study'&&allSubjectRequest(message)
      if(allSubjects){delete scoped.subjectId;intent={...intent,subject:undefined}}
      intent={...intent,view:(shortReadRefinement(message,now())?explicitReadView(message):undefined)||intent.view||explicitReadView(message)||inheritedIntent?.view||'all'}
      if(!allSubjects&&inheritedIntent&&previousRead&&!intent.subject&&!incomingScope.subjectId&&previousRead.scope.subjectId)scoped.subjectId=previousRead.scope.subjectId
      if(inheritedIntent&&previousRead&&!intent.courseRef&&!incomingScope.courseId&&previousRead.scope.courseId)scoped.courseId=previousRead.scope.courseId
    }
    if(intent.kind==='unsupported'&&group?.learning&&!group.permissions.includes('homework')&&/додай|добав|змін|измен|поменяй|онов/iu.test(message.split('\n')[0])&&/(?:^|[^\p{L}])дз[ьъ]?(?:$|[^\p{L}])|домашн|домашк|д[\/\\]з|(?:додай|добав[ьити]*|змін[а-яіїє]*|измен[а-я]*)\s*дз/iu.test(message.split('\n')[0])) return result('unsupported','Спільне ДЗ групи може додавати й змінювати староста або заступник із відповідним доступом. Можу натомість підготувати особисту справу у вашому органайзері.')
    if(intent.kind==='reply')return result('reply',intent.text)
    if(intent.kind==='clarify')return result('clarify',intent.text)
    if(intent.kind==='unsupported')return result('unsupported','Я допомагаю з розкладом, ДЗ, матеріалами, балами та особистими справами у Xelay. Спробуйте запит про них.')
    const commandSource=userCommand(message),sources=[commandSource,...(body?[body]:[])]
    const command=commandSource,commandDate=statedDate(command,now()),bodyDate=statedDate(body||'',now())
    const signedReadDate=intent.kind==='read'&&previousReadCompatible&&previousRead?.intent?.kind==='read'&&previousRead.intent.topic===intent.topic?previousRead.scope.date:undefined
    const requestedDate=resolvedDate||commandDate||(!dateHint(command)?bodyDate||(!dateHint(body||'')?signedReadDate||scoped.date:undefined):undefined)
    if(requestedDate)resolvedDate=requestedDate
    const needsLearningGroup=intent.kind==='homework'||intent.kind==='schedule'||intent.kind==='read'&&['study','materials','results','seminars'].includes(intent.topic)||intent.kind==='action'&&!['organizer.task.create','community.compose'].includes(intent.action)
    if(unselectedLearning&&needsLearningGroup)return clarify('group','У вас кілька навчальних груп. Для якої підготувати відповідь?',learning.map((g:Row)=>({id:g.id,label:groupLabel(g)})),'group')
    if(intent.kind==='action') {
      if(intent.courseRef&&!scoped.courseId){const chosen=courses.find(c=>c.ref===intent.courseRef);if(!chosen)fail('access_denied',403);scoped.courseId=chosen.id}
      else if(teacherHint&&!scoped.courseId&&courses.length===1)scoped.courseId=courses[0].id
      if(intent.action.startsWith('teaching.')){
        if(!scoped.courseId)return clarify('course','Для якого вашого предмета підготувати форму?',courses.map((c:Row)=>({id:c.id,label:c.name})))
        if(!group){const connected=allGroups.filter((g:Row)=>teaching.some((c:Row)=>c.id===scoped.courseId&&c.teachingGroupIds.includes(g.id)));if(connected.length===1){group=connected[0];scoped.groupId=group!.id}else return clarify('group','Оберіть підключену групу для відкриття форми. Для спільного завдання чи матеріалу далі можна вибрати кілька груп.',connected.map((g:Row)=>({id:g.id,label:groupLabel(g)})),'group')}
      }
      if(intent.subject&&group?.learning){const matched=subjectMatches(intent.subject,subjects);if(matched.length===1)scoped.subjectId=matched[0].id}
      const actionDate=resolvedDate||statedDate(commandSource,now());if(actionDate)scoped.date=actionDate
      await latest()
      const routed=await routeCloudSkill({credential,userId:s.userId,action:intent.action,command:commandSource,body,scope:scoped,group,courses,allowedActions,now:now(),read:deps.read,form:deps.writes.form?.bind(deps.writes),signal})
      await latest();return routed as CloudChatResult
    }
    if(intent.kind!=='read'&&!explicitWriteCommand(intent.kind,commandSource))return result('clarify','Зміни не підготовлено. Напишіть прямо, що потрібно додати або змінити: ДЗ до пари, нову пару чи особисту справу.')
    if(intent.kind==='organizer') {
      const title=literalUserFragment(intent.title,sources,200)||(commandSource.trim().length<=200?commandSource.trim():'Особиста справа')
      const notes=body&&!message.includes(body)?message+'\n'+body:message
      if(!title||notes.length>10000)return result('clarify','Напишіть назву й повний текст особистої справи, разом до 10 000 символів.')
      if(deps.writes.form&&(statedDate(commandSource,now())||/нагад|напом|повтор|термін|срок|дедлайн/iu.test(commandSource))) {
        const ready=await deps.writes.form(credential,{action:'organizer.task.create',scope:{},payload:{title,notes,...(statedDate(commandSource,now())?{dueDate:statedDate(commandSource,now())}:{})}})
        await latest();return result('clarify','Уточніть час і нагадування для особистої справи, потім перевірте чернетку.',{form:ready.form})
      }
      await latest();const prepared=await deps.writes.prepare(credential,{action:'organizer.task.create',scope:{},payload:{title,notes,space:'personal',dueAt:null}})
      return result('draft','Підготував особисту справу. Перевірте чернетку перед збереженням.',{draft:prepared.draft})
    }
    if(intent.kind==='read'&&['study','teaching'].includes(intent.topic)&&!requestedDate&&(dateHint(command)||dateHint(body||''))) return clarify('date','Уточніть дату перегляду: наприклад, «2 листопада» або «на завтра».')
    if(intent.kind==='homework'||intent.kind==='schedule') {
      if(!group?.learning || !group.permissions.includes(intent.kind==='homework'?'homework':'schedule')) return result('unsupported','Змінювати розклад і спільне ДЗ може староста або заступник із відповідним доступом. Ви можете створити особисту справу.')
      if(!requestedDate) return clarify('date','На яку дату підготувати зміну? Напишіть дату або «на завтра».')
      scoped.date=requestedDate
      if(intent.kind==='schedule') {
        const subject=groundedScheduleSubject(intent.subject,sources,subjects),startsAt=userTime(intent.startsAt,sources),endsAt=userTime(intent.endsAt,sources),lessonType=groundedLessonType(sources)
        if(!subject||!startsAt||!endsAt||!lessonType)return result('clarify','Напишіть точну назву предмета, дату й обидва часи у форматі 08:30–09:50. Якщо є кілька типів занять, уточніть один.')
        await latest();const prepared=await deps.writes.prepare(credential,{action:'schedule.create',scope:{groupId:group.id,date:requestedDate},payload:{date:requestedDate,subject,startsAt,endsAt,lessonType,teacherName:literalUserFragment(intent.teacherName,sources,180)||'',location:literalUserFragment(intent.location,sources,160)||'',recurring:false,week:'both'}})
        return result('draft','Підготував пару. Перевірте дату, час і предмет перед збереженням.',{draft:prepared.draft})
      }
      const read=await deps.read(credential,{topic:'study',scope:{groupId:group.id,from:requestedDate,to:requestedDate,period:'current'},limit:100},signal)
      if(read.userId!==s.userId||!Array.isArray(read.records)||read.truncated) fail('repository_invalid_response',503)
      let lessons=read.records.filter((row:Row)=>row.kind==='lesson'&&row.groupId===group.id&&row.date===requestedDate&&typeof row.scheduleId==='string'&&UUID.test(row.scheduleId))
      const subject=scoped.subjectId?subjects.filter((item:Row)=>item.id===scoped.subjectId):intent.subject?subjectMatches(intent.subject,subjects):[]
      if(subject.length===1&&!scoped.subjectId&&!cloudSubjectEvidence(subject[0].name,intent.subject,sources,subjects.map((item:Row)=>item.name)))return clarify('subject','Не можу підтвердити предмет за вашим текстом. Оберіть його зі своєї групи.',subjects.map((item:Row)=>({id:item.id,label:item.name})))
      if(subject.length===1) { scoped.subjectId=subject[0].id;lessons=lessons.filter((row:Row)=>row.subjectId===subject[0].id) }
      else if(intent.subject||lessons.length>1&&new Set(lessons.map((row:Row)=>row.subjectId)).size>1) return clarify('subject','Який предмет? Оберіть назву зі своєї групи.',subjects.map((item:Row)=>({id:item.id,label:item.name})))
      if(!lessons.length) return result('clarify','На цю дату потрібної пари в розкладі немає. Перевірте дату або спочатку додайте пару у групі.')
      const lessonChoices=lessons.map((row:Row)=>({id:row.scheduleId,label:row.startsAt+' · '+row.title}))
      let lesson=boundLesson?lessons.find((row:Row)=>row.scheduleId===boundLesson):lessons.length===1?lessons[0]:undefined
      if(pending?.stage==='lesson') { const chosen=matchChoice(value.message,lessonChoices);lesson=chosen?lessons.find((row:Row)=>row.scheduleId===chosen.id):undefined }
      if(!lesson) return clarify('lesson','Цього дня є кілька таких занять. До якої пари додати ДЗ?',lessonChoices,'lesson')
      boundLesson=lesson.scheduleId
      if(!body?.trim()) return clarify('body','Надішліть повне повідомлення викладача наступним повідомленням. Умови й винятки збережу без скорочення.')
      const deadlineMatches=[body.match(/(?:вільний\s+термін|свободный\s+срок|без\s+(?:терміну|срока|дедлайну|дедлайна)|термін|дедлайн|deadline|срок\s+сдачи|до\s+(?:\d|завтра|післязавтра|послезавтра|понед|вівтор|серед|четвер|п[’']?ят|субот|неділ))[^\n]*/iu),
        body.match(/(?:здати|сдать)\s+(?=(?:до(?=$|[^\p{L}])|сьогодні|сегодня|завтра|післязавтра|послезавтра|наступн|следующ|(?:в|у|на)\s+(?:\d|понед|понедель|вівтор|вторник|серед|сред[ауы]|четвер|п[’']?ят|пятниц|субот|суббот|неділ|воскрес)|(?:після|после)\s+(?:пари|пары|занят)|через\s+\d|\d{1,2}[./]\d{1,2}|\d{4}-\d{2}-\d{2}))[^\n]*/iu)]
      const deadlineSource=deadlineMatches.filter((match):match is RegExpMatchArray=>!!match).sort((a,b)=>(a.index||0)-(b.index||0))[0]?.[0]
      const dueAt=deadlineSource?parseCloudAssistantDeadline(deadlineSource,now()):null
      const payload={lessonId:lesson.scheduleId,date:requestedDate,topic:literalUserFragment(intent.topic,sources,240)||'Домашнє завдання',body,dueAt:dueAt??null}
      if(deadlineSource&&dueAt===undefined&&deps.writes.form){const ready=await deps.writes.form(credential,{action:'homework.upsert',scope:{groupId:group.id,date:requestedDate},payload});return result('clarify','У повідомленні є термін здачі. Уточніть його дату й час або виберіть вільний термін.',{form:ready.form})}
      await latest();const prepared=await deps.writes.prepare(credential,{action:'homework.upsert',scope:{groupId:group.id,date:requestedDate},payload})
      return result('draft','Підготував ДЗ до потрібної пари. Повний текст збережений у чернетці; перевірте її й підтвердьте.',{draft:prepared.draft})
    }
    const topic=intent.topic
    if(['organizer','community','news','opportunities','help'].includes(topic)) {
      const read=await deps.read(credential,{topic,scope:{query:commandSource,period:scoped.period||'current'},limit:30},signal)
      if(read.userId!==s.userId||!Array.isArray(read.records))fail('repository_invalid_response',503)
      await latest();const {modelContext:_private,...publicRead}=read
      return result('read',read.records.length?'Ось знайдені записи. Відкрийте джерело для повного перегляду.':emptyReadText(topic,undefined,now()),{read:publicRead})
    }
    if(['teaching','gradebook'].includes(topic)&&!teaching.length)fail('access_denied',403)
    let course=scoped.courseId?courses.find((c:Row)=>c.id===scoped.courseId):intent.courseRef?courses.find((c:Row)=>c.ref===intent.courseRef):courses.length===1?courses[0]:undefined
    if(!scoped.courseId&&!group?.learning&&intent.subject) { const matches=subjectMatches(intent.subject,courses);if(matches.length===1)course=matches[0];else return clarify('course','Оберіть ваш предмет викладання.',courses.map((c:Row)=>({id:c.id,label:c.name}))) }
    if((topic==='gradebook'||topic==='materials'&&!group?.learning)&&!course) return clarify('course','Для якого предмета викладання показати записи?',courses.map((c:Row)=>({id:c.id,label:c.name})))
    if(course&&(topic==='gradebook'&&!course.permissions?.includes('grades')||topic==='materials'&&!group?.learning&&!course.permissions?.includes('materials')))fail('access_denied',403)
    if(course&&(topic==='gradebook'||topic==='materials'&&!group?.learning)&&!group) {
      if(course.teachingGroupIds.length===1) { scoped.groupId=course.teachingGroupIds[0];group=allGroups.find((g:Row)=>g.id===scoped.groupId) }
      else { scoped.courseId=course.id;return clarify('group','Для якої підключеної групи показати записи?',allGroups.filter((g:Row)=>course.teachingGroupIds.includes(g.id)).map((g:Row)=>({id:g.id,label:groupLabel(g)})),'group') }
    }
    if((topic==='study'||topic==='results')&&!group?.learning) return result('unsupported','Ці записи доступні учасникам навчальної групи. Ваш розклад є у «Мої заняття».')
    const selectionSubjects=topic==='materials'?catalog.subjects.filter((item:Row)=>item.kind==='materials'&&item.groupId===group?.id):subjects
    let selectedSubject=topic==='materials'&&scoped.materialSubjectId?selectionSubjects.find((item:Row)=>item.id===scoped.materialSubjectId):scoped.subjectId?selectionSubjects.find((item:Row)=>item.id===scoped.subjectId):undefined
    const requestedSubject=intent.subject?(subjects.find((item:Row)=>item.ref===intent.subject)?.name||intent.subject):topic==='materials'&&scoped.materialSubjectId?undefined:scoped.subjectId?subjects.find((item:Row)=>item.id===scoped.subjectId)?.name:undefined
    if(group?.learning&&requestedSubject) {const matches=subjectMatches(requestedSubject,selectionSubjects);if(matches.length===1)selectedSubject=matches[0];else return result('clarify','Уточніть повну назву предмета, щоб показати правильні записи.')}
    const teacherSubject=course?.subjects?.find((item:Row)=>item.groupId===group?.id)?.subjectId
    const readScope={...(group?{groupId:group.id}:{}),...(course?{courseId:course.id}:{}),...(selectedSubject?{subjectId:selectedSubject.id}:teacherSubject?{subjectId:teacherSubject}:{}),...(['study','teaching'].includes(topic)?{from:requestedDate||kyivDate(now()),to:requestedDate||kyivDate(now())}:{}),period:scoped.period||'current'}
    const view=intent.view||'all'
    const read=await deps.read(credential,{topic,scope:readScope,limit:topic==='study'&&view==='homework'?100:30},signal)
    if(read.userId!==s.userId||!Array.isArray(read.records)) fail('repository_invalid_response',503)
    await latest();const {modelContext:_hidden,...publicRead}=read
    const selectedRecords=topic==='study'&&view!=='all'?read.records.filter((record:Row)=>record.kind===(view==='homework'?'homework':'lesson')):read.records
    publicRead.records=selectedRecords.slice(0,30);publicRead.truncated=read.truncated===true||selectedRecords.length>30;publicRead.topic=topic;publicRead.scope=readScope
    if(['study','teaching'].includes(topic))publicRead.view=view
    const continuation=pack({v:1,owner:s.userId,expires:now()+900000,stage:'followup',message:'',intent:{kind:'read',topic,...(['study','teaching'].includes(topic)?{view}:{})},scope:{...(readScope.groupId?{groupId:readScope.groupId}:{}),...(readScope.courseId?{courseId:readScope.courseId}:{}),...(readScope.subjectId?{subjectId:readScope.subjectId}:{}),...(readScope.from?{date:readScope.from}:{}),period:scoped.period||'current'}})
    return result('read',readHeading(view,topic,readScope.from,publicRead.records,now(),selectedSubject?.name,publicRead.truncated),{read:publicRead,continuation})
  }}
}
