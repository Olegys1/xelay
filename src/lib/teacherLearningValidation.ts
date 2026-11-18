import type { TeacherLearningBundle, TeacherLearningDraft, TeacherLearningKind, TeacherLearningRequest, TeacherLearningSave, TeacherLearningStatus } from './teacherLearning.js'

const kinds: TeacherLearningKind[] = ['questions','variants','tasks','rubric_review','quality','error_practice']
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export const teacherLearningObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const object = teacherLearningObject
const fields = (v: Record<string, any>, allowed: string[], required = allowed) => Object.keys(v).every(k => allowed.includes(k)) && required.every(k => Object.prototype.hasOwnProperty.call(v,k))
const plain = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && (empty || !!v.trim()) && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v) && !/<\/?[a-z][^>]*>/i.test(v)
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const numeric = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && Math.abs(v*100-Math.round(v*100)) < 0.000001
const fail = (): never => { throw new Error('TEACHER_LEARNING_INVALID') }
export const teacherLearningUuid = (v: unknown): v is string => typeof v === 'string' && uuidPattern.test(v)
export function validateTeacherLearningRequest(v: unknown): TeacherLearningRequest {
  if (!object(v)) return fail()
  if (!object(v) || !fields(v,['requestId','kind','courseId','groupIds','prompt','consent','sourceText','rubricText','submissionId','testId','questionCount','variantCount'],['requestId','kind','courseId','groupIds','prompt','consent']) || !teacherLearningUuid(v.requestId) || !teacherLearningUuid(v.courseId) || !kinds.includes(v.kind) || v.consent !== true || !plain(v.prompt,2400)) fail()
  if (!Array.isArray(v.groupIds) || v.groupIds.length < 1 || v.groupIds.length > 10 || v.groupIds.some((g: unknown) => !teacherLearningUuid(g)) || new Set(v.groupIds).size !== v.groupIds.length) fail()
  if (v.sourceText !== undefined && !plain(v.sourceText,12000) || v.rubricText !== undefined && !plain(v.rubricText,4000) || v.submissionId !== undefined && !teacherLearningUuid(v.submissionId) || v.testId !== undefined && !teacherLearningUuid(v.testId)) fail()
  if (v.questionCount !== undefined && !integer(v.questionCount,1,10) || v.variantCount !== undefined && !integer(v.variantCount,2,3)) fail()
  if (v.kind === 'rubric_review' && !v.submissionId || ['quality','error_practice'].includes(v.kind) && !v.testId) fail()
  if (v.kind !== 'rubric_review' && v.submissionId !== undefined || !['quality','error_practice'].includes(v.kind) && v.testId !== undefined || v.kind !== 'variants' && v.variantCount !== undefined) fail()
  if (v.kind === 'variants' && (v.questionCount ?? 5)*(v.variantCount ?? 2)>20) fail()
  if (new TextEncoder().encode(JSON.stringify(v)).byteLength > 64000) fail()
  return structuredClone(v) as TeacherLearningRequest
}
export function validateTeacherLearningBundle(v: unknown, request: TeacherLearningRequest): TeacherLearningBundle {
  if (!object(v)) return fail()
  if (!object(v) || !fields(v,['version','kind','title','summary','questions','tasks','review','quality','warnings']) || v.version !== 1 || v.kind !== request.kind || !plain(v.title,180) || !plain(v.summary,2400) || !Array.isArray(v.questions) || v.questions.length > 20 || !Array.isArray(v.tasks) || v.tasks.length > 10 || !Array.isArray(v.quality) || v.quality.length > 30 || !Array.isArray(v.warnings) || v.warnings.length > 10 || v.warnings.some((w: unknown) => !plain(w,500))) fail()
  const ids = new Set<string>()
  for (const q of v.questions) {
    if (!object(q) || !fields(q,['id','type','text','choices','correctIndex','explanation','points','topic','variant']) || typeof q.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(q.id) || ids.has(q.id) || q.type !== 'single' || !plain(q.text,2000) || !Array.isArray(q.choices) || q.choices.length !== 4 || q.choices.some((c: unknown) => !plain(c,500)) || new Set(q.choices).size !== q.choices.length || !integer(q.correctIndex,0,3) || !plain(q.explanation,1000) || !numeric(q.points,0.01,100) || !plain(q.topic,200) || !integer(q.variant,1,3)) fail()
    ids.add(q.id)
  }
  for (const task of v.tasks) if (!object(task) || !fields(task,['title','instructions','criteria']) || !plain(task.title,180) || !plain(task.instructions,3000) || !Array.isArray(task.criteria) || task.criteria.length < 1 || task.criteria.length > 10 || task.criteria.some((c: unknown) => !plain(c,500))) fail()
  for (const q of v.quality) if (!object(q) || !fields(q,['questionId','issue','suggestion']) || !plain(q.questionId,64) || !plain(q.issue,1000) || !plain(q.suggestion,1500)) fail()
  if (v.review !== null) {
    const review = v.review
    if (!object(review) || !fields(review,['criteria','feedback','suggestedScore','maxScore']) || !Array.isArray(review.criteria) || review.criteria.length < 1 || review.criteria.length > 20 || !plain(review.feedback,3000) || !numeric(review.maxScore,0.01,10000) || !numeric(review.suggestedScore,0,review.maxScore)) fail()
    for (const c of review.criteria) if (!object(c) || !fields(c,['title','points','maxPoints','comment','evidence']) || !plain(c.title,200) || !numeric(c.maxPoints,0,10000) || !numeric(c.points,0,c.maxPoints) || !plain(c.comment,1000) || !Array.isArray(c.evidence) || c.evidence.length > 4 || c.evidence.some((e: unknown) => !plain(e,180))) fail()
    if (Math.abs(review.criteria.reduce((n: number,c: any) => n+c.points,0)-review.suggestedScore)>0.011 || Math.abs(review.criteria.reduce((n: number,c: any) => n+c.maxPoints,0)-review.maxScore)>0.011) fail()
  }
  const questionModes = ['questions','variants','error_practice'].includes(request.kind)
  if (questionModes) {
    const n=request.questionCount??5, variants=request.kind==='variants'?(request.variantCount??2):1
    if (v.questions.length!==n*variants || v.tasks.length || v.review!==null || v.quality.length) fail()
    for(let variant=1;variant<=variants;variant++)if(v.questions.filter((q:any)=>q.variant===variant).length!==n)fail()
    if(request.kind==='variants'){
      const baseline=v.questions.filter((q:any)=>q.variant===1)
      for(let variant=2;variant<=variants;variant++){
        const next=v.questions.filter((q:any)=>q.variant===variant)
        if(next.some((q:any,i:number)=>q.topic!==baseline[i].topic || q.points!==baseline[i].points || q.text===baseline[i].text))fail()
      }
    }
  } else if (v.questions.length) fail()
  if (request.kind==='tasks' && (!v.tasks.length || v.review!==null || v.quality.length) || request.kind!=='tasks' && v.tasks.length || request.kind==='rubric_review' && v.review===null || request.kind!=='rubric_review' && v.review!==null || request.kind!=='quality' && v.quality.length) fail()
  if(new TextEncoder().encode(JSON.stringify(v)).byteLength>100000)fail()
  return structuredClone(v) as TeacherLearningBundle
}
export function validateTeacherLearningDraft(v: unknown): TeacherLearningDraft {
  if (!object(v)) return fail()
  if (!object(v) || !fields(v,['id','request','bundle','revision','status','teacherNotes','createdAt','updatedAt']) || !teacherLearningUuid(v.id) || !integer(v.revision,1,1000000) || !['draft','accepted'].includes(v.status) || !plain(v.teacherNotes,5000,true) || !Number.isFinite(Date.parse(v.createdAt)) || !Number.isFinite(Date.parse(v.updatedAt))) fail()
  const request=validateTeacherLearningRequest(v.request)
  if(v.id!==request.requestId)fail()
  return {...v,request,bundle:validateTeacherLearningBundle(v.bundle,request)} as TeacherLearningDraft
}
export function validateTeacherLearningSave(v: unknown): TeacherLearningSave {
  if (!object(v)) return fail()
  if(!object(v)||!fields(v,['id','expectedRevision','bundle','teacherNotes','status'])||!teacherLearningUuid(v.id)||!integer(v.expectedRevision,1,1000000)||!plain(v.teacherNotes,5000,true)||!['draft','accepted'].includes(v.status)||!object(v.bundle))fail()
  return structuredClone(v) as TeacherLearningSave
}
export function validateTeacherLearningStatus(v: unknown): TeacherLearningStatus {
  if (!object(v)) return fail()
  if(!object(v)||!teacherLearningUuid(v.userId)||!['student','teacher','unresolved'].includes(v.audience)||!['free','teacher_start','teacher_plus','teacher_max'].includes(v.planId)||typeof v.canGenerate!=='boolean'||typeof v.canEdit!=='boolean'||typeof v.available!=='boolean'||v.budgetPeriod!=='subscription_month'||!object(v.budget)||!fields(v.budget,['limitMicros','spentMicros','reservedMicros'])||Object.values(v.budget).some(x=>!integer(x,0,1000000000000))||!Array.isArray(v.allowedModes)||v.allowedModes.some((m:unknown)=>!kinds.includes(m as TeacherLearningKind))||!Array.isArray(v.courses)||v.courses.length>100)fail()
  const cap={free:0,teacher_start:1000000,teacher_plus:4000000,teacher_max:8000000}[v.planId as TeacherLearningStatus['planId']]
  if(v.budget.limitMicros!==cap||v.canGenerate&&(v.audience!=='teacher'||v.planId==='free'||v.available!==true)||v.canEdit&&(v.audience!=='teacher'||v.planId==='free'))fail()
  for(const date of [v.startsAt,v.expiresAt])if(date!==null&&(typeof date!=='string'||!Number.isFinite(Date.parse(date))))fail()
  for(const c of v.courses){if(!object(c)||!teacherLearningUuid(c.id)||!plain(c.title,180)||!Array.isArray(c.permissions)||!Array.isArray(c.groups)||c.groups.length>100)fail();for(const g of c.groups)if(!object(g)||!teacherLearningUuid(g.id)||!plain(g.name,180)||!Array.isArray(g.permissions))fail()}
  return structuredClone(v) as TeacherLearningStatus
}
