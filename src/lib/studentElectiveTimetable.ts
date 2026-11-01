import type { LessonType, TimetableLesson, WeekPattern } from './studyGroupTimetableTypes.ts'
import { normalizeScheduleConferenceAccess, normalizeScheduleExtraLinks, safeLessonUrl, type ScheduleExtraLink } from './studyGroupLinks.ts'

export const STUDENT_ELECTIVE_MAX_LESSONS = 20
export const STUDENT_ELECTIVE_MAX_PLAN_BYTES = 128000
export type StudentElectiveMeeting = {
  id: string; subject: string; weekday: number; starts_at: string; ends_at: string;
  lesson_type: LessonType; teacher_name: string; location: string;
  online_url: string | null; online_url_secondary: string | null;
  online_url_label?: string | null; online_url_secondary_label?: string | null;
  online_links_extra: ScheduleExtraLink[]; conference_id: string | null; conference_access_code: string | null;
  week_pattern: WeekPattern; week_anchor_date: string | null;
}
export type StudentElectivePlan = {
  id: string; user_id: string; group_id: string; valid_from: string; valid_until: string;
  configured: boolean; version: number; lessons: StudentElectiveMeeting[];
  created_at?: string; updated_at?: string;
}
export type StudentElectivePlanInput = {
  groupId: string; validFrom: string; validUntil: string; configured: boolean;
  lessons: StudentElectiveMeeting[]; expectedVersion?: number | null; planId?: string;
}
export type StudentElectiveProjectedLesson = TimetableLesson & {
  source_kind?: 'personal-elective'; personal_elective_id?: string; personal_elective_plan_id?: string;
  source_schedule_id?: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const lessonTypes:LessonType[]=['lecture','seminar','practical','lab','makeup','replacement','module','final_assessment','test','other']
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, any>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
function invalid(code='STUDENT_ELECTIVE_INVALID'):never { throw Object.assign(new Error(code),{code}) }
export const isStudentElectiveId = (value:unknown):value is string => typeof value==='string' && UUID.test(value) && value!=='00000000-0000-0000-0000-000000000000'
const id=(value:unknown)=>isStudentElectiveId(value)?value.toLowerCase():invalid()
const text=(value:unknown,max:number,required=false)=>{
  if(typeof value!=='string'||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value))return invalid()
  const normalized=value.trim().replace(/\s+/gu,' ')
  if(Array.from(normalized).length>max||required&&!normalized)return invalid()
  return normalized
}
const nullableText=(value:unknown,max:number)=>value==null?null:text(value,max)||null
const clock=(value:unknown)=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value)?value.slice(0,5):invalid()
// Calendar arithmetic uses UTC only as a date container. This module deliberately
// has no runtime import of studyGroupTimetable, which constructs a browser SDK.
const isTimetableDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value
const addTimetableDays=(value:string,days:number)=>new Date(Date.parse(value+'T00:00:00Z')+days*86400000).toISOString().slice(0,10)
const mondayForDate=(value:string)=>addTimetableDays(value,1-(new Date(value+'T00:00:00Z').getUTCDay()||7))
function scheduleOccursOnDate(item:TimetableLesson,date:string):boolean {
  if(!isTimetableDate(date)||item.excluded_dates?.includes(date)||(new Date(date+'T00:00:00Z').getUTCDay()||7)!==item.weekday)return false
  if(item.valid_from!=='-infinity'&&(!isTimetableDate(item.valid_from)||date<item.valid_from)||item.valid_until!=='infinity'&&(!isTimetableDate(item.valid_until)||date>item.valid_until))return false
  const pattern=item.week_pattern||'every'
  if(pattern==='every')return true
  if(!['upper','lower'].includes(pattern)||!isTimetableDate(item.week_anchor_date)||mondayForDate(item.week_anchor_date)!==item.week_anchor_date)return false
  const weeks=Math.round((Date.parse(mondayForDate(date)+'T00:00:00Z')-Date.parse(item.week_anchor_date+'T00:00:00Z'))/(7*86400000))
  return (((weeks%2)+2)%2===0?'upper':'lower')===pattern
}
const url=(value:unknown)=>{
  if(value==null||value==='')return null
  const original=text(value,2000),normalized=safeLessonUrl(original)
  if(!normalized||normalized.length>2000||new URL(normalized).username||new URL(normalized).password)return invalid()
  return normalized
}
export function validateStudentElectiveTerm(from:string,until:string):void {
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(from)||!/^20\d{2}-\d{2}-\d{2}$/.test(until)||!isTimetableDate(from)||!isTimetableDate(until)||until<from||Date.parse(until+'T00:00:00Z')-Date.parse(from+'T00:00:00Z')>366*86400000)invalid('STUDENT_ELECTIVE_TERM_INVALID')
}
export function normalizeStudentElectiveMeetings(value:unknown):StudentElectiveMeeting[] {
  if(!Array.isArray(value)||value.length>STUDENT_ELECTIVE_MAX_LESSONS)invalid()
  const meetings=value.map(item=>{
    if(!object(item)||!exact(item,['id','subject','weekday','starts_at','ends_at','lesson_type','teacher_name','location','online_url','online_url_secondary','online_url_label','online_url_secondary_label','online_links_extra','conference_id','conference_access_code','week_pattern','week_anchor_date']))return invalid()
    if(!Number.isInteger(item.weekday)||item.weekday<1||item.weekday>7||!lessonTypes.includes(item.lesson_type))return invalid()
    const starts_at=clock(item.starts_at),ends_at=clock(item.ends_at),week_pattern=item.week_pattern??'every'
    if(ends_at<=starts_at||!['every','upper','lower'].includes(week_pattern))return invalid()
    const week_anchor_date=week_pattern==='every'?null:item.week_anchor_date
    if(week_pattern!=='every'&&(typeof week_anchor_date!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(week_anchor_date)||!isTimetableDate(week_anchor_date)||mondayForDate(week_anchor_date)!==week_anchor_date))return invalid()
    const conference=normalizeScheduleConferenceAccess(item)
    return {id:id(item.id),subject:text(item.subject,120,true),weekday:item.weekday,starts_at,ends_at,lesson_type:item.lesson_type as LessonType,
      teacher_name:text(item.teacher_name??'',180),location:text(item.location??'',160),online_url:url(item.online_url),online_url_secondary:url(item.online_url_secondary),
      online_url_label:nullableText(item.online_url_label,80),online_url_secondary_label:nullableText(item.online_url_secondary_label,80),
      online_links_extra:normalizeScheduleExtraLinks(item.online_links_extra),...conference,week_pattern:week_pattern as WeekPattern,week_anchor_date}
  })
  if(new Set(meetings.map(item=>item.id)).size!==meetings.length||new TextEncoder().encode(JSON.stringify(meetings)).byteLength>STUDENT_ELECTIVE_MAX_PLAN_BYTES)invalid()
  return meetings
}
export function normalizeStudentElectivePlan(value:unknown):StudentElectivePlan {
  if(!object(value)||!exact(value,['id','user_id','group_id','valid_from','valid_until','configured','version','lessons','created_at','updated_at'])||typeof value.configured!=='boolean'||!Number.isSafeInteger(value.version)||value.version<1||value.version>1000000)invalid()
  validateStudentElectiveTerm(value.valid_from,value.valid_until)
  const result:StudentElectivePlan={id:id(value.id),user_id:id(value.user_id),group_id:id(value.group_id),valid_from:value.valid_from,valid_until:value.valid_until,configured:value.configured,version:value.version,lessons:normalizeStudentElectiveMeetings(value.lessons)}
  for(const key of ['created_at','updated_at'] as const)if(value[key]!==undefined){if(typeof value[key]!=='string'||!Number.isFinite(Date.parse(value[key])))invalid();result[key]=value[key]}
  return result
}
function usablePlans(plans:StudentElectivePlan[],userId:string,groupId:string,date:string) {
  return plans.filter(plan=>plan.user_id===userId&&plan.group_id===groupId&&plan.configured&&plan.valid_from<=date&&date<=plan.valid_until).map(normalizeStudentElectivePlan)
}
function activeBlock(schedule:TimetableLesson[],groupId:string,date:string) {
  return schedule.some(item=>item.group_id===groupId&&item.is_elective_block===true&&(item.valid_from==='-infinity'||item.valid_from<=date)&&(item.valid_until==='infinity'||date<=item.valid_until))
}
export function studentElectiveSetupState(schedule:TimetableLesson[],plans:StudentElectivePlan[],userId:string,groupId:string,date:string) {
  if(!isStudentElectiveId(userId)||!isStudentElectiveId(groupId)||!isTimetableDate(date))invalid()
  const hasElectiveBlocks=activeBlock(schedule,groupId,date),matches=usablePlans(plans,userId,groupId,date)
  // Overlapping or cross-account cached plans never replace the group calendar.
  const plan=hasElectiveBlocks&&matches.length===1?matches[0]:undefined
  return {hasElectiveBlocks,configured:!!plan,needsSetup:hasElectiveBlocks&&!plan,...(plan?{plan}:{})}
}
export function isPersonalElectiveLesson(value:unknown):value is StudentElectiveProjectedLesson & {source_kind:'personal-elective';personal_elective_id:string;personal_elective_plan_id:string} {
  return object(value)&&value.source_kind==='personal-elective'&&isStudentElectiveId(value.personal_elective_id)&&isStudentElectiveId(value.personal_elective_plan_id)
}
/** Day projection only. Never persist these rows to the shared schedule table. */
export function projectStudentElectiveTimetable(schedule:TimetableLesson[],plans:StudentElectivePlan[],userId:string,groupId:string,date:string):StudentElectiveProjectedLesson[] {
  const state=studentElectiveSetupState(schedule,plans,userId,groupId,date)
  const shared=schedule.filter(item=>item.group_id===groupId&&scheduleOccursOnDate(item,date)&&(!state.configured||!item.is_elective_block)).map(item=>({...item}))
  const personal:StudentElectiveProjectedLesson[]=state.plan?state.plan.lessons.map(item=>({
    ...item,id:item.id,group_id:groupId,valid_from:state.plan!.valid_from,valid_until:state.plan!.valid_until,created_by:userId,
    source_kind:'personal-elective' as const,personal_elective_id:item.id,personal_elective_plan_id:state.plan!.id,
    is_elective_block:false,
  })).filter(item=>scheduleOccursOnDate(item,date)):[]
  return [...shared,...personal].sort((a,b)=>a.starts_at.localeCompare(b.starts_at)||a.ends_at.localeCompare(b.ends_at)||a.id.localeCompare(b.id))
}
export function studentElectiveConflictDates(meetings:StudentElectiveMeeting[],from:string,until:string):string[] {
  validateStudentElectiveTerm(from,until)
  const normalized=normalizeStudentElectiveMeetings(meetings),conflicts:string[]=[]
  for(let day=from;day<=until;day=addTimetableDays(day,1)){
    const occurring=normalized.filter(item=>scheduleOccursOnDate({...item,group_id:'',created_by:'',valid_from:from,valid_until:until},day)).sort((a,b)=>a.starts_at.localeCompare(b.starts_at))
    if(occurring.some((item,index)=>index>0&&occurring.slice(0,index).some(previous=>previous.ends_at>item.starts_at)))conflicts.push(day)
  }
  return conflicts
}
export function studentElectiveError(value:unknown):string {
  const rawCode=object(value)?String(value.code||''):''
  const code=object(value)?rawCode+' '+String(value.message||''):''
  if(code.includes('CONFLICT')||rawCode==='40001')return'Налаштування вже змінилися. Оновіть їх і перевірте перед збереженням.'
  if(code.includes('OVERLAP'))return'Особисті вибіркові заняття перетинаються. Перевірте час і чергування тижнів.'
  if(code.includes('MEMBER')||rawCode==='42501'||code.includes('ACCOUNT'))return'Доступ до акаунта або групи змінився. Увійдіть знову й оновіть сторінку.'
  if(code.includes('BLOCK'))return'У цьому періоді староста ще не позначив вибіркові дисципліни.'
  if(code.includes('TERM'))return'Перевірте початок і завершення навчального періоду.'
  if(code.includes('CANCEL')||rawCode==='AbortError'||object(value)&&value.name==='AbortError')return'Збереження скасовано. Введені дані залишаються у формі.'
  return'Не вдалося зберегти особисті вибіркові заняття. Перевірте поля й спробуйте ще раз.'
}
