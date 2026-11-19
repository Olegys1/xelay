import type { TeacherInsights, TeacherInsightsScope, TeacherReminder, TeacherTestConditions } from './teacherAssistantTools'
import { supabase } from './supabase'
import { teacherLearningObject, teacherLearningUuid, validateTeacherLearningDraft, validateTeacherLearningRequest, validateTeacherLearningSave, validateTeacherLearningStatus } from './teacherLearningValidation'
import type { TeacherLearningDraft, TeacherLearningRequest, TeacherLearningSave, TeacherLearningStatus } from './teacherLearning'
export type { TeacherLearningDraft, TeacherLearningRequest, TeacherLearningSave, TeacherLearningStatus } from './teacherLearning'

export type TeacherLearningCandidates = { submissions: { id: string; label: string }[]; tests: { id: string; title: string }[] }
export type TeacherLearningClient = {
  status(signal?: AbortSignal): Promise<TeacherLearningStatus>
  history(signal?: AbortSignal): Promise<{ drafts: TeacherLearningDraft[] }>
  candidates(scope: { courseId: string; groupIds: string[] }, signal?: AbortSignal): Promise<TeacherLearningCandidates>
  generate(request: TeacherLearningRequest, signal?: AbortSignal): Promise<TeacherLearningDraft>
  insights?(scope: TeacherInsightsScope, signal?: AbortSignal): Promise<TeacherInsights>
  reminders?(operation: 'list' | 'create' | 'cancel', payload?: Record<string, unknown>, signal?: AbortSignal): Promise<TeacherReminder[]>
  createTest?(draftId: string, conditions: TeacherTestConditions, signal?: AbortSignal): Promise<{testId: string; replayed: boolean}>
  saveDraft(save: TeacherLearningSave, signal?: AbortSignal): Promise<TeacherLearningDraft>
}
const messages: Record<string,string> = {
  signed_out:'Увійдіть до свого облікового запису.',identity_changed:'Акаунт змінився. Відкрийте помічника ще раз.',
  forbidden:'Для цієї дії потрібні чинні права викладача й відповідний тариф.',quota_exhausted:'Ліміту ШІ цього періоду недостатньо для нового запиту.',
  invalid_request:'Перевірте обраний предмет, групу та умови завдання.',conflict:'Дані змінилися. Оновіть чернетку перед збереженням.',
  pending:'Попередній запит ще виконується. Дочекайтеся його завершення.',unavailable:'Помічник тимчасово недоступний. Збережені чернетки залишаються у вашому акаунті.',
  generation_failed:'Не вдалося завершити відповідь. Новий платний запит автоматично не запускається.',invalid_response:'Не вдалося перевірити відповідь сервера.',
  refused:'Не вдалося безпечно опрацювати цей текст.',context_changed:'Робота, критерії або права доступу змінилися. Оновіть вибраний контекст.',
}
export class TeacherLearningError extends Error { constructor(public readonly code:string, public readonly status=503) { super(messages[code]||messages.unavailable);this.name='TeacherLearningError' } }
export function createTeacherLearningClient(options: { currentUserId(): string | null; session(): Promise<{ userId: string; accessToken: string } | null>; fetcher?: typeof fetch; endpoint?: string }): TeacherLearningClient {
  const fetcher=options.fetcher||fetch, endpoint=options.endpoint||'/api/teacher-learning'
  async function call(action:string,payload:Record<string,unknown>={},signal?:AbortSignal){
    const expectedOwner=options.currentUserId(),session=await options.session(),owner=expectedOwner||options.currentUserId()
    if(!owner||!session)throw new TeacherLearningError('signed_out',401)
    if(session.userId!==owner)throw new TeacherLearningError('identity_changed',401)
    let response:Response
    try{response=await fetcher(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+session.accessToken},credentials:'same-origin',cache:'no-store',body:JSON.stringify({action,...payload}),signal})}catch{throw new TeacherLearningError(signal?.aborted?'cancelled':'unavailable')}
    const text=await response.text();if(new TextEncoder().encode(text).length>5_300_000)throw new TeacherLearningError('invalid_response')
    const latest=await options.session()
    const identity=(token:string)=>{try{const claims=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));return typeof claims.session_id==='string'&&claims.sub===owner?claims.session_id:null}catch{return null}}
    if(options.currentUserId()!==owner||!latest||latest.userId!==owner||!identity(session.accessToken)||identity(latest.accessToken)!==identity(session.accessToken))throw new TeacherLearningError('identity_changed',401)
    let result:any;try{result=JSON.parse(text)}catch{throw new TeacherLearningError('invalid_response')}
    if(!response.ok)throw new TeacherLearningError(teacherLearningObject(result)&&typeof result.code==='string'?result.code:'unavailable',response.status)
    if(!teacherLearningObject(result)||result.userId!==owner)throw new TeacherLearningError('identity_changed',401)
    return result
  }
  return {
    async status(signal){return validateTeacherLearningStatus(await call('status',{},signal))},
    async history(signal){const r=await call('history',{},signal);if(!Array.isArray(r.drafts)||r.drafts.length>50)throw new TeacherLearningError('invalid_response');return {drafts:r.drafts.map(validateTeacherLearningDraft)}},
    async candidates(scope,signal){if(!teacherLearningUuid(scope.courseId)||!Array.isArray(scope.groupIds)||scope.groupIds.length<1||scope.groupIds.length>10||scope.groupIds.some(id=>!teacherLearningUuid(id)))throw new TeacherLearningError('invalid_request',400);const r=await call('candidates',{scope},signal);if(!Array.isArray(r.submissions)||!Array.isArray(r.tests)||r.submissions.length>50||r.tests.length>50||r.submissions.some((s:any)=>!teacherLearningObject(s)||!teacherLearningUuid(s.id)||typeof s.label!=='string'||s.label.length>350)||r.tests.some((s:any)=>!teacherLearningObject(s)||!teacherLearningUuid(s.id)||typeof s.title!=='string'||s.title.length>180))throw new TeacherLearningError('invalid_response');return {submissions:r.submissions,tests:r.tests}},
    async generate(request,signal){const r=await call('generate',{request:validateTeacherLearningRequest(request)},signal);return validateTeacherLearningDraft(r.draft)},
    async insights(scope,signal){
      const r=await call('insights',{scope},signal),v=r.report
      const count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0
      const short=(x:unknown,n:number)=>typeof x==='string'&&x.length<=n
      const validDate=(x:unknown)=>typeof x==='string'&&Number.isFinite(Date.parse(x))
      if(!teacherLearningObject(v)||v.courseId!==scope.courseId||!short(v.courseTitle,180)||!short(v.notice,2000)||!validDate(v.checkedAt)
        ||!Array.isArray(v.groups)||v.groups.length>10||v.groups.some((g:any)=>!teacherLearningObject(g)||!scope.groupIds.includes(g.id)||!short(g.name,180)||![g.students,g.publishedGrades,g.pendingReviews].every(count)||(g.averagePercent!==null&&(typeof g.averagePercent!=='number'||!Number.isFinite(g.averagePercent)))||!Array.isArray(g.upcoming)||g.upcoming.some((d:any)=>!teacherLearningObject(d)||!short(d.title,500)||!validDate(d.dueAt)))
        ||!Array.isArray(v.questions)||v.questions.length>80||v.questions.some((q:any)=>!teacherLearningObject(q)||!short(q.key,64)||!short(q.text,450)||!short(q.kind,40)||![q.responses,q.mistakes,q.pendingReview].every(count))
        ||!Array.isArray(v.learners)||v.learners.length>500||v.learners.some((s:any)=>!teacherLearningObject(s)||!short(s.code,64)||!short(s.name,500)||!scope.groupIds.includes(s.groupId)||!count(s.pendingReview)||!Array.isArray(s.weak)||s.weak.some((k:unknown)=>!short(k,64)))
        ||v.test!==null&&(!teacherLearningObject(v.test)||v.test.id!==scope.testId||!short(v.test.title,180)||typeof v.test.ready!=='boolean'||!count(v.test.submitted)))throw new TeacherLearningError('invalid_response')
      return v as TeacherInsights
    },
    async reminders(operation,payload={},signal){const r=await call('reminders',{operation,payload},signal);if(!Array.isArray(r.reminders)||r.reminders.length>100||r.reminders.some((x:any)=>!teacherLearningObject(x)||!teacherLearningUuid(x.id)||typeof x.title!=='string'||x.title.length>180||!Number.isFinite(Date.parse(x.dueAt))||!['pending','sent','cancelled'].includes(x.state)))throw new TeacherLearningError('invalid_response');return r.reminders},
    async createTest(draftId,conditions,signal){const r=await call('create_test',{draftId,conditions},signal);if(!teacherLearningUuid(r.testId)||typeof r.replayed!=='boolean')throw new TeacherLearningError('invalid_response');return{testId:r.testId,replayed:r.replayed}},
    async saveDraft(save,signal){const r=await call('save_draft',{save:validateTeacherLearningSave(save)},signal);return validateTeacherLearningDraft(r.draft)},
  }
}
let currentOwner: string | null = null
export const teacherLearningClient = createTeacherLearningClient({
  currentUserId:()=>currentOwner,
  async session(){const{data,error}=await supabase.auth.getSession();currentOwner=!error&&data.session?data.session.user.id:null;return data.session?{userId:data.session.user.id,accessToken:data.session.access_token}:null},
})
